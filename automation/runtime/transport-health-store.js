'use strict';

const path = require('path');
const {
  getConnectAbilityDocumentsDir,
  ensureDirectoryExists,
  readJsonFile,
  writeJsonFileAtomic
} = require('../../connect-documents');

const STORE_VERSION = 1;
const DEFAULT_RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_FAILURE_THRESHOLD = 3;

class TransportHealthStore {
  /**
   * @param {object} [options]
   * @param {import('better-sqlite3').Database} [options.db] - existing SQLite handle (main process)
   * @param {string} [options.dbPath] - path to SQLite DB; a new connection is opened (worker process)
   * @param {string} [options.storePath] - JSON fallback path (no-db mode only)
   * @param {string} [options.documentsDir]
   * @param {number} [options.recoveryWindowMs]
   * @param {number} [options.failureThreshold]
   */
  constructor(options = {}) {
    this.recoveryWindowMs = Math.max(1000, Number(options.recoveryWindowMs) || DEFAULT_RECOVERY_WINDOW_MS);
    this.failureThreshold = Math.max(1, Number(options.failureThreshold) || DEFAULT_FAILURE_THRESHOLD);
    this._ownedDb = null;
    this._repo = null;

    // SQLite backend: prefer injected handle, fall back to opening our own
    if (options.db) {
      try {
        const SqliteTransportHealthRepository = require('../../storage/sqlite-transport-health-repository');
        this._repo = new SqliteTransportHealthRepository(options.db);
      } catch (dbErr) {
        console.warn('[TransportHealthStore] SQLite repo unavailable, falling back to JSON:', dbErr.message);
      }
    } else if (options.dbPath) {
      try {
        const { openDatabase } = require('../../storage/sqlite-db');
        this._ownedDb = openDatabase(options.dbPath);
        const SqliteTransportHealthRepository = require('../../storage/sqlite-transport-health-repository');
        this._repo = new SqliteTransportHealthRepository(this._ownedDb);
      } catch (dbErr) {
        console.warn('[TransportHealthStore] SQLite unavailable in worker, falling back to JSON:', dbErr.message);
        this._ownedDb = null;
      }
    }

    // JSON fallback path (used only when no SQLite backend is available)
    if (!this._repo) {
      this.documentsDir = options.documentsDir || getConnectAbilityDocumentsDir();
      ensureDirectoryExists(this.documentsDir);
      this.storePath = options.storePath || path.join(this.documentsDir, 'transport-health.json');
    } else {
      this.documentsDir = null;
      this.storePath = null;
    }
  }

  /**
   * Close any DB connection we opened ourselves (dbPath mode).
   * Caller must invoke this on process exit to release the file lock.
   */
  close() {
    if (this._ownedDb && typeof this._ownedDb.close === 'function' && this._ownedDb.open) {
      this._ownedDb.close();
      this._ownedDb = null;
    }
  }

  getTransportState(transport, action, accountEmail, now = new Date()) {
    const t = normalizeTransport(transport);
    const a = normalizeAction(action);
    const e = normalizeAccountEmail(accountEmail);
    if (!t || !a || !e) return null;

    if (this._repo) {
      const raw = this._repo.get(t, a, e);
      return raw ? normalizeEntry(raw, now) : null;
    }

    // JSON fallback
    const key = buildEntryKey(transport, action, accountEmail);
    if (!key) return null;
    const store = this._readJsonStore(now);
    return store.entries[key] || null;
  }

  isTransportDisabled(transport, action, accountEmail, now = new Date()) {
    const state = this.getTransportState(transport, action, accountEmail, now);
    return Boolean(state?.disabled);
  }

  readStore(now = new Date()) {
    if (this._repo) {
      const rawEntries = this._repo.readAll();
      const entries = {};
      for (const [key, raw] of Object.entries(rawEntries)) {
        entries[key] = normalizeEntry(raw, now);
      }
      return { version: STORE_VERSION, entries };
    }
    return this._readJsonStore(now);
  }

  recordSuccess(transport, action, accountEmail, meta = {}) {
    return this._updateEntry(transport, action, accountEmail, (entry, now) => ({
      ...entry,
      successCount: Math.max(0, Number(entry.successCount || 0)) + 1,
      failureCount: 0,
      lastSuccessAt: cleanTimestamp(meta.timestamp) || now.toISOString(),
      lastUpdatedAt: now.toISOString(),
      disabled: false,
      disabledUntil: null
    }), meta.timestamp);
  }

  recordFailure(transport, action, accountEmail, meta = {}) {
    return this._updateEntry(transport, action, accountEmail, (entry, now) => {
      const nextFailureCount = Math.max(0, Number(entry.failureCount || 0)) + 1;
      const disabled = nextFailureCount >= this.failureThreshold;
      const disabledUntil = disabled
        ? new Date(now.getTime() + this.recoveryWindowMs).toISOString()
        : null;

      return {
        ...entry,
        failureCount: nextFailureCount,
        lastFailureAt: cleanTimestamp(meta.timestamp) || now.toISOString(),
        lastFailureReason: cleanString(meta.reason, 200) || null,
        lastUpdatedAt: now.toISOString(),
        disabled,
        disabledUntil
      };
    }, meta.timestamp);
  }

  /**
   * Bulk import entries from the legacy JSON store into SQLite.
   * No-op when no SQLite backend is active.
   */
  importLegacyEntries(entriesMap) {
    if (this._repo) {
      this._repo.importLegacy(entriesMap);
    }
  }

  // ---- internal ----

  _updateEntry(transport, action, accountEmail, updater, timestamp = null) {
    const t = normalizeTransport(transport);
    const a = normalizeAction(action);
    const e = normalizeAccountEmail(accountEmail);
    if (!t || !a || !e || typeof updater !== 'function') {
      return null;
    }

    const now = parseUpdateTime(timestamp);

    if (this._repo) {
      const raw = this._repo.get(t, a, e);
      const current = raw
        ? normalizeEntry(raw, now)
        : createEmptyEntry(t, a, e);
      const updated = normalizeEntry(updater(current, now), now);
      this._repo.upsert(updated);
      return updated;
    }

    // JSON fallback
    return this._updateJsonEntry(transport, action, accountEmail, updater, timestamp);
  }

  // ---- JSON fallback methods (kept for no-db mode) ----

  _readJsonStore(now = new Date()) {
    const fallback = { version: STORE_VERSION, entries: {} };
    const store = readJsonFile(this.storePath, fallback);
    return {
      version: Number(store.version) || STORE_VERSION,
      entries: normalizeEntries(store.entries, now)
    };
  }

  _updateJsonEntry(transport, action, accountEmail, updater, timestamp = null) {
    const key = buildEntryKey(transport, action, accountEmail);
    if (!key || typeof updater !== 'function') {
      return null;
    }

    const now = parseUpdateTime(timestamp);
    const store = this._readJsonStore(now);
    const current = store.entries[key] || createEmptyEntry(
      normalizeTransport(transport),
      normalizeAction(action),
      normalizeAccountEmail(accountEmail)
    );
    store.entries[key] = normalizeEntry(updater(current, now), now);
    writeJsonFileAtomic(this.storePath, store);
    return store.entries[key];
  }
}

// ---- pure helpers ----

function normalizeEntries(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((accumulator, [key, entry]) => {
    const normalizedKey = cleanString(key, 400);
    if (!normalizedKey) {
      return accumulator;
    }
    accumulator[normalizedKey] = normalizeEntry(entry, now);
    return accumulator;
  }, {});
}

function normalizeEntry(value, now = new Date()) {
  const transport = normalizeTransport(value?.transport);
  const action = normalizeAction(value?.action);
  const accountEmail = normalizeAccountEmail(value?.accountEmail);
  const lastSuccessAt = cleanTimestamp(value?.lastSuccessAt);
  const lastFailureAt = cleanTimestamp(value?.lastFailureAt);
  const lastUpdatedAt = cleanTimestamp(value?.lastUpdatedAt);
  const disabledUntil = cleanTimestamp(value?.disabledUntil);
  const rawDisabled = value?.disabled === true || Boolean(disabledUntil);
  const stillDisabled = disabledUntil && new Date(disabledUntil).getTime() > now.getTime();
  const rawFailureCount = Math.max(0, Number(value?.failureCount) || 0);

  return {
    transport,
    action,
    accountEmail,
    successCount: Math.max(0, Number(value?.successCount) || 0),
    failureCount: rawDisabled && !stillDisabled ? 0 : rawFailureCount,
    lastSuccessAt: lastSuccessAt || null,
    lastFailureAt: lastFailureAt || null,
    lastFailureReason: cleanString(value?.lastFailureReason, 200) || null,
    lastUpdatedAt: lastUpdatedAt || null,
    disabled: Boolean(stillDisabled),
    disabledUntil: stillDisabled ? disabledUntil : null
  };
}

function createEmptyEntry(transport, action, accountEmail) {
  return {
    transport,
    action,
    accountEmail,
    successCount: 0,
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    lastUpdatedAt: null,
    disabled: false,
    disabledUntil: null
  };
}

function buildEntryKey(transport, action, accountEmail) {
  const normalizedTransport = normalizeTransport(transport);
  const normalizedAction = normalizeAction(action);
  const normalizedAccountEmail = normalizeAccountEmail(accountEmail);
  if (!normalizedTransport || !normalizedAction || !normalizedAccountEmail) {
    return null;
  }
  return `${normalizedTransport}::${normalizedAction}::${normalizedAccountEmail}`;
}

function normalizeTransport(value) {
  const normalized = cleanString(value, 40).toLowerCase();
  return normalized || null;
}

function normalizeAction(value) {
  const normalized = cleanString(value, 80).toLowerCase();
  return normalized || null;
}

function normalizeAccountEmail(value) {
  const normalized = cleanString(value, 240).toLowerCase();
  return normalized || null;
}

function cleanTimestamp(value) {
  const normalized = cleanString(value, 80);
  return normalized || null;
}

function parseUpdateTime(value) {
  const normalized = cleanTimestamp(value);
  if (!normalized) {
    return new Date();
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = TransportHealthStore;
module.exports.DEFAULT_RECOVERY_WINDOW_MS = DEFAULT_RECOVERY_WINDOW_MS;
module.exports.DEFAULT_FAILURE_THRESHOLD = DEFAULT_FAILURE_THRESHOLD;
