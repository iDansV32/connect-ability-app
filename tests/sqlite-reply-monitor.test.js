'use strict';

/**
 * tests/sqlite-reply-monitor.test.js
 *
 * Targeted tests for Ticket 8 — SQLite migration for reply-monitor and
 * notification state.
 *
 * Covers:
 *  1. Reply-monitor state persists and survives DB close/reopen
 *  2. Notification upsert, read_at preservation on re-upsert
 *  3. Unread count + markRead + markAllRead
 *  4. InboxStore upsert, getAll, setStatus through SQLite
 *  5. InboxStore appendMessages merges and recomputes preview
 *  6. Legacy import — notifications (idempotent)
 *  7. Legacy import — reply-monitor state (idempotent)
 *  8. Legacy import — inbox conversations (idempotent)
 *  9. JSON fallback when db absent (all three stores)
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase, closeDatabase }           = require('../storage/sqlite-db');
const SqliteNotificationRepository             = require('../storage/sqlite-notification-repository');
const SqliteReplyMonitorRepository             = require('../storage/sqlite-reply-monitor-repository');
const SqliteInboxRepository                    = require('../storage/sqlite-inbox-repository');
const InboxStore                               = require('../inbox-store');
const {
  importNotifications,
  importReplyMonitorState,
  importInboxConversations
} = require('../storage/reply-monitor-legacy-importer');
const { createTempWorkspace, writeJson }       = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openTestDb(ws, name = 'monitor.db') {
  return openDatabase(ws.path(name));
}

function makeNotif(overrides = {}) {
  return {
    id:               overrides.id               || 'notif-1',
    accountId:        overrides.accountId        || 'acc-1',
    accountName:      overrides.accountName      || 'Acme',
    senderName:       overrides.senderName       || 'Alice',
    text:             overrides.text             || 'Hello!',
    workflowId:       overrides.workflowId       || null,
    workflowName:     overrides.workflowName     || null,
    runId:            overrides.runId            || null,
    agentId:          overrides.agentId          || null,
    agentName:        overrides.agentName        || null,
    conversationUrn:  overrides.conversationUrn  || 'urn:conv:1',
    messageKey:       overrides.messageKey       || 'msg-key-1',
    senderProfileUrn: overrides.senderProfileUrn || null,
    deliveredAt:      overrides.deliveredAt      || 1700000000000,
    readAt:           overrides.readAt           || null,
    createdAt:        overrides.createdAt        || new Date().toISOString(),
    updatedAt:        overrides.updatedAt        || new Date().toISOString()
  };
}

function makeConversation(overrides = {}) {
  return {
    conversationUrn:       overrides.conversationUrn       || 'urn:conv:1',
    accountId:             overrides.accountId             || 'acc-1',
    accountName:           overrides.accountName           || 'Acme',
    mailboxUrn:            overrides.mailboxUrn            || null,
    participantProfileUrn: overrides.participantProfileUrn || null,
    participantNames:      overrides.participantNames      || ['Alice'],
    workflowId:            overrides.workflowId            || null,
    workflowName:          overrides.workflowName          || null,
    runId:                 overrides.runId                 || null,
    prospectId:            overrides.prospectId            || null,
    agentId:               overrides.agentId               || null,
    agentName:             overrides.agentName             || null,
    lastInboundAt:         overrides.lastInboundAt         || 0,
    lastOutboundAt:        overrides.lastOutboundAt        || 0,
    status:                overrides.status                || 'active',
    intentLabel:           overrides.intentLabel           || null,
    lastMessagePreview:    overrides.lastMessagePreview    || null,
    messages:              overrides.messages              || [],
    createdAt:             overrides.createdAt             || new Date().toISOString(),
    updatedAt:             overrides.updatedAt             || new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// 1. Reply-monitor state persists and survives DB close/reopen
// ---------------------------------------------------------------------------

test('SQLite reply-monitor state persists and survives DB close/reopen', (t) => {
  const ws = createTempWorkspace('rm-state-');
  const dbPath = ws.path('monitor.db');
  let db = openDatabase(dbPath);
  try {
    const repo = new SqliteReplyMonitorRepository(db);

    const state = {
      lastPolledAt: '2024-01-01T00:00:00Z',
      accounts: {
        'acc-1': {
          initialized:   true,
          mailboxUrn:    'urn:mailbox:1',
          lastSuccessAt: '2024-01-01T00:00:00Z',
          lastError:     null,
          conversations: {
            'urn:conv:A': {
              lastActivityAt:         1700000001000,
              lastInboundDeliveredAt: 1700000002000,
              lastMessageKey:         'key-A',
              participantNames:       ['Alice']
            }
          }
        }
      }
    };

    repo.saveFullState(state);

    // Close and reopen
    closeDatabase(db);
    db = openDatabase(dbPath);
    const repo2 = new SqliteReplyMonitorRepository(db);
    const loaded = repo2.readFullState();

    assert.equal(loaded.lastPolledAt, '2024-01-01T00:00:00Z');
    assert.ok(loaded.accounts['acc-1']);
    assert.equal(loaded.accounts['acc-1'].initialized, true);
    assert.equal(loaded.accounts['acc-1'].mailboxUrn, 'urn:mailbox:1');
    const cursor = loaded.accounts['acc-1'].conversations['urn:conv:A'];
    assert.ok(cursor);
    assert.equal(cursor.lastMessageKey, 'key-A');
    assert.deepEqual(cursor.participantNames, ['Alice']);
    assert.equal(cursor.lastActivityAt, 1700000001000);
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 2. Notification upsert + read_at preservation
// ---------------------------------------------------------------------------

test('SQLite notification upsert preserves read_at on re-upsert', (t) => {
  const ws = createTempWorkspace('notif-readat-');
  const db = openTestDb(ws);
  try {
    const repo = new SqliteNotificationRepository(db);
    const notif = makeNotif({ id: 'n-1' });

    // First upsert — unread
    repo.upsert(notif);
    assert.equal(repo.countUnread('acc-1'), 1);

    // Mark read
    repo.markRead('n-1', new Date().toISOString());
    assert.equal(repo.countUnread('acc-1'), 0);

    // Re-upsert should NOT clear read_at
    repo.upsert({ ...notif, text: 'Updated text' });
    const all = repo.findAll({});
    assert.equal(all.length, 1);
    assert.ok(all[0].readAt, 'read_at should still be set after re-upsert');
    assert.equal(all[0].text, 'Updated text', 'text field updated');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 3. Unread count + markAllRead
// ---------------------------------------------------------------------------

test('SQLite notifications markAllRead clears unread for account', (t) => {
  const ws = createTempWorkspace('notif-markall-');
  const db = openTestDb(ws);
  try {
    const repo = new SqliteNotificationRepository(db);

    repo.upsert(makeNotif({ id: 'n-1', accountId: 'acc-1' }));
    repo.upsert(makeNotif({ id: 'n-2', accountId: 'acc-1' }));
    repo.upsert(makeNotif({ id: 'n-3', accountId: 'acc-2' }));

    assert.equal(repo.countUnread('acc-1'), 2);
    assert.equal(repo.countUnread('acc-2'), 1);

    repo.markAllRead('acc-1', new Date().toISOString());

    assert.equal(repo.countUnread('acc-1'), 0, 'acc-1 notifications cleared');
    assert.equal(repo.countUnread('acc-2'), 1, 'acc-2 unread unchanged');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 4. InboxStore upsert, getAll, setStatus through SQLite
// ---------------------------------------------------------------------------

test('SQLite InboxStore upsert / getAll / setStatus', (t) => {
  const ws = createTempWorkspace('inbox-basic-');
  const db = openTestDb(ws);
  try {
    const store = new InboxStore({ db });

    store.upsert('urn:conv:1', makeConversation({ conversationUrn: 'urn:conv:1', accountId: 'acc-1' }));
    store.upsert('urn:conv:2', makeConversation({ conversationUrn: 'urn:conv:2', accountId: 'acc-1', status: 'replied' }));
    store.upsert('urn:conv:3', makeConversation({ conversationUrn: 'urn:conv:3', accountId: 'acc-2' }));

    const all = store.getAll();
    assert.equal(all.length, 3);

    const active = store.getAll({ status: 'active' });
    assert.equal(active.length, 2);

    // setStatus
    store.setStatus('urn:conv:1', 'paused');
    const conv = store.getConversation('urn:conv:1');
    assert.equal(conv.status, 'paused');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 5. InboxStore appendMessages merges and recomputes preview
// ---------------------------------------------------------------------------

test('SQLite InboxStore appendMessages merges messages and recomputes preview', (t) => {
  const ws = createTempWorkspace('inbox-msgs-');
  const db = openTestDb(ws);
  try {
    const store = new InboxStore({ db });

    store.upsert('urn:conv:1', makeConversation({ conversationUrn: 'urn:conv:1' }));

    const msg1 = { messageKey: 'k1', deliveredAt: 1700000001000, senderName: 'Alice', direction: 'inbound', text: 'Hi there' };
    const msg2 = { messageKey: 'k2', deliveredAt: 1700000002000, senderName: 'Bot',   direction: 'outbound', text: 'Hello!' };

    store.appendMessages('urn:conv:1', [msg1]);
    const after1 = store.getConversation('urn:conv:1');
    assert.equal(after1.messages.length, 1);
    assert.equal(after1.lastMessagePreview, 'Hi there');

    store.appendMessages('urn:conv:1', [msg2]);
    const after2 = store.getConversation('urn:conv:1');
    assert.equal(after2.messages.length, 2);
    assert.equal(after2.lastMessagePreview, 'Hello!');
    assert.equal(after2.lastInboundAt, 1700000001000);
    assert.equal(after2.lastOutboundAt, 1700000002000);

    // Dedupe: appending msg1 again should not add a duplicate
    store.appendMessages('urn:conv:1', [msg1]);
    const after3 = store.getConversation('urn:conv:1');
    assert.equal(after3.messages.length, 2, 'duplicate message ignored');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 6. Legacy import — notifications (idempotent)
// ---------------------------------------------------------------------------

test('importNotifications imports from JSON and is idempotent', (t) => {
  const ws = createTempWorkspace('import-notif-');
  const db = openTestDb(ws);
  try {
    const statePath = ws.path('dm-reply-monitor.json');
    writeJson(statePath, {
      notifications: {
        'n-1': makeNotif({ id: 'n-1', accountId: 'acc-1' }),
        'n-2': makeNotif({ id: 'n-2', accountId: 'acc-2' })
      }
    });

    const r1 = importNotifications(db, { statePath });
    assert.equal(r1.imported, true);
    assert.equal(r1.count, 2);

    // Second call — already has rows
    const r2 = importNotifications(db, { statePath });
    assert.equal(r2.imported, false, 'idempotent: skip if rows exist');

    const repo = new SqliteNotificationRepository(db);
    assert.equal(repo.count(), 2, 'exactly two notifications in DB');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 7. Legacy import — reply-monitor state (idempotent)
// ---------------------------------------------------------------------------

test('importReplyMonitorState imports from JSON and is idempotent', (t) => {
  const ws = createTempWorkspace('import-rm-');
  const db = openTestDb(ws);
  try {
    const statePath = ws.path('dm-reply-monitor.json');
    writeJson(statePath, {
      lastPolledAt: '2024-01-01T00:00:00Z',
      accounts: {
        'acc-1': {
          initialized:   true,
          mailboxUrn:    'urn:mailbox:1',
          lastSuccessAt: '2024-01-01T00:00:00Z',
          lastError:     null,
          conversations: {
            'urn:conv:A': {
              lastActivityAt:         1700000001000,
              lastInboundDeliveredAt: 1700000002000,
              lastMessageKey:         'key-A',
              participantNames:       ['Alice']
            }
          }
        }
      }
    });

    const r1 = importReplyMonitorState(db, { statePath });
    assert.equal(r1.imported, true);
    assert.equal(r1.count, 1);

    const r2 = importReplyMonitorState(db, { statePath });
    assert.equal(r2.imported, false, 'idempotent: skip if rows exist');

    const repo = new SqliteReplyMonitorRepository(db);
    const state = repo.readFullState();
    assert.ok(state.accounts['acc-1']);
    assert.equal(state.accounts['acc-1'].mailboxUrn, 'urn:mailbox:1');
    assert.equal(state.accounts['acc-1'].conversations['urn:conv:A'].lastMessageKey, 'key-A');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 8. Legacy import — inbox conversations (idempotent)
// ---------------------------------------------------------------------------

test('importInboxConversations imports from JSON and is idempotent', (t) => {
  const ws = createTempWorkspace('import-inbox-');
  const db = openTestDb(ws);
  try {
    const storePath = ws.path('inbox.json');
    writeJson(storePath, {
      version: 2,
      conversations: {
        'urn:conv:1': makeConversation({ conversationUrn: 'urn:conv:1', accountId: 'acc-1' }),
        'urn:conv:2': makeConversation({ conversationUrn: 'urn:conv:2', accountId: 'acc-2' })
      }
    });

    const r1 = importInboxConversations(db, { storePath });
    assert.equal(r1.imported, true);
    assert.equal(r1.count, 2);

    const r2 = importInboxConversations(db, { storePath });
    assert.equal(r2.imported, false, 'idempotent: skip if rows exist');

    const repo = new SqliteInboxRepository(db);
    assert.equal(repo.count(), 2, 'two conversations in DB');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 9. JSON fallback when db absent
// ---------------------------------------------------------------------------

test('InboxStore falls back to JSON when db is absent', (t) => {
  const ws = createTempWorkspace('inbox-json-fallback-');
  const store = new InboxStore({ storePath: ws.path('inbox.json') });

  store.upsert('urn:conv:X', makeConversation({ conversationUrn: 'urn:conv:X' }));
  const conv = store.getConversation('urn:conv:X');
  assert.ok(conv, 'conversation readable via JSON path');
  assert.equal(conv.conversationUrn, 'urn:conv:X');
});
