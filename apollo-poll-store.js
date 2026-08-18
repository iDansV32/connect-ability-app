'use strict';

const {
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');

const STORE_VERSION = 1;
const APOLLO_POLL_RECORD_STATUSES = new Set(['active', 'paused', 'completed', 'failed']);
const DEFAULT_APOLLO_POLL_MAX_POLLS = 72;
const DEFAULT_APOLLO_POLL_INTERVAL_MS = 30 * 60 * 1000;
const APOLLO_TERMINAL_SUCCESS_STATUSES = new Set(['finished', 'completed', 'complete', 'succeeded', 'sent']);
const APOLLO_TERMINAL_FAILURE_STATUSES = new Set(['failed', 'bounced', 'canceled', 'cancelled', 'stopped', 'unsubscribed']);

class ApolloPollStore {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.storePath = options.storePath || resolveInternalStatePath('apollo-polls.json');
  }

  getAllPollRecords() {
    const store = this.readStore();
    return store.polls
      .map((record) => normalizePollRecord(record))
      .sort((left, right) => new Date(left.nextPollAt || left.updatedAt).getTime() - new Date(right.nextPollAt || right.updatedAt).getTime());
  }

  listPollRecords(filters = {}) {
    const normalizedCampaignRunId = cleanString(filters.campaignRunId, 160) || null;
    const normalizedStatus = normalizePollStatus(filters.status);
    const limit = Math.max(0, Number(filters.limit) || 0);

    let records = this.getAllPollRecords();
    if (normalizedCampaignRunId) {
      records = records.filter((record) => record.campaignRunId === normalizedCampaignRunId);
    }
    if (normalizedStatus) {
      records = records.filter((record) => record.status === normalizedStatus);
    }
    return limit > 0 ? records.slice(0, limit) : records;
  }

  getPollRecord(campaignRunId) {
    const normalizedCampaignRunId = cleanString(campaignRunId, 160);
    if (!normalizedCampaignRunId) {
      return null;
    }
    return this.getAllPollRecords().find((record) => record.campaignRunId === normalizedCampaignRunId) || null;
  }

  createPollRecord(campaignRunId, input = {}) {
    const normalizedCampaignRunId = cleanString(campaignRunId || input.campaignRunId, 160);
    const normalizedSequenceContactId = cleanString(input.apolloSequenceContactId, 160);
    if (!normalizedCampaignRunId) {
      throw new Error('Apollo poll record requires campaignRunId');
    }
    if (!normalizedSequenceContactId) {
      throw new Error('Apollo poll record requires apolloSequenceContactId');
    }

    const existing = this.getPollRecord(normalizedCampaignRunId);
    if (!existing) {
      const store = this.readStore();
      const now = new Date().toISOString();
      const nextRecord = normalizePollRecordForCreate({
        campaignRunId: normalizedCampaignRunId,
        apolloSequenceContactId: normalizedSequenceContactId,
        status: input.status,
        nextPollAt: input.nextPollAt,
        pollCount: input.pollCount,
        maxPolls: input.maxPolls,
        pollIntervalMs: input.pollIntervalMs,
        lastPollResult: input.lastPollResult,
        lastPollAt: input.lastPollAt
      }, now);
      store.polls.unshift(nextRecord);
      writeJsonFileAtomic(this.storePath, store);
      return nextRecord;
    }

    if (
      existing.apolloSequenceContactId
      && normalizedSequenceContactId
      && existing.apolloSequenceContactId !== normalizedSequenceContactId
    ) {
      throw new Error('Apollo poll record already exists with a different sequence-contact id');
    }

    return this.mutatePollRecord(normalizedCampaignRunId, (currentRecord, now) => ({
      ...currentRecord,
      apolloSequenceContactId: currentRecord.apolloSequenceContactId || normalizedSequenceContactId,
      maxPolls: currentRecord.maxPolls || normalizePositiveInteger(input.maxPolls, DEFAULT_APOLLO_POLL_MAX_POLLS),
      pollIntervalMs: currentRecord.pollIntervalMs || normalizePositiveInteger(input.pollIntervalMs, DEFAULT_APOLLO_POLL_INTERVAL_MS),
      nextPollAt: currentRecord.nextPollAt || normalizeTimestamp(input.nextPollAt) || now
    }));
  }

  listDuePollRecords(options = {}) {
    const before = normalizeTimestamp(options.before) || new Date().toISOString();
    const limit = Math.max(1, Number(options.limit) || 10);
    const beforeTs = Date.parse(before);
    return this.getAllPollRecords()
      .filter((record) => record.status === 'active')
      .filter((record) => {
        const nextPollTs = Date.parse(String(record.nextPollAt || ''));
        return !Number.isNaN(nextPollTs) && nextPollTs <= beforeTs;
      })
      .slice(0, limit);
  }

  completePollRecord(campaignRunId, result = {}, options = {}) {
    return this.finalizePollRecord(campaignRunId, 'completed', result, options);
  }

  failPollRecord(campaignRunId, result = {}, options = {}) {
    return this.finalizePollRecord(campaignRunId, 'failed', result, options);
  }

  pausePollRecord(campaignRunId, options = {}) {
    return this.mutatePollRecord(campaignRunId, (currentRecord, now) => {
      if (currentRecord.status === 'completed' || currentRecord.status === 'failed') {
        return currentRecord;
      }

      const observedAt = normalizeTimestamp(options.observedAt) || currentRecord.lastPollAt || now;
      const pauseReason = cleanString(options.reason, 600) || null;
      const lastPollResult = mergePollResult(currentRecord.lastPollResult, {
        observedAt,
        transition: 'paused',
        pauseReason
      });

      return {
        ...currentRecord,
        status: 'paused',
        nextPollAt: null,
        lastPollResult,
        updatedAt: now
      };
    });
  }

  resumePollRecord(campaignRunId, options = {}) {
    return this.mutatePollRecord(campaignRunId, (currentRecord, now) => {
      if (currentRecord.status === 'completed' || currentRecord.status === 'failed') {
        return currentRecord;
      }

      const resumedAt = normalizeTimestamp(options.resumedAt) || now;
      const explicitNextPollAt = normalizeTimestamp(options.nextPollAt);
      const nextPollAt = explicitNextPollAt || new Date(Date.parse(resumedAt) + currentRecord.pollIntervalMs).toISOString();
      const lastPollResult = mergePollResult(currentRecord.lastPollResult, {
        observedAt: resumedAt,
        transition: 'resumed'
      });

      return {
        ...currentRecord,
        status: 'active',
        nextPollAt,
        lastPollResult,
        updatedAt: now
      };
    });
  }

  recordPollResult(campaignRunId, result = {}, options = {}) {
    return this.mutatePollRecord(campaignRunId, (currentRecord, now) => {
      const lastPollAt = normalizeTimestamp(options.lastPollAt) || normalizeTimestamp(result.lastPollAt) || now;
      const nextPollCount = Math.max(0, Number(currentRecord.pollCount) || 0) + 1;
      const normalizedResult = normalizeLastPollResult(result, lastPollAt);
      const enrollmentStatus = cleanString(
        result.apolloEnrollmentStatus
        || result.enrollmentStatus
        || result.sequenceContactStatus,
        120
      ) || null;
      const terminalPollStatus = resolveTerminalPollStatus(enrollmentStatus);

      if (terminalPollStatus) {
        return {
          ...currentRecord,
          status: terminalPollStatus,
          pollCount: nextPollCount,
          lastPollAt,
          lastPollResult: normalizedResult,
          nextPollAt: null,
          updatedAt: now
        };
      }

      if (nextPollCount >= currentRecord.maxPolls) {
        return {
          ...currentRecord,
          status: 'completed',
          pollCount: nextPollCount,
          lastPollAt,
          lastPollResult: normalizedResult,
          nextPollAt: null,
          updatedAt: now
        };
      }

      const explicitNextPollAt = normalizeTimestamp(options.nextPollAt) || normalizeTimestamp(result.nextPollAt);
      const computedNextPollAt = explicitNextPollAt || new Date(Date.parse(lastPollAt) + currentRecord.pollIntervalMs).toISOString();
      return {
        ...currentRecord,
        status: 'active',
        pollCount: nextPollCount,
        lastPollAt,
        lastPollResult: normalizedResult,
        nextPollAt: computedNextPollAt,
        updatedAt: now
      };
    });
  }

  readStore() {
    const fallback = {
      version: STORE_VERSION,
      polls: []
    };
    const store = readJsonFile(this.storePath, fallback);
    return normalizeStore(store);
  }

  finalizePollRecord(campaignRunId, finalStatus, result = {}, options = {}) {
    const normalizedFinalStatus = normalizePollStatus(finalStatus);
    if (!normalizedFinalStatus || !['completed', 'failed'].includes(normalizedFinalStatus)) {
      throw new Error('Apollo poll final status must be completed or failed');
    }
    return this.mutatePollRecord(campaignRunId, (currentRecord, now) => {
      const lastPollAt = normalizeTimestamp(options.lastPollAt) || normalizeTimestamp(result.lastPollAt) || now;
      return {
        ...currentRecord,
        status: normalizedFinalStatus,
        lastPollAt,
        lastPollResult: normalizeLastPollResult(result, lastPollAt),
        nextPollAt: null,
        updatedAt: now
      };
    });
  }

  mutatePollRecord(campaignRunId, mutator) {
    const normalizedCampaignRunId = cleanString(campaignRunId, 160);
    if (!normalizedCampaignRunId || typeof mutator !== 'function') {
      return null;
    }

    const store = this.readStore();
    const recordIndex = store.polls.findIndex((record) => cleanString(record?.campaignRunId, 160) === normalizedCampaignRunId);
    if (recordIndex === -1) {
      return null;
    }

    const now = new Date().toISOString();
    const currentRecord = normalizePollRecord(store.polls[recordIndex]);
    const nextRecord = normalizePollRecord(mutator(currentRecord, now));
    nextRecord.updatedAt = now;
    store.polls[recordIndex] = nextRecord;
    writeJsonFileAtomic(this.storePath, store);
    return nextRecord;
  }
}

function normalizeStore(store = {}) {
  return {
    version: STORE_VERSION,
    polls: Array.isArray(store.polls) ? store.polls.map((record) => normalizePollRecord(record)) : []
  };
}

function normalizePollRecordForCreate(input = {}, now = new Date().toISOString()) {
  return {
    campaignRunId: cleanString(input.campaignRunId, 160) || null,
    apolloSequenceContactId: cleanString(input.apolloSequenceContactId, 160) || null,
    status: normalizePollStatus(input.status) || 'active',
    nextPollAt: normalizeTimestamp(input.nextPollAt) || now,
    pollCount: Math.max(0, Number(input.pollCount) || 0),
    maxPolls: normalizePositiveInteger(input.maxPolls, DEFAULT_APOLLO_POLL_MAX_POLLS),
    pollIntervalMs: normalizePositiveInteger(input.pollIntervalMs, DEFAULT_APOLLO_POLL_INTERVAL_MS),
    lastPollResult: normalizeLastPollResult(input.lastPollResult),
    lastPollAt: normalizeTimestamp(input.lastPollAt),
    createdAt: now,
    updatedAt: now
  };
}

function normalizePollRecord(record = {}) {
  return {
    campaignRunId: cleanString(record.campaignRunId, 160) || null,
    apolloSequenceContactId: cleanString(record.apolloSequenceContactId, 160) || null,
    status: normalizePollStatus(record.status) || 'active',
    nextPollAt: normalizeTimestamp(record.nextPollAt),
    pollCount: Math.max(0, Number(record.pollCount) || 0),
    maxPolls: normalizePositiveInteger(record.maxPolls, DEFAULT_APOLLO_POLL_MAX_POLLS),
    pollIntervalMs: normalizePositiveInteger(record.pollIntervalMs, DEFAULT_APOLLO_POLL_INTERVAL_MS),
    lastPollResult: normalizeLastPollResult(record.lastPollResult),
    lastPollAt: normalizeTimestamp(record.lastPollAt),
    createdAt: normalizeTimestamp(record.createdAt) || new Date().toISOString(),
    updatedAt: normalizeTimestamp(record.updatedAt) || normalizeTimestamp(record.createdAt) || new Date().toISOString()
  };
}

function normalizePollStatus(value) {
  const normalized = cleanString(value, 40).toLowerCase();
  return APOLLO_POLL_RECORD_STATUSES.has(normalized) ? normalized : null;
}

function resolveTerminalPollStatus(apolloEnrollmentStatus) {
  const normalized = cleanString(apolloEnrollmentStatus, 120).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (APOLLO_TERMINAL_SUCCESS_STATUSES.has(normalized)) {
    return 'completed';
  }
  if (APOLLO_TERMINAL_FAILURE_STATUSES.has(normalized)) {
    return 'failed';
  }
  return null;
}

function normalizeLastPollResult(value, fallbackObservedAt = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const next = JSON.parse(JSON.stringify(value));
  const observedAt = normalizeTimestamp(next.observedAt) || normalizeTimestamp(fallbackObservedAt);
  if (observedAt) {
    next.observedAt = observedAt;
  }
  return next;
}

function mergePollResult(left, right) {
  const base = left && typeof left === 'object' && !Array.isArray(left)
    ? JSON.parse(JSON.stringify(left))
    : {};
  const patch = right && typeof right === 'object' && !Array.isArray(right)
    ? right
    : {};
  const next = {
    ...base,
    ...patch
  };
  return normalizeLastPollResult(next, patch.observedAt || base.observedAt || null);
}

function normalizePositiveInteger(value, fallback) {
  return Math.max(1, Number(value) || Number(fallback) || 1);
}

function normalizeTimestamp(value) {
  const text = cleanString(value, 80);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function cleanString(value, maxLength = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = ApolloPollStore;
module.exports.APOLLO_POLL_RECORD_STATUSES = APOLLO_POLL_RECORD_STATUSES;
module.exports.DEFAULT_APOLLO_POLL_MAX_POLLS = DEFAULT_APOLLO_POLL_MAX_POLLS;
module.exports.DEFAULT_APOLLO_POLL_INTERVAL_MS = DEFAULT_APOLLO_POLL_INTERVAL_MS;
