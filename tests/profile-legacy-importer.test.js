'use strict';

/**
 * tests/profile-legacy-importer.test.js
 *
 * Pins the Phase B step 3 contract for storage/profile-legacy-importer.js.
 * Importer is a pure module that takes (db, options) and returns a result
 * object describing what happened. It writes:
 *   - prospects rows via prospect-queue-store.upsertProspect (additive)
 *   - profile_actions rows via INSERT OR IGNORE on legacy_dedupe_key
 *   - import_state row with the same counts
 *
 * No Electron / main.js dependency. Tests run against an in-memory SQLite
 * database initialized by storage/sqlite-db.openDatabase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const ProspectQueueStore = require('../prospect-queue-store');
const { importProfiles } = require('../storage/profile-legacy-importer');
const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withImporterEnv(testName, fn) {
  return test(testName, () => {
    const workspace = createTempWorkspace('profile-importer-');
    const db = openDatabase(workspace.path('test.db'));
    try {
      const prospectStore = new ProspectQueueStore({ db });
      fn({ workspace, db, prospectStore });
    } finally {
      closeDatabase(db);
      workspace.cleanup();
    }
  });
}

function writeProfilesJson(workspace, content) {
  const filePath = workspace.path('profiles.json');
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

function selectAllProspects(db) {
  return db.prepare('SELECT * FROM prospects ORDER BY created_at ASC').all();
}

function selectAllActions(db) {
  return db.prepare('SELECT * FROM profile_actions ORDER BY occurred_at ASC').all();
}

function selectImportState(db, name = 'profiles') {
  return db.prepare('SELECT * FROM import_state WHERE importer_name = ?').get(name);
}

// ---------------------------------------------------------------------------
// 1. File-level failure modes — every case must NOT throw to the caller
// ---------------------------------------------------------------------------

withImporterEnv('missing file → no-op, returns zeros, writes import_state with errors=0', ({ workspace, db, prospectStore }) => {
  const result = importProfiles(db, {
    profilesPath: workspace.path('does-not-exist.json'),
    prospectStore
  });
  assert.deepEqual(
    { read: result.read, importedProspects: result.importedProspects, importedActions: result.importedActions, skipped: result.skipped, errors: result.errors },
    { read: 0, importedProspects: 0, importedActions: 0, skipped: 0, errors: 0 }
  );
  assert.ok(typeof result.ranAt === 'string' && result.ranAt.endsWith('Z'), 'ranAt is ISO timestamp');

  const state = selectImportState(db);
  assert.ok(state, 'import_state row written even when file absent');
  assert.equal(state.importer_name, 'profiles');
  assert.equal(state.last_run_imported, 0);
  assert.equal(state.last_run_errors, 0);
});

withImporterEnv('empty file → no-op, returns zeros', ({ workspace, db, prospectStore }) => {
  fs.writeFileSync(workspace.path('profiles.json'), '');
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(result.read, 0);
  assert.equal(result.errors, 0);
  assert.equal(selectAllProspects(db).length, 0);
});

withImporterEnv('malformed JSON → errors=1, returns gracefully', ({ workspace, db, prospectStore }) => {
  fs.writeFileSync(workspace.path('profiles.json'), '{not valid json{{');
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(result.read, 0);
  assert.equal(result.errors, 1);
  assert.equal(result.importedProspects, 0);
  const state = selectImportState(db);
  assert.equal(state.last_run_errors, 1);
});

withImporterEnv('non-array JSON root → errors=1', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, { not: 'an array' });
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(result.errors, 1);
  assert.equal(result.read, 0);
});

// ---------------------------------------------------------------------------
// 2. Happy path — single record, single action
// ---------------------------------------------------------------------------

withImporterEnv('valid single record + single action → 1 prospect + 1 action', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, [{
    url: 'https://www.linkedin.com/in/jane-doe/',
    fullName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    title: 'Senior Engineer',
    rawHeadline: 'Senior Engineer at Acme',
    company: 'Acme',
    companyDomain: 'acme.com',
    email: 'jane@acme.com',
    accountId: 'acc-1',
    accountName: 'Account One',
    firstInteraction: '2026-01-01T00:00:00Z',
    lastInteraction: '2026-05-28T00:00:00Z',
    actions: [
      { type: 'Profile Viewed', timestamp: '2026-01-15T10:00:00Z', notes: 'During search' }
    ]
  }]);
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(result.read, 1);
  assert.equal(result.importedProspects, 1, 'one new prospect created');
  assert.equal(result.importedActions, 1, 'one action inserted');
  assert.equal(result.errors, 0);

  const prospects = selectAllProspects(db);
  assert.equal(prospects.length, 1);
  assert.equal(prospects[0].full_name, 'Jane Doe');
  assert.equal(prospects[0].first_name, 'Jane');
  assert.equal(prospects[0].last_name, 'Doe');
  assert.equal(prospects[0].company_domain, 'acme.com');
  assert.equal(prospects[0].primary_email, 'jane@acme.com');
  assert.equal(prospects[0].first_interaction_at, '2026-01-01T00:00:00Z');
  assert.equal(prospects[0].source, 'profiles', 'sourceType set by importer');

  const actions = selectAllActions(db);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action_type, 'Profile Viewed');
  assert.equal(actions[0].notes, 'During search');
  assert.equal(actions[0].prospect_id, prospects[0].id);
  assert.ok(actions[0].legacy_dedupe_key, 'legacy_dedupe_key populated');
  assert.ok(actions[0].normalized_profile_url, 'normalized_profile_url populated');
});

// ---------------------------------------------------------------------------
// 3. Idempotency — re-running on same data produces same SQLite state
// ---------------------------------------------------------------------------

withImporterEnv('regression: legacy_dedupe_key is stable when upsertProspect returns different prospect IDs across runs', ({ workspace, db, prospectStore }) => {
  // Smoke against the real profiles.json surfaced this: when two records
  // dedupe to the same prospect via name+company keys, upsertProspect's
  // LIMIT-1 SQL lookup can return EITHER matching prospect on subsequent
  // runs (no ORDER BY guarantee). If the legacy_dedupe_key includes the
  // prospect_id, re-runs produce DIFFERENT keys for the same logical
  // action → INSERT OR IGNORE misses → action duplicates.
  //
  // The fix is to compose the key from normalizedProfileUrl (stable from
  // the input data), NOT prospect_id. This test wraps prospectStore so its
  // upsertProspect returns a DIFFERENT prospect.id every call — the most
  // adversarial possible behavior — and verifies the importer still
  // dedupes actions correctly across runs.
  const realUpsert = prospectStore.upsertProspect.bind(prospectStore);
  let callIdx = 0;
  prospectStore.upsertProspect = (input, options) => {
    callIdx += 1;
    // Force a brand-new prospect for every single call. This is what would
    // happen worst-case if the SQL lookup non-determinism flipped on every
    // call. The test passes ONLY if the dedupe key is prospect-agnostic.
    return realUpsert({ ...input, prospectId: `force-new-${callIdx}-${Math.random()}` }, options);
  };

  writeProfilesJson(workspace, [{
    url: 'https://www.linkedin.com/in/stable/',
    fullName: 'Stable',
    actions: [
      { type: 'Profile Viewed', timestamp: '2026-01-01T00:00:00Z', notes: 'first' },
      { type: 'Profile Viewed', timestamp: '2026-02-01T00:00:00Z', notes: 'second' }
    ]
  }]);

  // First run: 2 actions inserted
  importProfiles(db, { profilesPath: workspace.path('profiles.json'), prospectStore });
  // Second run: same data, but our wrapper forces a different prospect each call
  const second = importProfiles(db, { profilesPath: workspace.path('profiles.json'), prospectStore });

  assert.equal(second.importedActions, 0, 'dedupe_key must be prospect-agnostic so re-runs hit the unique index regardless of upsert non-determinism');
  assert.equal(selectAllActions(db).length, 2, 'still exactly 2 action rows after both runs');

  // Restore the original upsert for any subsequent tests.
  prospectStore.upsertProspect = realUpsert;
});

withImporterEnv('idempotent: re-running on same data produces 0 new imports', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, [{
    url: 'https://www.linkedin.com/in/jane-doe/',
    fullName: 'Jane Doe',
    actions: [
      { type: 'Profile Viewed', timestamp: '2026-01-15T10:00:00Z', notes: 'note 1' },
      { type: 'Profile Viewed', timestamp: '2026-02-01T10:00:00Z', notes: 'note 2' }
    ]
  }]);
  const first = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(first.importedProspects, 1);
  assert.equal(first.importedActions, 2);

  // Second run: same file.
  const second = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(second.read, 1);
  // Prospect already exists → upsert path doesn't create new
  // (still calls upsertProspect to fill any NULLs, but importer doesn't
  // count that as a new import — depends on impl. We pin: total actions
  // unchanged after re-run.)
  assert.equal(second.importedActions, 0, 'legacy_dedupe_key blocks re-import');
  assert.equal(selectAllActions(db).length, 2, 'action count unchanged after re-run');
  assert.equal(selectAllProspects(db).length, 1, 'prospect count unchanged after re-run');
});

// ---------------------------------------------------------------------------
// 4. Additive merge — importer never overwrites existing non-NULL SQLite
// ---------------------------------------------------------------------------

withImporterEnv('additive: importer does NOT overwrite existing non-NULL SQLite values', ({ workspace, db, prospectStore }) => {
  // Runtime writes first — establishes the "good" SQLite values.
  prospectStore.upsertProspect({
    accountId: 'acc-1',
    profileUrl: 'https://www.linkedin.com/in/jane-doe/',
    fullName: 'Runtime Jane',
    title: 'Runtime Title',
    company: 'Runtime Co.'
  });

  // Importer sees a STALE record with different values.
  writeProfilesJson(workspace, [{
    url: 'https://www.linkedin.com/in/jane-doe/',
    accountId: 'acc-1',
    fullName: 'Stale Jane',       // SHOULD NOT win
    title: 'Stale Title',          // SHOULD NOT win
    company: 'Stale Co.',          // SHOULD NOT win
    firstName: 'Jane',             // SHOULD win (NULL in SQLite)
    lastName: 'Doe',               // SHOULD win
    companyDomain: 'acme.com',     // SHOULD win
    actions: []
  }]);
  importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });

  const prospects = selectAllProspects(db);
  assert.equal(prospects.length, 1, 'still one prospect (deduped by URL)');
  assert.equal(prospects[0].full_name, 'Runtime Jane', 'existing non-NULL preserved');
  assert.equal(prospects[0].headline, 'Runtime Title', 'existing non-NULL preserved');
  assert.equal(prospects[0].company, 'Runtime Co.', 'existing non-NULL preserved');
  assert.equal(prospects[0].first_name, 'Jane', 'NULL field filled');
  assert.equal(prospects[0].last_name, 'Doe', 'NULL field filled');
  assert.equal(prospects[0].company_domain, 'acme.com', 'NULL field filled');
});

// ---------------------------------------------------------------------------
// 5. Orphan stub creation — profiles record with no matching prospect
// ---------------------------------------------------------------------------

withImporterEnv('orphan profile (no matching prospect) creates a stub via upsertProspect', ({ workspace, db, prospectStore }) => {
  assert.equal(selectAllProspects(db).length, 0, 'no prospects yet');

  writeProfilesJson(workspace, [{
    url: 'https://www.linkedin.com/in/new-orphan/',
    fullName: 'New Orphan',
    accountId: 'acc-1',
    actions: [{ type: 'Profile Viewed', timestamp: '2026-01-15T10:00:00Z' }]
  }]);
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(result.importedProspects, 1, 'stub prospect created');
  assert.equal(result.importedActions, 1);

  const prospects = selectAllProspects(db);
  assert.equal(prospects.length, 1);
  assert.equal(prospects[0].full_name, 'New Orphan');
  assert.equal(prospects[0].prospect_state, 'discovered');
  assert.equal(prospects[0].source, 'profiles');
});

// ---------------------------------------------------------------------------
// 6. URL normalization — variants collapse to one prospect
// ---------------------------------------------------------------------------

withImporterEnv('two records with different URL forms collapse to one prospect', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, [
    {
      url: 'https://www.linkedin.com/in/same-person/',
      fullName: 'Same Person',
      accountId: 'acc-1',
      actions: [{ type: 'Profile Viewed', timestamp: '2026-01-01T00:00:00Z' }]
    },
    {
      url: 'https://linkedin.com/in/SAME-PERSON?trk=public',  // different host + case + query
      fullName: 'Same Person',
      accountId: 'acc-1',
      actions: [{ type: 'Profile Viewed', timestamp: '2026-02-01T00:00:00Z' }]
    }
  ]);
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(result.read, 2);
  assert.equal(result.importedProspects, 1, 'two records → one prospect (URL-normalized dedupe)');
  assert.equal(result.importedActions, 2, 'both actions kept (different timestamps)');
  assert.equal(selectAllProspects(db).length, 1);
});

// ---------------------------------------------------------------------------
// 7. Malformed entry handling — must not break the whole import
// ---------------------------------------------------------------------------

withImporterEnv('non-object entry in array → skipped, other entries succeed', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, [
    'not an object',
    null,
    42,
    {
      url: 'https://www.linkedin.com/in/valid/',
      fullName: 'Valid Profile',
      actions: []
    }
  ]);
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(result.read, 4, 'all 4 entries examined');
  assert.equal(result.skipped, 3, '3 non-object entries skipped');
  assert.equal(result.importedProspects, 1, 'valid entry still imported');
});

withImporterEnv('record without url is skipped (no profile_url means no dedupe key)', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, [
    { fullName: 'No URL', actions: [] },
    { url: 'https://www.linkedin.com/in/has-url/', fullName: 'Has URL', actions: [] }
  ]);
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(result.skipped, 1, 'no-url record skipped');
  assert.equal(result.importedProspects, 1, 'has-url record imported');
});

withImporterEnv('malformed action (missing type) → errors counter increments, other actions still imported', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, [{
    url: 'https://www.linkedin.com/in/jane/',
    fullName: 'Jane',
    actions: [
      { type: 'Profile Viewed', timestamp: '2026-01-01T00:00:00Z' },
      { /* missing type */ timestamp: '2026-02-01T00:00:00Z' },
      { type: 'Post Liked', timestamp: '2026-03-01T00:00:00Z' }
    ]
  }]);
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore
  });
  assert.equal(result.errors, 1, 'one malformed action counted');
  assert.equal(result.importedActions, 2, 'other actions still imported');
});

// ---------------------------------------------------------------------------
// 8. import_state observability
// ---------------------------------------------------------------------------

withImporterEnv('import_state row carries split counts and accumulates total_imported across runs', ({ workspace, db, prospectStore }) => {
  // Run 1
  writeProfilesJson(workspace, [{
    url: 'https://www.linkedin.com/in/run1/',
    fullName: 'Run One',
    actions: [{ type: 'Profile Viewed', timestamp: '2026-01-01T00:00:00Z' }]
  }]);
  importProfiles(db, { profilesPath: workspace.path('profiles.json'), prospectStore });
  const state1 = selectImportState(db);
  // total_imported is the sum of prospects + actions per design doc convention
  assert.equal(state1.total_imported, 2, 'total_imported = 1 prospect + 1 action');
  assert.equal(state1.last_run_imported, 2);

  // Run 2: add a new record
  writeProfilesJson(workspace, [
    {
      url: 'https://www.linkedin.com/in/run1/',
      fullName: 'Run One',
      actions: [{ type: 'Profile Viewed', timestamp: '2026-01-01T00:00:00Z' }]  // dup, dedupe-blocked
    },
    {
      url: 'https://www.linkedin.com/in/run2/',
      fullName: 'Run Two',
      actions: [{ type: 'Profile Viewed', timestamp: '2026-02-01T00:00:00Z' }]
    }
  ]);
  importProfiles(db, { profilesPath: workspace.path('profiles.json'), prospectStore });
  const state2 = selectImportState(db);
  assert.equal(state2.last_run_imported, 2, '2nd run: 1 new prospect + 1 new action');
  assert.equal(state2.total_imported, 4, 'total_imported accumulates: 2 + 2');
});

// ---------------------------------------------------------------------------
// 9. dryRun mode — count but don't write
// ---------------------------------------------------------------------------

withImporterEnv('dryRun: counts what would happen but writes nothing', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, [{
    url: 'https://www.linkedin.com/in/preview/',
    fullName: 'Preview',
    actions: [{ type: 'Profile Viewed', timestamp: '2026-01-01T00:00:00Z' }]
  }]);
  const result = importProfiles(db, {
    profilesPath: workspace.path('profiles.json'),
    prospectStore,
    dryRun: true
  });
  // Counts reflect what WOULD happen
  assert.equal(result.read, 1);
  assert.equal(result.importedProspects, 1, 'counted as would-import');
  assert.equal(result.importedActions, 1);
  // But disk state is untouched
  assert.equal(selectAllProspects(db).length, 0, 'dry-run did not insert prospects');
  assert.equal(selectAllActions(db).length, 0, 'dry-run did not insert actions');
  assert.equal(selectImportState(db), undefined, 'dry-run did not write import_state');
});
