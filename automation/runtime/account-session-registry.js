const path = require('path');
const fs = require('fs');

const {
  ensureParentDirectory,
  getConnectAbilityAppStateDir,
  getConnectAbilityDocumentsDir,
  readJsonFile,
  writeJsonFileAtomic
} = require('../../connect-documents');

const STORE_VERSION = 1;
const VERIFIED_BY_VALUES = new Set(['canary', 'action', 'login']);
const DEFAULT_SESSION_VERIFICATION_MAX_AGE_MS = 4 * 60 * 60 * 1000;

class AccountSessionRegistry {
  constructor(options = {}) {
    this.storePath = String(options.storePath || '').trim()
      || resolveSessionRegistryPath();
  }

  getAccount(email) {
    const accountKey = normalizeEmail(email);
    if (!accountKey) {
      return null;
    }
    const store = this.readStore();
    return store.accounts[accountKey] || null;
  }

  upsertAccount(email, updates = {}) {
    return this.updateAccount(email, (current) => ({
      ...current,
      profilePath: cleanString(updates.profilePath || current.profilePath, 800) || null
    }));
  }

  recordVerified(email, options = {}) {
    const now = resolveTimestamp(options.at);
    return this.updateAccount(email, (current) => ({
      ...current,
      profilePath: cleanString(options.profilePath || current.profilePath, 800) || null,
      lastVerifiedAt: now,
      lastVerifiedBy: normalizeVerifiedBy(options.verifiedBy) || 'action'
    }));
  }

  recordAuthFailure(email, options = {}) {
    const now = resolveTimestamp(options.at);
    return this.updateAccount(email, (current) => ({
      ...current,
      profilePath: cleanString(options.profilePath || current.profilePath, 800) || null,
      lastAuthFailureAt: now
    }));
  }

  recordChallenge(email, options = {}) {
    const now = resolveTimestamp(options.at);
    return this.updateAccount(email, (current) => ({
      ...current,
      profilePath: cleanString(options.profilePath || current.profilePath, 800) || null,
      lastChallengeAt: now
    }));
  }

  shouldReauthenticate(email, options = {}) {
    const record = this.getAccount(email);
    if (!record) {
      return true;
    }

    const maxAgeMs = normalizePositiveInteger(
      options.maxAgeMs,
      DEFAULT_SESSION_VERIFICATION_MAX_AGE_MS
    );
    const now = resolveDate(options.now);
    const verifiedAt = parseTimestamp(record.lastVerifiedAt);
    if (!verifiedAt) {
      return true;
    }

    if ((now.getTime() - verifiedAt.getTime()) > maxAgeMs) {
      return true;
    }

    const authFailureAt = parseTimestamp(record.lastAuthFailureAt);
    if (authFailureAt && authFailureAt.getTime() > verifiedAt.getTime()) {
      return true;
    }

    const challengeAt = parseTimestamp(record.lastChallengeAt);
    if (challengeAt && challengeAt.getTime() > verifiedAt.getTime()) {
      return true;
    }

    return false;
  }

  readStore() {
    const fallback = {
      version: STORE_VERSION,
      accounts: {}
    };
    const store = readJsonFile(this.storePath, fallback);
    return {
      version: Number(store.version) || STORE_VERSION,
      accounts: normalizeAccountsMap(store.accounts)
    };
  }

  updateAccount(email, updater) {
    const accountKey = normalizeEmail(email);
    if (!accountKey || typeof updater !== 'function') {
      return null;
    }

    const store = this.readStore();
    const current = normalizeAccountRecord(store.accounts[accountKey], accountKey);
    const next = normalizeAccountRecord({
      ...updater(current),
      updatedAt: new Date().toISOString()
    }, accountKey);
    store.accounts[accountKey] = next;
    writeJsonFileAtomic(this.storePath, store);
    return next;
  }
}

function resolveSessionRegistryPath() {
  const nextPath = path.join(getConnectAbilityAppStateDir(), 'session-registry.json');
  const legacyPath = path.join(getConnectAbilityDocumentsDir(), 'session-registry.json');

  if (fs.existsSync(nextPath) || !fs.existsSync(legacyPath)) {
    return nextPath;
  }

  try {
    ensureParentDirectory(nextPath);
    fs.copyFileSync(legacyPath, nextPath);
    fs.chmodSync(nextPath, 0o600);
    fs.unlinkSync(legacyPath);
  } catch (_) {
    return legacyPath;
  }

  return nextPath;
}

function normalizeAccountsMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((accumulator, [email, record]) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return accumulator;
    }
    accumulator[normalizedEmail] = normalizeAccountRecord(record, normalizedEmail);
    return accumulator;
  }, {});
}

function normalizeAccountRecord(value, email) {
  return {
    email: normalizeEmail(value?.email || email) || null,
    profilePath: cleanString(value?.profilePath, 800) || null,
    lastVerifiedAt: normalizeOptionalTimestamp(value?.lastVerifiedAt),
    lastVerifiedBy: normalizeVerifiedBy(value?.lastVerifiedBy),
    lastAuthFailureAt: normalizeOptionalTimestamp(value?.lastAuthFailureAt),
    lastChallengeAt: normalizeOptionalTimestamp(value?.lastChallengeAt),
    updatedAt: normalizeOptionalTimestamp(value?.updatedAt) || new Date().toISOString()
  };
}

function normalizeOptionalTimestamp(value) {
  const parsed = parseTimestamp(value);
  return parsed ? parsed.toISOString() : null;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeVerifiedBy(value) {
  const normalized = cleanString(value, 40).toLowerCase();
  return VERIFIED_BY_VALUES.has(normalized) ? normalized : null;
}

function parseTimestamp(value) {
  const candidate = cleanString(value, 80);
  if (!candidate) {
    return null;
  }
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function resolveTimestamp(value) {
  return resolveDate(value).toISOString();
}

function resolveDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime());
  }
  const parsed = parseTimestamp(value);
  if (parsed) {
    return parsed;
  }
  return new Date();
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanString(value, maxLength = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  AccountSessionRegistry,
  DEFAULT_SESSION_VERIFICATION_MAX_AGE_MS
};
