'use strict';

/**
 * Tests for the Ticket-3 storage scaffold.
 *
 * These tests validate that:
 *  1. schema.js exports the expected DDL strings and constants.
 *  2. sqlite-db.js throws a useful error when better-sqlite3 is absent.
 *  3. repository.js stubs throw NOT_IMPLEMENTED on every method call.
 *
 * No SQLite runtime is required — the tests exercise only the scaffold layer.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ALL_DDL, SCHEMA_VERSION, TABLE_WORKFLOW_RUNS, TABLE_WORKFLOW_JOBS,
        TABLE_PROSPECTS, TABLE_ACTIVITY_EVENTS, TABLE_LINKEDIN_ACCOUNT_HEALTH,
        TABLE_TRANSPORT_HEALTH, TABLE_NOTIFICATIONS,
        TABLE_PROFILE_ACTIONS, TABLE_GROUPS, TABLE_GROUP_MEMBERS, TABLE_IMPORT_STATE,
        INDEX_PROFILE_ACTIONS_LEGACY_DEDUPE } = require('../storage/schema');

const { openDatabase, DRIVER_PACKAGE } = require('../storage/sqlite-db');

const { createStorageRepository, NOT_IMPLEMENTED } = require('../storage/repository');

// ---------------------------------------------------------------------------
// schema.js
// ---------------------------------------------------------------------------

describe('storage/schema.js', () => {

  test('SCHEMA_VERSION is a positive integer', () => {
    assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION > 0);
  });

  test('ALL_DDL contains all 7 tables and their indexes', () => {
    // 7 CREATE TABLE + 11 CREATE INDEX = 18 total statements
    assert.ok(Array.isArray(ALL_DDL));
    assert.ok(ALL_DDL.length >= 18, `expected >= 18 DDL statements, got ${ALL_DDL.length}`);
    assert.ok(ALL_DDL.every((s) => typeof s === 'string' && s.trim().length > 0));
  });

  test('every table DDL uses CREATE TABLE IF NOT EXISTS', () => {
    const tables = [
      TABLE_WORKFLOW_RUNS,
      TABLE_WORKFLOW_JOBS,
      TABLE_PROSPECTS,
      TABLE_ACTIVITY_EVENTS,
      TABLE_LINKEDIN_ACCOUNT_HEALTH,
      TABLE_TRANSPORT_HEALTH,
      TABLE_NOTIFICATIONS
    ];
    for (const ddl of tables) {
      assert.ok(
        ddl.toUpperCase().includes('CREATE TABLE IF NOT EXISTS'),
        `DDL missing IF NOT EXISTS: ${ddl.slice(0, 60)}`
      );
    }
  });

  test('workflow_runs DDL contains required columns', () => {
    const ddl = TABLE_WORKFLOW_RUNS.toLowerCase();
    for (const col of ['id', 'run_status', 'steps_json', 'targets_json', 'account_id', 'created_at', 'updated_at']) {
      assert.ok(ddl.includes(col), `workflow_runs missing column: ${col}`);
    }
  });

  test('workflow_jobs DDL contains required columns', () => {
    const ddl = TABLE_WORKFLOW_JOBS.toLowerCase();
    for (const col of ['id', 'run_id', 'target_id', 'step_index', 'step_type', 'job_status', 'scheduled_for', 'attempts']) {
      assert.ok(ddl.includes(col), `workflow_jobs missing column: ${col}`);
    }
  });

  test('prospects DDL has compliance columns', () => {
    const ddl = TABLE_PROSPECTS.toLowerCase();
    assert.ok(ddl.includes('do_not_contact'), 'prospects missing do_not_contact');
    assert.ok(ddl.includes('unsubscribed_at'), 'prospects missing unsubscribed_at');
    assert.ok(ddl.includes('archived'),        'prospects missing archived');
  });

  test('linkedin_account_health DDL has UNIQUE (account_id, subsystem)', () => {
    assert.ok(TABLE_LINKEDIN_ACCOUNT_HEALTH.toUpperCase().includes('UNIQUE'));
  });

  test('transport_health DDL has UNIQUE (transport, action, account_email)', () => {
    assert.ok(TABLE_TRANSPORT_HEALTH.toUpperCase().includes('UNIQUE'));
  });

  test('notifications DDL has conversation_urn and delivered_at', () => {
    const ddl = TABLE_NOTIFICATIONS.toLowerCase();
    assert.ok(ddl.includes('conversation_urn'), 'notifications missing conversation_urn');
    assert.ok(ddl.includes('delivered_at'),     'notifications missing delivered_at');
  });

  // -------------------------------------------------------------------------
  // Phase A — profiles/groups SQLite migration (roadmap #7)
  // -------------------------------------------------------------------------

  test('profile_actions DDL has prospect_id FK + legacy_dedupe_key + normalized URL', () => {
    const ddl = TABLE_PROFILE_ACTIONS.toLowerCase();
    for (const col of ['prospect_id', 'normalized_profile_url', 'action_type', 'occurred_at', 'legacy_dedupe_key']) {
      assert.ok(ddl.includes(col), `profile_actions missing column: ${col}`);
    }
    assert.ok(ddl.includes('references prospects'), 'profile_actions missing FK to prospects');
    assert.ok(ddl.includes('if not exists'), 'profile_actions missing IF NOT EXISTS');
  });

  test('profile_actions legacy_dedupe_key has UNIQUE partial index', () => {
    const idx = INDEX_PROFILE_ACTIONS_LEGACY_DEDUPE.toLowerCase();
    assert.ok(idx.includes('create unique index'), 'legacy_dedupe index not UNIQUE');
    assert.ok(idx.includes('where legacy_dedupe_key is not null'),
      'legacy_dedupe index missing partial WHERE clause (runtime writes must leave the column NULL without constraint)');
  });

  test('groups DDL has required columns + nullable account_id', () => {
    const ddl = TABLE_GROUPS.toLowerCase();
    for (const col of ['id', 'name', 'description', 'color', 'account_id', 'created_at', 'updated_at']) {
      assert.ok(ddl.includes(col), `groups missing column: ${col}`);
    }
    // account_id must be nullable — design doc §7 (cross-account / legacy groups allowed)
    assert.ok(!/account_id\s+text\s+not null/i.test(ddl), 'groups.account_id should be nullable');
  });

  test('group_members has composite PRIMARY KEY on (group_id, normalized_profile_url)', () => {
    const ddl = TABLE_GROUP_MEMBERS.toLowerCase();
    for (const col of ['group_id', 'profile_url', 'normalized_profile_url', 'prospect_id', 'member_metadata_json', 'added_at']) {
      assert.ok(ddl.includes(col), `group_members missing column: ${col}`);
    }
    assert.ok(/primary\s+key\s*\(\s*group_id\s*,\s*normalized_profile_url\s*\)/i.test(ddl),
      'group_members missing composite PRIMARY KEY (group_id, normalized_profile_url)');
    assert.ok(ddl.includes('on delete cascade'),
      'group_members missing ON DELETE CASCADE — orphan rows would survive group deletion');
  });

  test('import_state DDL has importer_name PK + run counters', () => {
    const ddl = TABLE_IMPORT_STATE.toLowerCase();
    for (const col of ['importer_name', 'last_run_at', 'last_run_imported', 'last_run_skipped', 'last_run_errors', 'total_imported']) {
      assert.ok(ddl.includes(col), `import_state missing column: ${col}`);
    }
    assert.ok(ddl.includes('primary key'), 'import_state missing PRIMARY KEY');
  });

});

// ---------------------------------------------------------------------------
// sqlite-db.js
// ---------------------------------------------------------------------------

describe('storage/sqlite-db.js', () => {

  test('DRIVER_PACKAGE is the expected npm package name', () => {
    assert.equal(DRIVER_PACKAGE, 'better-sqlite3');
  });

  test('openDatabase opens an in-memory database successfully (better-sqlite3 is now installed)', () => {
    // Ticket 4B installs better-sqlite3. Verify the happy path: openDatabase
    // returns a live db handle for :memory: and closeDatabase is idempotent.
    const { closeDatabase } = require('../storage/sqlite-db');
    const db = openDatabase(':memory:');
    try {
      assert.ok(db,                      'should return a db handle');
      assert.ok(typeof db.prepare === 'function', 'handle should have prepare()');
      // Schema should be applied — both workflow tables must exist
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflow_runs','workflow_jobs') ORDER BY name`
      ).all().map(r => r.name);
      assert.deepEqual(tables, ['workflow_jobs', 'workflow_runs'], 'schema tables created');
    } finally {
      closeDatabase(db);
    }
  });

  test('openDatabase throws TypeError for empty dbPath', () => {
    assert.throws(() => openDatabase(''),   TypeError);
    assert.throws(() => openDatabase('  '), TypeError);
    assert.throws(() => openDatabase(null), TypeError);
  });

  test('applySchema is idempotent — second open on same DB file is a no-op', () => {
    // Phase A test: pins the load-bearing contract that re-running the
    // schema (every app startup) never throws on an already-migrated DB.
    // The try/catch around ALTER TABLE in applySchema is what makes this
    // safe; this test prevents anyone from regressing that.
    const { closeDatabase } = require('../storage/sqlite-db');
    const { createTempWorkspace } = require('./test-helpers');
    const ws = createTempWorkspace('phase-a-idempotency-');
    try {
      const dbPath = ws.path('connect-ability.db');

      // First open — creates everything.
      const db1 = openDatabase(dbPath);
      const firstTableCount = db1.prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`
      ).get().n;
      // Seed a prospect so we can verify data survives the re-migration.
      db1.prepare(`
        INSERT INTO prospects (id, prospect_state, created_at, updated_at)
        VALUES ('phase-a-test-1', 'discovered', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `).run();
      closeDatabase(db1);

      // Second open on same path — must not throw, must not lose data.
      assert.doesNotThrow(() => {
        const db2 = openDatabase(dbPath);
        const secondTableCount = db2.prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`
        ).get().n;
        assert.equal(secondTableCount, firstTableCount, 'table count unchanged on re-migration');
        const survivor = db2.prepare(
          `SELECT id FROM prospects WHERE id='phase-a-test-1'`
        ).get();
        assert.equal(survivor && survivor.id, 'phase-a-test-1', 'seeded data survives re-migration');
        closeDatabase(db2);
      });
    } finally {
      ws.cleanup();
    }
  });

  test('applySchema creates Phase A tables + indexes + new prospect columns', () => {
    const { closeDatabase } = require('../storage/sqlite-db');
    const db = openDatabase(':memory:');
    try {
      // 4 new tables present
      const tableRows = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name IN ('profile_actions','groups','group_members','import_state')
        ORDER BY name
      `).all().map(r => r.name);
      assert.deepEqual(
        tableRows,
        ['group_members', 'groups', 'import_state', 'profile_actions'],
        'all 4 Phase A tables present'
      );

      // 6 new indexes present
      const idxRows = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND name IN (
          'idx_profile_actions_prospect',
          'idx_profile_actions_occurred',
          'idx_profile_actions_normalized_url',
          'idx_profile_actions_legacy_dedupe',
          'idx_group_members_prospect',
          'idx_group_members_normalized_url'
        )
        ORDER BY name
      `).all().map(r => r.name);
      assert.equal(idxRows.length, 6, 'all 6 Phase A indexes present');

      // 8 new prospect columns
      const prospectCols = new Set(
        db.prepare(`PRAGMA table_info(prospects)`).all().map(c => c.name)
      );
      for (const col of [
        'first_name', 'last_name', 'raw_headline', 'company_domain',
        'primary_email', 'suggested_emails_json',
        'first_interaction_at', 'last_interaction_at'
      ]) {
        assert.ok(prospectCols.has(col), `prospects missing Phase A column: ${col}`);
      }

      // import_state reads cleanly when empty (no error, returns empty set)
      const importStateRows = db.prepare(`SELECT * FROM import_state`).all();
      assert.deepEqual(importStateRows, [], 'import_state queryable when empty');
    } finally {
      closeDatabase(db);
    }
  });

  test('group_members ON DELETE CASCADE removes orphan rows', () => {
    // Pins the FK + CASCADE contract — when a group is deleted, all its
    // members go with it. Without CASCADE, group_members rows would
    // accumulate forever as ghosts referencing deleted groups.
    const { closeDatabase } = require('../storage/sqlite-db');
    const db = openDatabase(':memory:');
    try {
      db.exec(`PRAGMA foreign_keys = ON`);
      const now = '2026-01-01T00:00:00Z';
      db.prepare(`INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run('g1', 'Test', now, now);
      db.prepare(`
        INSERT INTO group_members (group_id, profile_url, normalized_profile_url, added_at)
        VALUES ('g1', 'https://www.linkedin.com/in/x/', 'linkedin.com/in/x', ?)
      `).run(now);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM group_members`).get().n, 1, 'member exists');

      db.prepare(`DELETE FROM groups WHERE id='g1'`).run();
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM group_members`).get().n, 0, 'member CASCADE-deleted');
    } finally {
      closeDatabase(db);
    }
  });

});

// ---------------------------------------------------------------------------
// repository.js — stub contract
// ---------------------------------------------------------------------------

describe('storage/repository.js', () => {

  // Null db — stubs never touch it, so passing null is fine here.
  const repo = createStorageRepository(null);

  test('createStorageRepository returns all expected sub-repositories', () => {
    for (const key of [
      'workflowRuns', 'workflowJobs', 'prospects', 'activityEvents',
      'linkedInAccountHealth', 'transportHealth', 'notifications'
    ]) {
      assert.ok(repo[key] && typeof repo[key] === 'object', `missing sub-repo: ${key}`);
    }
  });

  test('db reference is passed through', () => {
    const sentinel = {};
    const r = createStorageRepository(sentinel);
    assert.equal(r.db, sentinel);
  });

  // Each stub should throw (not return NOT_IMPLEMENTED, but throw an Error).
  const STUB_CALLS = [
    () => repo.workflowRuns.insert({}),
    () => repo.workflowRuns.update('id', {}),
    () => repo.workflowRuns.findById('id'),
    () => repo.workflowRuns.findAll(),
    () => repo.workflowRuns.refreshStatus('id'),

    () => repo.workflowJobs.insert({}),
    () => repo.workflowJobs.update('id', {}),
    () => repo.workflowJobs.findById('id'),
    () => repo.workflowJobs.findByRunId('id'),
    () => repo.workflowJobs.claimDue({}),
    () => repo.workflowJobs.retry('id', {}),
    () => repo.workflowJobs.complete('id', {}),
    () => repo.workflowJobs.fail('id', {}),
    () => repo.workflowJobs.heartbeat('id', {}),

    () => repo.prospects.upsert({}),
    () => repo.prospects.findById('id'),
    () => repo.prospects.findAll(),
    () => repo.prospects.applyLeadScores([]),
    () => repo.prospects.archive('id'),

    () => repo.activityEvents.append({}),
    () => repo.activityEvents.getStepOutcomeBreakdown(),
    () => repo.activityEvents.findAll(),

    () => repo.linkedInAccountHealth.findByKey('a', 'b'),
    () => repo.linkedInAccountHealth.findAll(),
    () => repo.linkedInAccountHealth.upsert('a', 'b', {}),
    () => repo.linkedInAccountHealth.getCoolingDownIds('workflow'),
    () => repo.linkedInAccountHealth.getChallengedIds(),

    () => repo.transportHealth.findByKey('a', 'b', 'c'),
    () => repo.transportHealth.upsert('a', 'b', 'c', {}),

    () => repo.notifications.insert({}),
    () => repo.notifications.update('id', {}),
    () => repo.notifications.findById('id'),
    () => repo.notifications.findAll(),
    () => repo.notifications.markRead('id'),
    () => repo.notifications.markAllRead()
  ];

  test('every stub method throws an Error mentioning NOT_IMPLEMENTED', () => {
    for (const call of STUB_CALLS) {
      assert.throws(
        call,
        (err) => {
          assert.ok(err instanceof Error, 'stub should throw Error');
          assert.ok(
            err.message.includes('not implemented'),
            `stub error should mention "not implemented": ${err.message}`
          );
          return true;
        }
      );
    }
  });

  test('NOT_IMPLEMENTED sentinel is a Symbol', () => {
    assert.equal(typeof NOT_IMPLEMENTED, 'symbol');
  });

});
