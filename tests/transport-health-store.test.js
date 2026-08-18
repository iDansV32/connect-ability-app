'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TransportHealthStore = require('../automation/runtime/transport-health-store');
const { createTempWorkspace, readJson } = require('./test-helpers');

test('TransportHealthStore disables a transport after three failures for the same account/action triple', () => {
  const workspace = createTempWorkspace('transport-health-');
  try {
    const store = new TransportHealthStore({
      storePath: workspace.path('transport-health.json')
    });

    store.recordFailure('private_api', 'send_dm', 'alice@example.com', {
      timestamp: '2026-03-22T10:00:00.000Z',
      reason: 'timeout'
    });
    store.recordFailure('private_api', 'send_dm', 'alice@example.com', {
      timestamp: '2026-03-22T10:01:00.000Z',
      reason: 'timeout'
    });
    const third = store.recordFailure('private_api', 'send_dm', 'alice@example.com', {
      timestamp: '2026-03-22T10:02:00.000Z',
      reason: 'timeout'
    });

    assert.equal(third.disabled, true);
    assert.equal(third.failureCount, 3);
    assert.equal(
      store.isTransportDisabled(
        'private_api',
        'send_dm',
        'alice@example.com',
        new Date('2026-03-22T10:03:00.000Z')
      ),
      true
    );
  } finally {
    workspace.cleanup();
  }
});

test('TransportHealthStore automatically re-enables a triple after the recovery window', () => {
  const workspace = createTempWorkspace('transport-health-recovery-');
  try {
    const store = new TransportHealthStore({
      storePath: workspace.path('transport-health.json'),
      recoveryWindowMs: 1000
    });

    store.recordFailure('private_api', 'send_connection', 'alice@example.com', {
      timestamp: '2026-03-22T10:00:00.000Z'
    });
    store.recordFailure('private_api', 'send_connection', 'alice@example.com', {
      timestamp: '2026-03-22T10:00:10.000Z'
    });
    store.recordFailure('private_api', 'send_connection', 'alice@example.com', {
      timestamp: '2026-03-22T10:00:20.000Z'
    });

    const recovered = store.getTransportState(
      'private_api',
      'send_connection',
      'alice@example.com',
      new Date('2026-03-22T10:00:21.500Z')
    );

    assert.equal(recovered.disabled, false);
    assert.equal(recovered.failureCount, 0);
  } finally {
    workspace.cleanup();
  }
});

test('TransportHealthStore persists entries across store instances', () => {
  const workspace = createTempWorkspace('transport-health-persist-');
  try {
    const storePath = workspace.path('transport-health.json');
    const writer = new TransportHealthStore({ storePath });
    writer.recordFailure('dom', 'send_connection', 'bob@example.com', {
      timestamp: '2026-03-22T11:00:00.000Z',
      reason: 'selector_drift_detected'
    });

    const reader = new TransportHealthStore({ storePath });
    const state = reader.getTransportState('dom', 'send_connection', 'bob@example.com');
    const raw = readJson(storePath);

    assert.equal(state.failureCount, 1);
    assert.equal(state.lastFailureReason, 'selector_drift_detected');
    assert.equal(Object.keys(raw.entries).length, 1);
  } finally {
    workspace.cleanup();
  }
});
