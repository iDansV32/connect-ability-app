'use strict';

/**
 * tests/run-legacy-importers.test.js
 *
 * Pins the Phase B step 5 contract for storage/run-legacy-importers.js.
 * The helper is the seam between main.js (which owns env + Electron paths)
 * and the pure importer modules. Tests run without Electron and without
 * mutating process.env — all I/O happens against an in-memory SQLite db
 * and tempdir fixtures.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const ProspectQueueStore = require('../prospect-queue-store');
const { runLegacyImporters } = require('../storage/run-legacy-importers');
const { createTempWorkspace } = require('./test-helpers');

function withEnv(testName, fn) {
  return test(testName, () => {
    const workspace = createTempWorkspace('run-legacy-importers-');
    const db = openDatabase(workspace.path('test.db'));
    try {
      const prospectStore = new ProspectQueueStore({ db });
      // Create the directory shapes the helper expects.
      const documentsDir = workspace.path('docs');
      const userDataDir = workspace.path('userData');
      fs.mkdirSync(documentsDir, { recursive: true });
      fs.mkdirSync(userDataDir, { recursive: true });
      fn({ workspace, db, prospectStore, documentsDir, userDataDir });
    } finally {
      closeDatabase(db);
      workspace.cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Disabled mode — no IO, no log lines, no SQL
// ---------------------------------------------------------------------------

withEnv('disabled=true: no IO, no log lines, returns all-zeros', ({ db, prospectStore, documentsDir, userDataDir }) => {
  // Plant data on disk — the helper should NOT touch it.
  fs.writeFileSync(path.join(documentsDir, 'profiles.json'), JSON.stringify([
    { url: 'https://www.linkedin.com/in/x/', fullName: 'X', actions: [] }
  ]));
  fs.writeFileSync(path.join(documentsDir, 'groups.json'), JSON.stringify([
    { id: 'g1', name: 'G', members: [], updatedAt: '2026-01-01T00:00:00Z' }
  ]));

  const logged = [];
  const result = runLegacyImporters({
    db,
    prospectStore,
    documentsDir,
    userDataDir,
    disabled: true,
    logger: (msg) => logged.push(msg)
  });

  assert.equal(result.disabled, true);
  assert.deepEqual(result.profiles, {
    read: 0, importedProspects: 0, importedActions: 0, skipped: 0, errors: 0, ranAt: null
  });
  assert.deepEqual(result.groups, {
    read: 0, importedGroups: 0, importedMembers: 0, skipped: 0, errors: 0, ranAt: null
  });
  assert.deepEqual(logged, [], 'disabled mode emits no log lines');

  // Disk state unchanged: no prospects, no groups, no import_state row.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prospects').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_state').get().n, 0);
});

// ---------------------------------------------------------------------------
// 2. Enabled mode — both importers run with the expected paths
// ---------------------------------------------------------------------------

withEnv('enabled=false: both importers run with documentsDir + userDataDir paths', ({ db, prospectStore, documentsDir, userDataDir }) => {
  fs.writeFileSync(path.join(documentsDir, 'profiles.json'), JSON.stringify([
    {
      url: 'https://www.linkedin.com/in/jane/',
      fullName: 'Jane',
      firstName: 'Jane',
      actions: [{ type: 'Profile Viewed', timestamp: '2026-01-15T00:00:00Z' }]
    }
  ]));
  fs.writeFileSync(path.join(documentsDir, 'groups.json'), JSON.stringify([
    { id: 'g1', name: 'A', members: ['https://www.linkedin.com/in/jane/'], updatedAt: '2026-01-01T00:00:00Z' }
  ]));

  const logged = [];
  const result = runLegacyImporters({
    db,
    prospectStore,
    documentsDir,
    userDataDir,
    disabled: false,
    logger: (msg) => logged.push(msg)
  });

  assert.equal(result.disabled, false);
  assert.equal(result.profiles.read, 1);
  assert.equal(result.profiles.importedProspects, 1);
  assert.equal(result.profiles.importedActions, 1);
  assert.equal(result.groups.read, 1);
  assert.equal(result.groups.importedGroups, 1);
  assert.equal(result.groups.importedMembers, 1);

  // Disk state: prospect + action + group + member rows present.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prospects').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM profile_actions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_members').get().n, 1);

  // Two log lines emitted — one per importer.
  assert.equal(logged.length, 2, 'one log line per importer');
  assert.ok(logged[0].includes('profiles'), 'first line is profiles');
  assert.ok(logged[1].includes('groups'), 'second line is groups');
});

// ---------------------------------------------------------------------------
// 3. Idempotency — second call on the same data reports zero new
// ---------------------------------------------------------------------------

withEnv('idempotent: second call on same data reports zero new imports', ({ db, prospectStore, documentsDir, userDataDir }) => {
  fs.writeFileSync(path.join(documentsDir, 'profiles.json'), JSON.stringify([
    {
      url: 'https://www.linkedin.com/in/jane/',
      fullName: 'Jane',
      actions: [{ type: 'Profile Viewed', timestamp: '2026-01-15T00:00:00Z' }]
    }
  ]));
  fs.writeFileSync(path.join(documentsDir, 'groups.json'), JSON.stringify([
    { id: 'g1', name: 'A', members: ['https://www.linkedin.com/in/jane/'], updatedAt: '2026-01-01T00:00:00Z' }
  ]));

  const first = runLegacyImporters({
    db, prospectStore, documentsDir, userDataDir, disabled: false, logger: () => {}
  });
  assert.equal(first.profiles.importedProspects, 1);
  assert.equal(first.profiles.importedActions, 1);
  assert.equal(first.groups.importedGroups, 1);
  assert.equal(first.groups.importedMembers, 1);

  // Same data, second pass:
  const second = runLegacyImporters({
    db, prospectStore, documentsDir, userDataDir, disabled: false, logger: () => {}
  });
  assert.equal(second.profiles.importedProspects, 0, 'no new prospects');
  assert.equal(second.profiles.importedActions, 0, 'legacy_dedupe_key blocks re-import');
  assert.equal(second.groups.importedGroups, 0, 'no new groups');
  assert.equal(second.groups.importedMembers, 0, 'composite PK blocks re-import');

  // Final counts unchanged.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM profile_actions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_members').get().n, 1);
});

// ---------------------------------------------------------------------------
// 4. Missing files — no errors, both importers report zeros
// ---------------------------------------------------------------------------

withEnv('missing files: both importers run cleanly with zeros', ({ db, prospectStore, documentsDir, userDataDir }) => {
  // No files planted. Helper should still call both importers, both
  // return zeros, both still write their import_state rows.
  const logged = [];
  const result = runLegacyImporters({
    db, prospectStore, documentsDir, userDataDir, disabled: false, logger: (msg) => logged.push(msg)
  });
  assert.equal(result.disabled, false);
  assert.equal(result.profiles.read, 0);
  assert.equal(result.profiles.errors, 0);
  assert.equal(result.groups.read, 0);
  assert.equal(result.groups.errors, 0);
  assert.equal(logged.length, 2, 'both importers still log a summary line');
});

// ---------------------------------------------------------------------------
// 5. The groupsPaths array shape — uses ALL three historic paths
// ---------------------------------------------------------------------------

withEnv('groupsPaths covers all 3 historic locations: docs/groups.json, docs/standalone-groups.json, userData/groups.json', ({ db, prospectStore, documentsDir, userDataDir }) => {
  // Plant a different group in each of the 3 paths. All three should be
  // imported, proving the helper threads all three paths to the importer.
  fs.writeFileSync(path.join(documentsDir, 'groups.json'), JSON.stringify([
    { id: 'docs-main', name: 'A', members: [], updatedAt: '2026-01-01T00:00:00Z' }
  ]));
  fs.writeFileSync(path.join(documentsDir, 'standalone-groups.json'), JSON.stringify([
    { id: 'docs-standalone', name: 'B', members: [], updatedAt: '2026-01-01T00:00:00Z' }
  ]));
  fs.writeFileSync(path.join(userDataDir, 'groups.json'), JSON.stringify([
    { id: 'userdata', name: 'C', members: [], updatedAt: '2026-01-01T00:00:00Z' }
  ]));

  const result = runLegacyImporters({
    db, prospectStore, documentsDir, userDataDir, disabled: false, logger: () => {}
  });
  assert.equal(result.groups.read, 3, 'all 3 paths examined');
  assert.equal(result.groups.importedGroups, 3, 'all 3 groups imported');
  const ids = db.prepare('SELECT id FROM groups ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, ['docs-main', 'docs-standalone', 'userdata']);
});

// ---------------------------------------------------------------------------
// 6. Logger contract — function called with strings only
// ---------------------------------------------------------------------------

withEnv('logger receives string args (signature stability)', ({ db, prospectStore, documentsDir, userDataDir }) => {
  const calls = [];
  runLegacyImporters({
    db, prospectStore, documentsDir, userDataDir, disabled: false, logger: (msg) => calls.push(msg)
  });
  for (const c of calls) {
    assert.equal(typeof c, 'string', `logger received non-string: ${typeof c}`);
  }
});

withEnv('logger missing: helper still runs without throwing', ({ db, prospectStore, documentsDir, userDataDir }) => {
  // Logger is optional — the helper should default-protect itself.
  assert.doesNotThrow(() => {
    runLegacyImporters({
      db, prospectStore, documentsDir, userDataDir, disabled: false
      // no logger
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Return shape contract
// ---------------------------------------------------------------------------

withEnv('return shape has profiles + groups + disabled keys', ({ db, prospectStore, documentsDir, userDataDir }) => {
  const r = runLegacyImporters({
    db, prospectStore, documentsDir, userDataDir, disabled: false, logger: () => {}
  });
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'profiles'));
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'groups'));
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'disabled'));
});
