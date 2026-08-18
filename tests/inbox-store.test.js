'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const InboxStore = require('../inbox-store');
const { createTempWorkspace } = require('./test-helpers');

test('InboxStore persists conversations and sorts by lastInboundAt descending', () => {
  const workspace = createTempWorkspace('inbox-store-');
  try {
    const storePath = workspace.path('inbox.json');
    const store = new InboxStore({ storePath });

    store.upsert('urn:li:msg_conversation:1', {
      accountId: 'account-1',
      participantNames: ['Jane Doe'],
      workflowId: 'workflow-1',
      prospectId: 'prospect-1',
      lastInboundAt: 1760000000000,
      status: 'replied'
    });
    store.upsert('urn:li:msg_conversation:2', {
      accountId: 'account-1',
      participantNames: ['John Doe'],
      workflowId: 'workflow-2',
      prospectId: 'prospect-2',
      lastInboundAt: 1760000005000,
      status: 'active'
    });

    const reopened = new InboxStore({ storePath });
    const items = reopened.getAll();

    assert.equal(items.length, 2);
    assert.equal(items[0].conversationUrn, 'urn:li:msg_conversation:2');
    assert.equal(items[1].conversationUrn, 'urn:li:msg_conversation:1');
    assert.equal(items[0].participantNames[0], 'John Doe');
  } finally {
    workspace.cleanup();
  }
});

test('InboxStore upsert is idempotent for the same conversation and merges participant names', () => {
  const workspace = createTempWorkspace('inbox-store-idempotent-');
  try {
    const store = new InboxStore({ storePath: workspace.path('inbox.json') });

    store.upsert('urn:li:msg_conversation:1', {
      participantNames: ['Jane Doe'],
      status: 'active',
      lastInboundAt: 1760000000000
    });
    store.upsert('urn:li:msg_conversation:1', {
      participantNames: ['Jane Doe', 'Jane D.'],
      status: 'replied',
      lastInboundAt: 1760000000000
    });

    const items = store.getAll();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].participantNames, ['Jane Doe', 'Jane D.']);
    assert.equal(items[0].status, 'replied');
  } finally {
    workspace.cleanup();
  }
});

test('InboxStore archive marks a conversation resolved', () => {
  const workspace = createTempWorkspace('inbox-store-archive-');
  try {
    const store = new InboxStore({ storePath: workspace.path('inbox.json') });
    store.upsert('urn:li:msg_conversation:1', {
      participantNames: ['Jane Doe'],
      status: 'replied',
      lastInboundAt: 1760000000000
    });

    const archived = store.archive('urn:li:msg_conversation:1');
    assert.equal(archived.status, 'resolved');
    assert.equal(store.getConversation('urn:li:msg_conversation:1').status, 'resolved');
  } finally {
    workspace.cleanup();
  }
});

test('InboxStore filters by workflow and status', () => {
  const workspace = createTempWorkspace('inbox-store-filters-');
  try {
    const store = new InboxStore({ storePath: workspace.path('inbox.json') });
    store.upsert('urn:li:msg_conversation:1', {
      workflowId: 'workflow-1',
      status: 'replied',
      lastInboundAt: 1760000000000
    });
    store.upsert('urn:li:msg_conversation:2', {
      workflowId: 'workflow-2',
      status: 'resolved',
      lastInboundAt: 1760000001000
    });

    const filtered = store.getAll({ workflowId: 'workflow-1', status: 'replied' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].conversationUrn, 'urn:li:msg_conversation:1');
  } finally {
    workspace.cleanup();
  }
});

test('InboxStore preserves suppressed conversation status', () => {
  const workspace = createTempWorkspace('inbox-store-suppressed-');
  try {
    const store = new InboxStore({ storePath: workspace.path('inbox.json') });
    store.upsert('urn:li:msg_conversation:1', {
      status: 'suppressed',
      intentLabel: 'unsubscribe',
      lastInboundAt: 1760000000000
    });

    const saved = store.getConversation('urn:li:msg_conversation:1');
    assert.equal(saved.status, 'suppressed');
    assert.equal(saved.intentLabel, 'unsubscribe');
  } finally {
    workspace.cleanup();
  }
});

test('InboxStore appends unique messages and derives inbound/outbound timestamps', () => {
  const workspace = createTempWorkspace('inbox-store-messages-');
  try {
    const store = new InboxStore({ storePath: workspace.path('inbox.json') });
    store.upsert('urn:li:msg_conversation:1', {
      participantNames: ['Jane Doe'],
      messages: [{
        messageKey: 'message-1',
        deliveredAt: 1760000000000,
        senderName: 'Jane Doe',
        text: 'Hello there',
        direction: 'inbound'
      }]
    });

    const updated = store.appendMessages('urn:li:msg_conversation:1', [
      {
        messageKey: 'message-1',
        deliveredAt: 1760000000000,
        senderName: 'Jane Doe',
        text: 'Hello there',
        direction: 'inbound'
      },
      {
        messageKey: 'message-2',
        deliveredAt: 1760000005000,
        senderName: 'You',
        text: 'Thanks for replying',
        direction: 'outbound'
      }
    ]);

    assert.equal(updated.messages.length, 2);
    assert.equal(updated.lastInboundAt, 1760000000000);
    assert.equal(updated.lastOutboundAt, 1760000005000);
    assert.equal(updated.lastMessagePreview, 'Thanks for replying');
  } finally {
    workspace.cleanup();
  }
});
