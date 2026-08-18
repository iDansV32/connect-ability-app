'use strict';

const {
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('../../connect-documents');

const STORE_VERSION = 1;
const DEFAULT_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

class PendingInviteSweepStore {
  constructor(options = {}) {
    this.storePath = options.storePath || resolveInternalStatePath('pending-invite-sweeps.json');
  }

  getAccountState(accountEmail, now = new Date()) {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    if (!normalizedEmail) {
      return null;
    }

    const store = this.readStore(now);
    return normalizeAccountState(store.accounts[normalizedEmail], now);
  }

  shouldRunSweep(accountEmail, options = {}) {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    if (!normalizedEmail) {
      return false;
    }

    const now = options.now instanceof Date ? new Date(options.now.getTime()) : new Date();
    const intervalMs = resolveSweepIntervalMs(options.intervalMs);
    const state = this.getAccountState(normalizedEmail, now);
    if (!state?.lastSweepAt) {
      return true;
    }

    const lastSweepTime = Date.parse(state.lastSweepAt);
    if (Number.isNaN(lastSweepTime)) {
      return true;
    }

    return now.getTime() - lastSweepTime >= intervalMs;
  }

  recordSweep(accountEmail, meta = {}) {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    if (!normalizedEmail) {
      return null;
    }

    const now = meta.now instanceof Date ? new Date(meta.now.getTime()) : new Date();
    const store = this.readStore(now);
    store.accounts[normalizedEmail] = normalizeAccountState({
      ...store.accounts[normalizedEmail],
      lastSweepAt: cleanString(meta.timestamp, 80) || now.toISOString(),
      lastWithdrawCount: toNonNegativeInteger(meta.withdrewCount, 0),
      lastCandidateCount: toNonNegativeInteger(meta.candidateCount, 0),
      lastStatus: cleanString(meta.status, 40) || 'completed',
      lastError: cleanString(meta.error, 280) || null,
      updatedAt: now.toISOString()
    }, now);
    writeJsonFileAtomic(this.storePath, store);
    return store.accounts[normalizedEmail];
  }

  readStore(now = new Date()) {
    const fallback = {
      version: STORE_VERSION,
      accounts: {}
    };

    const store = readJsonFile(this.storePath, fallback);
    const accounts = store?.accounts && typeof store.accounts === 'object' && !Array.isArray(store.accounts)
      ? store.accounts
      : {};

    return {
      version: Number(store?.version) || STORE_VERSION,
      accounts: Object.entries(accounts).reduce((accumulator, [accountEmail, rawState]) => {
        const normalizedEmail = normalizeAccountEmail(accountEmail);
        if (!normalizedEmail) {
          return accumulator;
        }
        accumulator[normalizedEmail] = normalizeAccountState(rawState, now);
        return accumulator;
      }, {})
    };
  }
}

function normalizeAccountState(rawState, _now = new Date()) {
  return {
    lastSweepAt: cleanString(rawState?.lastSweepAt, 80) || null,
    lastWithdrawCount: toNonNegativeInteger(rawState?.lastWithdrawCount, 0),
    lastCandidateCount: toNonNegativeInteger(rawState?.lastCandidateCount, 0),
    lastStatus: cleanString(rawState?.lastStatus, 40) || null,
    lastError: cleanString(rawState?.lastError, 280) || null,
    updatedAt: cleanString(rawState?.updatedAt, 80) || null
  };
}

function resolveSweepIntervalMs(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SWEEP_INTERVAL_MS;
}

function normalizeAccountEmail(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  PendingInviteSweepStore,
  DEFAULT_SWEEP_INTERVAL_MS,
  resolveSweepIntervalMs,
  _private: {
    normalizeAccountState,
    normalizeAccountEmail
  }
};
