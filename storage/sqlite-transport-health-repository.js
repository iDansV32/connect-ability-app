'use strict';

/**
 * storage/sqlite-transport-health-repository.js
 *
 * SQLite backend for the transport_health table.
 *
 * Row layout (UNIQUE on transport, action, account_email):
 *   Each row stores the failure/success counters and disable state for one
 *   (transport, action, account_email) tuple.
 *
 * Public API
 *   upsert(entry)                             — insert or update one row
 *   get(transport, action, accountEmail)       — read one row (or null)
 *   readAll()                                  — all rows as an entries map
 *   importLegacy(entriesMap)                   — bulk import from JSON store
 */

class SqliteTransportHealthRepository {
  constructor(db) {
    this.db = db;
    this._prep();
  }

  _prep() {
    this._stmtUpsert = this.db.prepare(`
      INSERT INTO transport_health (
        transport, action, account_email,
        failure_count, success_count,
        disabled, disabled_until,
        last_success_at, last_failure_at, last_failure_reason,
        last_updated_at
      ) VALUES (
        @transport, @action, @account_email,
        @failure_count, @success_count,
        @disabled, @disabled_until,
        @last_success_at, @last_failure_at, @last_failure_reason,
        @last_updated_at
      ) ON CONFLICT (transport, action, account_email) DO UPDATE SET
        failure_count       = excluded.failure_count,
        success_count       = excluded.success_count,
        disabled            = excluded.disabled,
        disabled_until      = excluded.disabled_until,
        last_success_at     = excluded.last_success_at,
        last_failure_at     = excluded.last_failure_at,
        last_failure_reason = excluded.last_failure_reason,
        last_updated_at     = excluded.last_updated_at
    `);

    this._stmtGet = this.db.prepare(`
      SELECT * FROM transport_health
      WHERE transport = ? AND action = ? AND account_email = ?
    `);

    this._stmtAll = this.db.prepare(
      'SELECT * FROM transport_health ORDER BY transport, action, account_email'
    );
  }

  upsert(entry) {
    this._stmtUpsert.run({
      transport:           entry.transport,
      action:              entry.action,
      account_email:       entry.accountEmail,
      failure_count:       Math.max(0, Number(entry.failureCount) || 0),
      success_count:       Math.max(0, Number(entry.successCount) || 0),
      disabled:            entry.disabled ? 1 : 0,
      disabled_until:      entry.disabledUntil || null,
      last_success_at:     entry.lastSuccessAt || null,
      last_failure_at:     entry.lastFailureAt || null,
      last_failure_reason: entry.lastFailureReason || null,
      last_updated_at:     entry.lastUpdatedAt || new Date().toISOString()
    });
  }

  get(transport, action, accountEmail) {
    const row = this._stmtGet.get(transport, action, accountEmail);
    return row ? rowToEntry(row) : null;
  }

  readAll() {
    const rows = this._stmtAll.all();
    const entries = {};
    for (const row of rows) {
      const key = `${row.transport}::${row.action}::${row.account_email}`;
      entries[key] = rowToEntry(row);
    }
    return entries;
  }

  importLegacy(entriesMap) {
    const doImport = this.db.transaction(() => {
      for (const [, entry] of Object.entries(entriesMap || {})) {
        if (entry && entry.transport && entry.action && entry.accountEmail) {
          this.upsert(entry);
        }
      }
    });
    doImport();
  }
}

function rowToEntry(row) {
  return {
    transport:         row.transport,
    action:            row.action,
    accountEmail:      row.account_email,
    successCount:      Number(row.success_count) || 0,
    failureCount:      Number(row.failure_count) || 0,
    lastSuccessAt:     row.last_success_at || null,
    lastFailureAt:     row.last_failure_at || null,
    lastFailureReason: row.last_failure_reason || null,
    lastUpdatedAt:     row.last_updated_at || null,
    disabled:          Boolean(row.disabled),
    disabledUntil:     row.disabled_until || null
  };
}

module.exports = SqliteTransportHealthRepository;
