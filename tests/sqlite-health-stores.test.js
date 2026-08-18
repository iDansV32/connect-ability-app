'use strict';

/**
 * tests/sqlite-health-stores.test.js
 *
 * Targeted tests for Ticket 6 — SQLite migration for activity events and
 * LinkedIn account health.
 *
 * Covers:
 *  1. ActivityEventStore.append persists to SQLite (not JSONL)
 *  2. ActivityAnalyticsService.readEventLedger reads from SQLite
 *  3. LinkedInAccountHealthStore subsystem write/read through SQLite
 *  4. LinkedInAccountHealthStore challenge record/clear through SQLite
 *  5. Legacy import: activity events from JSONL (idempotent)
 *  6. Legacy import: account health from JSON (idempotent)
 *  7. No-db path: stores continue using JSON/JSONL when db is absent
 */

const fs   = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const ActivityEventStore              = require('../activity-event-store');
const ActivityAnalyticsService        = require('../activity-analytics');
const LinkedInAccountHealthStore      = require('../linkedin-account-health-store');
const { importActivityEvents, importAccountHealth } = require('../storage/health-legacy-importer');

const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helper — open an in-memory SQLite DB for each test
// ---------------------------------------------------------------------------
function openMemoryDb() {
  return openDatabase(':memory:');
}

// ---------------------------------------------------------------------------
// 1. ActivityEventStore — SQLite append
// ---------------------------------------------------------------------------

describe('1 — ActivityEventStore appends to SQLite when db is injected', () => {

  test('append writes to activity_events table, not JSONL', () => {
    const db = openMemoryDb();
    const ws = createTempWorkspace('evt-sqlite-');
    try {
      const store = new ActivityEventStore({
        db,
        eventsPath: ws.path('events.jsonl') // should remain empty
      });

      const event = store.append({
        type:      'dm_sent',
        accountId: 'acc-1',
        agentId:   'agent-1',
        targetValue: 'Alice',
        metadata:  { message: 'Hi there' }
      });

      assert.equal(event.type, 'dm_sent');
      assert.equal(event.accountId, 'acc-1');

      // JSONL file must NOT have been written
      assert.ok(!fs.existsSync(ws.path('events.jsonl')), 'JSONL file should not be created');

      // SQLite table must have the row
      const row = db.prepare(
        'SELECT * FROM activity_events WHERE id = ?'
      ).get(event.id);
      assert.ok(row, 'row must exist in SQLite');
      assert.equal(row.event_type, 'dm_sent');
      assert.equal(row.account_id, 'acc-1');
      assert.equal(row.agent_id, 'agent-1');
      assert.equal(row.target_value, 'Alice');
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

  test('multiple appends are each stored as separate rows', () => {
    const db = openMemoryDb();
    try {
      const store = new ActivityEventStore({ db });

      store.append({ type: 'profile_viewed',     accountId: 'acc-1' });
      store.append({ type: 'connection_requested', accountId: 'acc-1' });
      store.append({ type: 'dm_sent',             accountId: 'acc-2' });

      const count = db.prepare(
        'SELECT COUNT(*) AS n FROM activity_events'
      ).get().n;
      assert.equal(count, 3);
    } finally {
      closeDatabase(db);
    }
  });

  test('INSERT OR IGNORE: duplicate ids are silently skipped', () => {
    const db = openMemoryDb();
    try {
      const store = new ActivityEventStore({ db });

      const event = store.append({ type: 'dm_sent', accountId: 'acc-1' });
      // Append same event again via a second store instance sharing the same db
      const store2 = new ActivityEventStore({ db });
      store2.append({ ...event, accountId: 'SHOULD_NOT_UPDATE' });

      const row = db.prepare(
        'SELECT * FROM activity_events WHERE id = ?'
      ).get(event.id);
      assert.equal(row.account_id, 'acc-1', 'original row should be unchanged');

      const count = db.prepare(
        'SELECT COUNT(*) AS n FROM activity_events'
      ).get().n;
      assert.equal(count, 1);
    } finally {
      closeDatabase(db);
    }
  });

  test('pruneRetainedRawEvents deletes only retained raw event families older than the cutoff', () => {
    const db = openMemoryDb();
    try {
      const store = new ActivityEventStore({ db });

      const oldTs = '2025-01-01T00:00:00.000Z';
      const freshTs = '2026-04-20T09:00:00.000Z';

      const oldLifecycle = store.append({ type: 'worker_spawn', accountId: 'acc-1' });
      db.prepare('UPDATE activity_events SET event_timestamp = ? WHERE id = ?').run(oldTs, oldLifecycle.id);

      const freshLifecycle = store.append({ type: 'worker_exit', accountId: 'acc-1' });
      db.prepare('UPDATE activity_events SET event_timestamp = ? WHERE id = ?').run(freshTs, freshLifecycle.id);

      const oldNonRetained = store.append({ type: 'dm_sent', accountId: 'acc-1' });
      db.prepare('UPDATE activity_events SET event_timestamp = ? WHERE id = ?').run(oldTs, oldNonRetained.id);

      db.prepare(`
        INSERT INTO activity_events (
          id, event_type, event_timestamp, event_status, metadata_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run('evt-old-scrutiny', 'scrutiny_blocked_999', oldTs, 'warning', '{}');

      const result = store.pruneRetainedRawEvents({
        nowMs: Date.parse('2026-04-20T12:00:00.000Z')
      });

      assert.equal(result.pruned, true);
      assert.equal(result.removedCount, 2);

      const remainingIds = db.prepare('SELECT id FROM activity_events ORDER BY id').all().map((row) => row.id);
      assert.deepEqual(remainingIds, [freshLifecycle.id, oldNonRetained.id].sort());
    } finally {
      closeDatabase(db);
    }
  });

});

// ---------------------------------------------------------------------------
// 2. ActivityAnalyticsService — reads from SQLite
// ---------------------------------------------------------------------------

describe('2 — ActivityAnalyticsService.getEvents reads from SQLite', () => {

  test('getStepOutcomeBreakdown works with SQLite-backed events', () => {
    const db = openMemoryDb();
    try {
      const eventStore   = new ActivityEventStore({ db });
      const analyticsService = new ActivityAnalyticsService({ db });

      eventStore.append({
        type:     'workflow_step_completed',
        accountId: 'acc-1',
        agentId:  'agent-1',
        status:   'ok',
        metadata: { stepType: 'send_dm', outcomeType: 'dm_sent' }
      });
      eventStore.append({
        type:     'workflow_step_failed',
        accountId: 'acc-1',
        agentId:  'agent-1',
        status:   'failed',
        metadata: { stepType: 'send_connection', outcomeType: 'failed_permanent' }
      });

      const breakdown = analyticsService.getStepOutcomeBreakdown({});
      assert.equal(breakdown.totals.total,     2);
      assert.equal(breakdown.totals.completed, 1);
      assert.equal(breakdown.totals.failed,    1);
      assert.ok(breakdown.byStepType.length >= 2);
    } finally {
      closeDatabase(db);
    }
  });

  test('getEvents filters by accountId using SQLite index', () => {
    const db = openMemoryDb();
    try {
      const store   = new ActivityEventStore({ db });
      const service = new ActivityAnalyticsService({ db });

      store.append({ type: 'dm_sent', accountId: 'acc-A' });
      store.append({ type: 'dm_sent', accountId: 'acc-B' });
      store.append({ type: 'dm_sent', accountId: 'acc-A' });

      const events = service.getEvents({ accountId: 'acc-A' });
      assert.equal(events.length, 2);
      assert.ok(events.every((e) => e.accountId === 'acc-A'));
    } finally {
      closeDatabase(db);
    }
  });

});

// ---------------------------------------------------------------------------
// 3. LinkedInAccountHealthStore — subsystem write/read
// ---------------------------------------------------------------------------

describe('3 — LinkedInAccountHealthStore subsystem write/read via SQLite', () => {

  test('recordSuccess writes to SQLite and can be read back', () => {
    const db = openMemoryDb();
    try {
      const store = new LinkedInAccountHealthStore({ db });

      const result = store.recordSuccess('acc-1', 'workflow', {
        timestamp: '2026-03-31T10:00:00.000Z'
      });

      assert.equal(result.status, 'healthy');
      assert.equal(result.consecutiveFailures, 0);
      assert.equal(result.lastSuccessAt, '2026-03-31T10:00:00.000Z');

      // Read back via readStore
      const storeState = store.readStore(new Date('2026-03-31T10:01:00.000Z'));
      const accountState = storeState.accounts['acc-1'];
      assert.ok(accountState, 'account state must exist');
      assert.equal(accountState.workflow.status, 'healthy');
      assert.equal(accountState.workflow.lastSuccessAt, '2026-03-31T10:00:00.000Z');
    } finally {
      closeDatabase(db);
    }
  });

  test('recordFailure accumulates failures and enters cooldown at threshold', () => {
    const db = openMemoryDb();
    try {
      const store = new LinkedInAccountHealthStore({ db });

      // 3 transient failures → cooldown (threshold = 3, policy.cooldownMs = 30min)
      store.recordFailure('acc-2', 'workflow', 'Timeout', { timestamp: '2026-03-31T09:00:00.000Z' });
      store.recordFailure('acc-2', 'workflow', 'Timeout', { timestamp: '2026-03-31T09:01:00.000Z' });
      const result = store.recordFailure('acc-2', 'workflow', 'Timeout', {
        timestamp: '2026-03-31T09:02:00.000Z'
      });

      assert.equal(result.consecutiveFailures, 3);
      assert.equal(result.status, 'cooldown');
      assert.ok(result.cooldownUntil, 'cooldownUntil must be set');

      // Verify cooling-down IDs
      const coolingIds = store.getCoolingDownAccountIds('workflow',
        new Date('2026-03-31T09:03:00.000Z'));
      assert.ok(coolingIds.includes('acc-2'));
    } finally {
      closeDatabase(db);
    }
  });

  test('recordSuccess after cooldown clears failure state', () => {
    const db = openMemoryDb();
    try {
      const store = new LinkedInAccountHealthStore({ db });

      store.recordFailure('acc-3', 'workflow', 'Timeout');
      store.recordFailure('acc-3', 'workflow', 'Timeout');
      store.recordFailure('acc-3', 'workflow', 'Timeout');

      const recovered = store.recordSuccess('acc-3', 'workflow', {
        timestamp: '2026-03-31T12:00:00.000Z'
      });
      assert.equal(recovered.status, 'healthy');
      assert.equal(recovered.consecutiveFailures, 0);
      assert.equal(recovered.cooldownUntil, null);
    } finally {
      closeDatabase(db);
    }
  });

});

// ---------------------------------------------------------------------------
// 4. LinkedInAccountHealthStore — challenge record/clear
// ---------------------------------------------------------------------------

describe('4 — LinkedInAccountHealthStore challenge state via SQLite', () => {

  test('recordChallenge marks account as challenged', () => {
    const db = openMemoryDb();
    try {
      const store = new LinkedInAccountHealthStore({ db });

      store.recordChallenge('acc-4', 'checkpoint', 'dom-canary', {
        timestamp: '2026-03-31T11:00:00.000Z'
      });

      assert.ok(store.isChallenged('acc-4'), 'account should be challenged');

      const challenged = store.getChallengedAccountIds(new Date());
      assert.ok(challenged.includes('acc-4'));
    } finally {
      closeDatabase(db);
    }
  });

  test('clearChallenge removes challenged state', () => {
    const db = openMemoryDb();
    try {
      const store = new LinkedInAccountHealthStore({ db });

      store.recordChallenge('acc-5', 'captcha');
      assert.ok(store.isChallenged('acc-5'));

      store.clearChallenge('acc-5');
      assert.ok(!store.isChallenged('acc-5'), 'challenge should be cleared');
    } finally {
      closeDatabase(db);
    }
  });

  test('challenge state is independent per account', () => {
    const db = openMemoryDb();
    try {
      const store = new LinkedInAccountHealthStore({ db });

      store.recordChallenge('acc-X', 'captcha');
      store.recordSuccess('acc-Y', 'workflow');

      assert.ok( store.isChallenged('acc-X'));
      assert.ok(!store.isChallenged('acc-Y'));
    } finally {
      closeDatabase(db);
    }
  });

});

// ---------------------------------------------------------------------------
// 5. Legacy import — activity events
// ---------------------------------------------------------------------------

describe('5 — importActivityEvents: JSONL → SQLite', () => {

  test('imports all events from JSONL on first run', () => {
    const db = openMemoryDb();
    const ws = createTempWorkspace('import-events-');
    try {
      const eventsPath = ws.path('activity-events.jsonl');

      // Write 3 events to JSONL
      const lines = [
        { id: 'e1', type: 'dm_sent',        timestamp: new Date().toISOString(), status: 'ok', accountId: 'a1', metadata: {} },
        { id: 'e2', type: 'profile_viewed', timestamp: new Date().toISOString(), status: 'ok', accountId: 'a1', metadata: {} },
        { id: 'e3', type: 'dm_sent',        timestamp: new Date().toISOString(), status: 'ok', accountId: 'a2', metadata: {} }
      ];
      fs.writeFileSync(eventsPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

      const result = importActivityEvents(db, { eventsPath });

      assert.equal(result.imported, true);
      assert.equal(result.count, 3);

      const count = db.prepare('SELECT COUNT(*) AS n FROM activity_events').get().n;
      assert.equal(count, 3);
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

  test('import is idempotent: skipped when table already has rows', () => {
    const db = openMemoryDb();
    const ws = createTempWorkspace('import-events-idem-');
    try {
      const eventsPath = ws.path('activity-events.jsonl');
      fs.writeFileSync(eventsPath,
        JSON.stringify({ id: 'e1', type: 'dm_sent', timestamp: new Date().toISOString(), status: 'ok', metadata: {} }) + '\n'
      );

      // First import
      importActivityEvents(db, { eventsPath });

      // Second import: should be a no-op
      const result2 = importActivityEvents(db, { eventsPath });
      assert.equal(result2.imported, false);

      const count = db.prepare('SELECT COUNT(*) AS n FROM activity_events').get().n;
      assert.equal(count, 1, 'rows must not be duplicated');
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

  test('returns imported=false when JSONL file does not exist', () => {
    const db = openMemoryDb();
    try {
      const result = importActivityEvents(db, { eventsPath: '/tmp/nonexistent-events.jsonl' });
      assert.equal(result.imported, false);
    } finally {
      closeDatabase(db);
    }
  });

});

// ---------------------------------------------------------------------------
// 6. Legacy import — account health
// ---------------------------------------------------------------------------

describe('6 — importAccountHealth: JSON → SQLite', () => {

  test('imports accounts and subsystem state from JSON on first run', () => {
    const db = openMemoryDb();
    const ws = createTempWorkspace('import-health-');
    try {
      const storePath = ws.path('linkedin-account-health.json');
      const now = new Date().toISOString();

      const healthJson = {
        version: 2,
        accounts: {
          'acc-import-1': {
            workflow: {
              status: 'healthy', lastSuccessAt: now, lastErrorAt: null,
              lastError: null, consecutiveFailures: 0, cooldownUntil: null,
              cooldownReason: null, lastUpdatedAt: now
            },
            replyMonitor: {
              status: 'healthy', lastSuccessAt: null, lastErrorAt: null,
              lastError: null, consecutiveFailures: 0, cooldownUntil: null,
              cooldownReason: null, lastUpdatedAt: now
            },
            challenged: null,
            updatedAt: now
          }
        }
      };
      fs.writeFileSync(storePath, JSON.stringify(healthJson, null, 2));

      const result = importAccountHealth(db, { storePath });
      assert.equal(result.imported, true);
      assert.equal(result.count, 1);

      const rows = db.prepare('SELECT * FROM linkedin_account_health').all();
      // Expect rows for workflow, replyMonitor, _account = 3 rows
      assert.ok(rows.length >= 2, 'at least workflow + replyMonitor rows expected');
      const workflowRow = rows.find((r) => r.subsystem === 'workflow');
      assert.ok(workflowRow);
      assert.equal(workflowRow.account_id, 'acc-import-1');
      assert.equal(workflowRow.health_status, 'healthy');
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

  test('import is idempotent: skipped when table already has rows', () => {
    const db = openMemoryDb();
    const ws = createTempWorkspace('import-health-idem-');
    try {
      const storePath = ws.path('linkedin-account-health.json');
      const now = new Date().toISOString();
      const healthJson = {
        version: 2,
        accounts: {
          'acc-x': {
            workflow:     { status: 'healthy', consecutiveFailures: 0, lastUpdatedAt: now },
            replyMonitor: { status: 'healthy', consecutiveFailures: 0, lastUpdatedAt: now },
            challenged: null, updatedAt: now
          }
        }
      };
      fs.writeFileSync(storePath, JSON.stringify(healthJson, null, 2));

      importAccountHealth(db, { storePath });

      const result2 = importAccountHealth(db, { storePath });
      assert.equal(result2.imported, false, 'second import must be a no-op');
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 7. No-db path: JSON/JSONL fallback is preserved
// ---------------------------------------------------------------------------

describe('7 — no-db path: stores fall back to JSON/JSONL', () => {

  test('ActivityEventStore without db writes to JSONL', () => {
    const ws = createTempWorkspace('evt-json-');
    try {
      const eventsPath = ws.path('events.jsonl');
      const store = new ActivityEventStore({ eventsPath });

      store.append({ type: 'dm_sent', accountId: 'acc-1' });

      assert.ok(fs.existsSync(eventsPath), 'JSONL file should be written');
      const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).type, 'dm_sent');
    } finally {
      ws.cleanup();
    }
  });

  test('LinkedInAccountHealthStore without db writes to JSON', () => {
    const ws = createTempWorkspace('health-json-');
    try {
      const storePath = ws.path('health.json');
      const store = new LinkedInAccountHealthStore({ storePath });

      store.recordSuccess('acc-1', 'workflow');

      assert.ok(fs.existsSync(storePath), 'JSON file should be written');
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      assert.ok(raw.accounts?.['acc-1']?.workflow);
      assert.equal(raw.accounts['acc-1'].workflow.status, 'healthy');
    } finally {
      ws.cleanup();
    }
  });

});
