'use strict';

/**
 * tests/sqlite-transport-health.test.js
 *
 * Targeted tests for Ticket 12 — SQLite-backed TransportHealthStore.
 *
 * Covers:
 *  1. SQLite-backed failure recording and disable threshold
 *  2. Auto-recovery after recovery window
 *  3. Persistence across separate connections (cross-process simulation)
 *  4. isTransportDisabled() after a "worker-side" write
 *  5. No-db fallback (JSON mode) still works
 *  6. Legacy JSON import into SQLite
 *  7. Schema creates transport_health table with index
 *  8. recordSuccess resets failure count
 *  9. Repository CRUD basics
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const TransportHealthStore = require('../automation/runtime/transport-health-store');
const SqliteTransportHealthRepository = require('../storage/sqlite-transport-health-repository');
const { createTempWorkspace, readJson, writeJson } = require('./test-helpers');

// ---------------------------------------------------------------------------
// 1. SQLite-backed failure recording and disable threshold
// ---------------------------------------------------------------------------

test('SQLite store disables transport after 3 failures for the same triple', () => {
  const ws = createTempWorkspace('transport-sqlite-threshold-');
  const dbPath = ws.path('test.db');
  const db = openDatabase(dbPath);
  try {
    const store = new TransportHealthStore({ db });

    store.recordFailure('private_api', 'send_dm', 'alice@example.com', {
      timestamp: '2026-03-22T10:00:00.000Z', reason: 'timeout'
    });
    store.recordFailure('private_api', 'send_dm', 'alice@example.com', {
      timestamp: '2026-03-22T10:01:00.000Z', reason: 'timeout'
    });
    const third = store.recordFailure('private_api', 'send_dm', 'alice@example.com', {
      timestamp: '2026-03-22T10:02:00.000Z', reason: 'timeout'
    });

    assert.equal(third.disabled, true);
    assert.equal(third.failureCount, 3);
    assert.equal(
      store.isTransportDisabled('private_api', 'send_dm', 'alice@example.com',
        new Date('2026-03-22T10:03:00.000Z')),
      true
    );
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 2. Auto-recovery after recovery window
// ---------------------------------------------------------------------------

test('SQLite store auto-recovers after recovery window expires', () => {
  const ws = createTempWorkspace('transport-sqlite-recovery-');
  const dbPath = ws.path('test.db');
  const db = openDatabase(dbPath);
  try {
    const store = new TransportHealthStore({ db, recoveryWindowMs: 1000 });

    store.recordFailure('private_api', 'send_connection', 'alice@example.com', {
      timestamp: '2026-03-22T10:00:00.000Z'
    });
    store.recordFailure('private_api', 'send_connection', 'alice@example.com', {
      timestamp: '2026-03-22T10:00:10.000Z'
    });
    store.recordFailure('private_api', 'send_connection', 'alice@example.com', {
      timestamp: '2026-03-22T10:00:20.000Z'
    });

    // Should be disabled right after the third failure
    assert.equal(
      store.isTransportDisabled('private_api', 'send_connection', 'alice@example.com',
        new Date('2026-03-22T10:00:20.500Z')),
      true
    );

    // After recovery window (1 second) — should auto-recover
    const recovered = store.getTransportState(
      'private_api', 'send_connection', 'alice@example.com',
      new Date('2026-03-22T10:00:21.500Z')
    );

    assert.equal(recovered.disabled, false);
    assert.equal(recovered.failureCount, 0);
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 3. Persistence across separate connections (cross-process simulation)
// ---------------------------------------------------------------------------

test('Failures written by one connection are visible from a separate connection', () => {
  const ws = createTempWorkspace('transport-sqlite-crossproc-');
  const dbPath = ws.path('test.db');

  // "Worker process" — writes failures
  const workerDb = openDatabase(dbPath);
  try {
    const workerStore = new TransportHealthStore({ db: workerDb });
    workerStore.recordFailure('dom', 'send_connection', 'bob@example.com', {
      timestamp: '2026-03-22T11:00:00.000Z', reason: 'selector_drift'
    });
    workerStore.recordFailure('dom', 'send_connection', 'bob@example.com', {
      timestamp: '2026-03-22T11:00:10.000Z', reason: 'selector_drift'
    });
    workerStore.recordFailure('dom', 'send_connection', 'bob@example.com', {
      timestamp: '2026-03-22T11:00:20.000Z', reason: 'selector_drift'
    });
  } finally {
    closeDatabase(workerDb);
  }

  // "Main process" — opens a SEPARATE connection and reads
  const mainDb = openDatabase(dbPath);
  try {
    const mainStore = new TransportHealthStore({ db: mainDb });
    const state = mainStore.getTransportState(
      'dom', 'send_connection', 'bob@example.com',
      new Date('2026-03-22T11:00:25.000Z')
    );

    assert.ok(state, 'state should be readable from the second connection');
    assert.equal(state.failureCount, 3);
    assert.equal(state.disabled, true);
    assert.equal(state.lastFailureReason, 'selector_drift');
  } finally {
    closeDatabase(mainDb);
  }
});

// ---------------------------------------------------------------------------
// 4. isTransportDisabled after a "worker-side" write (dbPath mode)
// ---------------------------------------------------------------------------

test('Store opened via dbPath can record failures and report disabled state', () => {
  const ws = createTempWorkspace('transport-sqlite-dbpath-');
  const dbPath = ws.path('test.db');

  // Ensure schema exists
  const initDb = openDatabase(dbPath);
  closeDatabase(initDb);

  // Worker opens its own connection via dbPath
  const store = new TransportHealthStore({ dbPath });
  try {
    store.recordFailure('private_api', 'send_dm', 'carol@example.com', { reason: 'err1' });
    store.recordFailure('private_api', 'send_dm', 'carol@example.com', { reason: 'err2' });
    store.recordFailure('private_api', 'send_dm', 'carol@example.com', { reason: 'err3' });

    assert.equal(store.isTransportDisabled('private_api', 'send_dm', 'carol@example.com'), true);
  } finally {
    store.close();
  }

  // Read from a separate main connection
  const mainDb = openDatabase(dbPath);
  try {
    const mainStore = new TransportHealthStore({ db: mainDb });
    assert.equal(mainStore.isTransportDisabled('private_api', 'send_dm', 'carol@example.com'), true);
  } finally {
    closeDatabase(mainDb);
  }
});

// ---------------------------------------------------------------------------
// 5. No-db fallback (JSON mode) still works
// ---------------------------------------------------------------------------

test('TransportHealthStore falls back to JSON when no db/dbPath provided', () => {
  const ws = createTempWorkspace('transport-json-fallback-');
  const storePath = ws.path('transport-health.json');

  const store = new TransportHealthStore({ storePath });
  store.recordFailure('private_api', 'send_dm', 'dave@example.com', {
    timestamp: '2026-03-22T12:00:00.000Z', reason: 'timeout'
  });

  const state = store.getTransportState('private_api', 'send_dm', 'dave@example.com');
  assert.equal(state.failureCount, 1);
  assert.equal(state.lastFailureReason, 'timeout');

  // Verify JSON file was created
  const raw = readJson(storePath);
  assert.equal(Object.keys(raw.entries).length, 1);
});

// ---------------------------------------------------------------------------
// 6. Legacy JSON import into SQLite
// ---------------------------------------------------------------------------

test('importLegacyEntries transfers JSON entries into SQLite', () => {
  const ws = createTempWorkspace('transport-sqlite-import-');
  const dbPath = ws.path('test.db');
  const db = openDatabase(dbPath);
  try {
    // Build a legacy entries map in the old JSON format
    const legacyEntries = {
      'private_api::send_dm::eve@example.com': {
        transport: 'private_api',
        action: 'send_dm',
        accountEmail: 'eve@example.com',
        successCount: 5,
        failureCount: 2,
        lastSuccessAt: '2026-03-22T09:00:00.000Z',
        lastFailureAt: '2026-03-22T09:30:00.000Z',
        lastFailureReason: 'rate_limited',
        lastUpdatedAt: '2026-03-22T09:30:00.000Z',
        disabled: false,
        disabledUntil: null
      },
      'dom::send_connection::eve@example.com': {
        transport: 'dom',
        action: 'send_connection',
        accountEmail: 'eve@example.com',
        successCount: 0,
        failureCount: 3,
        lastFailureAt: '2026-03-22T09:45:00.000Z',
        lastFailureReason: 'selector_error',
        lastUpdatedAt: '2026-03-22T09:45:00.000Z',
        disabled: true,
        disabledUntil: '2026-03-22T10:15:00.000Z'
      }
    };

    const store = new TransportHealthStore({ db });
    store.importLegacyEntries(legacyEntries);

    // Verify the entries are readable
    const dmState = store.getTransportState('private_api', 'send_dm', 'eve@example.com');
    assert.ok(dmState);
    assert.equal(dmState.successCount, 5);
    assert.equal(dmState.failureCount, 2);
    assert.equal(dmState.lastFailureReason, 'rate_limited');

    const connState = store.getTransportState(
      'dom', 'send_connection', 'eve@example.com',
      new Date('2026-03-22T09:50:00.000Z')  // still within disable window
    );
    assert.ok(connState);
    assert.equal(connState.disabled, true);
    assert.equal(connState.failureCount, 3);
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 7. Schema creates transport_health table with index
// ---------------------------------------------------------------------------

test('transport_health table and index exist after openDatabase', () => {
  const ws = createTempWorkspace('transport-sqlite-schema-');
  const dbPath = ws.path('test.db');
  const db = openDatabase(dbPath);
  try {
    // Check table exists
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='transport_health'"
    ).get();
    assert.ok(table, 'transport_health table should exist');

    // Check index exists
    const index = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_transport_health_lookup'"
    ).get();
    assert.ok(index, 'idx_transport_health_lookup index should exist');

    // Check UNIQUE constraint exists (via unique index)
    const uniqueIndex = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE '%transport_health%' AND sql LIKE '%UNIQUE%'"
    ).get();
    // UNIQUE constraint creates an autoindex — check columns instead
    const info = db.prepare("PRAGMA table_info('transport_health')").all();
    const colNames = info.map(c => c.name);
    assert.ok(colNames.includes('transport'));
    assert.ok(colNames.includes('action'));
    assert.ok(colNames.includes('account_email'));
    assert.ok(colNames.includes('failure_count'));
    assert.ok(colNames.includes('disabled_until'));
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 8. recordSuccess resets failure count and disabled state
// ---------------------------------------------------------------------------

test('SQLite store recordSuccess resets failure count and re-enables transport', () => {
  const ws = createTempWorkspace('transport-sqlite-success-');
  const dbPath = ws.path('test.db');
  const db = openDatabase(dbPath);
  try {
    const store = new TransportHealthStore({ db });

    // Build up to disabled state
    store.recordFailure('private_api', 'send_dm', 'frank@example.com', { reason: 'err' });
    store.recordFailure('private_api', 'send_dm', 'frank@example.com', { reason: 'err' });
    store.recordFailure('private_api', 'send_dm', 'frank@example.com', { reason: 'err' });
    assert.equal(store.isTransportDisabled('private_api', 'send_dm', 'frank@example.com'), true);

    // Record a success
    const success = store.recordSuccess('private_api', 'send_dm', 'frank@example.com');
    assert.equal(success.disabled, false);
    assert.equal(success.failureCount, 0);
    assert.equal(success.successCount, 1);
    assert.equal(store.isTransportDisabled('private_api', 'send_dm', 'frank@example.com'), false);
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 9. Repository CRUD basics
// ---------------------------------------------------------------------------

test('SqliteTransportHealthRepository upsert and get round-trip', () => {
  const ws = createTempWorkspace('transport-sqlite-repo-');
  const dbPath = ws.path('test.db');
  const db = openDatabase(dbPath);
  try {
    const repo = new SqliteTransportHealthRepository(db);

    repo.upsert({
      transport: 'private_api',
      action: 'send_dm',
      accountEmail: 'grace@example.com',
      failureCount: 2,
      successCount: 10,
      disabled: false,
      disabledUntil: null,
      lastSuccessAt: '2026-03-22T08:00:00.000Z',
      lastFailureAt: '2026-03-22T08:30:00.000Z',
      lastFailureReason: 'timeout',
      lastUpdatedAt: '2026-03-22T08:30:00.000Z'
    });

    const entry = repo.get('private_api', 'send_dm', 'grace@example.com');
    assert.ok(entry);
    assert.equal(entry.transport, 'private_api');
    assert.equal(entry.action, 'send_dm');
    assert.equal(entry.accountEmail, 'grace@example.com');
    assert.equal(entry.failureCount, 2);
    assert.equal(entry.successCount, 10);
    assert.equal(entry.lastFailureReason, 'timeout');

    // Upsert updates in place
    repo.upsert({
      transport: 'private_api',
      action: 'send_dm',
      accountEmail: 'grace@example.com',
      failureCount: 0,
      successCount: 11,
      disabled: false,
      disabledUntil: null,
      lastSuccessAt: '2026-03-22T09:00:00.000Z',
      lastFailureAt: '2026-03-22T08:30:00.000Z',
      lastFailureReason: 'timeout',
      lastUpdatedAt: '2026-03-22T09:00:00.000Z'
    });

    const updated = repo.get('private_api', 'send_dm', 'grace@example.com');
    assert.equal(updated.failureCount, 0);
    assert.equal(updated.successCount, 11);

    // readAll returns keyed map
    const all = repo.readAll();
    assert.equal(Object.keys(all).length, 1);
    assert.ok(all['private_api::send_dm::grace@example.com']);
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 10. Different triples are independent
// ---------------------------------------------------------------------------

test('SQLite store tracks different triples independently', () => {
  const ws = createTempWorkspace('transport-sqlite-independent-');
  const dbPath = ws.path('test.db');
  const db = openDatabase(dbPath);
  try {
    const store = new TransportHealthStore({ db });

    // Fail one triple to disabled
    store.recordFailure('private_api', 'send_dm', 'heidi@example.com', { reason: 'err' });
    store.recordFailure('private_api', 'send_dm', 'heidi@example.com', { reason: 'err' });
    store.recordFailure('private_api', 'send_dm', 'heidi@example.com', { reason: 'err' });

    // Different action for same account should be unaffected
    assert.equal(store.isTransportDisabled('private_api', 'send_dm', 'heidi@example.com'), true);
    assert.equal(store.isTransportDisabled('private_api', 'send_connection', 'heidi@example.com'), false);
    assert.equal(store.isTransportDisabled('dom', 'send_dm', 'heidi@example.com'), false);
  } finally {
    closeDatabase(db);
  }
});
