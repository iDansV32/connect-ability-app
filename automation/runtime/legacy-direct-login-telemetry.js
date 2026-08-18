'use strict';

const ActivityEventStore = require('../../activity-event-store');
const { createId, resolveInternalStatePath } = require('../../connect-documents');
const { openDatabase } = require('../../storage/sqlite-db');

let cachedStore = null;

function getLegacyDirectLoginEventStore() {
  if (cachedStore) {
    return cachedStore;
  }

  try {
    const db = openDatabase(resolveInternalStatePath('connect-ability.db'));
    cachedStore = new ActivityEventStore({ db });
    return cachedStore;
  } catch (_) {
    try {
      cachedStore = new ActivityEventStore();
      return cachedStore;
    } catch (__error) {
      return null;
    }
  }
}

function recordLegacyDirectLoginUsage(input = {}, options = {}) {
  const recordEvent = typeof options.recordEvent === 'function'
    ? options.recordEvent
    : null;
  const entryPoint = String(input.entryPoint || '').trim() || null;
  if (!entryPoint) {
    return null;
  }

  const eventInput = {
    type: 'legacy_direct_login_used',
    id: createId('legacy_direct_login'),
    timestamp: new Date().toISOString(),
    accountId: String(input.accountId || '').trim() || null,
    accountName: String(input.accountName || input.accountEmail || '').trim() || null,
    status: 'warning',
    targetValue: entryPoint,
    metadata: {
      entryPoint,
      accountEmail: String(input.accountEmail || '').trim() || null,
      source: String(input.source || 'legacy_direct_login_guard').trim() || 'legacy_direct_login_guard',
      mode: String(input.mode || process.env.CONNECT_MODE || 'customer').trim().toLowerCase() || 'customer',
      processPid: Number.isFinite(input.processPid) ? input.processPid : process.pid,
      ...(
        input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
          ? input.metadata
          : {}
      )
    }
  };

  try {
    if (recordEvent) {
      return recordEvent(eventInput);
    }
    const store = getLegacyDirectLoginEventStore();
    if (!store) {
      return null;
    }
    return store.append(eventInput);
  } catch (error) {
    if (!recordEvent) {
      try {
        const fallbackStore = new ActivityEventStore();
        return fallbackStore.append(eventInput);
      } catch (_) {
        // Best-effort telemetry only.
      }
    }
    if (process.env.CONNECT_DEBUG_LEGACY_DIRECT_LOGIN_TELEMETRY === '1') {
      console.warn(`Failed to record legacy direct-login usage: ${error.message}`);
    }
    return null;
  }
}

module.exports = {
  recordLegacyDirectLoginUsage
};
