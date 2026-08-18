'use strict';

/**
 * storage/sqlite-reply-monitor-repository.js
 *
 * SQLite backend for LinkedInReplyMonitor's poll-cursor state:
 *   - reply_monitor_state  — per-account initialized/mailboxUrn/lastSuccess/lastError
 *   - reply_monitor_cursors — per-(account,conversation) activity cursor
 *
 * Global state (lastPolledAt) is stored as a special row with
 * account_id = '_global_'.
 *
 * readFullState() reconstructs the in-memory state object that LinkedInReplyMonitor
 * expects:
 *   {
 *     version: 2,
 *     lastPolledAt: string|null,
 *     accounts: {
 *       [accountId]: {
 *         initialized: boolean,
 *         mailboxUrn: string|null,
 *         lastSuccessAt: string|null,
 *         lastError: string|null,
 *         conversations: {
 *           [conversationUrn]: {
 *             lastActivityAt: number,
 *             lastInboundDeliveredAt: number,
 *             lastMessageKey: string|null,
 *             participantNames: string[]
 *           }
 *         }
 *       }
 *     }
 *   }
 */

function safeParseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

const GLOBAL_ROW = '_global_';

class SqliteReplyMonitorRepository {
  constructor(db) {
    this._db = db;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Reconstruct the full in-memory state object from SQLite.
   * @returns {{ version: number, lastPolledAt: string|null, accounts: object }}
   */
  readFullState() {
    const stateRows = this._db
      .prepare('SELECT * FROM reply_monitor_state')
      .all();

    const cursorRows = this._db
      .prepare('SELECT * FROM reply_monitor_cursors')
      .all();

    let lastPolledAt = null;
    const accounts = {};

    for (const row of stateRows) {
      if (row.account_id === GLOBAL_ROW) {
        lastPolledAt = row.last_success_at || null;
        continue;
      }
      accounts[row.account_id] = {
        initialized:   Boolean(row.initialized),
        mailboxUrn:    row.mailbox_urn    || null,
        lastSuccessAt: row.last_success_at || null,
        lastError:     row.last_error     || null,
        conversations: {}
      };
    }

    for (const row of cursorRows) {
      const accountId = row.account_id;
      if (!accounts[accountId]) {
        // Account state row may not exist yet — create a minimal entry
        accounts[accountId] = {
          initialized: false,
          mailboxUrn: null,
          lastSuccessAt: null,
          lastError: null,
          conversations: {}
        };
      }
      accounts[accountId].conversations[row.conversation_urn] = {
        lastActivityAt:          Number(row.last_activity_at)            || 0,
        lastInboundDeliveredAt:  Number(row.last_inbound_delivered_at)   || 0,
        lastMessageKey:          row.last_message_key                    || null,
        participantNames:        safeParseJson(row.participant_names_json, [])
      };
    }

    return { version: 2, lastPolledAt, accounts };
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Flush the full in-memory state object back to SQLite.
   * Writes accounts + cursors in one transaction.
   * Notifications are handled separately by SqliteNotificationRepository.
   *
   * @param {object} state — the same shape as readFullState() returns
   */
  saveFullState(state) {
    const now = new Date().toISOString();
    const doSave = this._db.transaction(() => {
      // Global row (lastPolledAt)
      if (state.lastPolledAt) {
        this._db.prepare(`
          INSERT INTO reply_monitor_state (account_id, initialized, last_success_at, updated_at)
          VALUES (?, 0, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            last_success_at = excluded.last_success_at,
            updated_at      = excluded.updated_at
        `).run(GLOBAL_ROW, state.lastPolledAt, now);
      }

      // Per-account rows
      for (const [accountId, accountState] of Object.entries(state.accounts || {})) {
        this._db.prepare(`
          INSERT INTO reply_monitor_state
            (account_id, initialized, mailbox_urn, last_success_at, last_error, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            initialized     = excluded.initialized,
            mailbox_urn     = excluded.mailbox_urn,
            last_success_at = excluded.last_success_at,
            last_error      = excluded.last_error,
            updated_at      = excluded.updated_at
        `).run(
          accountId,
          accountState.initialized ? 1 : 0,
          accountState.mailboxUrn    || null,
          accountState.lastSuccessAt || null,
          accountState.lastError     || null,
          now
        );

        // Per-conversation cursors
        for (const [conversationUrn, cursor] of Object.entries(accountState.conversations || {})) {
          this._db.prepare(`
            INSERT INTO reply_monitor_cursors
              (account_id, conversation_urn, last_activity_at, last_inbound_delivered_at,
               last_message_key, participant_names_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, conversation_urn) DO UPDATE SET
              last_activity_at           = excluded.last_activity_at,
              last_inbound_delivered_at  = excluded.last_inbound_delivered_at,
              last_message_key           = excluded.last_message_key,
              participant_names_json     = excluded.participant_names_json,
              updated_at                 = excluded.updated_at
          `).run(
            accountId,
            conversationUrn,
            Number(cursor.lastActivityAt)           || 0,
            Number(cursor.lastInboundDeliveredAt)   || 0,
            cursor.lastMessageKey                   || null,
            JSON.stringify(Array.isArray(cursor.participantNames) ? cursor.participantNames : []),
            now
          );
        }
      }
    });
    doSave();
  }

  /**
   * Count of account rows (excluding _global_).
   * Used for idempotency check in importer.
   */
  count() {
    return this._db
      .prepare(`SELECT COUNT(*) AS n FROM reply_monitor_state WHERE account_id != '${GLOBAL_ROW}'`)
      .get().n;
  }
}

module.exports = SqliteReplyMonitorRepository;
