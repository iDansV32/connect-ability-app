const {
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const ACTION_QUOTA_WINDOWS = Object.freeze({
  profile_viewed: Object.freeze({
    daily: Object.freeze({ limit: 80, windowMs: DAY_MS }),
    weekly: Object.freeze({ limit: 400, windowMs: WEEK_MS })
  }),
  post_liked: Object.freeze({
    daily: Object.freeze({ limit: 35, windowMs: DAY_MS }),
    weekly: Object.freeze({ limit: 175, windowMs: WEEK_MS })
  }),
  connection_requested: Object.freeze({
    daily: Object.freeze({ limit: 22, windowMs: DAY_MS }),
    weekly: Object.freeze({ limit: 100, windowMs: WEEK_MS })
  }),
  profile_followed: Object.freeze({
    daily: Object.freeze({ limit: 22, windowMs: DAY_MS }),
    weekly: Object.freeze({ limit: 110, windowMs: WEEK_MS })
  }),
  skill_endorsed: Object.freeze({
    daily: Object.freeze({ limit: 20, windowMs: DAY_MS }),
    weekly: Object.freeze({ limit: 100, windowMs: WEEK_MS })
  }),
  profile_unfollowed: Object.freeze({
    daily: Object.freeze({ limit: 30, windowMs: DAY_MS }),
    weekly: Object.freeze({ limit: 150, windowMs: WEEK_MS })
  }),
  post_commented: Object.freeze({
    daily: Object.freeze({ limit: 10, windowMs: DAY_MS }),
    weekly: Object.freeze({ limit: 50, windowMs: WEEK_MS })
  }),
  post_published: Object.freeze({
    daily: Object.freeze({ limit: 2, windowMs: DAY_MS }),
    weekly: Object.freeze({ limit: 14, windowMs: WEEK_MS })
  })
});

const STORE_VERSION = 1;

// Randomisation bounds for the daily window limit.
// On each window reset, the effective ceiling is multiplied by a factor sampled
// uniformly within [MIN, MAX], making per-account action counts less predictable
// to platform detectors.  The weekly window is intentionally NOT randomised
// because it needs to remain a reliable upper bound for the week.
const DAILY_RANDOM_MIN_FACTOR = 0.60;
const DAILY_RANDOM_MAX_FACTOR = 0.95;

function resolveQuotaPath(options = {}) {
  const customPath = String(options.quotaPath || '').trim();
  return customPath || resolveInternalStatePath('linkedin-action-quota.json');
}

function getNow(options = {}) {
  return options.now instanceof Date ? new Date(options.now.getTime()) : new Date();
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

function normalizeActionType(actionType) {
  const normalized = cleanString(actionType, 80);
  if (!ACTION_QUOTA_WINDOWS[normalized]) {
    throw new Error(`Unknown LinkedIn action quota type: ${actionType || 'unknown'}`);
  }
  return normalized;
}

function resolveAccountKey(options = {}) {
  const accountId = cleanString(options.accountId, 160);
  if (accountId) {
    return `account:${accountId}`;
  }

  const accountEmail = cleanString(options.accountEmail || options.email, 200).toLowerCase();
  if (accountEmail) {
    return `email:${accountEmail}`;
  }

  return 'default';
}

function createWindowState(config, now) {
  return {
    limit: config.limit,
    used: 0,
    resetTime: new Date(now.getTime() + config.windowMs).toISOString()
  };
}

function createDefaultActionQuota(actionType, now = new Date()) {
  const normalizedActionType = normalizeActionType(actionType);
  const policy = ACTION_QUOTA_WINDOWS[normalizedActionType];
  return {
    daily: createWindowState(policy.daily, now),
    weekly: createWindowState(policy.weekly, now)
  };
}

function normalizeWindowState(rawWindow, config, now) {
  const nextWindow = createWindowState(config, now);
  if (!rawWindow || typeof rawWindow !== 'object') {
    return nextWindow;
  }

  nextWindow.limit = toNonNegativeInteger(rawWindow.limit, config.limit) || config.limit;
  nextWindow.used = toNonNegativeInteger(rawWindow.used, 0);

  const rawResetTime = cleanString(rawWindow.resetTime, 80);
  const parsedResetTime = rawResetTime ? new Date(rawResetTime) : null;
  const isValidResetTime = parsedResetTime instanceof Date && !Number.isNaN(parsedResetTime.getTime());

  if (isValidResetTime && parsedResetTime.getTime() > now.getTime()) {
    nextWindow.resetTime = parsedResetTime.toISOString();
    nextWindow.used = Math.min(nextWindow.used, nextWindow.limit);
    // Preserve the randomised-this-cycle flag so applyDailyWindowOptions does
    // not re-randomise an in-progress window on every read.
    if (rawWindow._randomized) {
      nextWindow._randomized = true;
    }
    return nextWindow;
  }

  // Window has expired — reset usage and roll a new reset time.
  // The _randomized flag is intentionally NOT carried over so that
  // applyDailyWindowOptions picks a fresh limit for the new cycle.
  nextWindow.used = 0;
  nextWindow.resetTime = new Date(now.getTime() + config.windowMs).toISOString();
  return nextWindow;
}

function normalizeActionQuota(rawQuota, actionType, now = new Date()) {
  const normalizedActionType = normalizeActionType(actionType);
  const policy = ACTION_QUOTA_WINDOWS[normalizedActionType];

  if (!rawQuota || typeof rawQuota !== 'object') {
    return createDefaultActionQuota(normalizedActionType, now);
  }

  return {
    daily: normalizeWindowState(rawQuota.daily, policy.daily, now),
    weekly: normalizeWindowState(rawQuota.weekly, policy.weekly, now)
  };
}

/**
 * Apply warm-up ceiling and per-cycle randomisation to a daily quota window.
 *
 * This is called AFTER structural normalisation (normalizeActionQuota) and only
 * for the daily window.  The weekly window always uses the configured limit to
 * remain a reliable upper bound.
 *
 * The `_randomized` flag on the window is the authoritative signal that options
 * have already been applied for this cycle.  Once set it is preserved by
 * normalizeWindowState until the window expires, ensuring the limit is chosen
 * exactly once per day regardless of how many quota checks happen.
 *
 * @param {object} window        - Normalised daily quota window.
 * @param {object} config        - Daily quota config (has .limit).
 * @param {object} [options]     - { warmUpMultiplier, rng }.
 * @returns {object}             - Window, possibly with updated limit and _randomized=true.
 */
function applyDailyWindowOptions(window, config, options = {}) {
  // Already applied for this cycle — skip.
  if (window._randomized) {
    return window;
  }

  const warmUpMultiplier = resolveWarmUpMultiplier(options.warmUpMultiplier);
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;

  // Apply warm-up: effective ceiling is at most warmUpMultiplier × configured limit.
  const ceiling = Math.max(1, Math.floor(config.limit * warmUpMultiplier));

  // Randomise the daily target within [60 %, 95 %] of the effective ceiling so
  // that no two accounts have the same exact action count each day.
  let newLimit;
  if (ceiling > 1) {
    const lo = Math.max(1, Math.floor(ceiling * DAILY_RANDOM_MIN_FACTOR));
    const hi = Math.max(lo, Math.floor(ceiling * DAILY_RANDOM_MAX_FACTOR));
    newLimit = randomBetween(lo, hi, rng);
  } else {
    newLimit = ceiling;
  }

  return {
    ...window,
    limit: newLimit,
    _randomized: true
  };
}

function resolveWarmUpMultiplier(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1.0;
}

/**
 * Return a uniformly distributed random integer in [min, max] (inclusive).
 * The optional `rng` parameter accepts a Math.random-compatible function and
 * is exposed so tests can inject a deterministic source.
 *
 * The result is clamped to [lo, hi] so that edge-case rng values (e.g. exactly
 * 1.0, which Math.random never produces but a test shim might) stay in range.
 */
function randomBetween(min, max, rng = Math.random) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (lo >= hi) return lo;
  return Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1)));
}

function normalizeAccountEntry(rawAccount, now = new Date()) {
  const actions = rawAccount?.actions && typeof rawAccount.actions === 'object' && !Array.isArray(rawAccount.actions)
    ? rawAccount.actions
    : {};

  const normalizedActions = Object.keys(ACTION_QUOTA_WINDOWS).reduce((accumulator, actionType) => {
    accumulator[actionType] = normalizeActionQuota(actions[actionType], actionType, now);
    return accumulator;
  }, {});

  return {
    accountId: cleanString(rawAccount?.accountId, 160) || null,
    accountEmail: cleanString(rawAccount?.accountEmail, 200).toLowerCase() || null,
    accountName: cleanString(rawAccount?.accountName, 200) || null,
    updatedAt: cleanString(rawAccount?.updatedAt, 80) || null,
    actions: normalizedActions
  };
}

function readStore(options = {}) {
  const now = getNow(options);
  const quotaPath = resolveQuotaPath(options);
  const fallback = {
    version: STORE_VERSION,
    accounts: {}
  };
  const rawStore = readJsonFile(quotaPath, fallback);
  const rawAccounts = rawStore?.accounts && typeof rawStore.accounts === 'object' && !Array.isArray(rawStore.accounts)
    ? rawStore.accounts
    : {};

  const accounts = Object.entries(rawAccounts).reduce((accumulator, [accountKey, rawAccount]) => {
    const normalizedKey = cleanString(accountKey, 220);
    if (!normalizedKey) {
      return accumulator;
    }
    accumulator[normalizedKey] = normalizeAccountEntry(rawAccount, now);
    return accumulator;
  }, {});

  return {
    quotaPath,
    now,
    store: {
      version: Number(rawStore.version) || STORE_VERSION,
      accounts
    }
  };
}

function writeStore(quotaPath, store) {
  writeJsonFileAtomic(quotaPath, store);
}

function getRemainingQuota(quota) {
  return {
    daily: Math.max(0, quota.daily.limit - quota.daily.used),
    weekly: Math.max(0, quota.weekly.limit - quota.weekly.used)
  };
}

function ensureAccountEntry(store, accountKey, options = {}, now = new Date()) {
  if (!store.accounts[accountKey]) {
    store.accounts[accountKey] = normalizeAccountEntry({
      accountId: options.accountId || null,
      accountEmail: options.accountEmail || options.email || null,
      accountName: options.accountName || null
    }, now);
  }

  const accountEntry = store.accounts[accountKey];
  accountEntry.accountId = cleanString(options.accountId || accountEntry.accountId, 160) || null;
  accountEntry.accountEmail = cleanString(options.accountEmail || options.email || accountEntry.accountEmail, 200).toLowerCase() || null;
  accountEntry.accountName = cleanString(options.accountName || accountEntry.accountName, 200) || null;
  accountEntry.updatedAt = now.toISOString();
  return accountEntry;
}

function getActionQuota(actionType, options = {}) {
  const normalizedActionType = normalizeActionType(actionType);
  const policy = ACTION_QUOTA_WINDOWS[normalizedActionType];
  const accountKey = resolveAccountKey(options);
  const { quotaPath, now, store } = readStore(options);
  const accountEntry = ensureAccountEntry(store, accountKey, options, now);
  const rawQuota = normalizeActionQuota(accountEntry.actions[normalizedActionType], normalizedActionType, now);

  // Apply warm-up ceiling and daily randomisation (once per window cycle).
  const quota = {
    daily: applyDailyWindowOptions(rawQuota.daily, policy.daily, options),
    weekly: rawQuota.weekly
  };

  accountEntry.actions[normalizedActionType] = quota;

  if (!options.readOnly) {
    writeStore(quotaPath, store);
  }

  return quota;
}

function canConsumeActionQuota(actionType, count = 1, options = {}) {
  const normalizedActionType = normalizeActionType(actionType);
  const normalizedCount = toNonNegativeInteger(count, 1);
  const quota = getActionQuota(normalizedActionType, options);
  const exceeded = [];

  if ((quota.daily.used + normalizedCount) > quota.daily.limit) {
    exceeded.push('daily');
  }
  if ((quota.weekly.used + normalizedCount) > quota.weekly.limit) {
    exceeded.push('weekly');
  }

  return {
    allowed: exceeded.length === 0,
    actionType: normalizedActionType,
    count: normalizedCount,
    exceeded,
    quota,
    remaining: getRemainingQuota(quota)
  };
}

function consumeActionQuota(actionType, count = 1, options = {}) {
  const normalizedActionType = normalizeActionType(actionType);
  const policy = ACTION_QUOTA_WINDOWS[normalizedActionType];
  const normalizedCount = toNonNegativeInteger(count, 1);
  const accountKey = resolveAccountKey(options);
  const { quotaPath, now, store } = readStore(options);
  const accountEntry = ensureAccountEntry(store, accountKey, options, now);
  const rawQuota = normalizeActionQuota(accountEntry.actions[normalizedActionType], normalizedActionType, now);

  // Apply warm-up ceiling and daily randomisation (once per window cycle).
  const quota = {
    daily: applyDailyWindowOptions(rawQuota.daily, policy.daily, options),
    weekly: rawQuota.weekly
  };

  const exceeded = [];
  if ((quota.daily.used + normalizedCount) > quota.daily.limit) {
    exceeded.push('daily');
  }
  if ((quota.weekly.used + normalizedCount) > quota.weekly.limit) {
    exceeded.push('weekly');
  }

  if (exceeded.length > 0 || normalizedCount === 0) {
    accountEntry.actions[normalizedActionType] = quota;
    return {
      allowed: exceeded.length === 0,
      actionType: normalizedActionType,
      count: normalizedCount,
      exceeded,
      quota,
      remaining: getRemainingQuota(quota)
    };
  }

  const updatedQuota = {
    daily: {
      ...quota.daily,
      used: quota.daily.used + normalizedCount
    },
    weekly: {
      ...quota.weekly,
      used: quota.weekly.used + normalizedCount
    }
  };

  accountEntry.actions[normalizedActionType] = updatedQuota;
  writeStore(quotaPath, store);

  return {
    allowed: true,
    actionType: normalizedActionType,
    count: normalizedCount,
    exceeded: [],
    quota: updatedQuota,
    remaining: getRemainingQuota(updatedQuota)
  };
}

function buildQuotaExceededReason(actionType, state) {
  const normalizedActionType = normalizeActionType(actionType);
  const exceededText = Array.isArray(state?.exceeded) && state.exceeded.length
    ? state.exceeded.join(', ')
    : 'active safety limit';
  const quota = state?.quota || {};
  const daily = quota.daily || {};
  const weekly = quota.weekly || {};
  return [
    `${normalizedActionType} blocked by ${exceededText} safety limit`,
    `daily ${daily.used ?? 0}/${daily.limit ?? 0}`,
    `weekly ${weekly.used ?? 0}/${weekly.limit ?? 0}`
  ].join(' | ');
}

module.exports = {
  ACTION_QUOTA_WINDOWS,
  DAILY_RANDOM_MIN_FACTOR,
  DAILY_RANDOM_MAX_FACTOR,
  STORE_VERSION,
  applyDailyWindowOptions,
  buildQuotaExceededReason,
  canConsumeActionQuota,
  consumeActionQuota,
  createDefaultActionQuota,
  getActionQuota,
  getRemainingQuota,
  normalizeActionQuota,
  randomBetween,
  readStore,
  resolveAccountKey,
  resolveQuotaPath
};
