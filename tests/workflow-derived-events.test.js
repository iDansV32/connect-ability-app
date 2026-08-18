const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDerivedWorkflowActivityEvents } = require('../workflow-derived-events');

test('workflow derived events emit connection_accepted from inferred send_dm success', () => {
  const events = resolveDerivedWorkflowActivityEvents(
    {
      id: 'run-1',
      workflowId: 'workflow-1',
      workflowName: 'Chief of Staff Sequence',
      accountId: 'account-1',
      accountName: 'Account One',
      agentId: 'agent-1',
      agentName: 'Agent One',
      targetType: 'search'
    },
    {
      targetId: 'target-1',
      prospectId: 'prospect-1',
      targetValue: 'https://www.linkedin.com/in/jane-doe/',
      targetLabel: 'Jane Doe',
      stepIndex: 3,
      stepType: 'send_dm'
    },
    {
      outcomeType: 'completed',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      recipientName: 'Jane Doe',
      metadata: {
        connectionAcceptedInferred: true,
        connectionAcceptedInferredAt: '2026-03-21T12:00:00.000Z',
        connectionAcceptedInference: 'successful_dm_after_connection_request',
        connectionRequestCount: 1
      }
    }
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'connection_accepted');
  assert.equal(events[0].prospectId, 'prospect-1');
  assert.equal(events[0].workflowId, 'workflow-1');
  assert.equal(events[0].metadata.inferred, true);
  assert.equal(events[0].metadata.connectionRequestCount, 1);
});

test('workflow derived events do not emit connection_accepted for non-inferred DM results', () => {
  const events = resolveDerivedWorkflowActivityEvents(
    { id: 'run-1' },
    {
      targetId: 'target-1',
      prospectId: 'prospect-1',
      targetValue: 'Jane Doe',
      targetLabel: 'Jane Doe',
      stepIndex: 1,
      stepType: 'send_dm'
    },
    {
      outcomeType: 'completed',
      recipientName: 'Jane Doe',
      metadata: {}
    }
  );

  assert.deepEqual(events, []);
});

test('workflow derived events do not emit connection_accepted for unverified DM results', () => {
  const events = resolveDerivedWorkflowActivityEvents(
    { id: 'run-1' },
    {
      targetId: 'target-1',
      prospectId: 'prospect-1',
      targetValue: 'Jane Doe',
      targetLabel: 'Jane Doe',
      stepIndex: 1,
      stepType: 'send_dm'
    },
    {
      outcomeType: 'completed',
      recipientName: 'Jane Doe',
      verificationResult: {
        verified: false,
        method: 'dom',
        reason: 'dom_message_not_confirmed'
      },
      metadata: {
        connectionAcceptedInferred: true
      }
    }
  );

  assert.deepEqual(events, []);
});

test('workflow derived events emit connection_accepted from detected view_profile state change', () => {
  const events = resolveDerivedWorkflowActivityEvents(
    {
      id: 'run-1',
      workflowId: 'workflow-1',
      workflowName: 'Follow-up Sequence',
      accountId: 'account-1',
      accountName: 'Account One',
      agentId: 'agent-1',
      agentName: 'Agent One',
      targetType: 'search'
    },
    {
      targetId: 'target-1',
      prospectId: 'prospect-1',
      targetValue: 'https://www.linkedin.com/in/jane-doe/',
      targetLabel: 'Jane Doe',
      stepIndex: 1,
      stepType: 'view_profile'
    },
    {
      outcomeType: 'completed',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      recipientName: 'Jane Doe',
      metadata: {
        connectionAcceptedDetected: true,
        connectionAcceptedDetectedAt: '2026-03-23T12:00:00.000Z',
        connectionAcceptedDetection: 'connected_profile_state_after_connection_request',
        connectionRequestCount: 1,
        connectionStateConnected: true,
        connectionStatePending: false
      }
    }
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'connection_accepted');
  assert.equal(events[0].metadata.detected, true);
  assert.equal(events[0].metadata.detectionReason, 'connected_profile_state_after_connection_request');
  assert.equal(events[0].metadata.connectionStateConnected, true);
  assert.equal(events[0].metadata.connectionStatePending, false);
  assert.equal(events[0].metadata.connectionRequestCount, 1);
});
