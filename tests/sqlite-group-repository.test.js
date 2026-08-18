'use strict';

/**
 * tests/sqlite-group-repository.test.js
 *
 * Pins the Phase C step C2b-1 contract for storage/sqlite-group-repository.js —
 * the shared SQLite group WRITER used by the save-groups-data dual-write.
 *
 * saveGroups is a transactional full-state REPLACE: the renderer sends the
 * complete desired group set, so present groups are upserted, absent groups
 * deleted (members cascade), and members reconciled in payload order. These
 * tests verify create, update (createdAt preserved), removal, member ordering,
 * variant dedupe, prospect backfill, empty payload, and that the result reads
 * back cleanly through group-reconstruction (the C2b-2 read side).
 *
 * No Electron / main.js dependency. SQLite via storage/sqlite-db.openDatabase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const SqliteGroupRepository = require('../storage/sqlite-group-repository');
const { reconstructGroups } = require('../storage/group-reconstruction');
const { createTempWorkspace } = require('./test-helpers');

function withEnv(testName, fn) {
  return test(testName, () => {
    const workspace = createTempWorkspace('sqlite-group-repo-');
    const db = openDatabase(workspace.path('test.db'));
    try {
      fn({ db, repo: new SqliteGroupRepository(db) });
    } finally {
      closeDatabase(db);
      workspace.cleanup();
    }
  });
}

function group(overrides = {}) {
  return {
    id: 'grp-1',
    name: 'Heads of People',
    description: 'People leaders',
    color: '#3366ff',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    members: ['https://www.linkedin.com/in/jane-doe'],
    ...overrides
  };
}

function selectGroupRow(db, id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
}
function selectMembers(db, id) {
  return db.prepare('SELECT * FROM group_members WHERE group_id = ? ORDER BY rowid').all(id);
}

// ---------------------------------------------------------------------------
// 1. Create
// ---------------------------------------------------------------------------

withEnv('saveGroups creates groups + members', ({ db, repo }) => {
  const counts = repo.saveGroups([group({
    members: ['https://www.linkedin.com/in/jane-doe', 'https://www.linkedin.com/in/john-smith']
  })]);
  assert.equal(counts.groups, 1);
  assert.equal(counts.members, 2);

  const row = selectGroupRow(db, 'grp-1');
  assert.equal(row.name, 'Heads of People');
  assert.equal(row.description, 'People leaders');
  assert.equal(row.color, '#3366ff');
  assert.equal(row.account_id, null, 'accountId always NULL on save (matches JSON path)');
  assert.equal(row.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(row.updated_at, '2026-02-01T00:00:00.000Z');

  const members = selectMembers(db, 'grp-1');
  assert.equal(members.length, 2);
  assert.equal(members[0].profile_url, 'https://www.linkedin.com/in/jane-doe');
});

// ---------------------------------------------------------------------------
// 2. Member order = payload order (rowid)
// ---------------------------------------------------------------------------

withEnv('member rowid order follows payload order', ({ db, repo }) => {
  repo.saveGroups([group({
    members: [
      'https://www.linkedin.com/in/zoe',
      'https://www.linkedin.com/in/amy',
      'https://www.linkedin.com/in/mike'
    ]
  })]);
  const urls = selectMembers(db, 'grp-1').map((m) => m.profile_url);
  assert.deepEqual(urls, [
    'https://www.linkedin.com/in/zoe',
    'https://www.linkedin.com/in/amy',
    'https://www.linkedin.com/in/mike'
  ]);
});

// ---------------------------------------------------------------------------
// 3. Update preserves createdAt, refreshes updatedAt, reconciles members
// ---------------------------------------------------------------------------

withEnv('re-save updates fields, preserves created_at, reconciles members', ({ db, repo }) => {
  repo.saveGroups([group()]);
  // Re-save same id: new name, no createdAt sent, member swapped.
  repo.saveGroups([{
    id: 'grp-1',
    name: 'Renamed Group',
    description: 'Updated',
    color: '#000000',
    createdAt: null,
    updatedAt: '2026-03-01T00:00:00.000Z',
    members: ['https://www.linkedin.com/in/new-person']
  }]);

  const row = selectGroupRow(db, 'grp-1');
  assert.equal(row.name, 'Renamed Group');
  assert.equal(row.description, 'Updated');
  assert.equal(row.created_at, '2026-01-01T00:00:00.000Z', 'created_at preserved across re-save');
  assert.equal(row.updated_at, '2026-03-01T00:00:00.000Z');

  const members = selectMembers(db, 'grp-1');
  assert.equal(members.length, 1);
  assert.equal(members[0].profile_url, 'https://www.linkedin.com/in/new-person', 'old member removed, new one present');
});

// ---------------------------------------------------------------------------
// 4. Removed group is deleted (members cascade)
// ---------------------------------------------------------------------------

withEnv('group absent from payload is deleted with its members', ({ db, repo }) => {
  repo.saveGroups([
    group({ id: 'grp-1' }),
    group({ id: 'grp-2', name: 'Second', members: ['https://www.linkedin.com/in/x'] })
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM groups').get().n, 2);

  // Re-save with only grp-1.
  repo.saveGroups([group({ id: 'grp-1' })]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM groups').get().n, 1);
  assert.equal(selectGroupRow(db, 'grp-2'), undefined, 'grp-2 deleted');
  assert.equal(selectMembers(db, 'grp-2').length, 0, 'grp-2 members cascade-deleted');
});

// ---------------------------------------------------------------------------
// 5. Empty payload clears all groups
// ---------------------------------------------------------------------------

withEnv('empty payload removes all groups', ({ db, repo }) => {
  repo.saveGroups([group()]);
  repo.saveGroups([]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM groups').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM group_members').get().n, 0);
});

// ---------------------------------------------------------------------------
// 6. Duplicate member URL variants collapse
// ---------------------------------------------------------------------------

withEnv('duplicate member URL variants collapse to one row', ({ db, repo }) => {
  const counts = repo.saveGroups([group({
    members: [
      'https://www.linkedin.com/in/jane-doe',
      'https://www.linkedin.com/in/jane-doe/',
      'https://linkedin.com/in/JANE-DOE'
    ]
  })]);
  assert.equal(counts.members, 1);
  assert.equal(selectMembers(db, 'grp-1').length, 1);
});

// ---------------------------------------------------------------------------
// 7. prospect_id backfill via injected map
// ---------------------------------------------------------------------------

withEnv('prospect_id backfilled from injected normalizedUrl map', ({ db, repo }) => {
  const prospectIdByUrl = new Map([
    ['https://www.linkedin.com/in/jane-doe', 'prospect-123']
  ]);
  repo.saveGroups([group({ members: ['https://www.linkedin.com/in/jane-doe'] })], { prospectIdByUrl });
  const members = selectMembers(db, 'grp-1');
  assert.equal(members[0].prospect_id, 'prospect-123');
});

// ---------------------------------------------------------------------------
// 8. Empty / invalid member urls are skipped
// ---------------------------------------------------------------------------

withEnv('blank member urls are skipped', ({ db, repo }) => {
  const counts = repo.saveGroups([group({ members: ['', '   ', 'https://www.linkedin.com/in/ok'] })]);
  assert.equal(counts.members, 1);
  assert.equal(selectMembers(db, 'grp-1').length, 1);
});

// ---------------------------------------------------------------------------
// 9. Round-trip through reconstruction (the C2b-2 read side)
// ---------------------------------------------------------------------------

withEnv('saved groups read back through reconstructGroups', ({ db, repo }) => {
  repo.saveGroups([group({
    members: ['https://www.linkedin.com/in/jane-doe', 'https://www.linkedin.com/in/john-smith']
  })]);
  const rebuilt = reconstructGroups(db);
  assert.equal(rebuilt.length, 1);
  assert.deepEqual(rebuilt[0], {
    id: 'grp-1',
    name: 'Heads of People',
    description: 'People leaders',
    color: '#3366ff',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    members: ['https://www.linkedin.com/in/jane-doe', 'https://www.linkedin.com/in/john-smith']
  });
});

// ---------------------------------------------------------------------------
// 10. Verbatim empty-string description is stored (mirrors JSON exactly)
// ---------------------------------------------------------------------------

withEnv('empty-string description stored verbatim (mirrors JSON save)', ({ db, repo }) => {
  repo.saveGroups([group({ description: '' })]);
  assert.equal(selectGroupRow(db, 'grp-1').description, '');
  // And reconstruction emits it (since '' != null), matching a JSON read.
  assert.equal(reconstructGroups(db)[0].description, '');
});

// ---------------------------------------------------------------------------
// 11. now injection used when timestamps absent
// ---------------------------------------------------------------------------

withEnv('uses injected clock when createdAt/updatedAt absent', ({ db, repo }) => {
  repo.saveGroups([{ id: 'g', name: 'G', members: [] }], { now: () => new Date('2026-09-09T00:00:00.000Z') });
  const row = selectGroupRow(db, 'g');
  assert.equal(row.created_at, '2026-09-09T00:00:00.000Z');
  assert.equal(row.updated_at, '2026-09-09T00:00:00.000Z');
});
