const {
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');
const SqliteAccountHealthRepository = require('./storage/sqlite-account-health-repository');

const STORE_VERSION = 2;
const SUBSYSTEMS = Object.freeze(['workflow', 'replyMonitor']);
const HEALTH_STATUSES = Object.freeze({
  healthy: 'healthy',
  warning: 'warning',
  cooldown: 'cooldown'
});
const CHALLENGE_TYPES = Object.freeze([
  'checkpoint',
  'captcha',
  'device_verification',
  'unknown'
]);
const DEFAULT_POLICIES = Object.freeze({
  workflow: Object.freeze({
    threshold: 3,
    cooldownMs: 30 * 60 * 1000,
    authCooldownMs: 60 * 60 * 1000,
    severeCooldownMs: 6 * 60 * 60 * 1000
  }),
  replyMonitor: Object.freeze({
    threshold: 3,
    cooldownMs: 15 * 60 * 1000,
    authCooldownMs: 30 * 60 * 1000,
    severeCooldownMs: 2 * 60 * 60 * 1000
  })
});

class LinkedInAccountHealthStore {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.storePath = options.storePath || resolveInternalStatePath('linkedin-account-health.json');
    this._repo = options.db ? new SqliteAccountHealthRepository(options.db) : null;
  }

  getAllAccountHealth() {
    const now = new Date();
    const store = this.readStore(now);
    return Object.entries(store.accounts || {}).reduce((accumulator, [accountId, accountState]) => {
      accumulator[accountId] = normalizeAccountState(accountState, now);
      return accumulator;
    }, {});
  }

  getAccountHealth(accountId) {
    const normalizedAccountId = cleanString(accountId, 120);
    if (!normalizedAccountId) return null;
    const store = this.readStore(new Date());
    return normalizeAccountState(store.accounts?.[normalizedAccountId], new Date());
  }

  isChallenged(accountId) {
    const normalizedAccountId = cleanString(accountId, 120);
    if (!normalizedAccountId) return false;
    const store = this.readStore(new Date());
    const accountState = normalizeAccountState(store.accounts?.[normalizedAccountId], new Date());
    return Boolean(accountState.challenged);
  }

  isCoolingDown(accountId, subsystem, now = new Date()) {
    const normalizedAccountId = cleanString(accountId, 120);
    const normalizedSubsystem = normalizeSubsystem(subsystem);
    if (!normalizedAccountId || !normalizedSubsystem) return false;
    const store = this.readStore(now);
    const accountState = normalizeAccountState(store.accounts?.[normalizedAccountId], now);
    return accountState[normalizedSubsystem].status === HEALTH_STATUSES.cooldown;
  }

  getCoolingDownAccountIds(subsystem, now = new Date()) {
    const normalizedSubsystem = normalizeSubsystem(subsystem);
    if (!normalizedSubsystem) return [];
    const store = this.readStore(now);
    return Object.entries(store.accounts || {})
      .filter(([, accountState]) => {
        const normalized = normalizeAccountState(accountState, now);
        return normalized[normalizedSubsystem].status === HEALTH_STATUSES.cooldown;
      })
      .map(([accountId]) => accountId);
  }

  getChallengedAccountIds(now = new Date()) {
    const store = this.readStore(now);
    return Object.entries(store.accounts || {})
      .filter(([, accountState]) => Boolean(normalizeAccountState(accountState, now).challenged))
      .map(([accountId]) => accountId);
  }

  recordSuccess(accountId, subsystem, meta = {}) {
    return this.updateAccountSubsystem(accountId, subsystem, (currentState, now) => ({
      ...currentState,
      status: HEALTH_STATUSES.healthy,
      consecutiveFailures: 0,
      cooldownUntil: null,
      cooldownReason: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: cleanString(meta.timestamp, 80) || now.toISOString(),
      lastUpdatedAt: now.toISOString()
    }));
  }

  recordFailure(accountId, subsystem, errorInput, meta = {}) {
    return this.updateAccountSubsystem(accountId, subsystem, (currentState, now) => {
      const nextConsecutiveFailures = Math.max(0, Number(currentState.consecutiveFailures || 0)) + 1;
      const classification = classifyRuntimeIssue(errorInput);
      const cooldownMs = resolveCooldownMs(subsystem, classification, nextConsecutiveFailures, meta);
      const cooldownUntil = cooldownMs > 0
        ? new Date(now.getTime() + cooldownMs).toISOString()
        : null;

      return {
        ...currentState,
        status: cooldownUntil ? HEALTH_STATUSES.cooldown : HEALTH_STATUSES.warning,
        consecutiveFailures: nextConsecutiveFailures,
        cooldownUntil,
        cooldownReason: cooldownUntil ? classification : null,
        lastError: cleanString(errorInput, 400) || 'Unknown error',
        lastErrorAt: cleanString(meta.timestamp, 80) || now.toISOString(),
        lastUpdatedAt: now.toISOString()
      };
    });
  }

  recordChallenge(accountId, type, source = null, meta = {}) {
    return this.updateAccount(accountId, (currentState, now) => ({
      ...currentState,
      challenged: normalizeChallengeState({
        at: cleanString(meta.timestamp, 80) || now.toISOString(),
        type,
        source
      })
    }));
  }

  clearChallenge(accountId) {
    return this.updateAccount(accountId, (currentState) => ({
      ...currentState,
      challenged: null
    }));
  }

  updateAccountSubsystem(accountId, subsystem, updater) {
    const normalizedAccountId = cleanString(accountId, 120);
    const normalizedSubsystem = normalizeSubsystem(subsystem);
    if (!normalizedAccountId || !normalizedSubsystem || typeof updater !== 'function') {
      return null;
    }

    const now = new Date();

    if (this._repo) {
      const accountsMap = this._repo.readAll();
      const accountState = normalizeAccountState(accountsMap[normalizedAccountId], now);
      accountState[normalizedSubsystem] = normalizeSubsystemState(
        updater(accountState[normalizedSubsystem], now),
        now
      );
      this._repo.upsertSubsystem(normalizedAccountId, normalizedSubsystem, accountState[normalizedSubsystem]);
      return accountState[normalizedSubsystem];
    }

    const store = this.readStore(now);
    store.accounts = store.accounts && typeof store.accounts === 'object' ? store.accounts : {};
    const accountState = normalizeAccountState(store.accounts[normalizedAccountId], now);
    accountState[normalizedSubsystem] = normalizeSubsystemState(
      updater(accountState[normalizedSubsystem], now),
      now
    );
    accountState.updatedAt = now.toISOString();
    store.accounts[normalizedAccountId] = accountState;
    writeJsonFileAtomic(this.storePath, store);
    return accountState[normalizedSubsystem];
  }

  updateAccount(accountId, updater) {
    const normalizedAccountId = cleanString(accountId, 120);
    if (!normalizedAccountId || typeof updater !== 'function') {
      return null;
    }

    const now = new Date();

    if (this._repo) {
      const accountsMap = this._repo.readAll();
      const accountState = normalizeAccountState(accountsMap[normalizedAccountId], now);
      const nextAccountState = normalizeAccountState(updater(accountState, now), now);
      nextAccountState.updatedAt = now.toISOString();
      // Upsert all subsystems and the challenge row.
      for (const sub of ['workflow', 'replyMonitor']) {
        this._repo.upsertSubsystem(normalizedAccountId, sub, nextAccountState[sub]);
      }
      this._repo.upsertChallenge(normalizedAccountId, nextAccountState.challenged);
      return nextAccountState;
    }

    const store = this.readStore(now);
    store.accounts = store.accounts && typeof store.accounts === 'object' ? store.accounts : {};
    const accountState = normalizeAccountState(store.accounts[normalizedAccountId], now);
    const nextAccountState = normalizeAccountState(updater(accountState, now), now);
    nextAccountState.updatedAt = now.toISOString();
    store.accounts[normalizedAccountId] = nextAccountState;
    writeJsonFileAtomic(this.storePath, store);
    return nextAccountState;
  }

  readStore(now = new Date()) {
    if (this._repo) {
      return {
        version:  STORE_VERSION,
        accounts: normalizeAccountsMap(this._repo.readAll(), now)
      };
    }

    const fallback = {
      version: STORE_VERSION,
      accounts: {}
    };
    const store = readJsonFile(this.storePath, fallback);
    return {
      version: Number(store.version) || STORE_VERSION,
      accounts: normalizeAccountsMap(store.accounts, now)
    };
  }
}

function normalizeAccountsMap(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((accumulator, [accountId, accountState]) => {
    const normalizedAccountId = cleanString(accountId, 120);
    if (!normalizedAccountId) {
      return accumulator;
    }
    accumulator[normalizedAccountId] = normalizeAccountState(accountState, now);
    return accumulator;
  }, {});
}

function normalizeAccountState(value, now = new Date()) {
  return {
    workflow: normalizeSubsystemState(value?.workflow, now),
    replyMonitor: normalizeSubsystemState(value?.replyMonitor, now),
    challenged: normalizeChallengeState(value?.challenged),
    updatedAt: cleanString(value?.updatedAt, 80) || null
  };
}

function normalizeChallengeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const at = normalizeOptionalTimestamp(value.at || value.detectedAt);
  if (!at) {
    return null;
  }

  return {
    at,
    type: normalizeChallengeType(value.type) || 'unknown',
    source: cleanString(value.source, 120) || null
  };
}

function normalizeSubsystemState(value, now = new Date()) {
  const cooldownUntil = cleanString(value?.cooldownUntil, 80) || null;
  const isActiveCooldown = cooldownUntil && new Date(cooldownUntil).getTime() > now.getTime();
  const hasError = cleanString(value?.lastError, 400).length > 0;

  return {
    status: isActiveCooldown
      ? HEALTH_STATUSES.cooldown
      : (hasError ? HEALTH_STATUSES.warning : HEALTH_STATUSES.healthy),
    lastSuccessAt: cleanString(value?.lastSuccessAt, 80) || null,
    lastErrorAt: cleanString(value?.lastErrorAt, 80) || null,
    lastError: cleanString(value?.lastError, 400) || null,
    consecutiveFailures: Math.max(0, Number(value?.consecutiveFailures) || 0),
    cooldownUntil: isActiveCooldown ? cooldownUntil : null,
    cooldownReason: isActiveCooldown ? cleanString(value?.cooldownReason, 120) || null : null,
    lastUpdatedAt: cleanString(value?.lastUpdatedAt, 80) || null
  };
}

function normalizeSubsystem(subsystem) {
  const normalized = cleanString(subsystem, 40);
  return SUBSYSTEMS.includes(normalized) ? normalized : null;
}

function normalizeChallengeType(value) {
  const normalized = cleanString(value, 40).toLowerCase();
  return CHALLENGE_TYPES.includes(normalized) ? normalized : null;
}

function classifyRuntimeIssue(errorInput) {
  const message = cleanString(errorInput, 400).toLowerCase();
  if (!message) return 'transient';
  if (/rate limit|too many requests|429|slow down|temporarily restricted/i.test(message)) {
    return 'rate_limit';
  }
  if (/challenge|checkpoint|security|verification|captcha|restricted/i.test(message)) {
    return 'challenge';
  }
  if (/auth|login|credential|password|session|cookie/i.test(message)) {
    return 'auth';
  }
  return 'transient';
}

function resolveCooldownMs(subsystem, classification, consecutiveFailures, meta = {}) {
  const normalizedSubsystem = normalizeSubsystem(subsystem);
  if (!normalizedSubsystem) return 0;
  const policy = DEFAULT_POLICIES[normalizedSubsystem];
  const explicitCooldownMs = Math.max(0, Number(meta.cooldownMs) || 0);
  if (explicitCooldownMs > 0) {
    return explicitCooldownMs;
  }
  if (classification === 'rate_limit' || classification === 'challenge') {
    return policy.severeCooldownMs;
  }
  if (classification === 'auth') {
    return policy.authCooldownMs;
  }
  if (consecutiveFailures >= policy.threshold) {
    return policy.cooldownMs;
  }
  return 0;
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeOptionalTimestamp(value) {
  const candidate = cleanString(value, 80);
  if (!candidate) {
    return null;
  }
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

module.exports = LinkedInAccountHealthStore;
