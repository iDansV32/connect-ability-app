const test = require('node:test');
const assert = require('node:assert/strict');

const {
  interpretPollObservation,
  DEFAULT_APOLLO_POLL_SIGNAL_RULES
} = require('../apollo-poll-signal-interpreter');

function buildObservation(overrides = {}) {
  return {
    outcome: 'ok',
    observedAt: '2026-03-27T12:30:00.000Z',
    contact: {},
    dealSnapshot: {},
    taskSnapshot: {},
    ...overrides
  };
}

test('interpretPollObservation suppresses on active-sales-process contact stage', () => {
  const result = interpretPollObservation(buildObservation({
    contact: {
      stageName: 'Customer'
    }
  }));

  assert.equal(result.shouldSuppress, true);
  assert.deepEqual(result.matchedSignals.map((signal) => signal.name), ['contact_stage_active_sales_process']);
  assert.match(result.suppressReason, /apollo_poll:contact_stage_active_sales_process:stage=customer/);
});

test('interpretPollObservation suppresses on non-closed-lost deal stages', () => {
  const result = interpretPollObservation(buildObservation({
    dealSnapshot: {
      nonClosedLostStageNames: ['Demo']
    }
  }));

  assert.equal(result.shouldSuppress, true);
  assert.deepEqual(result.matchedSignals.map((signal) => signal.name), ['deal_stage_not_closed_lost']);
  assert.match(result.suppressReason, /apollo_poll:deal_stage_not_closed_lost:stages=demo/);
});

test('interpretPollObservation suppresses on recent meeting or call activity', () => {
  const result = interpretPollObservation(buildObservation({
    taskSnapshot: {
      latestMeetingOrCallCompletedAt: '2026-03-15T00:00:00.000Z'
    }
  }));

  assert.equal(result.shouldSuppress, true);
  assert.deepEqual(result.matchedSignals.map((signal) => signal.name), ['meeting_booked_recently']);
  assert.match(result.suppressReason, /apollo_poll:meeting_booked_recently:task_completed_at=2026-03-15T00:00:00.000Z/);
});

test('interpretPollObservation suppresses on active sales-owned open tasks', () => {
  const result = interpretPollObservation(buildObservation({
    taskSnapshot: {
      latestSalesOwnedOpenTaskUpdatedAt: '2026-03-20T00:00:00.000Z'
    }
  }));

  assert.equal(result.shouldSuppress, true);
  assert.deepEqual(result.matchedSignals.map((signal) => signal.name), ['active_sales_conversation']);
  assert.match(result.suppressReason, /apollo_poll:active_sales_conversation:task_updated_at=2026-03-20T00:00:00.000Z/);
});

test('interpretPollObservation suppresses on recent owner activity', () => {
  const result = interpretPollObservation(buildObservation({
    taskSnapshot: {
      latestOwnerActivityAt: '2026-03-24T00:00:00.000Z'
    }
  }));

  assert.equal(result.shouldSuppress, true);
  assert.deepEqual(result.matchedSignals.map((signal) => signal.name), ['recent_owner_activity']);
  assert.match(result.suppressReason, /apollo_poll:recent_owner_activity:owner_activity_at=2026-03-24T00:00:00.000Z/);
});

test('interpretPollObservation collects all matched suppressive signals', () => {
  const result = interpretPollObservation(buildObservation({
    contact: {
      stageName: 'Opportunity'
    },
    dealSnapshot: {
      nonClosedLostStageNames: ['Proposal']
    },
    taskSnapshot: {
      latestMeetingOrCallCompletedAt: '2026-03-20T00:00:00.000Z'
    }
  }));

  assert.equal(result.shouldSuppress, true);
  assert.deepEqual(result.matchedSignals.map((signal) => signal.name), [
    'contact_stage_active_sales_process',
    'deal_stage_not_closed_lost',
    'meeting_booked_recently'
  ]);
  assert.match(result.suppressReason, /apollo_poll:contact_stage_active_sales_process/);
  assert.match(result.suppressReason, /apollo_poll:deal_stage_not_closed_lost/);
  assert.match(result.suppressReason, /apollo_poll:meeting_booked_recently/);
});

test('interpretPollObservation does not suppress when timestamps are outside the configured windows', () => {
  const result = interpretPollObservation(buildObservation({
    taskSnapshot: {
      latestMeetingOrCallCompletedAt: '2026-01-15T00:00:00.000Z',
      latestSalesOwnedOpenTaskUpdatedAt: '2026-01-15T00:00:00.000Z',
      latestOwnerActivityAt: '2026-01-15T00:00:00.000Z'
    }
  }));

  assert.equal(result.shouldSuppress, false);
  assert.equal(result.matchedSignals.length, 0);
  assert.equal(result.suppressReason, null);
});

test('interpretPollObservation throws loudly when blocked sequence-contact signals are enabled', () => {
  assert.throws(() => interpretPollObservation(
    buildObservation({
      sequenceContactStatus: 'finished'
    }),
    [
      ...DEFAULT_APOLLO_POLL_SIGNAL_RULES,
      { name: 'reply', enabled: true }
    ]
  ), /requires sequenceContactStatus and is not observable yet/i);
});
