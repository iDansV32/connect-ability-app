'use strict';

/**
 * tests/group-reconstruction.test.js
 *
 * Pins the Phase C step C2a contract for storage/group-reconstruction.js.
 *
 * C2a builds the pure helper that rebuilds the legacy `get-groups-data` group
 * shape (PRE-enrichment) from the SQLite spine (groups + group_members). The
 * gate is equivalence with the current 3-path JSON merge. These tests run the
 * REAL Phase B group importer to populate SQLite from groups.json fixture(s),
 * then compare:
 *
 *     fixture --[importGroups]--> SQLite --[reconstructGroups]--> R
 *     fixture --[legacy 3-path merge replica]--------------------> L
 *     assert.deepEqual(R[id], L[id])   // per group, strict, pre-enrichment
 *
 * Plus: the documented narrowings (empty-string fields, duplicate member
 * variants, multi-path merge tie-break), the enrichment-composition check
 * (reconstruction still pipes cleanly through the UNCHANGED enrichGroupMembers),
 * and pure-unit edges.
 *
 * No Electron / main.js dependency. SQLite via storage/sqlite-db.openDatabase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const ProspectQueueStore = require('../prospect-queue-store');
const { importGroups } = require('../storage/group-legacy-importer');
const { reconstructGroups, reconstructGroupRecord } = require('../storage/group-reconstruction');
const {
  buildProfileLookupIndex,
  enrichGroupMembers
} = require('../automation/profile/group-member-enrichment');
const { normalizeProfileUrl } = require('../automation/url/normalize');
const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function withEnv(testName, fn) {
  return test(testName, () => {
    const workspace = createTempWorkspace('group-reconstruction-');
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

function writeGroupsJson(workspace, name, content) {
  const filePath = workspace.path(name);
  fs.writeFileSync(filePath, JSON.stringify(content));
  return filePath;
}

// Faithful replica of main.js get-groups-data's PRE-enrichment 3-path merge
// (main.js ~8023-8041). Last-path-wins per id; members filtered truthy.
function legacyMergeGroups(paths) {
  const mergedGroups = new Map();
  for (const groupsPath of paths) {
    if (!fs.existsSync(groupsPath)) continue;
    const groups = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
    if (!Array.isArray(groups)) continue;
    groups.forEach((group) => {
      if (!group || typeof group !== 'object') return;
      const groupId = String(group.id || group.name || `group-${mergedGroups.size + 1}`);
      mergedGroups.set(groupId, {
        ...group,
        id: groupId,
        members: Array.isArray(group.members) ? group.members.filter(Boolean) : []
      });
    });
  }
  return Array.from(mergedGroups.values());
}

function indexById(groups) {
  const m = new Map();
  for (const g of groups) m.set(g.id, g);
  return m;
}

function canonicalGroup(overrides = {}) {
  return {
    id: 'grp-1',
    name: 'Heads of People',
    description: 'People leaders in SaaS',
    color: '#3366ff',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    members: [
      'https://www.linkedin.com/in/jane-doe',
      'https://www.linkedin.com/in/john-smith'
    ],
    ...overrides
  };
}

// Import a single-path fixture, then assert reconstruction === legacy merge.
function assertEquivalence({ workspace, db, prospectStore }, fixture) {
  const p = writeGroupsJson(workspace, 'groups.json', fixture);
  importGroups(db, { groupsPaths: [p], prospectStore });

  const L = indexById(legacyMergeGroups([p]));
  const R = indexById(reconstructGroups(db));

  assert.deepEqual([...R.keys()].sort(), [...L.keys()].sort(), 'same set of group ids');
  for (const [id, lrec] of L) {
    assert.deepEqual(R.get(id), lrec, `group ${id} must match legacy merge field-for-field (pre-enrichment)`);
  }
  return { L, R };
}

// ---------------------------------------------------------------------------
// 1. Equivalence — canonical group
// ---------------------------------------------------------------------------

withEnv('equivalence: canonical group with members', (ctx) => {
  const { R } = assertEquivalence(ctx, [canonicalGroup()]);
  const g = [...R.values()][0];
  assert.deepEqual(g.members, [
    'https://www.linkedin.com/in/jane-doe',
    'https://www.linkedin.com/in/john-smith'
  ]);
  assert.ok(!('accountId' in g), 'no accountId when source had none');
});

// ---------------------------------------------------------------------------
// 2. Equivalence — multiple groups
// ---------------------------------------------------------------------------

withEnv('equivalence: multiple groups', (ctx) => {
  assertEquivalence(ctx, [
    canonicalGroup({ id: 'grp-1', name: 'Heads of People' }),
    canonicalGroup({
      id: 'grp-2',
      name: 'VP Sales',
      description: 'Sales leaders',
      color: '#ff8800',
      members: ['https://www.linkedin.com/in/sara-lee']
    })
  ]);
});

// ---------------------------------------------------------------------------
// 3. Equivalence — group with no members
// ---------------------------------------------------------------------------

withEnv('equivalence: group with empty members array', (ctx) => {
  const { R } = assertEquivalence(ctx, [canonicalGroup({ members: [] })]);
  assert.deepEqual([...R.values()][0].members, []);
});

// ---------------------------------------------------------------------------
// 4. Member order preserved (rowid = insertion = source array order)
// ---------------------------------------------------------------------------

withEnv('member order matches source array order', ({ workspace, db, prospectStore }) => {
  const p = writeGroupsJson(workspace, 'groups.json', [canonicalGroup({
    members: [
      'https://www.linkedin.com/in/zoe',
      'https://www.linkedin.com/in/amy',
      'https://www.linkedin.com/in/mike'
    ]
  })]);
  importGroups(db, { groupsPaths: [p], prospectStore });
  const g = reconstructGroups(db)[0];
  assert.deepEqual(g.members, [
    'https://www.linkedin.com/in/zoe',
    'https://www.linkedin.com/in/amy',
    'https://www.linkedin.com/in/mike'
  ], 'members preserve source order, not alphabetical');
});

// ---------------------------------------------------------------------------
// 5. Equivalence — group with accountId
// ---------------------------------------------------------------------------

withEnv('equivalence: group carrying accountId', (ctx) => {
  const { R } = assertEquivalence(ctx, [canonicalGroup({ accountId: 'acc-1' })]);
  assert.equal([...R.values()][0].accountId, 'acc-1');
});

// ---------------------------------------------------------------------------
// 6. Enrichment composition — reconstruction pipes through the UNCHANGED
//    enrichGroupMembers exactly like get-groups-data does.
// ---------------------------------------------------------------------------

withEnv('reconstruction composes with enrichGroupMembers (profile reads untouched)', ({ workspace, db, prospectStore }) => {
  const p = writeGroupsJson(workspace, 'groups.json', [canonicalGroup({
    members: ['https://www.linkedin.com/in/jane-doe']
  })]);
  importGroups(db, { groupsPaths: [p], prospectStore });

  // A profile list as getEnrichedStoredProfiles would return it (the C3 flip
  // does NOT happen here — enrichment input is still the profile read).
  const profiles = [{
    url: 'https://www.linkedin.com/in/jane-doe',
    fullName: 'Jane Doe',
    title: 'Head of People',
    company: 'Acme'
  }];
  const lookup = buildProfileLookupIndex(profiles, normalizeProfileUrl);
  const enriched = enrichGroupMembers(reconstructGroups(db), lookup, normalizeProfileUrl);

  assert.equal(enriched.length, 1);
  assert.deepEqual(enriched[0].memberProfiles, [{
    url: 'https://www.linkedin.com/in/jane-doe',
    name: 'Jane Doe',
    title: 'Head of People',
    company: 'Acme'
  }]);
  assert.deepEqual(enriched[0].members, ['https://www.linkedin.com/in/jane-doe'], 'members preserved unchanged');
});

// ---------------------------------------------------------------------------
// 7. Documented narrowing — empty-string description collapses to absent
// ---------------------------------------------------------------------------

withEnv('narrowing: empty-string description/color become absent (importer || null)', ({ workspace, db, prospectStore }) => {
  const p = writeGroupsJson(workspace, 'groups.json', [canonicalGroup({ description: '', color: '' })]);
  importGroups(db, { groupsPaths: [p], prospectStore });

  const g = reconstructGroups(db)[0];
  assert.ok(!('description' in g), 'empty description not recoverable → omitted');
  assert.ok(!('color' in g), 'empty color not recoverable → omitted');
  // This is a divergence from the legacy merge (which would keep ''), so it is
  // pinned here explicitly rather than asserted as equivalence.
});

// ---------------------------------------------------------------------------
// 8. Documented narrowing — duplicate member URL variants collapse
// ---------------------------------------------------------------------------

withEnv('narrowing: duplicate member URL variants collapse to one row', ({ workspace, db, prospectStore }) => {
  const p = writeGroupsJson(workspace, 'groups.json', [canonicalGroup({
    members: [
      'https://www.linkedin.com/in/jane-doe',
      'https://www.linkedin.com/in/jane-doe/',     // trailing slash variant
      'https://linkedin.com/in/JANE-DOE'           // host + case variant
    ]
  })]);
  importGroups(db, { groupsPaths: [p], prospectStore });

  const g = reconstructGroups(db)[0];
  assert.equal(g.members.length, 1, 'composite PK on normalized_profile_url dedupes variants');
});

// ---------------------------------------------------------------------------
// 9. Documented behavior — multi-path tie-break is newest-updatedAt-wins
//    (the importer's rule), which differs from the legacy read's last-path-wins.
// ---------------------------------------------------------------------------

withEnv('multi-path: spine uses newest-updatedAt-wins (importer policy)', ({ workspace, db, prospectStore }) => {
  const older = writeGroupsJson(workspace, 'groups.json', [canonicalGroup({
    name: 'Older Name', updatedAt: '2026-01-01T00:00:00.000Z'
  })]);
  const newer = writeGroupsJson(workspace, 'standalone-groups.json', [canonicalGroup({
    name: 'Newer Name', updatedAt: '2026-05-01T00:00:00.000Z'
  })]);
  // Pass older first, newer second.
  importGroups(db, { groupsPaths: [older, newer], prospectStore });

  const g = reconstructGroups(db)[0];
  assert.equal(g.name, 'Newer Name', 'newest updatedAt wins regardless of path order');
});

// ---------------------------------------------------------------------------
// 10. Pure unit + empty DB
// ---------------------------------------------------------------------------

test('reconstructGroupRecord: minimal row omits optional nulls, keeps timestamps', () => {
  const rec = reconstructGroupRecord(
    { id: 'g1', name: 'G1', description: null, color: null, account_id: null,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
    []
  );
  assert.deepEqual(rec, {
    id: 'g1',
    name: 'G1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    members: []
  });
});

test('reconstructGroupRecord: handles undefined memberUrls', () => {
  const rec = reconstructGroupRecord(
    { id: 'g1', name: 'G1', created_at: 'a', updated_at: 'b' },
    undefined
  );
  assert.deepEqual(rec.members, []);
});

withEnv('empty database reconstructs to empty array', ({ db }) => {
  assert.deepEqual(reconstructGroups(db), []);
});
