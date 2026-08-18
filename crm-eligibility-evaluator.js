'use strict';

const RULE_CONTACT_STAGE_ACTIVE_SALES_PROCESS = 'contact_stage_active_sales_process';
const RULE_DEAL_STAGE_NOT_CLOSED_LOST = 'deal_stage_not_closed_lost';
const RULE_MEETING_BOOKED_RECENTLY = 'meeting_booked_recently';
const RULE_ACTIVE_SALES_CONVERSATION = 'active_sales_conversation';
const RULE_RECENT_OWNER_ACTIVITY = 'recent_owner_activity';

const DEFAULT_CRM_ELIGIBILITY_RULES = Object.freeze([
  Object.freeze({
    name: RULE_CONTACT_STAGE_ACTIVE_SALES_PROCESS,
    enabled: true,
    blockedStageNames: ['opportunity', 'customer']
  }),
  Object.freeze({
    name: RULE_DEAL_STAGE_NOT_CLOSED_LOST,
    enabled: true,
    closedLostStageNames: ['closed lost']
  }),
  Object.freeze({
    name: RULE_MEETING_BOOKED_RECENTLY,
    enabled: true,
    windowDays: 30,
    activityTypes: ['meeting', 'call']
  }),
  Object.freeze({
    name: RULE_ACTIVE_SALES_CONVERSATION,
    enabled: true,
    windowDays: 14
  }),
  Object.freeze({
    name: RULE_RECENT_OWNER_ACTIVITY,
    enabled: true,
    windowDays: 7
  })
]);

async function evaluateCrmEligibility(contactId, apolloClient, rules = DEFAULT_CRM_ELIGIBILITY_RULES, options = {}) {
  const normalizedContactId = cleanString(contactId, 160);
  if (!normalizedContactId) {
    throw new Error('Apollo contactId is required for CRM eligibility evaluation');
  }
  if (!apolloClient || typeof apolloClient !== 'object') {
    throw new Error('Apollo client is required for CRM eligibility evaluation');
  }
  if (typeof apolloClient.getContact !== 'function') {
    throw new Error('Apollo client must implement getContact(contactId) for CRM eligibility evaluation');
  }

  const now = normalizeNow(options.now);
  const normalizedRules = normalizeRules(rules);
  const contactResult = await loadApolloContact(normalizedContactId, apolloClient, options);
  if (contactResult.holdCause) {
    return buildHoldResult(contactResult.holdCause, [], contactResult.contact, now);
  }

  const context = {
    apolloClient,
    contact: contactResult.contact,
    now,
    options
  };
  const suppressionReasons = [];

  for (const rule of normalizedRules) {
    if (!rule.enabled) {
      continue;
    }
    const result = await evaluateRule(rule, context);
    if (result.holdCause) {
      return buildHoldResult(result.holdCause, [], context.contact, now);
    }
    if (result.suppressed) {
      suppressionReasons.push(result.reason || rule.name);
    }
  }

  return {
    eligible: suppressionReasons.length === 0,
    suppressionReasons,
    holdCause: null,
    contact: context.contact,
    evaluatedAt: now.toISOString()
  };
}

async function evaluateRule(rule, context) {
  switch (rule.name) {
    case RULE_CONTACT_STAGE_ACTIVE_SALES_PROCESS:
      return evaluateContactStageRule(rule, context);
    case RULE_DEAL_STAGE_NOT_CLOSED_LOST:
      return evaluateDealStageRule(rule, context);
    case RULE_MEETING_BOOKED_RECENTLY:
      return evaluateMeetingBookedRule(rule, context);
    case RULE_ACTIVE_SALES_CONVERSATION:
      return evaluateActiveSalesConversationRule(rule, context);
    case RULE_RECENT_OWNER_ACTIVITY:
      return evaluateRecentOwnerActivityRule(rule, context);
    default:
      return { suppressed: false, reason: null, holdCause: null };
  }
}

async function evaluateContactStageRule(rule, context) {
  const contact = context.contact || {};
  const blockedStages = normalizeNameList(rule.blockedStageNames);
  const stageResult = await resolveContactStageName(contact, context);
  if (stageResult.holdCause) {
    return { suppressed: false, reason: rule.name, holdCause: stageResult.holdCause };
  }
  const stageName = stageResult.stageName;
  if (!stageName) {
    return { suppressed: false, reason: rule.name, holdCause: null };
  }
  return {
    suppressed: blockedStages.has(stageName),
    reason: rule.name,
    holdCause: null
  };
}

async function evaluateDealStageRule(rule, context) {
  if (typeof context.apolloClient.searchDeals !== 'function') {
    throw new Error('Apollo client must implement searchDeals(filters) for deal-stage eligibility rules');
  }

  let deals;
  try {
    deals = await context.apolloClient.searchDeals({
      contact_id: context.contact.id,
      page: 1,
      per_page: 100
    });
  } catch (_error) {
    return { suppressed: false, reason: rule.name, holdCause: 'unreachable' };
  }

  const normalizedDeals = Array.isArray(deals) ? deals.filter(Boolean) : [];
  if (!normalizedDeals.length) {
    return { suppressed: false, reason: rule.name, holdCause: null };
  }

  const closedLostStageNames = normalizeNameList(rule.closedLostStageNames);
  let dealStagesById = null;
  for (const deal of normalizedDeals) {
    let stageName = normalizeComparableText(
      deal.stageName
      || deal.raw?.opportunity_stage_name
      || deal.raw?.stage_name
    );
    if (!stageName) {
      const stageId = cleanString(deal.stageId || deal.raw?.opportunity_stage_id || deal.raw?.stage_id, 160);
      if (stageId) {
        if (!dealStagesById) {
          const dealStageResult = await loadApolloDealStages(context);
          if (dealStageResult.holdCause) {
            return { suppressed: false, reason: rule.name, holdCause: dealStageResult.holdCause };
          }
          dealStagesById = dealStageResult.stagesById;
        }
        stageName = normalizeComparableText(dealStagesById.get(stageId));
      }
    }
    if (!stageName) {
      continue;
    }
    if (!closedLostStageNames.has(stageName)) {
      return { suppressed: true, reason: rule.name, holdCause: null };
    }
  }

  return { suppressed: false, reason: rule.name, holdCause: null };
}

async function evaluateMeetingBookedRule(rule, context) {
  const tasksResult = await searchApolloTasksForRule(context, {
    contact_id: context.contact.id,
    type: Array.isArray(rule.activityTypes) ? rule.activityTypes : ['meeting', 'call'],
    completed: true,
    completed_at_gte: toApolloTimestampFloor(context.now, rule.windowDays)
  });
  if (tasksResult.holdCause) {
    return tasksResult;
  }
  const allowedTypes = normalizeNameList(rule.activityTypes);
  const matched = tasksResult.tasks.some((task) => {
    const type = normalizeComparableText(task.type || task.raw?.task_type);
    return allowedTypes.has(type) && isTaskCompleted(task) && isTimestampWithinWindow(task.completedAt || task.raw?.completed_at, rule.windowDays, context.now);
  });
  return { suppressed: matched, reason: rule.name, holdCause: null };
}

async function evaluateActiveSalesConversationRule(rule, context) {
  const salesUsersResult = await loadApolloSalesUsers(context);
  if (salesUsersResult.holdCause) {
    return salesUsersResult;
  }
  if (!salesUsersResult.salesUserIds.size) {
    return { suppressed: false, reason: rule.name, holdCause: null };
  }

  const tasksResult = await searchApolloTasksForRule(context, {
    contact_id: context.contact.id,
    open: true,
    updated_at_gte: toApolloTimestampFloor(context.now, rule.windowDays)
  });
  if (tasksResult.holdCause) {
    return tasksResult;
  }

  const matched = tasksResult.tasks.some((task) => (
    isTaskOpen(task)
    && salesUsersResult.salesUserIds.has(cleanString(task.ownerId, 160))
    && isTimestampWithinWindow(task.updatedAt || task.raw?.updated_at, rule.windowDays, context.now)
  ));
  return { suppressed: matched, reason: rule.name, holdCause: null };
}

async function evaluateRecentOwnerActivityRule(rule, context) {
  const ownerId = cleanString(context.contact.ownerId || context.contact.raw?.owner_id, 160);
  if (!ownerId) {
    return { suppressed: false, reason: rule.name, holdCause: null };
  }

  const tasksResult = await searchApolloTasksForRule(context, {
    contact_id: context.contact.id,
    owner_id: ownerId,
    updated_at_gte: toApolloTimestampFloor(context.now, rule.windowDays)
  });
  if (tasksResult.holdCause) {
    return tasksResult;
  }

  const matched = tasksResult.tasks.some((task) => (
    cleanString(task.ownerId, 160) === ownerId
    && (
      (isTaskOpen(task) && isTimestampWithinWindow(task.updatedAt || task.raw?.updated_at, rule.windowDays, context.now))
      || isTimestampWithinWindow(task.completedAt || task.raw?.completed_at, rule.windowDays, context.now)
    )
  ));
  return { suppressed: matched, reason: rule.name, holdCause: null };
}

async function loadApolloContact(contactId, apolloClient, options = {}) {
  const providedContact = options.contact && typeof options.contact === 'object'
    ? options.contact
    : null;
  if (providedContact?.id === contactId) {
    return { contact: providedContact, holdCause: null };
  }

  try {
    const contact = await apolloClient.getContact(contactId);
    if (!contact?.id) {
      return { contact: null, holdCause: 'freshness_unknown' };
    }
    return { contact, holdCause: null };
  } catch (_error) {
    return { contact: null, holdCause: 'unreachable' };
  }
}

async function loadApolloSalesUsers(context) {
  const providedUsers = Array.isArray(context.options?.apolloUsers)
    ? context.options.apolloUsers.filter(Boolean)
    : null;
  const users = providedUsers || await fetchApolloUsers(context.apolloClient);
  if (!users) {
    return { salesUserIds: new Set(), holdCause: 'unreachable' };
  }

  const salesUserIds = new Set(
    users
      .filter((user) => isSalesApolloUser(user))
      .map((user) => cleanString(user.id, 160))
      .filter(Boolean)
  );
  return { salesUserIds, holdCause: null };
}

async function fetchApolloUsers(apolloClient) {
  if (typeof apolloClient.listUsers !== 'function') {
    throw new Error('Apollo client must implement listUsers() for sales-conversation eligibility rules');
  }
  try {
    const users = await apolloClient.listUsers({ page: 1, perPage: 100 });
    return Array.isArray(users) ? users : [];
  } catch (_error) {
    return null;
  }
}

async function loadApolloContactStages(context) {
  if (context.contactStagesById) {
    return {
      stagesById: context.contactStagesById,
      holdCause: null
    };
  }
  const providedStages = Array.isArray(context.options?.contactStages)
    ? context.options.contactStages
    : null;
  const stages = providedStages || await fetchApolloStages(context.apolloClient, 'listContactStages');
  if (!stages) {
    return {
      stagesById: new Map(),
      holdCause: 'unreachable'
    };
  }
  context.contactStagesById = new Map(stages
    .filter(Boolean)
    .map((stage) => [cleanString(stage.id, 160), normalizeComparableText(stage.name || stage.raw?.name)]));
  return {
    stagesById: context.contactStagesById,
    holdCause: null
  };
}

async function loadApolloDealStages(context) {
  if (context.dealStagesById) {
    return {
      stagesById: context.dealStagesById,
      holdCause: null
    };
  }
  const providedStages = Array.isArray(context.options?.dealStages)
    ? context.options.dealStages
    : null;
  const stages = providedStages || await fetchApolloStages(context.apolloClient, 'listDealStages');
  if (!stages) {
    return {
      stagesById: new Map(),
      holdCause: 'unreachable'
    };
  }
  context.dealStagesById = new Map(stages
    .filter(Boolean)
    .map((stage) => [cleanString(stage.id, 160), normalizeComparableText(stage.name || stage.raw?.name)]));
  return {
    stagesById: context.dealStagesById,
    holdCause: null
  };
}

async function fetchApolloStages(apolloClient, methodName) {
  if (typeof apolloClient[methodName] !== 'function') {
    throw new Error(`Apollo client must implement ${methodName}() for CRM eligibility rules`);
  }
  try {
    const stages = await apolloClient[methodName]();
    return Array.isArray(stages) ? stages : [];
  } catch (_error) {
    return null;
  }
}

async function resolveContactStageName(contact, context) {
  const directStageName = normalizeComparableText(
    contact.stageName
    || contact.lifecycleStage
    || contact.raw?.contact_stage_name
    || contact.raw?.contact_stage?.name
    || contact.raw?.stage_name
    || contact.raw?.lifecycle_stage_name
    || contact.raw?.lifecycle_stage
  );
  if (directStageName) {
    return {
      stageName: directStageName,
      holdCause: null
    };
  }

  const stageId = cleanString(contact.stageId || contact.raw?.contact_stage_id || contact.raw?.stage_id, 160);
  if (!stageId) {
    return {
      stageName: null,
      holdCause: null
    };
  }

  const contactStageResult = await loadApolloContactStages(context);
  if (contactStageResult.holdCause) {
    return {
      stageName: null,
      holdCause: contactStageResult.holdCause
    };
  }
  return {
    stageName: contactStageResult.stagesById.get(stageId) || null,
    holdCause: null
  };
}

async function searchApolloTasksForRule(context, filters = {}) {
  if (typeof context.apolloClient.searchTasks !== 'function') {
    throw new Error('Apollo client must implement searchTasks(filters) for CRM eligibility rules');
  }
  try {
    const tasks = await context.apolloClient.searchTasks({
      filters,
      page: 1,
      perPage: 100
    });
    return {
      tasks: Array.isArray(tasks) ? tasks.filter(Boolean) : [],
      suppressed: false,
      reason: null,
      holdCause: null
    };
  } catch (_error) {
    return {
      tasks: [],
      suppressed: false,
      reason: null,
      holdCause: 'unreachable'
    };
  }
}

function buildHoldResult(holdCause, suppressionReasons, contact, now) {
  return {
    eligible: false,
    suppressionReasons,
    holdCause,
    contact: contact || null,
    evaluatedAt: now.toISOString()
  };
}

function normalizeRules(rules) {
  const input = Array.isArray(rules) && rules.length ? rules : DEFAULT_CRM_ELIGIBILITY_RULES;
  return input
    .filter((rule) => rule && typeof rule === 'object')
    .map((rule) => ({
      ...rule,
      name: cleanString(rule.name, 160),
      enabled: rule.enabled !== false,
      windowDays: Math.max(0, Number(rule.windowDays) || 0)
    }))
    .filter((rule) => Boolean(rule.name));
}

function isSalesApolloUser(user = {}) {
  const candidates = [
    user.role,
    user.team,
    user.title,
    user.raw?.role,
    user.raw?.user_role,
    user.raw?.role_name,
    user.raw?.department,
    user.raw?.team,
    user.raw?.team_name,
    user.raw?.title
  ]
    .map((value) => normalizeComparableText(value))
    .filter(Boolean);
  return candidates.some((value) => value.includes('sales'));
}

function isTaskCompleted(task = {}) {
  if (task.completedAt || task.raw?.completed_at || task.raw?.done_at) {
    return true;
  }
  const status = normalizeComparableText(task.status || task.raw?.status);
  return ['completed', 'complete', 'done', 'closed'].includes(status);
}

function isTaskOpen(task = {}) {
  if (isTaskCompleted(task)) {
    return false;
  }
  if (task.raw?.open === true) {
    return true;
  }
  const status = normalizeComparableText(task.status || task.raw?.status);
  if (!status) {
    return true;
  }
  return !['cancelled', 'canceled', 'closed', 'completed', 'complete', 'done'].includes(status);
}

function isTimestampWithinWindow(value, windowDays, now) {
  const timestamp = Date.parse(cleanString(value, 80));
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const windowMs = Math.max(0, Number(windowDays) || 0) * 24 * 60 * 60 * 1000;
  return timestamp >= (now.getTime() - windowMs);
}

function toApolloTimestampFloor(now, windowDays) {
  const timestamp = new Date(now.getTime() - (Math.max(0, Number(windowDays) || 0) * 24 * 60 * 60 * 1000));
  return timestamp.toISOString();
}

function normalizeNameList(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeComparableText(value))
    .filter(Boolean));
}

function normalizeComparableText(value) {
  return cleanString(value, 240).toLowerCase();
}

function normalizeNow(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
}

function cleanString(value, maxLength = 200) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  evaluateCrmEligibility,
  DEFAULT_CRM_ELIGIBILITY_RULES,
  CRM_ELIGIBILITY_RULE_NAMES: {
    CONTACT_STAGE_ACTIVE_SALES_PROCESS: RULE_CONTACT_STAGE_ACTIVE_SALES_PROCESS,
    DEAL_STAGE_NOT_CLOSED_LOST: RULE_DEAL_STAGE_NOT_CLOSED_LOST,
    MEETING_BOOKED_RECENTLY: RULE_MEETING_BOOKED_RECENTLY,
    ACTIVE_SALES_CONVERSATION: RULE_ACTIVE_SALES_CONVERSATION,
    RECENT_OWNER_ACTIVITY: RULE_RECENT_OWNER_ACTIVITY
  }
};
