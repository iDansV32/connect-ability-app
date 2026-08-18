const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const ActivityEventStore = require('../activity-event-store');
const { createTempWorkspace } = require('./test-helpers');

test('ActivityEventStore appends normalized events to JSONL storage', () => {
  const workspace = createTempWorkspace('activity-event-store-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    const store = new ActivityEventStore({ eventsPath });

    const event = store.append({
      type: 'dm_sent',
      accountId: 'account-1',
      prospectId: 'prospect-1',
      targetValue: ' Ivan Dans ',
      metadata: {
        message: 'Hello there'
      }
    });

    assert.equal(event.type, 'dm_sent');
    assert.equal(event.accountId, 'account-1');
    assert.equal(event.prospectId, 'prospect-1');
    assert.equal(event.targetValue, 'Ivan Dans');

    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).type, 'dm_sent');
  } finally {
    workspace.cleanup();
  }
});

test('ActivityEventStore rejects unsupported event types', () => {
  const workspace = createTempWorkspace('activity-event-store-error-');
  try {
    const store = new ActivityEventStore({
      eventsPath: workspace.path('activity-events.jsonl')
    });

    assert.throws(() => store.append({ type: 'unknown_event' }), /Unsupported activity event type/);
  } finally {
    workspace.cleanup();
  }
});

test('ActivityEventStore accepts legacy direct-login usage events', () => {
  const workspace = createTempWorkspace('activity-event-store-legacy-login-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    const store = new ActivityEventStore({ eventsPath });

    const event = store.append({
      type: 'legacy_direct_login_used',
      accountId: 'account-1',
      accountName: 'Alice SDR',
      targetValue: 'main.start-automation',
      status: 'warning',
      metadata: {
        entryPoint: 'main.start-automation',
        source: 'legacy_direct_login_guard'
      }
    });

    assert.equal(event.type, 'legacy_direct_login_used');
    assert.equal(event.status, 'warning');
    assert.equal(event.targetValue, 'main.start-automation');
  } finally {
    workspace.cleanup();
  }
});

test('ActivityEventStore accepts the session lifecycle event family', () => {
  const workspace = createTempWorkspace('activity-event-store-lifecycle-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    const store = new ActivityEventStore({ eventsPath });

    const workerCorrelationId = 'worker-lifetime-abc';
    const lifecycleTypes = [
      'worker_spawn',
      'login_attempt',
      'session_verified',
      'auth_failure',
      'challenge_detected',
      'challenge_recovery',
      'worker_exit'
    ];

    for (const type of lifecycleTypes) {
      const event = store.append({
        type,
        accountId: 'account-1',
        accountName: 'aged@example.com',
        correlationId: workerCorrelationId,
        rootCorrelationId: workerCorrelationId,
        metadata: { reason: `${type}-reason`, trigger: 'worker-startup' }
      });

      assert.equal(event.type, type);
      assert.equal(event.correlationId, workerCorrelationId);
      assert.equal(event.rootCorrelationId, workerCorrelationId);
      assert.equal(event.accountId, 'account-1');
    }

    const persisted = fs.readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.deepEqual(persisted.map((e) => e.type), lifecycleTypes);
    for (const event of persisted) {
      assert.equal(event.correlationId, workerCorrelationId);
      assert.equal(event.rootCorrelationId, workerCorrelationId);
    }
  } finally {
    workspace.cleanup();
  }
});

test('ActivityEventStore exports the session lifecycle enum', () => {
  assert.ok(ActivityEventStore.SESSION_LIFECYCLE_EVENT_TYPES instanceof Set);
  for (const type of [
    'worker_spawn',
    'worker_exit',
    'login_attempt',
    'session_verified',
    'auth_failure',
    'challenge_detected',
    'challenge_recovery'
  ]) {
    assert.ok(
      ActivityEventStore.SESSION_LIFECYCLE_EVENT_TYPES.has(type),
      `expected ${type} to be in SESSION_LIFECYCLE_EVENT_TYPES`
    );
    assert.ok(
      ActivityEventStore.ALLOWED_EVENT_TYPES.has(type),
      `expected ${type} to be in ALLOWED_EVENT_TYPES`
    );
  }
});

test('ActivityEventStore prunes retained raw lifecycle and scrutiny events from JSONL fallback', () => {
  const workspace = createTempWorkspace('activity-event-store-prune-jsonl-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    const oldTs = '2025-01-01T00:00:00.000Z';
    const freshTs = '2026-04-20T09:00:00.000Z';
    fs.writeFileSync(eventsPath, [
      JSON.stringify({ id: 'evt-old-lifecycle', type: 'worker_spawn', timestamp: oldTs }),
      JSON.stringify({ id: 'evt-old-scrutiny', type: 'scrutiny_blocked_999', timestamp: oldTs }),
      JSON.stringify({ id: 'evt-fresh-lifecycle', type: 'worker_exit', timestamp: freshTs }),
      JSON.stringify({ id: 'evt-old-nonretained', type: 'dm_sent', timestamp: oldTs }),
      '{not-valid-json}'
    ].join('\n') + '\n');

    const store = new ActivityEventStore({ eventsPath });

    const result = store.pruneRetainedRawEvents({
      nowMs: Date.parse('2026-04-20T12:00:00.000Z')
    });

    assert.equal(result.pruned, true);
    assert.equal(result.removedCount, 2);
    assert.equal(result.invalidCount, 1);

    const persisted = fs.readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.deepEqual(
      persisted.map((event) => event.id),
      ['evt-fresh-lifecycle', 'evt-old-nonretained']
    );
  } finally {
    workspace.cleanup();
  }
});

test('ActivityEventStore only runs retention pruning on construction when explicitly enabled', () => {
  const workspace = createTempWorkspace('activity-event-store-construct-prune-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    const oldTs = '2025-01-01T00:00:00.000Z';
    fs.writeFileSync(eventsPath, `${JSON.stringify({ id: 'evt-old-lifecycle', type: 'worker_spawn', timestamp: oldTs })}\n`);

    new ActivityEventStore({ eventsPath });
    let persisted = fs.readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(persisted.map((event) => event.id), ['evt-old-lifecycle']);

    new ActivityEventStore({
      eventsPath,
      enableRetentionPrune: true
    });
    persisted = fs.readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(persisted.map((event) => event.type), ['telemetry_prune_completed']);
    assert.equal(persisted[0].targetValue, 'activity_events');
    assert.equal(persisted[0].metadata.target, 'activity_events');
    assert.equal(persisted[0].metadata.removedCount, 1);
  } finally {
    workspace.cleanup();
  }
});
