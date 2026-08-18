const test = require('node:test');
const assert = require('node:assert/strict');

const ApolloPollStore = require('../apollo-poll-store');
const { createTempWorkspace } = require('./test-helpers');

test('ApolloPollStore creates normalized poll records with persisted bounds', () => {
  const workspace = createTempWorkspace('apollo-poll-store-create-');
  try {
    const store = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });

    const record = store.createPollRecord('campaign-1', {
      apolloSequenceContactId: 'seq-contact-1'
    });

    assert.equal(record.campaignRunId, 'campaign-1');
    assert.equal(record.apolloSequenceContactId, 'seq-contact-1');
    assert.equal(record.status, 'active');
    assert.equal(record.pollCount, 0);
    assert.equal(record.maxPolls, 72);
    assert.equal(record.pollIntervalMs, 30 * 60 * 1000);
    assert.equal(Boolean(record.nextPollAt), true);
    assert.equal(record.lastPollResult, null);
    assert.equal(record.lastPollAt, null);
  } finally {
    workspace.cleanup();
  }
});

test('ApolloPollStore advances active polls and finalizes on terminal Apollo statuses', () => {
  const workspace = createTempWorkspace('apollo-poll-store-progress-');
  try {
    const store = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });

    store.createPollRecord('campaign-1', {
      apolloSequenceContactId: 'seq-contact-1',
      pollIntervalMs: 60 * 1000,
      nextPollAt: '2026-03-27T10:00:00.000Z'
    });

    const active = store.recordPollResult('campaign-1', {
      outcome: 'ok',
      apolloEnrollmentStatus: 'active',
      observedAt: '2026-03-27T10:00:00.000Z'
    }, {
      lastPollAt: '2026-03-27T10:00:00.000Z'
    });
    const completed = store.recordPollResult('campaign-1', {
      outcome: 'ok',
      apolloEnrollmentStatus: 'finished',
      observedAt: '2026-03-27T10:05:00.000Z'
    }, {
      lastPollAt: '2026-03-27T10:05:00.000Z'
    });

    assert.equal(active.status, 'active');
    assert.equal(active.pollCount, 1);
    assert.equal(active.lastPollAt, '2026-03-27T10:00:00.000Z');
    assert.equal(active.nextPollAt, '2026-03-27T10:01:00.000Z');

    assert.equal(completed.status, 'completed');
    assert.equal(completed.pollCount, 2);
    assert.equal(completed.lastPollAt, '2026-03-27T10:05:00.000Z');
    assert.equal(completed.nextPollAt, null);
    assert.equal(completed.lastPollResult.apolloEnrollmentStatus, 'finished');
  } finally {
    workspace.cleanup();
  }
});

test('ApolloPollStore completes after max polls and rejects conflicting sequence-contact ids', () => {
  const workspace = createTempWorkspace('apollo-poll-store-bounds-');
  try {
    const store = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });

    store.createPollRecord('campaign-1', {
      apolloSequenceContactId: 'seq-contact-1',
      maxPolls: 2,
      pollIntervalMs: 60 * 1000
    });

    store.recordPollResult('campaign-1', {
      outcome: 'ok',
      apolloEnrollmentStatus: 'active',
      observedAt: '2026-03-27T11:00:00.000Z'
    }, {
      lastPollAt: '2026-03-27T11:00:00.000Z'
    });
    const bounded = store.recordPollResult('campaign-1', {
      outcome: 'ok',
      apolloEnrollmentStatus: 'active',
      observedAt: '2026-03-27T11:30:00.000Z'
    }, {
      lastPollAt: '2026-03-27T11:30:00.000Z'
    });

    assert.equal(bounded.status, 'completed');
    assert.equal(bounded.pollCount, 2);
    assert.equal(bounded.nextPollAt, null);

    assert.throws(() => store.createPollRecord('campaign-1', {
      apolloSequenceContactId: 'seq-contact-2'
    }), /different sequence-contact id/i);
  } finally {
    workspace.cleanup();
  }
});

test('ApolloPollStore pauses active poll records and resumes them from the current time', () => {
  const workspace = createTempWorkspace('apollo-poll-store-pause-resume-');
  try {
    const store = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });

    store.createPollRecord('campaign-1', {
      apolloSequenceContactId: 'seq-contact-1',
      pollIntervalMs: 30 * 60 * 1000,
      nextPollAt: '2026-03-27T12:00:00.000Z'
    });

    const paused = store.pausePollRecord('campaign-1', {
      observedAt: '2026-03-27T12:05:00.000Z',
      reason: 'linkedin_reply:reply_received'
    });
    const resumed = store.resumePollRecord('campaign-1', {
      resumedAt: '2026-03-27T13:00:00.000Z'
    });

    assert.equal(paused.status, 'paused');
    assert.equal(paused.nextPollAt, null);
    assert.equal(paused.lastPollResult.transition, 'paused');
    assert.equal(paused.lastPollResult.pauseReason, 'linkedin_reply:reply_received');

    assert.equal(resumed.status, 'active');
    assert.equal(resumed.nextPollAt, '2026-03-27T13:30:00.000Z');
    assert.equal(resumed.lastPollResult.transition, 'resumed');
  } finally {
    workspace.cleanup();
  }
});
