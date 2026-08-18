'use strict';

/**
 * tests/group-legacy-importer.test.js
 *
 * Pins the Phase B step 4 contract for storage/group-legacy-importer.js.
 * Mirrors the shape of profile-legacy-importer but operates on the
 * 3-path groups.json store + writes to groups + group_members tables.
 *
 * Critical asymmetry pinned here (per design doc + Phase B framing):
 *
 *   • cross-store (JSON vs SQLite):  SQLite always wins; importer additive only
 *   • intra-source (3 groups.json):  most-recent updatedAt wins, because
 *                                    all three files are operator-machine
 *                                    replicas of the same logical store
 *                                    (written by save-groups-data IPC).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const ProspectQueueStore = require('../prospect-queue-store');
const { importGroups } = require('../storage/group-legacy-importer');
const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withImporterEnv(name, fn) {
  return test(name, () => {
    const workspace = createTempWorkspace('group-importer-');
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

function writeJsonAt(filePath, content) {
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

function selectAllGroups(db) {
  return db.prepare('SELECT * FROM groups ORDER BY created_at ASC').all();
}

function selectAllMembers(db) {
  return db.prepare('SELECT * FROM group_members ORDER BY group_id, normalized_profile_url').all();
}

function selectImportState(db, name = 'groups') {
  return db.prepare('SELECT * FROM import_state WHERE importer_name = ?').get(name);
}

function paths(workspace) {
  return [
    workspace.path('docs', 'groups.json'),
    workspace.path('docs', 'standalone-groups.json'),
    workspace.path('userData', 'groups.json')
  ];
}

// ---------------------------------------------------------------------------
// 1. File-level failure modes
// ---------------------------------------------------------------------------

withImporterEnv('all three files missing → no-op + zeros + import_state row', ({ workspace, db, prospectStore }) => {
  const result = importGroups(db, { groupsPaths: paths(workspace), prospectStore });
  assert.equal(result.read, 0);
  assert.equal(result.importedGroups, 0);
  assert.equal(result.importedMembers, 0);
  assert.equal(result.errors, 0);
  assert.ok(typeof result.ranAt === 'string' && result.ranAt.endsWith('Z'));
  const state = selectImportState(db);
  assert.ok(state, 'import_state row written');
  assert.equal(state.importer_name, 'groups');
  assert.equal(state.last_run_errors, 0);
});

withImporterEnv('one file present, two missing → only present file imported, no errors', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [
    { id: 'g1', name: 'One Path Only', members: ['https://www.linkedin.com/in/a/'], updatedAt: '2026-01-01T00:00:00Z' }
  ]);
  const result = importGroups(db, { groupsPaths: ps, prospectStore });
  assert.equal(result.read, 1);
  assert.equal(result.importedGroups, 1);
  assert.equal(result.importedMembers, 1);
  assert.equal(result.errors, 0, 'missing files do NOT count as errors');
});

withImporterEnv('malformed JSON in one file → errors+=1, other files still imported', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  fs.mkdirSync(workspace.path('userData'), { recursive: true });
  writeJsonAt(ps[0], [{ id: 'g1', name: 'Valid', members: ['https://www.linkedin.com/in/a/'], updatedAt: '2026-01-01T00:00:00Z' }]);
  fs.writeFileSync(ps[1], '{{not valid json');
  writeJsonAt(ps[2], [{ id: 'g2', name: 'Also Valid', members: [], updatedAt: '2026-01-01T00:00:00Z' }]);
  const result = importGroups(db, { groupsPaths: ps, prospectStore });
  assert.equal(result.errors, 1, 'one malformed file');
  assert.equal(result.importedGroups, 2, 'other two files still imported');
});

withImporterEnv('non-array root in one file → errors+=1', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], { not: 'an array' });
  const result = importGroups(db, { groupsPaths: ps, prospectStore });
  assert.equal(result.errors, 1);
  assert.equal(result.importedGroups, 0);
});

// ---------------------------------------------------------------------------
// 2. Intra-source merge — most-recent updatedAt wins across the 3 replicas
// ---------------------------------------------------------------------------

withImporterEnv('same group id in 3 files → most-recent updatedAt wins', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  fs.mkdirSync(workspace.path('userData'), { recursive: true });
  // Oldest
  writeJsonAt(ps[0], [{ id: 'g1', name: 'Oldest Name', description: 'old',  members: ['https://www.linkedin.com/in/a/'], updatedAt: '2026-01-01T00:00:00Z' }]);
  // Newest
  writeJsonAt(ps[1], [{ id: 'g1', name: 'Newest Name', description: 'new',  members: ['https://www.linkedin.com/in/b/'], updatedAt: '2026-03-01T00:00:00Z' }]);
  // Middle
  writeJsonAt(ps[2], [{ id: 'g1', name: 'Middle Name', description: 'mid',  members: ['https://www.linkedin.com/in/c/'], updatedAt: '2026-02-01T00:00:00Z' }]);

  importGroups(db, { groupsPaths: ps, prospectStore });
  const groups = selectAllGroups(db);
  assert.equal(groups.length, 1, 'one merged group');
  assert.equal(groups[0].name, 'Newest Name', 'most-recent updatedAt wins');
  assert.equal(groups[0].description, 'new');

  // Members should be from the winning replica only, NOT a union of all three.
  // (Union would be ambiguous if the operator removed a member in the latest
  // edit — the runtime IPC handler treats each save as an authoritative
  // replacement; the importer must preserve that semantic.)
  const members = selectAllMembers(db);
  assert.equal(members.length, 1, 'only winning replica\'s members imported');
  assert.equal(members[0].normalized_profile_url, 'https://www.linkedin.com/in/b');
});

withImporterEnv('updatedAt missing → falls back to first-seen-wins (no crash)', ({ workspace, db, prospectStore }) => {
  // If two replicas of a group have no updatedAt, the importer can't pick
  // a "most recent" one. Pin: first-encountered wins, no crash.
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [{ id: 'g1', name: 'First', members: [] }]);
  writeJsonAt(ps[1], [{ id: 'g1', name: 'Second', members: [] }]);
  importGroups(db, { groupsPaths: ps, prospectStore });
  const groups = selectAllGroups(db);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'First', 'first-seen wins when neither has updatedAt');
});

// ---------------------------------------------------------------------------
// 3. Happy path — single group, mixed member shapes
// ---------------------------------------------------------------------------

withImporterEnv('imports a group with bare-URL members and object members', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [{
    id: 'g1',
    name: 'Mixed Members',
    description: 'has both kinds',
    color: '#0a66c2',
    members: [
      'https://www.linkedin.com/in/bare-url/',                                  // bare string
      { url: 'https://www.linkedin.com/in/object-1', name: 'Object Name One' }, // object with metadata
      { profileUrl: 'https://www.linkedin.com/in/object-2/', label: 'Object Two' } // object via profileUrl alias
    ],
    updatedAt: '2026-01-01T00:00:00Z'
  }]);
  const result = importGroups(db, { groupsPaths: ps, prospectStore });
  assert.equal(result.importedGroups, 1);
  assert.equal(result.importedMembers, 3);

  const groups = selectAllGroups(db);
  assert.equal(groups[0].name, 'Mixed Members');
  assert.equal(groups[0].description, 'has both kinds');
  assert.equal(groups[0].color, '#0a66c2');

  const members = selectAllMembers(db);
  assert.equal(members.length, 3);
  const bare = members.find((m) => m.normalized_profile_url === 'https://www.linkedin.com/in/bare-url');
  assert.equal(bare.member_metadata_json, null, 'bare-URL member: no metadata');
  const obj1 = members.find((m) => m.normalized_profile_url === 'https://www.linkedin.com/in/object-1');
  const meta1 = JSON.parse(obj1.member_metadata_json);
  assert.equal(meta1.name, 'Object Name One', 'object member metadata preserved');
});

// ---------------------------------------------------------------------------
// 4. URL normalization — variants collapse via composite PK
// ---------------------------------------------------------------------------

withImporterEnv('URL variants of same member collapse to one row via composite PK', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [{
    id: 'g1', name: 'Dupes', updatedAt: '2026-01-01T00:00:00Z',
    members: [
      'https://www.linkedin.com/in/same/',
      'https://linkedin.com/in/SAME?trk=public',  // different host + case + query
      { url: 'https://www.linkedin.com/in/same' }  // object form
    ]
  }]);
  importGroups(db, { groupsPaths: ps, prospectStore });
  const members = selectAllMembers(db);
  assert.equal(members.length, 1, 'three URL variants → one row (composite PK dedupe)');
});

// ---------------------------------------------------------------------------
// 5. Idempotency — re-run produces 0 new
// ---------------------------------------------------------------------------

withImporterEnv('idempotent: re-running on same data produces 0 new groups/members', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [
    { id: 'g1', name: 'A', members: ['https://www.linkedin.com/in/x/'], updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'g2', name: 'B', members: ['https://www.linkedin.com/in/y/'], updatedAt: '2026-01-01T00:00:00Z' }
  ]);
  const first = importGroups(db, { groupsPaths: ps, prospectStore });
  assert.equal(first.importedGroups, 2);
  assert.equal(first.importedMembers, 2);

  const second = importGroups(db, { groupsPaths: ps, prospectStore });
  // Same data, second pass: composite PK + groups id PK both dedupe.
  assert.equal(second.importedGroups, 0, 'no new groups');
  assert.equal(second.importedMembers, 0, 'no new members');
  assert.equal(selectAllGroups(db).length, 2);
  assert.equal(selectAllMembers(db).length, 2);
});

// ---------------------------------------------------------------------------
// 6. prospect_id backfill
// ---------------------------------------------------------------------------

withImporterEnv('prospect_id backfilled when prospect exists for member URL', ({ workspace, db, prospectStore }) => {
  // Pre-seed a prospect via the runtime store.
  const prospect = prospectStore.upsertProspect({
    accountId: 'acc-1',
    profileUrl: 'https://www.linkedin.com/in/known/',
    fullName: 'Known Person'
  });
  assert.ok(prospect.id);

  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [{
    id: 'g1', name: 'With Known',
    members: [
      'https://www.linkedin.com/in/known/',  // has matching prospect
      'https://www.linkedin.com/in/unknown/' // no matching prospect
    ],
    updatedAt: '2026-01-01T00:00:00Z'
  }]);
  importGroups(db, { groupsPaths: ps, prospectStore });

  const members = selectAllMembers(db);
  const known   = members.find((m) => m.normalized_profile_url === 'https://www.linkedin.com/in/known');
  const unknown = members.find((m) => m.normalized_profile_url === 'https://www.linkedin.com/in/unknown');
  assert.equal(known.prospect_id, prospect.id, 'known member gets prospect_id backfilled');
  assert.equal(unknown.prospect_id, null, 'unknown member: prospect_id stays NULL');
});

// ---------------------------------------------------------------------------
// 7. Malformed entry handling
// ---------------------------------------------------------------------------

withImporterEnv('non-object array entry → skipped, others succeed', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [
    'not an object',
    null,
    42,
    { id: 'g-valid', name: 'Valid', members: [], updatedAt: '2026-01-01T00:00:00Z' }
  ]);
  const result = importGroups(db, { groupsPaths: ps, prospectStore });
  assert.equal(result.read, 4);
  assert.equal(result.skipped, 3, '3 non-object entries skipped');
  assert.equal(result.importedGroups, 1);
});

withImporterEnv('group missing id AND name → skipped', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [
    { members: [], updatedAt: '2026-01-01T00:00:00Z' },                     // no id, no name
    { id: 'g-ok', name: 'OK', members: [], updatedAt: '2026-01-01T00:00:00Z' }
  ]);
  const result = importGroups(db, { groupsPaths: ps, prospectStore });
  assert.equal(result.skipped, 1, 'no-id-no-name skipped');
  assert.equal(result.importedGroups, 1);
});

withImporterEnv('group missing id but has name → uses name as id (legacy compat)', ({ workspace, db, prospectStore }) => {
  // The runtime IPC handler falls back to `name` as id; the importer matches
  // that behavior so existing groups don't get duplicated under synthetic ids.
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [
    { name: 'No-Id Group', members: [], updatedAt: '2026-01-01T00:00:00Z' }
  ]);
  importGroups(db, { groupsPaths: ps, prospectStore });
  const groups = selectAllGroups(db);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'No-Id Group', 'name used as id when id is absent');
});

withImporterEnv('member with no URL → counted as error, other members proceed', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [{
    id: 'g1', name: 'With Bad Member',
    members: [
      'https://www.linkedin.com/in/ok/',
      '',                                      // empty string
      { /* no url */ name: 'No URL Member' },  // object with no url
      null
    ],
    updatedAt: '2026-01-01T00:00:00Z'
  }]);
  const result = importGroups(db, { groupsPaths: ps, prospectStore });
  assert.equal(result.errors, 3, 'three malformed members');
  assert.equal(result.importedMembers, 1, 'only the OK member imported');
});

// ---------------------------------------------------------------------------
// 8. import_state observability
// ---------------------------------------------------------------------------

withImporterEnv('import_state row accumulates total_imported across runs', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });

  // Run 1
  writeJsonAt(ps[0], [{ id: 'g1', name: 'A', members: ['https://www.linkedin.com/in/x/'], updatedAt: '2026-01-01T00:00:00Z' }]);
  importGroups(db, { groupsPaths: ps, prospectStore });
  let state = selectImportState(db);
  assert.equal(state.total_imported, 2, 'run 1: 1 group + 1 member');
  assert.equal(state.last_run_imported, 2);

  // Run 2: add a new group
  writeJsonAt(ps[0], [
    { id: 'g1', name: 'A', members: ['https://www.linkedin.com/in/x/'], updatedAt: '2026-01-01T00:00:00Z' },  // dup
    { id: 'g2', name: 'B', members: ['https://www.linkedin.com/in/y/'], updatedAt: '2026-01-01T00:00:00Z' }   // new
  ]);
  importGroups(db, { groupsPaths: ps, prospectStore });
  state = selectImportState(db);
  assert.equal(state.last_run_imported, 2, 'run 2: 1 new group + 1 new member');
  assert.equal(state.total_imported, 4, 'accumulates: 2 + 2');
});

// ---------------------------------------------------------------------------
// 9. dryRun
// ---------------------------------------------------------------------------

withImporterEnv('dryRun: counts what would happen but writes nothing', ({ workspace, db, prospectStore }) => {
  const ps = paths(workspace);
  fs.mkdirSync(workspace.path('docs'), { recursive: true });
  writeJsonAt(ps[0], [{
    id: 'g1', name: 'Preview',
    members: ['https://www.linkedin.com/in/preview/'],
    updatedAt: '2026-01-01T00:00:00Z'
  }]);
  const result = importGroups(db, { groupsPaths: ps, prospectStore, dryRun: true });
  assert.equal(result.read, 1);
  assert.equal(result.importedGroups, 1, 'counted as would-import');
  assert.equal(result.importedMembers, 1);
  assert.equal(selectAllGroups(db).length, 0, 'dry-run did not insert groups');
  assert.equal(selectAllMembers(db).length, 0, 'dry-run did not insert members');
  assert.equal(selectImportState(db), undefined, 'dry-run did not write import_state');
});
