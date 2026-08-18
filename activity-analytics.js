const fs = require('fs');
const path = require('path');
const {
  getConnectAbilityAppStateDir,
  getConnectAbilityDocumentsDir,
  resolveInternalStatePath
} = require('./connect-documents');
const LinkedInAccountHealthStore = require('./linkedin-account-health-store');
const TransportHealthStore = require('./automation/runtime/transport-health-store');
const RuntimeLogStore = require('./runtime-log-store');
const { AccountSessionRegistry } = require('./automation/runtime/account-session-registry');
const SqliteActivityEventRepository = require('./storage/sqlite-activity-event-repository');

const LEGACY_ACTION_TO_EVENT = {
  'Profile Viewed': 'profile_viewed',
  'Post Liked': 'post_liked',
  'Connection Request Sent': 'connection_requested',
  'Connection Accepted': 'connection_accepted',
  'Message Sent': 'dm_sent'
};

class ActivityAnalyticsService {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.eventsPath = options.eventsPath || resolveInternalStatePath('activity-events.jsonl');
    this.profilesPath = options.profilesPath || path.join(getConnectAbilityDocumentsDir(), 'profiles.json');
    this.accountHealthPath = options.accountHealthPath || resolveInternalStatePath('linkedin-account-health.json');
    this.transportHealthPath = options.transportHealthPath || resolveInternalStatePath('transport-health.json');
    this.runtimeLogsPath = options.runtimeLogsPath || resolveInternalStatePath('runtime-logs.jsonl');
    this.sessionRegistryPath = options.sessionRegistryPath || resolveInternalStatePath('session-registry.json');
    this.linkedInAccountsPath = options.linkedInAccountsPath || path.join(getConnectAbilityAppStateDir(), 'linkedin-accounts.json');
    // SQLite repo for event reads (injected when main process has SQLite open)
    this._eventRepo = options.db ? new SqliteActivityEventRepository(options.db) : null;
    // SQLite-backed health store for account health reads
    this._db = options.db || null;
  }

  getOverview(filters = {}) {
    const normalizedFilters = normalizeFilters(filters);
    const events = this.getEvents(normalizedFilters);
    const recentActivity = events.slice(0, normalizedFilters.activityLimit);

    const totals = {
      profilesViewed: 0,
      postLikes: 0,
      connectionRequests: 0,
      connectionAcceptances: 0,
      dmsSent: 0,
      dmReplies: 0,
      postsPublished: 0,
      workflowStarted: 0,
      workflowCompleted: 0,
      workflowFailed: 0
    };

    const byAgent = new Map();
    const byWorkflow = new Map();

    for (const event of events) {
      incrementTotals(totals, event.type);
      incrementSummary(byAgent, event.agentId || '__unassigned__', event, 'agent');
      incrementSummary(byWorkflow, event.workflowId || '__unassigned__', event, 'workflow');
    }

    return {
      filters: normalizedFilters,
      totals,
      rates: {
        dmReplyRate: totals.dmsSent > 0 ? Math.round((totals.dmReplies / totals.dmsSent) * 100) : 0,
        connectionAcceptanceRate: totals.connectionRequests > 0 ? Math.round((totals.connectionAcceptances / totals.connectionRequests) * 100) : 0
      },
      recentActivity: recentActivity.map(toActivityFeedItem),
      recentReplies: events
        .filter((event) => event.type === 'dm_reply_received')
        .slice(0, 10)
        .map(toActivityFeedItem),
      byAgent: Array.from(byAgent.values()).sort((left, right) => right.totalEvents - left.totalEvents),
      byWorkflow: Array.from(byWorkflow.values()).sort((left, right) => right.totalEvents - left.totalEvents)
    };
  }

  getEvents(filters = {}) {
    const normalizedFilters = normalizeFilters(filters);
    return this.getMergedEvents(normalizedFilters)
      .slice()
      .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
  }

  getReplyEvents(filters = {}) {
    return this.getEvents(filters).filter((event) => event.type === 'dm_reply_received');
  }

  /**
   * Summarize current account health from the persisted health stores and logs.
   *
   * The breakdown is intentionally conservative: challenge/cooldown/transport
   * counts reflect the current stored state, while the failure rates are based
   * on stored verification/canary signals that already exist in the app.
   */
  getAccountHealthBreakdown(filters = {}) {
    const normalizedFilters = normalizeFilters(filters);
    const accountHealthStore = new LinkedInAccountHealthStore({
      storePath: this.accountHealthPath,
      db: this._db || undefined
    });
    const transportHealthStore = new TransportHealthStore({ storePath: this.transportHealthPath });
    const runtimeLogStore = new RuntimeLogStore({ logsPath: this.runtimeLogsPath });
    const sessionRegistry = new AccountSessionRegistry({ storePath: this.sessionRegistryPath });

    const accountRecords = readLinkedInAccountsById(this.linkedInAccountsPath);
    const accountHealthState = accountHealthStore.readStore();
    const transportHealthState = transportHealthStore.readStore();
    const runtimeLogs = runtimeLogStore.getEntries({ limit: 10000 });
    const accounts = normalizedFilters.accountId
      ? [normalizedFilters.accountId]
      : collectAccountIds({
          accountHealthState,
          transportHealthState,
          runtimeLogs,
          accountRecords
        });

    const byAccount = accounts
      .map((accountId) => buildAccountHealthSummary(accountId, {
        accountRecords,
        accountHealthState,
        transportHealthState,
        runtimeLogs,
        sessionRegistry
      }))
      .filter(Boolean)
      .sort((left, right) => {
        const leftLabel = left.accountName || left.accountEmail || left.accountId || '';
        const rightLabel = right.accountName || right.accountEmail || right.accountId || '';
        return leftLabel.localeCompare(rightLabel);
      });

    return {
      filters: normalizedFilters,
      totals: byAccount.reduce((accumulator, entry) => {
        accumulator.accounts += 1;
        accumulator.challengeCount += entry.challengeCount;
        accumulator.cooldownCount += entry.cooldownCount;
        accumulator.transportDisableCount += entry.transportDisableCount;
        accumulator.verificationFailureCount += entry.verificationFailureCount;
        accumulator.verificationSignalCount += entry.verificationSignalCount;
        accumulator.canaryFailureCount += entry.canaryFailureCount;
        accumulator.canarySignalCount += entry.canarySignalCount;
        return accumulator;
      }, {
        accounts: 0,
        challengeCount: 0,
        cooldownCount: 0,
        transportDisableCount: 0,
        verificationFailureCount: 0,
        verificationSignalCount: 0,
        canaryFailureCount: 0,
        canarySignalCount: 0
      }),
      byAccount
    };
  }

  /**
   * Aggregate workflow step outcomes by (stepType, outcomeType).
   *
   * Reads `workflow_step_completed` and `workflow_step_failed` events and
   * returns a breakdown showing how many steps of each type ended in each
   * outcome — including skips (quota exceeded, outside working hours, managed
   * elsewhere, budget exceeded) and failures, not just successes.
   *
   * @param {object} filters - same shape as getOverview filters:
   *   accountId, agentId, workflowId, since, until
   * @returns {{
   *   filters: object,
   *   byStepType: Array<{stepType: string, total: number, breakdown: Array<{outcomeType: string, count: number}>}>,
   *   totals: {total: number, completed: number, skipped: number, failed: number}
   * }}
   */
  getStepOutcomeBreakdown(filters = {}) {
    const events = this.getEvents(filters).filter(
      (event) => event.type === 'workflow_step_completed' || event.type === 'workflow_step_failed'
    );

    // stepType → Map<outcomeType, count>
    const byStepType = new Map();
    const totals = { total: 0, completed: 0, skipped: 0, failed: 0 };

    for (const event of events) {
      const stepType = cleanString(event.metadata?.stepType, 80) || 'unknown';
      const outcomeType = cleanString(event.metadata?.outcomeType, 80) || 'unknown';
      const status = cleanString(event.status, 40) || 'ok';

      if (!byStepType.has(stepType)) {
        byStepType.set(stepType, new Map());
      }
      const forStep = byStepType.get(stepType);
      forStep.set(outcomeType, (forStep.get(outcomeType) || 0) + 1);

      totals.total += 1;
      if (status === 'ok') totals.completed += 1;
      else if (status === 'skipped') totals.skipped += 1;
      else totals.failed += 1;
    }

    const byStepTypeArray = Array.from(byStepType.entries())
      .map(([stepType, outcomeCounts]) => {
        const breakdown = Array.from(outcomeCounts.entries())
          .map(([outcomeType, count]) => ({ outcomeType, count }))
          .sort((left, right) => right.count - left.count);
        const total = breakdown.reduce((sum, entry) => sum + entry.count, 0);
        return { stepType, total, breakdown };
      })
      .sort((left, right) => right.total - left.total);

    return {
      filters: normalizeFilters(filters),
      byStepType: byStepTypeArray,
      totals
    };
  }

  /**
   * Compute a conversion funnel from activity events.
   *
   * Funnel stages (ordered from top to bottom):
   *   profile_viewed → profile_followed → skill_endorsed → post_commented →
   *   connection_requested → connection_accepted → dm_sent → dm_reply_received
   *
   * Each stage count is the number of UNIQUE prospects (by profileUrl) that
   * reached that stage.  Drop-off is calculated between adjacent stages that
   * have a causal relationship.  Stages that are optional (follow, endorse,
   * comment) don't penalise drop-off against later stages.
   *
   * The funnel supports optional breakdown by workflow / agent / account when
   * the corresponding filter is set.
   *
   * @param {object} filters
   * @returns {{ filters: object, stages: Array, dropOff: Array }}
   */
  getFunnelAnalytics(filters = {}) {
    const normalizedFilters = normalizeFilters(filters);
    const events = this.getEvents(normalizedFilters);

    // Ordered funnel stages — each maps to an event type
    const FUNNEL_STAGES = [
      { key: 'profile_viewed',        label: 'Profile Viewed' },
      { key: 'profile_followed',      label: 'Profile Followed' },
      { key: 'skill_endorsed',        label: 'Skill Endorsed' },
      { key: 'post_commented',        label: 'Post Commented' },
      { key: 'connection_requested',  label: 'Connection Requested' },
      { key: 'connection_accepted',   label: 'Connection Accepted' },
      { key: 'dm_sent',              label: 'DM Sent' },
      { key: 'dm_reply_received',    label: 'DM Reply Received' }
    ];

    // Collect unique profileUrls per stage
    const stageProfiles = new Map();
    for (const stage of FUNNEL_STAGES) {
      stageProfiles.set(stage.key, new Set());
    }

    for (const event of events) {
      const profileKey = event.profileUrl || event.prospectId || event.targetValue || null;
      if (!profileKey) continue;
      const stageSet = stageProfiles.get(event.type);
      if (stageSet) {
        stageSet.add(profileKey);
      }
    }

    const stages = FUNNEL_STAGES.map((stage) => ({
      stage: stage.key,
      label: stage.label,
      count: stageProfiles.get(stage.key).size
    }));

    // Drop-off pairs: primary causal chain (view → connect → accept → dm → reply)
    const DROP_OFF_PAIRS = [
      ['profile_viewed', 'connection_requested'],
      ['connection_requested', 'connection_accepted'],
      ['connection_accepted', 'dm_sent'],
      ['dm_sent', 'dm_reply_received']
    ];

    const dropOff = DROP_OFF_PAIRS.map(([from, to]) => {
      const fromCount = stageProfiles.get(from).size;
      const toCount = stageProfiles.get(to).size;
      const rate = fromCount > 0
        ? Math.round(((fromCount - toCount) / fromCount) * 100)
        : 0;
      return {
        from,
        to,
        fromCount,
        toCount,
        dropOffCount: Math.max(0, fromCount - toCount),
        dropOffRate: rate,
        conversionRate: fromCount > 0 ? Math.round((toCount / fromCount) * 100) : 0
      };
    });

    return { filters: normalizedFilters, stages, dropOff };
  }

  /**
   * Group outreach outcomes by variant key for attribution.
   *
   * Attribution model:
   *   For each outcome event (dm_reply_received, connection_accepted), find
   *   the most recent prior outreach event for the same profile that:
   *     - has a variantKey in metadata
   *     - occurred before the outcome's timestamp
   *     - is channel-compatible:
   *       • dm_reply_received  → only dm_sent outreach (not post_commented)
   *       • connection_accepted → dm_sent OR post_commented (either channel
   *         could have preceded a connection)
   *   If no eligible prior outreach exists, the outcome is unattributed.
   *
   * @param {object} filters
   * @returns {{ filters: object, variants: Array }}
   */
  getVariantPerformance(filters = {}) {
    const normalizedFilters = normalizeFilters(filters);
    const events = this.getEvents(normalizedFilters);

    // Build per-profile outreach timeline (oldest-first for binary search).
    // Each entry: { variantKey, timestamp, channel: 'dm'|'comment' }
    const profileOutreach = new Map();
    // variantKey → { sends, replies, acceptances, type }
    const variantStats = new Map();

    // Events arrive newest-first. Collect outreach events.
    for (const event of events) {
      const variantKey = event.metadata?.variantKey;
      if (!variantKey) continue;
      const profileKey = event.profileUrl || event.prospectId || null;
      if (!profileKey) continue;

      if (event.type === 'dm_sent' || event.type === 'post_commented') {
        const channel = event.type === 'dm_sent' ? 'dm' : 'comment';
        if (!profileOutreach.has(profileKey)) {
          profileOutreach.set(profileKey, []);
        }
        profileOutreach.get(profileKey).push({
          variantKey,
          timestamp: new Date(event.timestamp).getTime(),
          channel
        });

        if (!variantStats.has(variantKey)) {
          variantStats.set(variantKey, {
            variantKey,
            sends: 0,
            replies: 0,
            acceptances: 0,
            type: channel
          });
        }
        variantStats.get(variantKey).sends += 1;
      }
    }

    // Sort each profile's outreach timeline oldest→newest for lookup.
    for (const timeline of profileOutreach.values()) {
      timeline.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Attribute outcome events.
    for (const event of events) {
      const profileKey = event.profileUrl || event.prospectId || null;
      if (!profileKey) continue;
      const timeline = profileOutreach.get(profileKey);
      if (!timeline || timeline.length === 0) continue;

      const outcomeTs = new Date(event.timestamp).getTime();

      if (event.type === 'dm_reply_received') {
        // Only attribute to DM outreach
        const match = findMostRecentPriorOutreach(timeline, outcomeTs, 'dm');
        if (match && variantStats.has(match.variantKey)) {
          variantStats.get(match.variantKey).replies += 1;
        }
      } else if (event.type === 'connection_accepted') {
        // Attribute to either DM or comment outreach (either could precede a connection)
        const match = findMostRecentPriorOutreach(timeline, outcomeTs, null);
        if (match && variantStats.has(match.variantKey)) {
          variantStats.get(match.variantKey).acceptances += 1;
        }
      }
    }

    const variants = Array.from(variantStats.values())
      .map((v) => ({
        ...v,
        replyRate: v.sends > 0 ? Math.round((v.replies / v.sends) * 100) : 0,
        acceptanceRate: v.sends > 0 ? Math.round((v.acceptances / v.sends) * 100) : 0
      }))
      .sort((a, b) => b.sends - a.sends);

    return { filters: normalizedFilters, variants };
  }

  /**
   * Compute time-to-reply statistics.
   *
   * For each `dm_reply_received` event, finds the most recent prior `dm_sent`
   * event for the same profile (strictly before the reply timestamp).
   * Replies with no attributable prior DM are excluded from the stats.
   *
   * @param {object} filters
   * @returns {{ filters: object, count: number, averageMs: number|null, medianMs: number|null, minMs: number|null, maxMs: number|null, averageHours: number|null, medianHours: number|null }}
   */
  getTimeToReply(filters = {}) {
    return computeTimingStats(
      this.getEvents(filters),
      'dm_reply_received',
      'dm_sent',
      filters
    );
  }

  /**
   * Compute time-to-accept statistics.
   *
   * For each `connection_accepted` event, finds the most recent prior
   * `connection_requested` event for the same profile.
   * Acceptances with no attributable prior request are excluded.
   *
   * @param {object} filters
   * @returns {{ filters: object, count: number, averageMs: number|null, medianMs: number|null, minMs: number|null, maxMs: number|null, averageHours: number|null, medianHours: number|null }}
   */
  getTimeToAccept(filters = {}) {
    return computeTimingStats(
      this.getEvents(filters),
      'connection_accepted',
      'connection_requested',
      filters
    );
  }

  /**
   * Compute per-week event counts over the filtered period.
   *
   * Buckets events by calendar week (Monday start, ISO-8601 week numbering).
   * Returns an array of week objects sorted oldest→newest.
   *
   * @param {object} filters
   * @returns {{ filters: object, weeks: Array<{ weekStart: string, weekLabel: string, counts: object }> }}
   */
  getWeeklyTrends(filters = {}) {
    const normalizedFilters = normalizeFilters(filters);
    const events = this.getEvents(normalizedFilters);

    const TREND_EVENT_TYPES = [
      'profile_viewed',
      'profile_followed',
      'profile_unfollowed',
      'skill_endorsed',
      'post_commented',
      'connection_requested',
      'connection_accepted',
      'dm_sent',
      'dm_reply_received'
    ];

    // Map weekStart ISO string → counts object
    const weekBuckets = new Map();

    for (const event of events) {
      if (!TREND_EVENT_TYPES.includes(event.type)) continue;
      const ts = new Date(event.timestamp);
      if (Number.isNaN(ts.getTime())) continue;

      const weekStart = getIsoWeekStart(ts);
      if (!weekBuckets.has(weekStart)) {
        weekBuckets.set(weekStart, createEmptyWeekCounts(TREND_EVENT_TYPES));
      }
      const counts = weekBuckets.get(weekStart);
      if (event.type in counts) {
        counts[event.type] += 1;
      }
    }

    const weeks = Array.from(weekBuckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekStart, counts]) => ({
        weekStart,
        weekLabel: formatWeekLabel(weekStart),
        counts
      }));

    return { filters: normalizedFilters, weeks };
  }

  getMergedEvents(filters) {
    const events = [];
    const seenEventIds = new Set();
    const seenLegacyKeys = new Set();

    for (const event of this.readEventLedger()) {
      if (!matchesFilters(event, filters)) continue;
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      seenLegacyKeys.add(buildDedupeKey(event));
      events.push(event);
    }

    for (const event of this.readLegacyProfileEvents()) {
      if (!matchesFilters(event, filters)) continue;
      const key = buildDedupeKey(event);
      if (seenLegacyKeys.has(key)) continue;
      seenLegacyKeys.add(key);
      events.push(event);
    }

    return events;
  }

  readEventLedger() {
    // SQLite path: return rows directly (already normalised by the repo).
    if (this._eventRepo) {
      return this._eventRepo.findAll().map((event) => normalizeEvent(event, 'event-ledger'));
    }

    if (!fs.existsSync(this.eventsPath)) return [];
    const raw = fs.readFileSync(this.eventsPath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean)
      .map((event) => normalizeEvent(event, 'event-ledger'));
  }

  readLegacyProfileEvents() {
    if (!fs.existsSync(this.profilesPath)) return [];
    try {
      const profiles = JSON.parse(fs.readFileSync(this.profilesPath, 'utf8'));
      if (!Array.isArray(profiles)) return [];

      return profiles.flatMap((profile) => {
        const profileUrl = profile.originalUrl || profile.linkedInUrl || profile.url || null;
        const targetValue = profile.fullName || `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || profileUrl || 'LinkedIn Profile';
        return Array.isArray(profile.actions)
          ? profile.actions
              .map((action) => {
                const mappedType = LEGACY_ACTION_TO_EVENT[action?.type];
                if (!mappedType) return null;
                return normalizeEvent({
                  type: mappedType,
                  timestamp: action.timestamp,
                  accountId: profile.accountId || null,
                  accountName: profile.accountName || null,
                  profileUrl,
                  targetValue,
                  metadata: {
                    sourceAction: action.type,
                    notes: action.notes || '',
                    searchQuery: action.searchQuery || null
                  }
                }, 'legacy-profile');
              })
              .filter(Boolean)
          : [];
      });
    } catch (error) {
      console.warn('Failed to read legacy profile analytics:', error.message);
      return [];
    }
  }
}

function normalizeFilters(filters = {}) {
  return {
    accountId: cleanString(filters.accountId, 120) || null,
    agentId: cleanString(filters.agentId, 120) || null,
    workflowId: cleanString(filters.workflowId, 160) || null,
    since: cleanString(filters.since, 80) || null,
    until: cleanString(filters.until, 80) || null,
    activityLimit: Math.max(1, Number(filters.activityLimit) || 12)
  };
}

function matchesFilters(event, filters) {
  if (filters.accountId && event.accountId !== filters.accountId) return false;
  if (filters.agentId && event.agentId !== filters.agentId) return false;
  if (filters.workflowId && event.workflowId !== filters.workflowId) return false;

  const timestamp = new Date(event.timestamp).getTime();
  if (filters.since && timestamp < new Date(filters.since).getTime()) return false;
  if (filters.until && timestamp > new Date(filters.until).getTime()) return false;
  return true;
}

function normalizeEvent(event = {}, source = 'event-ledger') {
  return {
    id: cleanString(event.id, 160) || `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: cleanString(event.type, 80),
    timestamp: cleanString(event.timestamp, 80) || new Date().toISOString(),
    accountId: cleanString(event.accountId, 120) || null,
    accountName: cleanString(event.accountName, 160) || null,
    agentId: cleanString(event.agentId, 120) || null,
    agentName: cleanString(event.agentName, 160) || null,
    workflowId: cleanString(event.workflowId, 160) || null,
    workflowName: cleanString(event.workflowName, 160) || null,
    runId: cleanString(event.runId, 160) || null,
    correlationId: cleanString(event.correlationId || event.metadata?.correlationId, 160) || null,
    rootCorrelationId:
      cleanString(event.rootCorrelationId || event.metadata?.rootCorrelationId, 160)
      || cleanString(event.correlationId || event.metadata?.correlationId, 160)
      || null,
    prospectId: cleanString(event.prospectId, 160) || null,
    targetValue: cleanString(event.targetValue, 300) || null,
    profileUrl: cleanString(event.profileUrl, 400) || null,
    status: cleanString(event.status, 40) || 'ok',
    metadata: event.metadata && typeof event.metadata === 'object' ? { ...event.metadata } : {},
    source
  };
}

function buildDedupeKey(event) {
  const bucket = Math.floor(new Date(event.timestamp).getTime() / 10000);
  return [
    event.type,
    event.profileUrl || event.targetValue || '',
    event.workflowId || '',
    bucket
  ].join('|');
}

function incrementTotals(totals, type) {
  switch (type) {
    case 'profile_viewed':
      totals.profilesViewed += 1;
      break;
    case 'post_liked':
      totals.postLikes += 1;
      break;
    case 'connection_requested':
      totals.connectionRequests += 1;
      break;
    case 'connection_accepted':
      totals.connectionAcceptances += 1;
      break;
    case 'dm_sent':
      totals.dmsSent += 1;
      break;
    case 'dm_reply_received':
      totals.dmReplies += 1;
      break;
    case 'post_published':
      totals.postsPublished += 1;
      break;
    case 'workflow_started':
      totals.workflowStarted += 1;
      break;
    case 'workflow_completed':
      totals.workflowCompleted += 1;
      break;
    case 'workflow_failed':
      totals.workflowFailed += 1;
      break;
    default:
      break;
  }
}

function incrementSummary(collection, key, event, kind) {
  const safeKey = key || `__${kind}__`;
  const current = collection.get(safeKey) || {
    id: safeKey,
    label: event[`${kind}Name`] || event.accountName || 'Unassigned',
    totalEvents: 0,
    replies: 0,
    dmsSent: 0,
    connections: 0,
    acceptances: 0,
    views: 0,
    failures: 0
  };

  current.totalEvents += 1;
  if (event.type === 'dm_reply_received') current.replies += 1;
  if (event.type === 'dm_sent') current.dmsSent += 1;
  if (event.type === 'connection_requested') current.connections += 1;
  if (event.type === 'connection_accepted') current.acceptances += 1;
  if (event.type === 'profile_viewed') current.views += 1;
  if (event.type === 'workflow_failed') current.failures += 1;

  collection.set(safeKey, current);
}

function toActivityFeedItem(event) {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    profileId: event.profileUrl || null,
    profileUrl: event.profileUrl || null,
    name: event.metadata?.senderName || event.targetValue || event.metadata?.recipientName || event.accountName || 'LinkedIn activity',
    title: event.workflowName || event.accountName || event.metadata?.reason || '',
    status: event.status,
    workflowId: event.workflowId || null,
    workflowName: event.workflowName || null,
    agentId: event.agentId || null,
    agentName: event.agentName || null,
    metadata: event.metadata || {}
  };
}

function buildAccountHealthSummary(accountId, context = {}) {
  const accountRecord = context.accountRecords?.get(accountId) || null;
  const accountHealth = context.accountHealthState?.accounts?.[accountId] || null;
  const accountEmail = accountRecord?.email || null;
  const accountName = accountRecord?.name || accountHealth?.accountName || accountEmail || accountId;
  const challengeCount = accountHealth?.challenged ? 1 : 0;
  const cooldownCount = Number(accountHealth?.workflow?.status === 'cooldown')
    + Number(accountHealth?.replyMonitor?.status === 'cooldown');
  const transportDisableCount = countDisabledTransportEntries(context.transportHealthState, accountEmail);
  const accountLogs = Array.isArray(context.runtimeLogs)
    ? context.runtimeLogs.filter((entry) => entry.accountId === accountId)
    : [];
  const verificationSignals = collectVerificationSignals(accountLogs, context.sessionRegistry, accountEmail);
  const canarySignals = collectCanarySignals(accountLogs);

  return {
    accountId,
    accountName,
    accountEmail,
    challengeCount,
    cooldownCount,
    transportDisableCount,
    verificationFailureRate: calculateFailureRate(
      verificationSignals.failureCount,
      verificationSignals.successCount
    ),
    verificationFailureCount: verificationSignals.failureCount,
    verificationSignalCount: verificationSignals.successCount + verificationSignals.failureCount,
    canaryFailureRate: calculateFailureRate(
      canarySignals.failureCount,
      canarySignals.successCount
    ),
    canaryFailureCount: canarySignals.failureCount,
    canarySignalCount: canarySignals.successCount + canarySignals.failureCount
  };
}

function collectAccountIds({ accountHealthState, transportHealthState, runtimeLogs, accountRecords }) {
  const accountIds = new Set();

  Object.keys(accountHealthState?.accounts || {}).forEach((accountId) => accountIds.add(accountId));
  for (const record of (accountRecords || new Map()).values()) {
    if (record?.accountId) {
      accountIds.add(record.accountId);
    }
  }

  Object.values(transportHealthState?.entries || {}).forEach((entry) => {
    if (entry?.accountEmail) {
      const mapped = findAccountIdByEmail(accountRecords, entry.accountEmail);
      if (mapped) {
        accountIds.add(mapped);
      }
    }
  });

  (runtimeLogs || []).forEach((entry) => {
    if (entry?.accountId) {
      accountIds.add(entry.accountId);
    }
  });

  return Array.from(accountIds);
}

function readLinkedInAccountsById(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return new Map();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const accounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
    return accounts.reduce((map, account) => {
      const accountId = cleanString(account?.id, 120);
      if (!accountId) {
        return map;
      }
      map.set(accountId, {
        accountId,
        name: cleanString(account?.name, 160) || null,
        email: cleanString(account?.email, 240).toLowerCase() || null
      });
      return map;
    }, new Map());
  } catch (_) {
    return new Map();
  }
}

function findAccountIdByEmail(accountRecords, email) {
  const normalizedEmail = cleanString(email, 240).toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  for (const [accountId, record] of accountRecords || new Map()) {
    if (record?.email && record.email === normalizedEmail) {
      return accountId;
    }
  }

  return null;
}

function countDisabledTransportEntries(transportHealthState, accountEmail) {
  const normalizedEmail = cleanString(accountEmail, 240).toLowerCase();
  if (!normalizedEmail) {
    return 0;
  }

  return Object.values(transportHealthState?.entries || {}).filter((entry) => (
    entry?.accountEmail === normalizedEmail && entry.disabled === true
  )).length;
}

function collectVerificationSignals(accountLogs, sessionRegistry, accountEmail) {
  let successCount = 0;
  let failureCount = 0;

  if (accountEmail) {
    const sessionRecord = sessionRegistry?.getAccount(accountEmail) || null;
    if (sessionRecord) {
      if (sessionRecord.lastVerifiedAt) {
        successCount += 1;
      }

      if (sessionRecord.lastAuthFailureAt || sessionRecord.lastChallengeAt) {
        const verifiedAt = parseOptionalTimestamp(sessionRecord.lastVerifiedAt);
        const authFailureAt = parseOptionalTimestamp(sessionRecord.lastAuthFailureAt);
        const challengeAt = parseOptionalTimestamp(sessionRecord.lastChallengeAt);
        const latestFailureAt = maxTimestamp(authFailureAt, challengeAt);

        if (!verifiedAt || (latestFailureAt && latestFailureAt > verifiedAt)) {
          failureCount += 1;
        }
      }
    }
  }

  for (const entry of accountLogs || []) {
    if (entry?.source !== 'workflow-worker') {
      continue;
    }

    if (/session verification failed|could not be verified/i.test(String(entry.message || ''))) {
      failureCount += 1;
    }
  }

  return { successCount, failureCount };
}

function collectCanarySignals(accountLogs) {
  let successCount = 0;
  let failureCount = 0;

  for (const entry of accountLogs || []) {
    const source = String(entry?.source || '').trim();
    if (source !== 'private-api-canary' && source !== 'selector-canary') {
      continue;
    }

    const message = String(entry?.message || '');
    if (/failed/i.test(message)) {
      failureCount += 1;
      continue;
    }

    if (/passed|matched/i.test(message)) {
      successCount += 1;
    }
  }

  return { successCount, failureCount };
}

function calculateFailureRate(failureCount, successCount) {
  const failures = Math.max(0, Number(failureCount) || 0);
  const successes = Math.max(0, Number(successCount) || 0);
  const total = failures + successes;
  if (total <= 0) {
    return 0;
  }
  return Math.round((failures / total) * 100);
}

function parseOptionalTimestamp(value) {
  const parsed = new Date(String(value || '').trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function maxTimestamp(left, right) {
  const values = [left, right].filter((value) => Number.isFinite(value));
  if (!values.length) {
    return null;
  }
  return Math.max(...values);
}

/**
 * Find the most recent outreach entry in a sorted (oldest→newest) timeline
 * that occurred strictly before `outcomeTs`.
 *
 * @param {Array<{variantKey: string, timestamp: number, channel: string}>} timeline
 *   Sorted oldest-first.
 * @param {number} outcomeTs - Outcome event timestamp in ms.
 * @param {string|null} channelFilter - 'dm', 'comment', or null for any channel.
 * @returns {{ variantKey: string, timestamp: number, channel: string } | null}
 */
function findMostRecentPriorOutreach(timeline, outcomeTs, channelFilter) {
  let best = null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry.timestamp >= outcomeTs) continue;
    if (channelFilter && entry.channel !== channelFilter) continue;
    best = entry;
    break;  // timeline is oldest→newest, walking backwards finds most recent first
  }
  return best;
}

// ---------------------------------------------------------------------------
// Timing stats helper
// ---------------------------------------------------------------------------

/**
 * Compute timing statistics between an outcome event type and a prior cause
 * event type, using per-profile timelines for attribution.
 *
 * @param {Array} events - sorted newest-first from getEvents()
 * @param {string} outcomeType - e.g. 'dm_reply_received'
 * @param {string} causeType - e.g. 'dm_sent'
 * @param {object} filters
 * @returns {{ filters: object, count: number, averageMs, medianMs, minMs, maxMs, averageHours, medianHours }}
 */
function computeTimingStats(events, outcomeType, causeType, filters = {}) {
  const normalizedFilters = normalizeFilters(filters);

  // Build per-profile cause timeline (oldest→newest)
  const profileCauses = new Map();
  for (const event of events) {
    if (event.type !== causeType) continue;
    const profileKey = event.profileUrl || event.prospectId || null;
    if (!profileKey) continue;
    const ts = new Date(event.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    if (!profileCauses.has(profileKey)) {
      profileCauses.set(profileKey, []);
    }
    profileCauses.get(profileKey).push(ts);
  }

  // Sort each timeline oldest→newest
  for (const timeline of profileCauses.values()) {
    timeline.sort((a, b) => a - b);
  }

  // Compute deltas for each outcome
  const deltas = [];
  for (const event of events) {
    if (event.type !== outcomeType) continue;
    const profileKey = event.profileUrl || event.prospectId || null;
    if (!profileKey) continue;
    const outcomeTs = new Date(event.timestamp).getTime();
    if (Number.isNaN(outcomeTs)) continue;

    const timeline = profileCauses.get(profileKey);
    if (!timeline || timeline.length === 0) continue;

    // Find most recent cause strictly before the outcome
    const causeTs = findMostRecentPriorTimestamp(timeline, outcomeTs);
    if (causeTs === null) continue;

    const delta = outcomeTs - causeTs;
    if (delta > 0) {
      deltas.push(delta);
    }
  }

  if (deltas.length === 0) {
    return {
      filters: normalizedFilters,
      count: 0,
      averageMs: null,
      medianMs: null,
      minMs: null,
      maxMs: null,
      averageHours: null,
      medianHours: null
    };
  }

  deltas.sort((a, b) => a - b);
  const sum = deltas.reduce((s, d) => s + d, 0);
  const avg = Math.round(sum / deltas.length);
  const med = computeMedian(deltas);
  const min = deltas[0];
  const max = deltas[deltas.length - 1];

  return {
    filters: normalizedFilters,
    count: deltas.length,
    averageMs: avg,
    medianMs: med,
    minMs: min,
    maxMs: max,
    averageHours: msToHours(avg),
    medianHours: msToHours(med)
  };
}

/**
 * Find the most recent timestamp in a sorted (oldest→newest) array that is
 * strictly less than `targetTs`.
 */
function findMostRecentPriorTimestamp(sortedTimestamps, targetTs) {
  let best = null;
  for (let i = sortedTimestamps.length - 1; i >= 0; i--) {
    if (sortedTimestamps[i] < targetTs) {
      best = sortedTimestamps[i];
      break;
    }
  }
  return best;
}

/**
 * Compute the median of a sorted array of numbers.
 * For even-length arrays, returns the average of the two middle values (rounded).
 */
function computeMedian(sortedValues) {
  const n = sortedValues.length;
  if (n === 0) return null;
  if (n === 1) return sortedValues[0];
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedValues[mid];
  return Math.round((sortedValues[mid - 1] + sortedValues[mid]) / 2);
}

function msToHours(ms) {
  if (ms === null || ms === undefined) return null;
  return Math.round((ms / (1000 * 60 * 60)) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Weekly trends helpers
// ---------------------------------------------------------------------------

/**
 * Get the Monday 00:00:00 UTC of the ISO week containing `date`.
 * Returns an ISO date string (YYYY-MM-DD).
 */
function getIsoWeekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  // ISO weeks start on Monday (day 1).  Sunday (day 0) belongs to the prior week.
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function formatWeekLabel(weekStartIso) {
  const d = new Date(weekStartIso + 'T00:00:00Z');
  const end = new Date(d);
  end.setUTCDate(end.getUTCDate() + 6);
  const fmt = (dt) => `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
  return `${fmt(d)}–${fmt(end)}`;
}

function createEmptyWeekCounts(eventTypes) {
  const counts = {};
  for (const type of eventTypes) {
    counts[type] = 0;
  }
  return counts;
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = ActivityAnalyticsService;
