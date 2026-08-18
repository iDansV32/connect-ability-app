const {
  createId,
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');

const STORE_VERSION = 1;
const CAMPAIGN_RUN_STATUSES = new Set([
  'queued',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'suppressed',
  'quarantined'
]);
const CAMPAIGN_CHANNEL_TYPES = new Set(['linkedin', 'apollo', 'multi']);
const APOLLO_HOLD_CAUSES = new Set(['unreachable', 'freshness_unknown']);
const TERMINAL_CAMPAIGN_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'suppressed', 'quarantined']);
const APOLLO_HOLD_WAIT_REASON = 'apollo_hold';
const APOLLO_HOLD_MAX_ATTEMPTS = 5;
const APOLLO_HOLD_MAX_RETRIES_EXCEEDED_REASON = 'apollo_hold_max_retries_exceeded';

class CampaignRunManager {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.storePath = options.storePath || resolveInternalStatePath('campaign-runs.json');
  }

  getAllRuns() {
    const store = this.readStore();
    return store.runs
      .map((run) => normalizeCampaignRun(run))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  getRun(campaignRunId) {
    const normalizedCampaignRunId = cleanString(campaignRunId, 160);
    if (!normalizedCampaignRunId) {
      return null;
    }
    return this.getAllRuns().find((run) => run.id === normalizedCampaignRunId) || null;
  }

  createRun(runInput = {}) {
    const store = this.readStore();
    const now = new Date().toISOString();
    const normalizedRun = normalizeCampaignRunForCreate(runInput, now);
    store.runs.unshift(normalizedRun);
    writeJsonFileAtomic(this.storePath, store);
    return normalizedRun;
  }

  updateRun(campaignRunId, updates = {}) {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      ...sanitizeCampaignRunUpdates(updates, currentRun, now)
    }));
  }

  attachChildRun(campaignRunId, childRunId) {
    const normalizedChildRunId = cleanString(childRunId, 160);
    if (!normalizedChildRunId) {
      return null;
    }

    return this.mutateRun(campaignRunId, (currentRun) => ({
      ...currentRun,
      childRunIds: Array.from(new Set([
        ...currentRun.childRunIds,
        normalizedChildRunId
      ]))
    }));
  }

  recordApolloEnrollment(campaignRunId, enrollment = {}) {
    return this.mutateRun(campaignRunId, (currentRun, now) => {
      const nextContactId = cleanString(enrollment.apolloContactId, 160) || null;
      const nextSequenceId = cleanString(enrollment.apolloSequenceId, 160) || null;
      const nextSequenceContactId = cleanString(enrollment.apolloSequenceContactId, 160) || null;
      const nextEnrolledAt = normalizeTimestamp(enrollment.apolloEnrolledAt || enrollment.enrolledAt) || now;
      const nextStatus = cleanString(enrollment.apolloEnrollmentStatus || enrollment.status, 120) || 'active';

      if (currentRun.apolloSequenceId && nextSequenceId && currentRun.apolloSequenceId !== nextSequenceId) {
        throw new Error('Campaign run already has a different Apollo sequence id recorded');
      }
      if (
        currentRun.apolloSequenceContactId
        && nextSequenceContactId
        && currentRun.apolloSequenceContactId !== nextSequenceContactId
      ) {
        throw new Error('Campaign run already has a different Apollo sequence-contact id recorded');
      }

      return {
        ...currentRun,
        apolloContactId: currentRun.apolloContactId || nextContactId,
        apolloSequenceId: currentRun.apolloSequenceId || nextSequenceId,
        apolloSequenceContactId: currentRun.apolloSequenceContactId || nextSequenceContactId,
        apolloEnrollmentStatus: nextStatus,
        apolloEnrolledAt: currentRun.apolloEnrolledAt || nextEnrolledAt,
        updatedAt: now
      };
    });
  }

  updateApolloEnrollmentStatus(campaignRunId, statusUpdate = {}) {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      apolloEnrollmentStatus: cleanString(statusUpdate.status || statusUpdate.apolloEnrollmentStatus, 120) || currentRun.apolloEnrollmentStatus || null,
      apolloLastPolledAt: normalizeTimestamp(statusUpdate.lastPolledAt || statusUpdate.apolloLastPolledAt) || now,
      updatedAt: now
    }));
  }

  markWaiting(campaignRunId, waitReason) {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      status: 'waiting',
      waitReason: cleanString(waitReason, 160) || null,
      holdCause: null,
      holdAttempts: 0,
      holdLastAttemptAt: null,
      updatedAt: now
    }));
  }

  markApolloHold(campaignRunId, holdCause = 'unreachable', options = {}) {
    const normalizedHoldCause = normalizeApolloHoldCause(holdCause) || 'unreachable';
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || APOLLO_HOLD_MAX_ATTEMPTS);
    const childRuns = Array.isArray(options.childRuns) ? options.childRuns.filter(Boolean) : null;

    return this.mutateRun(campaignRunId, (currentRun, now) => {
      if (TERMINAL_CAMPAIGN_RUN_STATUSES.has(currentRun.status)) {
        return currentRun;
      }
      if (!canApplyApolloHold(currentRun, childRuns)) {
        return currentRun;
      }

      const alreadyHolding = currentRun.status === 'waiting' && currentRun.waitReason === APOLLO_HOLD_WAIT_REASON;
      const nextAttempts = alreadyHolding
        ? Math.max(0, Number(currentRun.holdAttempts) || 0) + 1
        : 1;

      if (nextAttempts >= maxAttempts) {
        return {
          ...currentRun,
          status: 'failed',
          terminalReason: APOLLO_HOLD_MAX_RETRIES_EXCEEDED_REASON,
          completedAt: currentRun.completedAt || now,
          waitReason: null,
          pauseReason: null,
          holdCause: normalizedHoldCause,
          holdAttempts: nextAttempts,
          holdLastAttemptAt: now,
          updatedAt: now
        };
      }

      return {
        ...currentRun,
        status: 'waiting',
        waitReason: APOLLO_HOLD_WAIT_REASON,
        pauseReason: null,
        terminalReason: null,
        completedAt: null,
        holdCause: normalizedHoldCause,
        holdAttempts: nextAttempts,
        holdLastAttemptAt: now,
        updatedAt: now
      };
    });
  }

  clearApolloHold(campaignRunId) {
    return this.mutateRun(campaignRunId, (currentRun, now) => {
      const hasApolloHold = currentRun.waitReason === APOLLO_HOLD_WAIT_REASON
        || currentRun.terminalReason === APOLLO_HOLD_MAX_RETRIES_EXCEEDED_REASON;
      if (!hasApolloHold) {
        return currentRun;
      }

      return {
        ...currentRun,
        status: 'queued',
        waitReason: null,
        pauseReason: null,
        terminalReason: null,
        completedAt: null,
        holdCause: null,
        holdAttempts: 0,
        holdLastAttemptAt: null,
        updatedAt: now
      };
    });
  }

  pauseRun(campaignRunId, reason = 'Paused') {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      status: 'paused',
      pauseReason: cleanString(reason, 600) || 'Paused',
      waitReason: null,
      holdCause: null,
      holdAttempts: 0,
      holdLastAttemptAt: null,
      updatedAt: now
    }));
  }

  resumeRun(campaignRunId) {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      status: currentRun.waitReason ? 'waiting' : 'queued',
      pauseReason: null,
      updatedAt: now
    }));
  }

  suppressRun(campaignRunId, reason) {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      status: 'suppressed',
      suppressedAt: currentRun.suppressedAt || now,
      suppressReason: cleanString(reason, 600) || 'suppressed',
      terminalReason: cleanString(reason, 600) || 'suppressed',
      waitReason: null,
      pauseReason: null,
      holdCause: null,
      holdAttempts: 0,
      holdLastAttemptAt: null,
      updatedAt: now
    }));
  }

  quarantineRun(campaignRunId, reason) {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      status: 'quarantined',
      quarantinedAt: currentRun.quarantinedAt || now,
      quarantineReason: cleanString(reason, 600) || 'quarantined',
      terminalReason: cleanString(reason, 600) || 'quarantined',
      waitReason: null,
      pauseReason: null,
      holdCause: null,
      holdAttempts: 0,
      holdLastAttemptAt: null,
      updatedAt: now
    }));
  }

  completeRun(campaignRunId) {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      status: 'completed',
      completedAt: currentRun.completedAt || now,
      waitReason: null,
      pauseReason: null,
      holdCause: null,
      holdAttempts: 0,
      holdLastAttemptAt: null,
      updatedAt: now
    }));
  }

  failRun(campaignRunId, reason = 'Failed') {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      status: 'failed',
      terminalReason: cleanString(reason, 600) || 'Failed',
      completedAt: currentRun.completedAt || now,
      waitReason: null,
      pauseReason: null,
      holdCause: null,
      holdAttempts: 0,
      holdLastAttemptAt: null,
      updatedAt: now
    }));
  }

  cancelRun(campaignRunId, reason = 'Cancelled') {
    return this.mutateRun(campaignRunId, (currentRun, now) => ({
      ...currentRun,
      status: 'cancelled',
      terminalReason: cleanString(reason, 600) || 'Cancelled',
      completedAt: currentRun.completedAt || now,
      waitReason: null,
      pauseReason: null,
      holdCause: null,
      holdAttempts: 0,
      holdLastAttemptAt: null,
      updatedAt: now
    }));
  }

  readStore() {
    const fallback = {
      version: STORE_VERSION,
      runs: []
    };
    const store = readJsonFile(this.storePath, fallback);
    return {
      version: Number(store.version) || STORE_VERSION,
      runs: Array.isArray(store.runs) ? store.runs : []
    };
  }

  mutateRun(campaignRunId, mutator) {
    const normalizedCampaignRunId = cleanString(campaignRunId, 160);
    if (!normalizedCampaignRunId || typeof mutator !== 'function') {
      return null;
    }

    const store = this.readStore();
    const runIndex = store.runs.findIndex((run) => cleanString(run?.id, 160) === normalizedCampaignRunId);
    if (runIndex === -1) {
      return null;
    }

    const now = new Date().toISOString();
    const currentRun = normalizeCampaignRun(store.runs[runIndex]);
    const nextRun = normalizeCampaignRun(mutator(currentRun, now));
    nextRun.updatedAt = now;
    store.runs[runIndex] = nextRun;
    writeJsonFileAtomic(this.storePath, store);
    return nextRun;
  }
}

function normalizeCampaignRunForCreate(runInput = {}, now = new Date().toISOString()) {
  const metadata = normalizeMetadata(runInput.metadata);
  return {
    id: cleanString(runInput.id, 160) || createId('campaign_run'),
    campaignTemplateId: cleanString(runInput.campaignTemplateId, 160) || null,
    campaignTemplateName: cleanString(runInput.campaignTemplateName, 160) || 'Campaign Run',
    status: normalizeStatus(runInput.status) || 'queued',
    channelType: normalizeChannelType(runInput.channelType) || 'multi',
    childRunIds: normalizeStringList(runInput.childRunIds, 200, 160),
    accountId: cleanString(runInput.accountId, 120) || null,
    accountName: cleanString(runInput.accountName, 160) || null,
    agentId: cleanString(runInput.agentId, 120) || null,
    agentName: cleanString(runInput.agentName, 160) || null,
    prospectId: cleanString(runInput.prospectId, 160) || null,
    prospectLabel: cleanString(runInput.prospectLabel, 240) || null,
    apolloContactId: cleanString(runInput.apolloContactId, 160) || null,
    apolloSequenceId: cleanString(runInput.apolloSequenceId, 160) || null,
    apolloSequenceContactId: cleanString(runInput.apolloSequenceContactId, 160) || null,
    apolloEnrollmentStatus: cleanString(runInput.apolloEnrollmentStatus, 120) || null,
    apolloEnrolledAt: normalizeTimestamp(runInput.apolloEnrolledAt),
    apolloLastPolledAt: normalizeTimestamp(runInput.apolloLastPolledAt),
    enrolledAt: normalizeTimestamp(runInput.enrolledAt) || now,
    waitReason: cleanString(runInput.waitReason, 160) || null,
    holdCause: normalizeApolloHoldCause(runInput.holdCause),
    holdAttempts: normalizeHoldAttempts(runInput.holdAttempts),
    holdLastAttemptAt: normalizeTimestamp(runInput.holdLastAttemptAt),
    pauseReason: cleanString(runInput.pauseReason, 600) || null,
    terminalReason: cleanString(runInput.terminalReason, 600) || null,
    suppressedAt: normalizeTimestamp(runInput.suppressedAt),
    suppressReason: cleanString(runInput.suppressReason, 600) || null,
    quarantinedAt: normalizeTimestamp(runInput.quarantinedAt),
    quarantineReason: cleanString(runInput.quarantineReason, 600) || null,
    completedAt: normalizeTimestamp(runInput.completedAt),
    featureVersion: Math.max(1, Number(runInput.featureVersion) || 1),
    metadata,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeCampaignRun(run = {}) {
  const metadata = normalizeMetadata(run.metadata);
  return {
    id: cleanString(run.id, 160) || createId('campaign_run'),
    campaignTemplateId: cleanString(run.campaignTemplateId, 160) || null,
    campaignTemplateName: cleanString(run.campaignTemplateName, 160) || 'Campaign Run',
    status: normalizeStatus(run.status) || 'queued',
    channelType: normalizeChannelType(run.channelType) || 'multi',
    childRunIds: normalizeStringList(run.childRunIds, 200, 160),
    accountId: cleanString(run.accountId, 120) || null,
    accountName: cleanString(run.accountName, 160) || null,
    agentId: cleanString(run.agentId, 120) || null,
    agentName: cleanString(run.agentName, 160) || null,
    prospectId: cleanString(run.prospectId, 160) || null,
    prospectLabel: cleanString(run.prospectLabel, 240) || null,
    apolloContactId: cleanString(run.apolloContactId, 160) || null,
    apolloSequenceId: cleanString(run.apolloSequenceId, 160) || null,
    apolloSequenceContactId: cleanString(run.apolloSequenceContactId, 160) || null,
    apolloEnrollmentStatus: cleanString(run.apolloEnrollmentStatus, 120) || null,
    apolloEnrolledAt: normalizeTimestamp(run.apolloEnrolledAt),
    apolloLastPolledAt: normalizeTimestamp(run.apolloLastPolledAt),
    enrolledAt: normalizeTimestamp(run.enrolledAt),
    waitReason: cleanString(run.waitReason, 160) || null,
    holdCause: normalizeApolloHoldCause(run.holdCause),
    holdAttempts: normalizeHoldAttempts(run.holdAttempts),
    holdLastAttemptAt: normalizeTimestamp(run.holdLastAttemptAt),
    pauseReason: cleanString(run.pauseReason, 600) || null,
    terminalReason: cleanString(run.terminalReason, 600) || null,
    suppressedAt: normalizeTimestamp(run.suppressedAt),
    suppressReason: cleanString(run.suppressReason, 600) || null,
    quarantinedAt: normalizeTimestamp(run.quarantinedAt),
    quarantineReason: cleanString(run.quarantineReason, 600) || null,
    completedAt: normalizeTimestamp(run.completedAt),
    featureVersion: Math.max(1, Number(run.featureVersion) || 1),
    metadata,
    createdAt: normalizeTimestamp(run.createdAt) || new Date().toISOString(),
    updatedAt: normalizeTimestamp(run.updatedAt) || normalizeTimestamp(run.createdAt) || new Date().toISOString()
  };
}

function sanitizeCampaignRunUpdates(updates = {}, currentRun = {}, now = new Date().toISOString()) {
  const next = {};

  if ('campaignTemplateId' in updates) next.campaignTemplateId = cleanString(updates.campaignTemplateId, 160) || null;
  if ('campaignTemplateName' in updates) next.campaignTemplateName = cleanString(updates.campaignTemplateName, 160) || currentRun.campaignTemplateName;
  if ('status' in updates) next.status = normalizeStatus(updates.status) || currentRun.status;
  if ('channelType' in updates) next.channelType = normalizeChannelType(updates.channelType) || currentRun.channelType;
  if ('childRunIds' in updates) next.childRunIds = normalizeStringList(updates.childRunIds, 200, 160);
  if ('accountId' in updates) next.accountId = cleanString(updates.accountId, 120) || null;
  if ('accountName' in updates) next.accountName = cleanString(updates.accountName, 160) || null;
  if ('agentId' in updates) next.agentId = cleanString(updates.agentId, 120) || null;
  if ('agentName' in updates) next.agentName = cleanString(updates.agentName, 160) || null;
  if ('prospectId' in updates) next.prospectId = cleanString(updates.prospectId, 160) || null;
  if ('prospectLabel' in updates) next.prospectLabel = cleanString(updates.prospectLabel, 240) || null;
  if ('apolloContactId' in updates) next.apolloContactId = cleanString(updates.apolloContactId, 160) || null;
  if ('apolloSequenceId' in updates) next.apolloSequenceId = cleanString(updates.apolloSequenceId, 160) || null;
  if ('apolloSequenceContactId' in updates) next.apolloSequenceContactId = cleanString(updates.apolloSequenceContactId, 160) || null;
  if ('apolloEnrollmentStatus' in updates) next.apolloEnrollmentStatus = cleanString(updates.apolloEnrollmentStatus, 120) || null;
  if ('apolloEnrolledAt' in updates) next.apolloEnrolledAt = normalizeTimestamp(updates.apolloEnrolledAt);
  if ('apolloLastPolledAt' in updates) next.apolloLastPolledAt = normalizeTimestamp(updates.apolloLastPolledAt);
  if ('enrolledAt' in updates) next.enrolledAt = normalizeTimestamp(updates.enrolledAt) || currentRun.enrolledAt || now;
  if ('waitReason' in updates) next.waitReason = cleanString(updates.waitReason, 160) || null;
  if ('holdCause' in updates) next.holdCause = normalizeApolloHoldCause(updates.holdCause);
  if ('holdAttempts' in updates) next.holdAttempts = normalizeHoldAttempts(updates.holdAttempts);
  if ('holdLastAttemptAt' in updates) next.holdLastAttemptAt = normalizeTimestamp(updates.holdLastAttemptAt);
  if ('pauseReason' in updates) next.pauseReason = cleanString(updates.pauseReason, 600) || null;
  if ('terminalReason' in updates) next.terminalReason = cleanString(updates.terminalReason, 600) || null;
  if ('suppressedAt' in updates) next.suppressedAt = normalizeTimestamp(updates.suppressedAt);
  if ('suppressReason' in updates) next.suppressReason = cleanString(updates.suppressReason, 600) || null;
  if ('quarantinedAt' in updates) next.quarantinedAt = normalizeTimestamp(updates.quarantinedAt);
  if ('quarantineReason' in updates) next.quarantineReason = cleanString(updates.quarantineReason, 600) || null;
  if ('completedAt' in updates) next.completedAt = normalizeTimestamp(updates.completedAt);
  if ('featureVersion' in updates) next.featureVersion = Math.max(1, Number(updates.featureVersion) || currentRun.featureVersion || 1);
  if ('metadata' in updates) next.metadata = normalizeMetadata(updates.metadata, currentRun.metadata);

  return next;
}

function normalizeStatus(status) {
  const normalized = cleanString(status, 40).toLowerCase();
  return CAMPAIGN_RUN_STATUSES.has(normalized) ? normalized : null;
}

function normalizeChannelType(value) {
  const normalized = cleanString(value, 40).toLowerCase();
  return CAMPAIGN_CHANNEL_TYPES.has(normalized) ? normalized : null;
}

function normalizeApolloHoldCause(value) {
  const normalized = cleanString(value, 80).toLowerCase();
  return APOLLO_HOLD_CAUSES.has(normalized) ? normalized : null;
}

function normalizeHoldAttempts(value) {
  return Math.max(0, Number(value) || 0);
}

function normalizeStringList(value, maxItems, maxLength) {
  const items = Array.isArray(value) ? value : [];
  const seen = new Set();
  return items
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function normalizeMetadata(value, fallback = {}) {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? { ...candidate } : {};
}

function normalizeTimestamp(value) {
  const candidate = cleanString(value, 80);
  if (!candidate) {
    return null;
  }
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function canApplyApolloHold(currentRun = {}, childRuns = null) {
  const childRunIds = Array.isArray(currentRun.childRunIds)
    ? currentRun.childRunIds.filter(Boolean)
    : [];
  if (!childRunIds.length) {
    return true;
  }
  if (!Array.isArray(childRuns) || childRuns.length !== childRunIds.length) {
    return false;
  }
  return childRuns.every((childRun) => cleanString(childRun?.status, 40).toLowerCase() === 'queued');
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = CampaignRunManager;
