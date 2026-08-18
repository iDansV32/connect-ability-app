const test = require('node:test');
const assert = require('node:assert/strict');

const InboxStore = require('../inbox-store');
const LinkedInReplyMonitor = require('../linkedin-reply-monitor');
const { ACCOUNT_WORKER_MESSAGE_TYPES } = require('../automation/runtime/account-worker-protocol');
const { createTempWorkspace, writeJson } = require('./test-helpers');

test('LinkedInReplyMonitor exposes persisted reply notifications and acknowledges them', () => {
  const workspace = createTempWorkspace('reply-monitor-');
  try {
    const statePath = workspace.path('dm-reply-monitor.json');
    writeJson(statePath, {
      version: 2,
      lastPolledAt: null,
      accounts: {},
      notifications: {
        'reply:account-1:conversation-1:message-1': {
          id: 'reply:account-1:conversation-1:message-1',
          accountId: 'account-1',
          accountName: 'Account One',
          senderName: 'Jane Doe',
          text: 'Thanks for reaching out.',
          deliveredAt: 1760000000000,
          workflowId: 'workflow-1',
          workflowName: 'CS follow-up',
          agentId: 'agent-1',
          agentName: 'Customer Success SDR',
          conversationUrn: 'conversation-1',
          messageKey: 'message-1',
          readAt: null
        }
      }
    });

    const monitor = new LinkedInReplyMonitor({ statePath });
    const before = monitor.getNotifications();
    assert.equal(before.items.length, 1);
    assert.equal(before.unreadCount, 1);
    assert.equal(before.items[0].senderName, 'Jane Doe');

    const markResult = monitor.markNotificationRead('reply:account-1:conversation-1:message-1');
    assert.equal(markResult.success, true);
    assert.equal(markResult.unreadCount, 0);

    const after = monitor.getNotifications();
    assert.equal(after.items[0].readAt !== null, true);
  } finally {
    workspace.cleanup();
  }
});

test('LinkedInReplyMonitor marks all matching notifications as read', () => {
  const workspace = createTempWorkspace('reply-monitor-all-');
  try {
    const statePath = workspace.path('dm-reply-monitor.json');
    writeJson(statePath, {
      version: 2,
      lastPolledAt: null,
      accounts: {},
      notifications: {
        'reply:account-1:conversation-1:message-1': {
          id: 'reply:account-1:conversation-1:message-1',
          accountId: 'account-1',
          senderName: 'Jane Doe',
          text: 'Reply one',
          deliveredAt: 1760000000000,
          readAt: null
        },
        'reply:account-2:conversation-2:message-2': {
          id: 'reply:account-2:conversation-2:message-2',
          accountId: 'account-2',
          senderName: 'John Doe',
          text: 'Reply two',
          deliveredAt: 1760000001000,
          readAt: null
        }
      }
    });

    const monitor = new LinkedInReplyMonitor({ statePath });
    const result = monitor.markAllNotificationsRead({ accountId: 'account-1' });
    assert.equal(result.success, true);
    assert.equal(result.updated, 1);
    assert.equal(result.unreadCount, 1);

    const notifications = monitor.getNotifications({ limit: 10 });
    const accountOne = notifications.items.find((item) => item.accountId === 'account-1');
    const accountTwo = notifications.items.find((item) => item.accountId === 'account-2');
    assert.equal(Boolean(accountOne.readAt), true);
    assert.equal(accountTwo.readAt, null);
  } finally {
    workspace.cleanup();
  }
});

test('LinkedInReplyMonitor tolerates legacy state files without notifications', () => {
  const workspace = createTempWorkspace('reply-monitor-legacy-');
  try {
    const statePath = workspace.path('dm-reply-monitor.json');
    writeJson(statePath, {
      version: 1,
      lastPolledAt: '2026-03-21T10:00:00.000Z',
      accounts: {
        'account-1': {
          initialized: true,
          mailboxUrn: 'urn:li:fsd_mailbox:123',
          conversations: {
            'conversation-1': {
              lastActivityAt: 1760000000000
            }
          }
        }
      }
    });

    const monitor = new LinkedInReplyMonitor({ statePath });
    const state = monitor.getState();
    const notifications = monitor.getNotifications();

    assert.equal(state.version, 1);
    assert.equal(state.accounts['account-1'].initialized, true);
    assert.deepEqual(state.notifications, {});
    assert.equal(notifications.items.length, 0);
    assert.equal(notifications.unreadCount, 0);
  } finally {
    workspace.cleanup();
  }
});

test('LinkedInReplyMonitor initializes account conversation state from worker poll results', async () => {
  const workspace = createTempWorkspace('reply-monitor-poll-init-');
  try {
    const statePath = workspace.path('dm-reply-monitor.json');
    const dispatched = [];
    const monitor = new LinkedInReplyMonitor({
      statePath,
      accountWorkerProcessManager: {
        async dispatchAndAwaitMessage(account, message, options) {
          dispatched.push({
            account: { ...account },
            message: JSON.parse(JSON.stringify(message)),
            options: { ...options }
          });
          return {
            type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT,
            requestId: message.requestId,
            pollResult: {
              mailboxUrn: 'urn:li:fsd_profile:self',
              conversations: [
                {
                  conversationUrn: 'urn:li:msg_conversation:1',
                  participantNames: ['Jane Doe'],
                  lastActivityAt: 1760000000000,
                  messageKey: 'message-1',
                  inboundMessages: []
                }
              ]
            }
          };
        }
      },
      onPollResult: () => {}
    });

    const state = monitor.readState();
    await monitor.pollAccount({
      id: 'account-1',
      email: 'reply@example.com',
      password: 'secret',
      name: 'Reply Account'
    }, state);

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].message.type, ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES);
    assert.equal(dispatched[0].message.initialized, false);
    assert.deepEqual(dispatched[0].message.conversationStates, {});
    assert.equal(state.accounts['account-1'].initialized, true);
    assert.equal(state.accounts['account-1'].mailboxUrn, 'urn:li:fsd_profile:self');
    assert.equal(state.accounts['account-1'].conversations['urn:li:msg_conversation:1'].lastActivityAt, 1760000000000);
    assert.equal(Object.keys(state.notifications).length, 0);
  } finally {
    workspace.cleanup();
  }
});

test('LinkedInReplyMonitor records new inbound replies from worker poll results', async () => {
  const workspace = createTempWorkspace('reply-monitor-poll-reply-');
  try {
    const statePath = workspace.path('dm-reply-monitor.json');
    const inboxStore = new InboxStore({ storePath: workspace.path('inbox.json') });
    const recordedEvents = [];
    const notifications = [];
    const pausedRuns = [];
    const inboxUpdates = [];
    const monitor = new LinkedInReplyMonitor({
      statePath,
      inboxStore,
      accountWorkerProcessManager: {
        async dispatchAndAwaitMessage(_account, message) {
          assert.equal(message.initialized, true);
          assert.equal(message.conversationStates['urn:li:msg_conversation:1'].lastActivityAt, 1760000000000);
          return {
            type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT,
            requestId: message.requestId,
            pollResult: {
              mailboxUrn: 'urn:li:fsd_profile:self',
              conversations: [
                {
                  conversationUrn: 'urn:li:msg_conversation:1',
                  participantNames: ['Jane Doe'],
                  lastActivityAt: 1760000005000,
                  messageKey: 'message-2',
                  inboundMessages: [
                    {
                      messageKey: 'message-2',
                      deliveredAt: 1760000005000,
                      senderName: 'Jane Doe',
                      senderProfileUrn: 'urn:li:fsd_profile:jane',
                      text: 'Thanks for reaching out.'
                    }
                  ]
                }
              ]
            }
          };
        }
      },
      recordEvent: (event) => {
        recordedEvents.push(event);
      },
      notify: (notification) => {
        notifications.push(notification);
      },
      pauseWorkflowRun: (runId, options = {}) => {
        pausedRuns.push({ runId, options });
        return { id: runId, status: 'paused' };
      },
      onInboxUpdated: (conversation) => {
        inboxUpdates.push(conversation);
      },
      matchWorkflowRun: () => ({
        workflowId: 'workflow-1',
        workflowName: 'CS follow-up',
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'CS SDR',
        targetId: 'target-1',
        prospectId: 'prospect-1'
      }),
      onPollResult: () => {}
    });

    const state = {
      version: 2,
      lastPolledAt: null,
      accounts: {
        'account-1': {
          initialized: true,
          mailboxUrn: 'urn:li:fsd_profile:self',
          lastSuccessAt: null,
          lastError: null,
          conversations: {
            'urn:li:msg_conversation:1': {
              lastActivityAt: 1760000000000,
              lastInboundDeliveredAt: 1760000000000,
              lastMessageKey: 'message-1',
              participantNames: ['Jane Doe']
            }
          }
        }
      },
      notifications: {}
    };

    await monitor.pollAccount({
      id: 'account-1',
      email: 'reply@example.com',
      password: 'secret',
      name: 'Reply Account'
    }, state);

    assert.equal(recordedEvents.length, 1);
    assert.equal(recordedEvents[0].type, 'dm_reply_received');
    assert.equal(recordedEvents[0].workflowId, 'workflow-1');
    assert.equal(recordedEvents[0].metadata.intentLabel, 'neutral');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].senderName, 'Jane Doe');
    assert.equal(pausedRuns.length, 1);
    assert.equal(pausedRuns[0].runId, 'run-1');
    assert.equal(pausedRuns[0].options.reason, 'reply_received');
    assert.equal(inboxUpdates.length, 2);
    assert.equal(Object.keys(state.notifications).length, 1);
    assert.equal(state.accounts['account-1'].conversations['urn:li:msg_conversation:1'].lastMessageKey, 'message-2');
    assert.equal(state.accounts['account-1'].lastError, null);

    const conversations = inboxStore.getAll();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].conversationUrn, 'urn:li:msg_conversation:1');
    assert.equal(conversations[0].workflowId, 'workflow-1');
    assert.equal(conversations[0].runId, 'run-1');
    assert.equal(conversations[0].status, 'paused');
    assert.equal(conversations[0].intentLabel, 'neutral');
    assert.equal(conversations[0].mailboxUrn, 'urn:li:fsd_profile:self');
    assert.equal(conversations[0].participantProfileUrn, 'urn:li:fsd_profile:jane');
    assert.equal(conversations[0].lastMessagePreview, 'Thanks for reaching out.');
    assert.equal(conversations[0].messages.length, 1);
    assert.equal(conversations[0].messages[0].direction, 'inbound');
  } finally {
    workspace.cleanup();
  }
});

test('LinkedInReplyMonitor records worker poll failures without attempting browser teardown', async () => {
  const workspace = createTempWorkspace('reply-monitor-poll-failure-');
  try {
    const results = [];
    const monitor = new LinkedInReplyMonitor({
      statePath: workspace.path('dm-reply-monitor.json'),
      accountWorkerProcessManager: {
        async dispatchAndAwaitMessage() {
          throw new Error('worker poll failed');
        }
      },
      onPollResult: (payload) => {
        results.push(payload);
      }
    });

    const state = monitor.readState();
    await monitor.pollAccount({
      id: 'account-1',
      email: 'reply@example.com',
      password: 'secret',
      name: 'Reply Account'
    }, state);

    assert.equal(results.length, 1);
    assert.equal(results[0].success, false);
    assert.match(state.accounts['account-1'].lastError, /worker poll failed/);
  } finally {
    workspace.cleanup();
  }
});

test('LinkedInReplyMonitor auto-cancels and suppresses unsubscribe replies', async () => {
  const workspace = createTempWorkspace('reply-monitor-unsubscribe-');
  try {
    const statePath = workspace.path('dm-reply-monitor.json');
    const inboxStore = new InboxStore({ storePath: workspace.path('inbox.json') });
    const cancelledRuns = [];
    const archivedProspects = [];
    const pausedRuns = [];
    const inboxUpdates = [];
    const monitor = new LinkedInReplyMonitor({
      statePath,
      inboxStore,
      accountWorkerProcessManager: {
        async dispatchAndAwaitMessage(_account, message) {
          return {
            type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT,
            requestId: message.requestId,
            pollResult: {
              mailboxUrn: 'urn:li:fsd_profile:self',
              conversations: [
                {
                  conversationUrn: 'urn:li:msg_conversation:1',
                  participantNames: ['Jane Doe'],
                  lastActivityAt: 1760000005000,
                  messageKey: 'message-2',
                  inboundMessages: [
                    {
                      messageKey: 'message-2',
                      deliveredAt: 1760000005000,
                      senderName: 'Jane Doe',
                      senderProfileUrn: 'urn:li:fsd_profile:jane',
                      text: 'Please unsubscribe me from this list.'
                    }
                  ]
                }
              ]
            }
          };
        }
      },
      pauseWorkflowRun: (runId, options = {}) => {
        pausedRuns.push({ runId, options });
        return { id: runId, status: 'paused' };
      },
      cancelWorkflowRun: (runId, reason) => {
        cancelledRuns.push({ runId, reason });
        return { cancelled: true };
      },
      archiveProspect: (prospectId, options = {}) => {
        archivedProspects.push({ prospectId, options });
        return { id: prospectId, state: 'archived' };
      },
      onInboxUpdated: (conversation) => {
        inboxUpdates.push(conversation);
      },
      matchWorkflowRun: () => ({
        workflowId: 'workflow-1',
        workflowName: 'CS follow-up',
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'CS SDR',
        targetId: 'target-1',
        prospectId: 'prospect-1'
      }),
      onPollResult: () => {}
    });

    const state = {
      version: 2,
      lastPolledAt: null,
      accounts: {
        'account-1': {
          initialized: true,
          mailboxUrn: 'urn:li:fsd_profile:self',
          lastSuccessAt: null,
          lastError: null,
          conversations: {}
        }
      },
      notifications: {}
    };

    await monitor.pollAccount({
      id: 'account-1',
      email: 'reply@example.com',
      password: 'secret',
      name: 'Reply Account'
    }, state);

    assert.equal(cancelledRuns.length, 1);
    assert.deepEqual(cancelledRuns[0], { runId: 'run-1', reason: 'unsubscribe_received' });
    assert.equal(pausedRuns.length, 0);
    assert.equal(archivedProspects.length, 1);
    assert.equal(archivedProspects[0].prospectId, 'prospect-1');
    assert.equal(archivedProspects[0].options.reason, 'unsubscribe_received');
    assert.equal(inboxUpdates.length, 2);

    const conversations = inboxStore.getAll();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].status, 'suppressed');
    assert.equal(conversations[0].intentLabel, 'unsubscribe');
    assert.equal(conversations[0].messages.length, 1);
  } finally {
    workspace.cleanup();
  }
});
