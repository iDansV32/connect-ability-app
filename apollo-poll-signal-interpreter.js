'use strict';

const {
  DEFAULT_CRM_ELIGIBILITY_RULES,
  CRM_ELIGIBILITY_RULE_NAMES
} = require('./crm-eligibility-evaluator');

// Current Apollo polling can only observe contact state, deal summaries, and task summaries.
// That means the interpreter can safely evaluate:
// - contact_stage_active_sales_process
// - deal_stage_not_closed_lost
// - meeting_booked_recently
// - active_sales_conversation
// - recent_owner_activity
//
// Signals that depend on live sequence-contact reads remain intentionally blocked here:
// - reply
// - unsubscribe
// - bounce
// - sequence_finished
//
// If one of those blocked signals is enabled before sequenceContactStatus is wired,
// this interpreter throws loudly instead of silently treating it as "no signal."

const BLOCKED_SEQUENCE_CONTACT_SIGNAL_NAMES = new Set([
  'reply',
  'unsubscribe',
  'bounce',
  'sequence_finished'
]);

const IMPLEMENTABLE_SIGNAL_NAMES = new Set([
  CRM_ELIGIBILITY_RULE_NAMES.CONTACT_STAGE_ACTIVE_SALES_PROCESS,
  CRM_ELIGIBILITY_RULE_NAMES.DEAL_STAGE_NOT_CLOSED_LOST,
  CRM_ELIGIBILITY_RULE_NAMES.MEETING_BOOKED_RECENTLY,
  CRM_ELIGIBILITY_RULE_NAMES.ACTIVE_SALES_CONVERSATION,
  CRM_ELIGIBILITY_RULE_NAMES.RECENT_OWNER_ACTIVITY
]);

const DEFAULT_APOLLO_POLL_SIGNAL_RULES = Object.freeze(
  DEFAULT_CRM_ELIGIBILITY_RULES
    .filter((rule) => IMPLEMENTABLE_SIGNAL_NAMES.has(cleanString(rule?.name, 160)))
    .map((rule) => Object.freeze({ ...rule }))
);

function interpretPollObservation(pollResult = {}, rules = DEFAULT_APOLLO_POLL_SIGNAL_RULES) {
  const observation = normalizePollObservation(pollResult);
  const normalizedRules = normalizeRules(rules);
  const matchedSignals = [];

  for (const rule of normalizedRules) {
    if (!rule.enabled) {
      continue;
    }
    if (BLOCKED_SEQUENCE_CONTACT_SIGNAL_NAMES.has(rule.name)) {
      throw new Error(`Apollo poll signal "${rule.name}" requires sequenceContactStatus and is not observable yet`);
    }

    const signal = evaluatePollRule(observation, rule);
    if (signal) {
      matchedSignals.push(signal);
    }
  }

  return {
    matchedSignals,
    shouldSuppress: matchedSignals.length > 0,
    suppressReason: matchedSignals.length ? matchedSignals.map((signal) => signal.reason).join('; ') : null
  };
}

function evaluatePollRule(observation, rule) {
  switch (rule.name) {
    case CRM_ELIGIBILITY_RULE_NAMES.CONTACT_STAGE_ACTIVE_SALES_PROCESS:
      return evaluateContactStageSignal(observation, rule);
    case CRM_ELIGIBILITY_RULE_NAMES.DEAL_STAGE_NOT_CLOSED_LOST:
      return evaluateDealStageSignal(observation, rule);
    case CRM_ELIGIBILITY_RULE_NAMES.MEETING_BOOKED_RECENTLY:
      return evaluateMeetingBookedSignal(observation, rule);
    case CRM_ELIGIBILITY_RULE_NAMES.ACTIVE_SALES_CONVERSATION:
      return evaluateActiveSalesConversationSignal(observation, rule);
    case CRM_ELIGIBILITY_RULE_NAMES.RECENT_OWNER_ACTIVITY:
      return evaluateRecentOwnerActivitySignal(observation, rule);
    default:
      return null;
  }
}

function evaluateContactStageSignal(observation, rule) {
  const blockedStages = normalizeNameList(rule.blockedStageNames);
  const stageName = normalizeComparableText(observation.contact.stageName || observation.contact.lifecycleStage);
  if (!stageName || !blockedStages.has(stageName)) {
    return null;
  }
  return {
    name: rule.name,
    reason: `apollo_poll:${rule.name}:stage=${stageName}`
  };
}

function evaluateDealStageSignal(observation, rule) {
  const blockingStages = Array.isArray(observation.dealSnapshot.nonClosedLostStageNames)
    ? observation.dealSnapshot.nonClosedLostStageNames.map((value) => normalizeComparableText(value)).filter(Boolean)
    : [];
  if (!blockingStages.length) {
    return null;
  }
  return {
    name: rule.name,
    reason: `apollo_poll:${rule.name}:stages=${blockingStages.join(',')}`
  };
}

function evaluateMeetingBookedSignal(observation, rule) {
  const completedAt = normalizeTimestamp(observation.taskSnapshot.latestMeetingOrCallCompletedAt);
  if (!completedAt || !isTimestampWithinWindow(completedAt, rule.windowDays, observation.observedAt)) {
    return null;
  }
  return {
    name: rule.name,
    reason: `apollo_poll:${rule.name}:task_completed_at=${completedAt}`
  };
}

function evaluateActiveSalesConversationSignal(observation, rule) {
  const updatedAt = normalizeTimestamp(observation.taskSnapshot.latestSalesOwnedOpenTaskUpdatedAt);
  if (!updatedAt || !isTimestampWithinWindow(updatedAt, rule.windowDays, observation.observedAt)) {
    return null;
  }
  return {
    name: rule.name,
    reason: `apollo_poll:${rule.name}:task_updated_at=${updatedAt}`
  };
}

function evaluateRecentOwnerActivitySignal(observation, rule) {
  const activityAt = normalizeTimestamp(observation.taskSnapshot.latestOwnerActivityAt);
  if (!activityAt || !isTimestampWithinWindow(activityAt, rule.windowDays, observation.observedAt)) {
    return null;
  }
  return {
    name: rule.name,
    reason: `apollo_poll:${rule.name}:owner_activity_at=${activityAt}`
  };
}

function normalizePollObservation(value = {}) {
  return {
    outcome: cleanString(value.outcome, 80) || null,
    observedAt: normalizeTimestamp(value.observedAt || value.lastPollAt),
    sequenceContactStatus: cleanString(value.sequenceContactStatus, 120) || null,
    contact: normalizeObject(value.contact),
    dealSnapshot: normalizeObject(value.dealSnapshot),
    taskSnapshot: normalizeObject(value.taskSnapshot)
  };
}

function normalizeRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule && typeof rule === 'object')
    .map((rule) => ({
      ...rule,
      name: cleanString(rule.name, 160),
      enabled: rule.enabled !== false,
      windowDays: Math.max(0, Number(rule.windowDays) || 0)
    }))
    .filter((rule) => Boolean(rule.name));
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeNameList(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeComparableText(value))
    .filter(Boolean));
}

function normalizeComparableText(value) {
  return cleanString(value, 240).toLowerCase();
}

function normalizeTimestamp(value) {
  const text = cleanString(value, 80);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function isTimestampWithinWindow(value, windowDays, referenceTime = null) {
  const timestamp = Date.parse(cleanString(value, 80));
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const windowMs = Math.max(0, Number(windowDays) || 0) * 24 * 60 * 60 * 1000;
  const referenceTimestamp = Date.parse(cleanString(referenceTime, 80));
  const safeReferenceTimestamp = Number.isFinite(referenceTimestamp) ? referenceTimestamp : Date.now();
  return timestamp >= (safeReferenceTimestamp - windowMs);
}

function cleanString(value, maxLength = 200) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  BLOCKED_SEQUENCE_CONTACT_SIGNAL_NAMES,
  DEFAULT_APOLLO_POLL_SIGNAL_RULES,
  interpretPollObservation
};
