'use strict';

/**
 * storage/reply-monitor-legacy-importer.js
 *
 * One-time idempotent imports for the reply-monitor and inbox JSON stores.
 *
 *   importNotifications(db, { statePath })
 *     Imports the notifications dict from dm-reply-monitor.json.
 *     Idempotency: skips if notifications table already has rows.
 *
 *   importReplyMonitorState(db, { statePath })
 *     Imports account poll state + conversation cursors from dm-reply-monitor.json.
 *     Idempotency: skips if reply_monitor_state already has rows (excluding _global_).
 *
 *   importInboxConversations(db, { storePath })
 *     Imports conversation records from inbox.json.
 *     Idempotency: skips if inbox_conversations already has rows.
 *
 * Each function returns { imported: boolean, count: number }.
 */

const { readJsonFile } = require('../connect-documents');
const SqliteNotificationRepository    = require('./sqlite-notification-repository');
const SqliteInboxRepository           = require('./sqlite-inbox-repository');
const SqliteReplyMonitorRepository    = require('./sqlite-reply-monitor-repository');

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ statePath: string }} options
 * @returns {{ imported: boolean, count: number }}
 */
function importNotifications(db, { statePath }) {
  const repo = new SqliteNotificationRepository(db);
  if (repo.count() > 0) {
    return { imported: false, count: 0 };
  }

  const state = readJsonFile(statePath, { notifications: {} });
  const notifications = Object.values(state.notifications || {}).filter(Boolean);
  if (!notifications.length) {
    return { imported: false, count: 0 };
  }

  // Normalize for import — maps JS field names to what upsert expects
  const normalized = notifications.map((n) => ({
    id:               n.id,
    accountId:        n.accountId        || null,
    accountName:      n.accountName      || null,
    senderName:       n.senderName       || 'LinkedIn reply',
    text:             n.text             || '',
    workflowId:       n.workflowId       || null,
    workflowName:     n.workflowName     || null,
    runId:            n.runId            || null,
    agentId:          n.agentId          || null,
    agentName:        n.agentName        || null,
    conversationUrn:  n.conversationUrn  || null,
    messageKey:       n.messageKey       || null,
    senderProfileUrn: n.senderProfileUrn || null,
    deliveredAt:      Number(n.deliveredAt) || 0,
    readAt:           n.readAt           || null,
    createdAt:        n.createdAt        || new Date().toISOString(),
    updatedAt:        n.updatedAt        || n.createdAt || new Date().toISOString()
  })).filter((n) => n.id);

  if (!normalized.length) {
    return { imported: false, count: 0 };
  }

  repo.importLegacy(normalized);
  return { imported: true, count: normalized.length };
}

// ---------------------------------------------------------------------------
// Reply-monitor account state + cursors
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ statePath: string }} options
 * @returns {{ imported: boolean, count: number }}
 */
function importReplyMonitorState(db, { statePath }) {
  const repo = new SqliteReplyMonitorRepository(db);
  if (repo.count() > 0) {
    return { imported: false, count: 0 };
  }

  const state = readJsonFile(statePath, { accounts: {} });
  const accounts = state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
  const accountEntries = Object.entries(accounts).filter(([id]) => id);
  if (!accountEntries.length) {
    return { imported: false, count: 0 };
  }

  // Build a state object in the shape readFullState() returns
  const stateForImport = {
    lastPolledAt: state.lastPolledAt || null,
    accounts: Object.fromEntries(
      accountEntries.map(([accountId, accountState]) => [
        accountId,
        {
          initialized:   Boolean(accountState.initialized),
          mailboxUrn:    accountState.mailboxUrn    || null,
          lastSuccessAt: accountState.lastSuccessAt || null,
          lastError:     accountState.lastError     || null,
          conversations: Object.fromEntries(
            Object.entries(accountState.conversations || {}).map(([urn, cursor]) => [
              urn,
              {
                lastActivityAt:         Number(cursor.lastActivityAt)         || 0,
                lastInboundDeliveredAt: Number(cursor.lastInboundDeliveredAt) || 0,
                lastMessageKey:         cursor.lastMessageKey                 || null,
                participantNames:       Array.isArray(cursor.participantNames) ? cursor.participantNames : []
              }
            ])
          )
        }
      ])
    )
  };

  repo.saveFullState(stateForImport);

  const accountCount = accountEntries.length;
  return { imported: true, count: accountCount };
}

// ---------------------------------------------------------------------------
// Inbox conversations
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ storePath: string }} options
 * @returns {{ imported: boolean, count: number }}
 */
function importInboxConversations(db, { storePath }) {
  const repo = new SqliteInboxRepository(db);
  if (repo.count() > 0) {
    return { imported: false, count: 0 };
  }

  const store = readJsonFile(storePath, { conversations: {} });
  const conversations = Object.values(store.conversations || {}).filter(Boolean);
  if (!conversations.length) {
    return { imported: false, count: 0 };
  }

  // Normalize for import
  const normalized = conversations.map((c) => ({
    conversationUrn:       c.conversationUrn,
    accountId:             c.accountId              || null,
    accountName:           c.accountName            || null,
    mailboxUrn:            c.mailboxUrn             || null,
    participantProfileUrn: c.participantProfileUrn  || null,
    participantNames:      Array.isArray(c.participantNames) ? c.participantNames : [],
    workflowId:            c.workflowId             || null,
    workflowName:          c.workflowName           || null,
    runId:                 c.runId                  || null,
    prospectId:            c.prospectId             || null,
    agentId:               c.agentId                || null,
    agentName:             c.agentName              || null,
    lastInboundAt:         Number(c.lastInboundAt)  || 0,
    lastOutboundAt:        Number(c.lastOutboundAt) || 0,
    status:                c.status                 || 'active',
    intentLabel:           c.intentLabel            || null,
    lastMessagePreview:    c.lastMessagePreview      || null,
    messages:              Array.isArray(c.messages) ? c.messages : [],
    createdAt:             c.createdAt              || new Date().toISOString(),
    updatedAt:             c.updatedAt              || new Date().toISOString()
  })).filter((c) => c.conversationUrn);

  if (!normalized.length) {
    return { imported: false, count: 0 };
  }

  repo.importLegacy(normalized);
  return { imported: true, count: normalized.length };
}

module.exports = {
  importNotifications,
  importReplyMonitorState,
  importInboxConversations
};
