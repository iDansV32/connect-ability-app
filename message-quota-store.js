'use strict';

const {
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Daily limit is drawn from [MIN_FACTOR, MAX_FACTOR] × effective ceiling on every window reset. */
const DAILY_RANDOM_MIN_FACTOR = 0.60;
const DAILY_RANDOM_MAX_FACTOR = 0.95;

const QUOTA_WINDOWS = Object.freeze({
  daily:  Object.freeze({ limit: 50,  windowMs: DAY_MS }),
  weekly: Object.freeze({ limit: 250, windowMs: WEEK_MS })
});

// ---------------------------------------------------------------------------
// Public API (surface-compatible with the previous global implementation)
// ---------------------------------------------------------------------------

/**
 * Read the current per-account message quota, initialising it if absent.
 * Options:
 *   accountId, accountEmail  — key for per-account isolation (falls back to 'default')
 *   quotaPath                — path to the quota JSON file
 *   now                      — Date override for testing
 *   warmUpMultiplier         — (0, 1] applied to the daily ceiling before randomisation
 *   rng                      — () => number  RNG override for testing
 */
function getMessageQuota(options = {}) {
  const now   = getNow(options);
  const key   = resolveAccountKey(options);
  const store = readStore(options, now);
  const raw   = store.accounts[key] || null;

  const quota   = normalizeMessageQuota(raw, now);
  const applied = applyDailyOptions(quota, options);

  if (quotaNeedsWrite(raw, applied)) {
    writeStore(options, mergeIntoStore(store, key, applied));
  }
  return applied;
}

function canConsumeMessageQuota(count = 1, options = {}) {
  const n     = toNonNegativeInt(count, 1);
  const quota = getMessageQuota(options);
  const exceeded = [];
  if ((quota.daily.used  + n) > quota.daily.limit)  exceeded.push('daily');
  if ((quota.weekly.used + n) > quota.weekly.limit) exceeded.push('weekly');
  return { allowed: exceeded.length === 0, count: n, exceeded, quota, remaining: getRemainingQuota(quota) };
}

function consumeMessageQuota(count = 1, options = {}) {
  const n   = toNonNegativeInt(count, 1);
  const now = getNow(options);
  const key = resolveAccountKey(options);

  const store = readStore(options, now);
  const raw   = store.accounts[key] || null;
  const quota = applyDailyOptions(normalizeMessageQuota(raw, now), options);

  const exceeded = [];
  if ((quota.daily.used  + n) > quota.daily.limit)  exceeded.push('daily');
  if ((quota.weekly.used + n) > quota.weekly.limit) exceeded.push('weekly');
  if (exceeded.length > 0) {
    return { allowed: false, count: n, exceeded, quota, remaining: getRemainingQuota(quota) };
  }

  const updated = {
    daily:  { ...quota.daily,  used: quota.daily.used  + n },
    weekly: { ...quota.weekly, used: quota.weekly.used + n }
  };
  writeStore(options, mergeIntoStore(store, key, updated));
  return { allowed: true, count: n, exceeded: [], quota: updated, remaining: getRemainingQuota(updated) };
}

function resetMessageQuotaWindow(windowName, options = {}) {
  const name = String(windowName || '').trim().toLowerCase();
  if (!QUOTA_WINDOWS[name]) throw new Error(`Unknown message quota window: ${windowName}`);
  const now   = getNow(options);
  const key   = resolveAccountKey(options);
  const store = readStore(options, now);
  const raw   = store.accounts[key] || null;
  const quota = applyDailyOptions(normalizeMessageQuota(raw, now), options);
  const updated = { ...quota, [name]: createWindowState(QUOTA_WINDOWS[name], now) };
  writeStore(options, mergeIntoStore(store, key, updated));
  return updated;
}

// Kept for backward-compat callers that import it directly.
function createDefaultMessageQuota(now = new Date()) {
  return {
    daily:  createWindowState(QUOTA_WINDOWS.daily,  now),
    weekly: createWindowState(QUOTA_WINDOWS.weekly, now)
  };
}

function getRemainingQuota(quota) {
  return {
    daily:  Math.max(0, quota.daily.limit  - quota.daily.used),
    weekly: Math.max(0, quota.weekly.limit - quota.weekly.used)
  };
}

function resolveQuotaPath(options = {}) {
  const custom = String(options.quotaPath || '').trim();
  return custom || resolveInternalStatePath('message-quota.json');
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function normalizeMessageQuota(raw, now) {
  if (!raw || typeof raw !== 'object') return createDefaultMessageQuota(now);
  return {
    daily:  normalizeWindowState(raw.daily,  QUOTA_WINDOWS.daily,  now),
    weekly: normalizeWindowState(raw.weekly, QUOTA_WINDOWS.weekly, now)
  };
}

function normalizeWindowState(rawWindow, config, now) {
  const next = createWindowState(config, now);
  if (!rawWindow || typeof rawWindow !== 'object') return next;

  next.limit = toNonNegativeInt(rawWindow.limit, config.limit) || config.limit;
  next.used  = toNonNegativeInt(rawWindow.used, 0);

  const rawReset    = String(rawWindow.resetTime || '').trim();
  const parsedReset = rawReset ? new Date(rawReset) : null;
  const isValid     = parsedReset && !Number.isNaN(parsedReset.getTime());

  if (isValid && parsedReset.getTime() > now.getTime()) {
    next.resetTime = parsedReset.toISOString();
    next.used      = Math.min(next.used, next.limit);
    // Carry the _randomized flag so the same window is not re-randomised.
    if (rawWindow._randomized) next._randomized = true;
    return next;
  }

  // Expired window — fresh slate.  _randomized is intentionally NOT carried.
  next.used      = 0;
  next.resetTime = new Date(now.getTime() + config.windowMs).toISOString();
  return next;
}

// ---------------------------------------------------------------------------
// Daily randomisation + warm-up
// ---------------------------------------------------------------------------

/**
 * Apply the warm-up ceiling and then pick a randomised daily limit, storing
 * a _randomized flag so the same window is only randomised once per cycle.
 */
function applyDailyOptions(quota, options = {}) {
  if (quota.daily._randomized) return quota;  // already locked for this cycle

  const multiplier = resolveWarmUpMultiplier(options.warmUpMultiplier);
  const rng        = typeof options.rng === 'function' ? options.rng : Math.random;
  const ceiling    = Math.max(1, Math.floor(QUOTA_WINDOWS.daily.limit * multiplier));

  let newLimit;
  if (ceiling > 1) {
    const lo = Math.max(1, Math.floor(ceiling * DAILY_RANDOM_MIN_FACTOR));
    const hi = Math.max(lo, Math.floor(ceiling * DAILY_RANDOM_MAX_FACTOR));
    newLimit = randomBetween(lo, hi, rng);
  } else {
    newLimit = ceiling;
  }

  return { ...quota, daily: { ...quota.daily, limit: newLimit, _randomized: true } };
}

function resolveWarmUpMultiplier(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1;
}

function randomBetween(min, max, rng = Math.random) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (lo >= hi) return lo;
  return Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1)));
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function readStore(options, _now) {
  const path    = resolveQuotaPath(options);
  const fallback = { version: STORE_VERSION, accounts: {} };
  const raw     = readJsonFile(path, fallback);

  // Migration: v1 stored a flat { daily, weekly } object without per-account keying.
  // Treat it as the 'default' account so existing quota state is preserved.
  if (raw && !raw.accounts && (raw.daily || raw.weekly)) {
    return {
      version:  STORE_VERSION,
      accounts: { default: { daily: raw.daily || null, weekly: raw.weekly || null } }
    };
  }

  const accounts = raw?.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)
    ? raw.accounts
    : {};
  return { version: STORE_VERSION, accounts };
}

function mergeIntoStore(store, key, quota) {
  return { ...store, accounts: { ...store.accounts, [key]: quota } };
}

function writeStore(options, store) {
  writeJsonFileAtomic(resolveQuotaPath(options), store);
}

function quotaNeedsWrite(raw, normalized) {
  if (!raw) return true;
  return (
    raw.daily?.resetTime   !== normalized.daily?.resetTime ||
    raw.daily?._randomized !== normalized.daily?._randomized
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWindowState(config, now) {
  return { limit: config.limit, used: 0, resetTime: new Date(now.getTime() + config.windowMs).toISOString() };
}

function resolveAccountKey(options = {}) {
  const id    = String(options.accountId    || '').trim();
  const email = String(options.accountEmail || '').trim().toLowerCase();
  return id || email || 'default';
}

function getNow(options = {}) {
  return options.now instanceof Date ? new Date(options.now.getTime()) : new Date();
}

function toNonNegativeInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Exports (same surface as the previous implementation, with additions)
// ---------------------------------------------------------------------------

module.exports = {
  QUOTA_WINDOWS,
  DAILY_RANDOM_MIN_FACTOR,
  DAILY_RANDOM_MAX_FACTOR,
  canConsumeMessageQuota,
  consumeMessageQuota,
  createDefaultMessageQuota,
  getMessageQuota,
  getRemainingQuota,
  normalizeMessageQuota,
  resetMessageQuotaWindow,
  resolveQuotaPath,
  // exposed for unit tests
  _private: { randomBetween, applyDailyOptions, resolveAccountKey }
};
