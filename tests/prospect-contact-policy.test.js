const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getProspectContactStage,
  summarizeManagedElsewhere
} = require('../prospect-contact-policy');

test('prospect contact policy does not treat invites alone as managed contact', () => {
  const summary = summarizeManagedElsewhere([
    {
      id: 'prospect-1',
      accountId: 'account-1',
      agentId: 'agent-1',
      normalizedProfileUrl: 'https://www.linkedin.com/in/jane-doe',
      metrics: {
        connectionRequests: 1
      },
      metadata: {}
    }
  ], {
    accountId: 'account-2',
    agentId: 'agent-2',
    normalizedProfileUrl: 'https://www.linkedin.com/in/jane-doe'
  });

  assert.equal(summary.blocked, false);
  assert.equal(summary.handlersInContact.length, 0);
});

test('prospect contact policy blocks when another handler has a connection acceptance', () => {
  const summary = summarizeManagedElsewhere([
    {
      id: 'prospect-1',
      accountId: 'account-1',
      accountName: 'Account One',
      agentId: 'agent-1',
      agentName: 'Agent One',
      normalizedProfileUrl: 'https://www.linkedin.com/in/jane-doe',
      metrics: {
        connectionAcceptances: 1
      },
      metadata: {
        connectionAcceptedAt: '2026-03-21T12:30:00.000Z'
      }
    }
  ], {
    accountId: 'account-2',
    agentId: 'agent-2',
    normalizedProfileUrl: 'https://www.linkedin.com/in/jane-doe'
  });

  assert.equal(summary.blocked, true);
  assert.equal(summary.blockReason, 'connected_elsewhere');
  assert.equal(summary.handlersInContact[0].agentId, 'agent-1');
  assert.equal(summary.handlersInContact[0].contactStage, 'connected');
});

test('prospect contact stage prioritizes replies over accepted connections', () => {
  const stage = getProspectContactStage({
    state: 'responded',
    lastReplyAt: '2026-03-21T13:00:00.000Z',
    metrics: {
      connectionAcceptances: 1,
      dmReplies: 1
    },
    metadata: {
      connectionAcceptedAt: '2026-03-21T12:30:00.000Z'
    }
  });

  assert.equal(stage.stage, 'responded');
  assert.equal(stage.reason, 'dm_reply_received');
  assert.equal(stage.engagedAt, '2026-03-21T13:00:00.000Z');
});
