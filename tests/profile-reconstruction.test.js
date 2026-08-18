'use strict';

/**
 * tests/profile-reconstruction.test.js
 *
 * Pins the Phase C step C1 contract for storage/profile-reconstruction.js.
 *
 * C1 builds the pure reconstruction helper that rebuilds the legacy
 * profiles.json record shape from the SQLite spine (prospects +
 * profile_actions). The load-bearing gate is field-for-field equivalence with
 * the CURRENT read output (JSON spine + prospect-overlay). These tests run the
 * REAL Phase B importer to populate SQLite from a profiles.json fixture, then
 * compare:
 *
 *     fixture --[importProfiles]--> SQLite --[reconstructProfiles]--> R
 *     fixture --[buildProspectEnrichmentIndex + overlayProspectEnrichment]--> L
 *     assert.deepEqual(R[url], L[url])   // per record, strict
 *
 * Equivalence is proven under a single consistent normalizer
 * (automation/url/normalize) — the same one the importer writes its join key
 * with. (main.js currently injects its own looser normalizer into the overlay;
 * reconciling that is a C3 concern, flagged in the migration design doc.)
 *
 * No Electron / main.js dependency. SQLite via storage/sqlite-db.openDatabase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const ProspectQueueStore = require('../prospect-queue-store');
const { importProfiles } = require('../storage/profile-legacy-importer');
const {
  reconstructProfiles,
  reconstructProfileRecord,
  mapActionRow,
  cleanField
} = require('../storage/profile-reconstruction');
const {
  buildProspectEnrichmentIndex,
  overlayProspectEnrichment
} = require('../automation/profile/prospect-overlay');
const { normalizeProfileUrl } = require('../automation/url/normalize');
const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function withEnv(testName, fn) {
  return test(testName, () => {
    const workspace = createTempWorkspace('profile-reconstruction-');
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
  fs.writeFileSync(filePath, JSON.stringify(content));
  return filePath;
}

// Build the CURRENT (pre-flip) read output: JSON spine + prospect overlay.
function legacyOverlayOutput(profiles, prospectStore) {
  const prospects = prospectStore.getAllProspects();
  const index = buildProspectEnrichmentIndex(prospects, normalizeProfileUrl);
  return overlayProspectEnrichment(profiles, index, normalizeProfileUrl);
}

function indexByUrl(records) {
  const m = new Map();
  for (const r of records) {
    const key = normalizeProfileUrl(r.url || r.originalUrl || r.linkedInProfileUrl || '');
    m.set(key, r);
  }
  return m;
}

// Import the fixture, then assert reconstruction === overlay for every record.
function assertEquivalence({ workspace, db, prospectStore }, fixture) {
  writeProfilesJson(workspace, fixture);
  importProfiles(db, { profilesPath: workspace.path('profiles.json'), prospectStore });

  const legacy = legacyOverlayOutput(fixture, prospectStore);
  const rebuilt = reconstructProfiles(db);

  const L = indexByUrl(legacy);
  const R = indexByUrl(rebuilt);

  assert.deepEqual(
    [...R.keys()].sort(),
    [...L.keys()].sort(),
    'reconstruction yields the same set of profile URLs as JSON+overlay'
  );
  for (const [url, lrec] of L) {
    assert.deepEqual(
      R.get(url),
      lrec,
      `record for ${url} must match JSON+overlay output field-for-field`
    );
  }
  return { L, R };
}

// A storage.js-shaped record with every always-present field. Helpers below
// produce records that match exactly what automation/profile/storage.js
// writes, so overlay output and reconstruction output can be strictly equal.
function canonicalRecord(overrides = {}) {
  const url = overrides.url || 'https://www.linkedin.com/in/jane-doe';
  return {
    url,
    originalUrl: url,
    linkedInProfileUrl: url,
    firstName: 'Jane',
    lastName: 'Doe',
    fullName: 'Jane Doe',
    title: 'Senior Engineer',
    company: 'Acme',
    rawHeadline: 'Senior Engineer at Acme Corp',
    email: 'jane@acme.com',
    accountId: 'acc-1',
    accountName: 'Account One',
    firstInteraction: '2026-01-01T00:00:00.000Z',
    lastInteraction: '2026-05-28T00:00:00.000Z',
    actions: [
      { type: 'Profile Viewed', timestamp: '2026-01-15T10:00:00.000Z', notes: 'During search', searchQuery: null }
    ],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. Equivalence — full canonical record (all 17 profile fields + actions)
// ---------------------------------------------------------------------------

withEnv('equivalence: full canonical record with all fields + suggestedEmails', (ctx) => {
  const fixture = [canonicalRecord({
    suggestedEmails: ['jane@acme.com', 'j.doe@acme.com'],
    companyDomain: 'acme.com'
  })];
  const { R } = assertEquivalence(ctx, fixture);
  // Spot-check the reconstructed record carries the overlay-added fields.
  const rec = [...R.values()][0];
  assert.equal(rec.enrichmentSource, 'prospect', 'enrichmentSource stamped');
  assert.equal(rec.position, 'Senior Engineer', 'position mirrors title');
  assert.deepEqual(rec.suggestedEmails, ['jane@acme.com', 'j.doe@acme.com']);
  assert.equal(rec.companyDomain, 'acme.com');
});

// ---------------------------------------------------------------------------
// 2. Equivalence — multiple records
// ---------------------------------------------------------------------------

withEnv('equivalence: multiple distinct records', (ctx) => {
  const fixture = [
    canonicalRecord({
      url: 'https://www.linkedin.com/in/jane-doe',
      fullName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe'
    }),
    canonicalRecord({
      url: 'https://www.linkedin.com/in/john-smith',
      fullName: 'John Smith', firstName: 'John', lastName: 'Smith',
      title: 'Head of People', company: 'Globex', email: 'john@globex.com',
      actions: [
        { type: 'Profile Viewed', timestamp: '2026-02-01T09:00:00.000Z', notes: '', searchQuery: 'head of people' },
        { type: 'Post Liked', timestamp: '2026-02-02T09:00:00.000Z', notes: 'liked latest post', searchQuery: null }
      ]
    })
  ];
  assertEquivalence(ctx, fixture);
});

// ---------------------------------------------------------------------------
// 3. Equivalence — prospect with no actions
// ---------------------------------------------------------------------------

withEnv('equivalence: record with empty actions array', (ctx) => {
  const fixture = [canonicalRecord({ actions: [] })];
  const { R } = assertEquivalence(ctx, fixture);
  assert.deepEqual([...R.values()][0].actions, [], 'no actions reconstructs to []');
});

// ---------------------------------------------------------------------------
// 4. Equivalence — many chronological actions, order preserved
// ---------------------------------------------------------------------------

withEnv('equivalence: many chronological actions keep order', (ctx) => {
  const fixture = [canonicalRecord({
    actions: [
      { type: 'Profile Viewed', timestamp: '2026-01-01T00:00:00.000Z', notes: '', searchQuery: null },
      { type: 'Profile Viewed', timestamp: '2026-01-02T00:00:00.000Z', notes: 'second view', searchQuery: null },
      { type: 'Post Liked', timestamp: '2026-01-03T00:00:00.000Z', notes: '', searchQuery: null },
      { type: 'Connection Sent', timestamp: '2026-01-04T00:00:00.000Z', notes: 'note attached', searchQuery: null }
    ]
  })];
  const { R } = assertEquivalence(ctx, fixture);
  const rec = [...R.values()][0];
  assert.deepEqual(
    rec.actions.map((a) => a.timestamp),
    ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z']
  );
});

// ---------------------------------------------------------------------------
// 5. Equivalence — optional enrichment fields absent
// ---------------------------------------------------------------------------

withEnv('equivalence: no suggestedEmails / companyDomain → keys omitted', (ctx) => {
  const fixture = [canonicalRecord({ rawHeadline: '' })];
  const { R } = assertEquivalence(ctx, fixture);
  const rec = [...R.values()][0];
  assert.ok(!('suggestedEmails' in rec), 'suggestedEmails omitted when absent');
  assert.ok(!('companyDomain' in rec), 'companyDomain omitted when absent');
  assert.equal(rec.rawHeadline, '', 'empty rawHeadline round-trips to empty string');
});

// ---------------------------------------------------------------------------
// 6. Equivalence — placeholder identity (no clean fields → no enrichment)
// ---------------------------------------------------------------------------

withEnv('equivalence: placeholder identity → no enrichmentSource / position', (ctx) => {
  const fixture = [canonicalRecord({
    fullName: 'Unknown Profile',
    title: '',
    company: ''
  })];
  const { R } = assertEquivalence(ctx, fixture);
  const rec = [...R.values()][0];
  assert.ok(!('enrichmentSource' in rec), 'no enrichmentSource when nothing clean to overlay');
  assert.ok(!('position' in rec), 'no position when title empty');
  assert.equal(rec.fullName, 'Unknown Profile');
  assert.equal(rec.title, '');
  assert.equal(rec.company, '');
});

// ---------------------------------------------------------------------------
// 7. Equivalence — name-as-title suppression
// ---------------------------------------------------------------------------

withEnv('equivalence: title === fullName suppresses title/company overlay', (ctx) => {
  const fixture = [canonicalRecord({
    fullName: 'Jane Doe',
    title: 'Jane Doe',       // bad-bio signature
    company: 'Acme'
  })];
  const { R } = assertEquivalence(ctx, fixture);
  const rec = [...R.values()][0];
  // fullName still overlays; title/company keep their (raw) value; no position.
  assert.equal(rec.fullName, 'Jane Doe');
  assert.equal(rec.enrichmentSource, 'prospect', 'fullName still drives enrichment');
  assert.ok(!('position' in rec), 'suppressed title sets no position');
  assert.equal(rec.title, 'Jane Doe', 'raw title retained (matches overlay keeping JSON value)');
  assert.equal(rec.company, 'Acme', 'raw company retained');
});

// ---------------------------------------------------------------------------
// 8. Equivalence — null-account record
// ---------------------------------------------------------------------------

withEnv('equivalence: record with null accountId/accountName', (ctx) => {
  const fixture = [canonicalRecord({ accountId: null, accountName: null })];
  const { R } = assertEquivalence(ctx, fixture);
  const rec = [...R.values()][0];
  assert.equal(rec.accountId, null);
  assert.equal(rec.accountName, null);
});

// ---------------------------------------------------------------------------
// 9. Canonicalization — out-of-order action timestamps re-sorted by occurred_at
//    (documented intentional behavior, NOT equivalence with append order)
// ---------------------------------------------------------------------------

withEnv('actions are canonicalized to (occurred_at, id) order', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, [canonicalRecord({
    actions: [
      { type: 'Post Liked', timestamp: '2026-03-01T00:00:00.000Z', notes: 'late', searchQuery: null },
      { type: 'Profile Viewed', timestamp: '2026-01-01T00:00:00.000Z', notes: 'early', searchQuery: null },
      { type: 'Connection Sent', timestamp: '2026-02-01T00:00:00.000Z', notes: 'mid', searchQuery: null }
    ]
  })]);
  importProfiles(db, { profilesPath: workspace.path('profiles.json'), prospectStore });

  const rebuilt = reconstructProfiles(db);
  assert.equal(rebuilt.length, 1);
  assert.deepEqual(
    rebuilt[0].actions.map((a) => a.timestamp),
    ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
    'reconstruction orders actions chronologically regardless of source array order'
  );
});

// ---------------------------------------------------------------------------
// 10. Account filtering — reconstructProfiles(accountId) scopes the result
// ---------------------------------------------------------------------------

withEnv('reconstructProfiles filters by accountId', ({ workspace, db, prospectStore }) => {
  writeProfilesJson(workspace, [
    canonicalRecord({ url: 'https://www.linkedin.com/in/acc1-person', accountId: 'acc-1' }),
    canonicalRecord({ url: 'https://www.linkedin.com/in/acc2-person', accountId: 'acc-2', fullName: 'Other Person' })
  ]);
  importProfiles(db, { profilesPath: workspace.path('profiles.json'), prospectStore });

  const all = reconstructProfiles(db);
  assert.equal(all.length, 2, 'no filter returns all');

  const onlyAcc1 = reconstructProfiles(db, { accountId: 'acc-1' });
  assert.equal(onlyAcc1.length, 1, 'accountId filter scopes to one account');
  assert.equal(onlyAcc1[0].accountId, 'acc-1');
});

// ---------------------------------------------------------------------------
// 11. Pure unit — reconstructProfileRecord edge cases
// ---------------------------------------------------------------------------

test('reconstructProfileRecord: empty prospect yields defaulted record', () => {
  const rec = reconstructProfileRecord({}, []);
  assert.equal(rec.url, '');
  assert.equal(rec.originalUrl, '');
  assert.equal(rec.linkedInProfileUrl, '');
  assert.equal(rec.firstName, '');
  assert.equal(rec.lastName, '');
  assert.equal(rec.fullName, 'Unknown Profile');
  assert.equal(rec.title, '');
  assert.equal(rec.company, '');
  assert.equal(rec.rawHeadline, '');
  assert.equal(rec.email, 'Not available');
  assert.equal(rec.accountId, null);
  assert.equal(rec.accountName, null);
  assert.equal(rec.firstInteraction, null);
  assert.equal(rec.lastInteraction, null);
  assert.deepEqual(rec.actions, []);
  assert.ok(!('position' in rec), 'no position without clean title');
  assert.ok(!('enrichmentSource' in rec), 'no enrichmentSource without clean identity');
});

test('reconstructProfileRecord: NULL normalized + profile url → url empty string', () => {
  const rec = reconstructProfileRecord(
    { profileUrl: null, normalizedProfileUrl: null, fullName: 'Test User' },
    []
  );
  assert.equal(rec.url, '');
  assert.equal(rec.fullName, 'Test User');
});

test('reconstructProfileRecord: falls back to normalizedProfileUrl when profileUrl null', () => {
  const rec = reconstructProfileRecord(
    { profileUrl: null, normalizedProfileUrl: 'https://www.linkedin.com/in/x', fullName: 'X' },
    []
  );
  assert.equal(rec.url, 'https://www.linkedin.com/in/x');
  assert.equal(rec.originalUrl, 'https://www.linkedin.com/in/x');
});

// ---------------------------------------------------------------------------
// 12. Pure unit — mapActionRow null handling
// ---------------------------------------------------------------------------

test('mapActionRow: null notes → empty string, null search_query → null', () => {
  assert.deepEqual(
    mapActionRow({ action_type: 'Profile Viewed', occurred_at: '2026-01-01T00:00:00.000Z', notes: null, search_query: null }),
    { type: 'Profile Viewed', timestamp: '2026-01-01T00:00:00.000Z', notes: '', searchQuery: null }
  );
});

test('mapActionRow: present values pass through', () => {
  assert.deepEqual(
    mapActionRow({ action_type: 'Post Liked', occurred_at: '2026-02-01T00:00:00.000Z', notes: 'great post', search_query: 'vp sales' }),
    { type: 'Post Liked', timestamp: '2026-02-01T00:00:00.000Z', notes: 'great post', searchQuery: 'vp sales' }
  );
});

// ---------------------------------------------------------------------------
// 13. Drift guard — cleanField matches the overlay's placeholder rules
// ---------------------------------------------------------------------------

test('cleanField: placeholders and whitespace handled like the overlay', () => {
  assert.equal(cleanField('Not Available'), null);
  assert.equal(cleanField('Not available'), null);
  assert.equal(cleanField('Unknown Profile'), null);
  assert.equal(cleanField('Unknown'), null);
  assert.equal(cleanField(''), null);
  assert.equal(cleanField(null), null);
  assert.equal(cleanField('  Jane   Doe  '), 'Jane Doe', 'whitespace collapsed + trimmed');
  assert.equal(cleanField('Senior Engineer'), 'Senior Engineer');
});

// ---------------------------------------------------------------------------
// 14. enrichmentSource / position presence rules
// ---------------------------------------------------------------------------

test('reconstructProfileRecord: fullName-only prospect gets enrichmentSource but no position', () => {
  const rec = reconstructProfileRecord({ profileUrl: 'https://www.linkedin.com/in/y', fullName: 'Real Name', title: '', company: '' }, []);
  assert.equal(rec.enrichmentSource, 'prospect');
  assert.ok(!('position' in rec));
  assert.equal(rec.fullName, 'Real Name');
});

test('reconstructProfileRecord: clean title sets position and enrichmentSource', () => {
  const rec = reconstructProfileRecord({ profileUrl: 'https://www.linkedin.com/in/z', fullName: 'Real Name', title: 'CTO', company: 'Initech' }, []);
  assert.equal(rec.enrichmentSource, 'prospect');
  assert.equal(rec.position, 'CTO');
  assert.equal(rec.title, 'CTO');
  assert.equal(rec.company, 'Initech');
});
