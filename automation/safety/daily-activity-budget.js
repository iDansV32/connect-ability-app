'use strict';

/**
 * Per-account daily activity budget — a coarse total-actions envelope that
 * sits on top of the per-action-type quotas.  It prevents a single account
 * from maxing every action bucket on the same day, which would look anomalous
 * even if every individual limit is technically respected.
 *
 * Store shape (daily-activity-budget.json):
 *   { version: 1, accounts: { [accountKey]: { used: N, limit: M, resetTime: ISO } } }
 */

const {
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('../../connect-documents');

const STORE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default maximum total actions any one account may take in a day. */
const DEFAULT_DAILY_BUDGET = 120;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the current per-account budget without modifying it.
 * @returns {{ used: number, limit: number, resetTime: string }}
 */
function getActivityBudget(options = {}) {
  const now   = getNow(options);
  const key   = resolveAccountKey(options);
  const limit = resolveDailyBudget(options);
  const store = readStore(options);

  const raw     = store.accounts[key] || null;
  const budget  = normalizeBudgetState(raw, limit, now);

  if (budgetNeedsWrite(raw, budget, limit)) {
    writeStore(options, mergeIntoStore(store, key, budget));
  }
  return budget;
}

/**
 * Check whether `count` more actions fit within the daily budget.
 * @returns {{ allowed: boolean, used: number, limit: number, remaining: number, exceeded: string[] }}
 */
function canConsumeActivityBudget(count = 1, options = {}) {
  const n      = toNonNegativeInt(count, 1);
  const budget = getActivityBudget(options);
  const allowed = (budget.used + n) <= budget.limit;
  return {
    allowed,
    used:      budget.used,
    limit:     budget.limit,
    remaining: Math.max(0, budget.limit - budget.used),
    exceeded:  allowed ? [] : ['daily_total']
  };
}

/**
 * Increment the per-account daily counter by `count`.
 * Rejects (returns allowed: false) if the budget would be exceeded.
 */
function consumeActivityBudget(count = 1, options = {}) {
  const n   = toNonNegativeInt(count, 1);
  const now = getNow(options);
  const key = resolveAccountKey(options);
  const limit = resolveDailyBudget(options);

  const store  = readStore(options);
  const raw    = store.accounts[key] || null;
  const budget = normalizeBudgetState(raw, limit, now);

  if ((budget.used + n) > budget.limit) {
    return {
      allowed:   false,
      used:      budget.used,
      limit:     budget.limit,
      remaining: Math.max(0, budget.limit - budget.used),
      exceeded:  ['daily_total']
    };
  }

  const updated = { ...budget, used: budget.used + n };
  writeStore(options, mergeIntoStore(store, key, updated));
  return {
    allowed:   true,
    used:      updated.used,
    limit:     updated.limit,
    remaining: Math.max(0, updated.limit - updated.used),
    exceeded:  []
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function normalizeBudgetState(raw, limit, now) {
  const defaultState = {
    used:      0,
    limit,
    resetTime: new Date(now.getTime() + DAY_MS).toISOString()
  };

  if (!raw || typeof raw !== 'object') return defaultState;

  const rawReset    = String(raw.resetTime || '').trim();
  const parsedReset = rawReset ? new Date(rawReset) : null;
  const isValid     = parsedReset && !Number.isNaN(parsedReset.getTime());

  if (isValid && parsedReset.getTime() > now.getTime()) {
    // Active window — keep existing usage, but always apply the current limit.
    return { used: toNonNegativeInt(raw.used, 0), limit, resetTime: parsedReset.toISOString() };
  }

  // Expired window — start fresh.
  return defaultState;
}

function budgetNeedsWrite(raw, normalized, limit) {
  if (!raw) return true;
  // Write if the window expired (resetTime changed) or limit diverged.
  return String(raw.resetTime || '') !== normalized.resetTime || Number(raw.limit) !== limit;
}

function mergeIntoStore(store, key, budget) {
  return { ...store, accounts: { ...store.accounts, [key]: budget } };
}

function resolveStorePath(options = {}) {
  const custom = String(options.budgetPath || '').trim();
  return custom || resolveInternalStatePath('daily-activity-budget.json');
}

function readStore(options = {}) {
  const path    = resolveStorePath(options);
  const fallback = { version: STORE_VERSION, accounts: {} };
  const raw     = readJsonFile(path, fallback);
  const accounts = raw?.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)
    ? raw.accounts
    : {};
  return { version: STORE_VERSION, accounts };
}

function writeStore(options, store) {
  writeJsonFileAtomic(resolveStorePath(options), store);
}

function resolveAccountKey(options = {}) {
  const id    = String(options.accountId    || '').trim();
  const email = String(options.accountEmail || '').trim().toLowerCase();
  return id || email || 'default';
}

function resolveDailyBudget(options = {}) {
  const v = Number(options.dailyBudget);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_DAILY_BUDGET;
}

function getNow(options = {}) {
  return options.now instanceof Date ? new Date(options.now.getTime()) : new Date();
}

function toNonNegativeInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  DEFAULT_DAILY_BUDGET,
  getActivityBudget,
  canConsumeActivityBudget,
  consumeActivityBudget
};
