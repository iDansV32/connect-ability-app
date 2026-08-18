'use strict';

/**
 * storage/sqlite-notification-repository.js
 *
 * SQLite backend for the `notifications` table.
 * Mirrors the notification dict stored in dm-reply-monitor.json.
 *
 * The `message_text` column maps to the JS `text` field (legacy column name
 * from the original schema scaffold).
 */

function safeParseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function notificationToRow(n) {
  return {
    id:                 n.id,
    account_id:         n.accountId         || null,
    account_name:       n.accountName       || null,
    sender_name:        n.senderName        || 'LinkedIn reply',
    message_text:       n.text              || '',
    workflow_id:        n.workflowId        || null,
    workflow_name:      n.workflowName      || null,
    run_id:             n.runId             || null,
    agent_id:           n.agentId           || null,
    agent_name:         n.agentName         || null,
    conversation_urn:   n.conversationUrn   || null,
    message_key:        n.messageKey        || null,
    sender_profile_urn: n.senderProfileUrn  || null,
    delivered_at:       Number(n.deliveredAt) || 0,
    read_at:            n.readAt            || null,
    created_at:         n.createdAt         || new Date().toISOString(),
    updated_at:         n.updatedAt         || new Date().toISOString()
  };
}

function rowToNotification(row) {
  return {
    id:               row.id,
    accountId:        row.account_id         || null,
    accountName:      row.account_name       || null,
    senderName:       row.sender_name        || 'LinkedIn reply',
    text:             row.message_text       || '',
    workflowId:       row.workflow_id        || null,
    workflowName:     row.workflow_name      || null,
    runId:            row.run_id             || null,
    agentId:          row.agent_id           || null,
    agentName:        row.agent_name         || null,
    conversationUrn:  row.conversation_urn   || null,
    messageKey:       row.message_key        || null,
    senderProfileUrn: row.sender_profile_urn || null,
    deliveredAt:      Number(row.delivered_at) || 0,
    readAt:           row.read_at            || null,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at         || row.created_at
  };
}

class SqliteNotificationRepository {
  constructor(db) {
    this._db = db;
  }

  /**
   * Insert or replace a notification.
   * Preserves `read_at` / `created_at` from existing row on conflict.
   */
  upsert(notification) {
    const row = notificationToRow(notification);
    this._db.prepare(`
      INSERT INTO notifications (
        id, account_id, account_name, sender_name, message_text,
        workflow_id, workflow_name, run_id, agent_id, agent_name,
        conversation_urn, message_key, sender_profile_urn,
        delivered_at, read_at, created_at, updated_at
      ) VALUES (
        @id, @account_id, @account_name, @sender_name, @message_text,
        @workflow_id, @workflow_name, @run_id, @agent_id, @agent_name,
        @conversation_urn, @message_key, @sender_profile_urn,
        @delivered_at, @read_at, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        account_id         = excluded.account_id,
        account_name       = excluded.account_name,
        sender_name        = excluded.sender_name,
        message_text       = excluded.message_text,
        workflow_id        = excluded.workflow_id,
        workflow_name      = excluded.workflow_name,
        run_id             = excluded.run_id,
        agent_id           = excluded.agent_id,
        agent_name         = excluded.agent_name,
        conversation_urn   = excluded.conversation_urn,
        message_key        = excluded.message_key,
        sender_profile_urn = excluded.sender_profile_urn,
        delivered_at       = excluded.delivered_at,
        read_at            = COALESCE(notifications.read_at, excluded.read_at),
        updated_at         = excluded.updated_at
    `).run(row);
  }

  /**
   * Find all notifications, optionally filtered.
   * @param {object} [filters]
   * @param {string} [filters.accountId]
   * @param {boolean} [filters.unreadOnly]
   * @param {number} [filters.limit]
   * @returns {object[]}
   */
  findAll(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.accountId) {
      conditions.push('account_id = ?');
      params.push(filters.accountId);
    }
    if (filters.unreadOnly) {
      conditions.push('read_at IS NULL');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ? `LIMIT ${Math.max(1, Number(filters.limit))}` : '';
    const rows = this._db
      .prepare(`SELECT * FROM notifications ${where} ORDER BY delivered_at DESC ${limit}`)
      .all(...params);

    return rows.map(rowToNotification);
  }

  /** @returns {object|null} */
  findById(id) {
    const row = this._db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
    return row ? rowToNotification(row) : null;
  }

  /**
   * Mark a single notification as read.
   * @returns {object|null} updated notification or null if not found
   */
  markRead(id, readAt) {
    const now = readAt || new Date().toISOString();
    this._db.prepare(`
      UPDATE notifications SET read_at = ?, updated_at = ?
      WHERE id = ? AND read_at IS NULL
    `).run(now, now, id);
    return this.findById(id);
  }

  /**
   * Mark all unread notifications for an account as read.
   * @returns {number} count of rows updated
   */
  markAllRead(accountId, readAt) {
    const now = readAt || new Date().toISOString();
    if (accountId) {
      const result = this._db.prepare(`
        UPDATE notifications SET read_at = ?, updated_at = ?
        WHERE read_at IS NULL AND account_id = ?
      `).run(now, now, accountId);
      return result.changes;
    }
    const result = this._db.prepare(`
      UPDATE notifications SET read_at = ?, updated_at = ?
      WHERE read_at IS NULL
    `).run(now, now);
    return result.changes;
  }

  /** Count of unread notifications, optionally for a specific account. */
  countUnread(accountId) {
    if (accountId) {
      return this._db
        .prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND account_id = ?')
        .get(accountId).n;
    }
    return this._db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL')
      .get().n;
  }

  /** Total count — used for idempotency guard in importer. */
  count() {
    return this._db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
  }

  /**
   * Delete oldest rows beyond `limit` (keep the most recent `limit` rows).
   * Mirrors pruneReplyNotifications in linkedin-reply-monitor.js.
   */
  pruneToLimit(limit) {
    const total = this.count();
    if (total <= limit) return;
    this._db.prepare(`
      DELETE FROM notifications WHERE id IN (
        SELECT id FROM notifications
        ORDER BY delivered_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(limit);
  }

  /**
   * Bulk-upsert an array of notifications inside a single transaction.
   */
  importLegacy(notifications) {
    const doImport = this._db.transaction(() => {
      for (const n of notifications) {
        this.upsert(n);
      }
    });
    doImport();
  }
}

module.exports = SqliteNotificationRepository;
