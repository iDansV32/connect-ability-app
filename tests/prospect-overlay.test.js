'use strict';

/**
 * tests/prospect-overlay.test.js
 *
 * Pins the store-consistency overlay: the SQLite prospect store is the source
 * of truth for identity fields, so getAllProfiles/getProfileData overlay the
 * prospect's clean fullName/title/company onto the (possibly stale) profiles.json
 * records. Pure module — no I/O, no DB, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProspectEnrichmentIndex,
  overlayProspectEnrichment
} = require('../automation/profile/prospect-overlay');

// Minimal normalizer mirroring the app's: strip protocol/query/trailing slash.
const normalizeUrl = (u) => String(u || '')
  .split('?')[0]
  .replace(/\/+$/, '')
  .replace(/^https?:\/\/(www\.)?/, '')
  .toLowerCase() || '';

// ---------------------------------------------------------------------------
// buildProspectEnrichmentIndex
// ---------------------------------------------------------------------------

test('buildProspectEnrichmentIndex: keys by normalized URL, drops placeholders + empty', () => {
  const idx = buildProspectEnrichmentIndex([
    { profileUrl: 'https://www.linkedin.com/in/harper-l-b7c395021/', fullName: 'Harper L.', title: 'Software Engineer @ Marisol Telecom', company: 'Marisol Telecom' },
    { profileUrl: 'https://www.linkedin.com/in/empty', fullName: 'Unknown Profile', title: 'Not Available', company: '' }, // all placeholder/empty → omitted
    { profileUrl: '', fullName: 'No URL' } // no url → omitted
  ], normalizeUrl);

  assert.equal(idx.size, 1);
  const g = idx.get('linkedin.com/in/harper-l-b7c395021');
  assert.equal(g.fullName, 'Harper L.');
  assert.equal(g.title, 'Software Engineer @ Marisol Telecom');
  assert.equal(g.company, 'Marisol Telecom');
});

test('buildProspectEnrichmentIndex: tolerates non-array / bad normalizeUrl', () => {
  assert.equal(buildProspectEnrichmentIndex(null, normalizeUrl).size, 0);
  assert.equal(buildProspectEnrichmentIndex([{ profileUrl: 'x' }], null).size, 0);
});

// ---------------------------------------------------------------------------
// overlayProspectEnrichment
// ---------------------------------------------------------------------------

test('overlayProspectEnrichment: clean prospect data overwrites stale profiles.json fields', () => {
  const profiles = [{
    url: 'https://www.linkedin.com/in/harper-l-b7c395021',
    fullName: 'Harper L.',
    title: 'Software Engineer',                                  // truncated/stale
    company: 'Marisol Telecom | DevOps Engineering, @) Northcrst Unirsiy of' // OCR garble
  }];
  const idx = buildProspectEnrichmentIndex([
    { profileUrl: 'https://www.linkedin.com/in/harper-l-b7c395021', title: 'Software Engineer @ Marisol Telecom | DevOps Engineering', company: 'Marisol Telecom' }
  ], normalizeUrl);

  const [p] = overlayProspectEnrichment(profiles, idx, normalizeUrl);
  assert.equal(p.title, 'Software Engineer @ Marisol Telecom | DevOps Engineering', 'title overlaid from prospect');
  assert.equal(p.position, 'Software Engineer @ Marisol Telecom | DevOps Engineering', 'position mirrors title');
  assert.equal(p.company, 'Marisol Telecom', 'garbled company replaced by clean prospect company');
  assert.equal(p.enrichmentSource, 'prospect');
});

test('overlayProspectEnrichment: profiles without a matching prospect are unchanged', () => {
  const profiles = [{ url: 'https://www.linkedin.com/in/no-prospect', title: 'Original', company: 'OrigCo' }];
  const idx = buildProspectEnrichmentIndex([
    { profileUrl: 'https://www.linkedin.com/in/someone-else', title: 'X', company: 'Y' }
  ], normalizeUrl);
  const [p] = overlayProspectEnrichment(profiles, idx, normalizeUrl);
  assert.equal(p.title, 'Original');
  assert.equal(p.company, 'OrigCo');
  assert.equal(p.enrichmentSource, undefined, 'no overlay marker when no match');
});

test('overlayProspectEnrichment: only present prospect fields overlay; absent ones keep profile value', () => {
  const profiles = [{ url: 'https://www.linkedin.com/in/partial', fullName: 'Pat Doe', title: 'Existing Title', company: 'ExistingCo' }];
  // prospect has only company; title/fullName absent → keep profile's
  const idx = buildProspectEnrichmentIndex([
    { profileUrl: 'https://www.linkedin.com/in/partial', company: 'NewCo' }
  ], normalizeUrl);
  const [p] = overlayProspectEnrichment(profiles, idx, normalizeUrl);
  assert.equal(p.company, 'NewCo', 'company overlaid');
  assert.equal(p.title, 'Existing Title', 'absent prospect title keeps profile title');
  assert.equal(p.fullName, 'Pat Doe', 'absent prospect fullName keeps profile fullName');
});

test('overlayProspectEnrichment: matches across URL formats (no-www, trailing slash, query)', () => {
  const profiles = [{ url: 'https://linkedin.com/in/harper-l-b7c395021/?trk=x' }];
  const idx = buildProspectEnrichmentIndex([
    { profileUrl: 'https://www.linkedin.com/in/harper-l-b7c395021', company: 'Marisol Telecom' }
  ], normalizeUrl);
  const [p] = overlayProspectEnrichment(profiles, idx, normalizeUrl);
  assert.equal(p.company, 'Marisol Telecom', 'URL-format differences still match');
});

test('suspect-bio guard: a prospect with title === fullName overlays NEITHER title NOR company', () => {
  // Radu regression: stale prospect has title === name AND garbled company; the
  // whole bio is suspect, so profiles.json title AND company are preserved.
  const profiles = [{ url: 'https://www.linkedin.com/in/theo-marchetti', fullName: 'Theo Marchetti', title: 'Software Engineer', company: 'Northwind Games' }];
  const idx = buildProspectEnrichmentIndex([
    { profileUrl: 'https://www.linkedin.com/in/theo-marchetti', fullName: 'Theo Marchetti', title: 'Theo Marchetti', company: 'He/rim - 2nd a Northwind Games' }
  ], normalizeUrl);
  const entry = idx.get('linkedin.com/in/theo-marchetti');
  assert.equal(entry.title, null, 'suspect title dropped');
  assert.equal(entry.company, null, 'suspect company dropped (same bad extraction)');
  assert.equal(entry.fullName, 'Theo Marchetti', 'reliable name kept');
  const [p] = overlayProspectEnrichment(profiles, idx, normalizeUrl);
  assert.equal(p.title, 'Software Engineer', 'profiles.json title preserved');
  assert.equal(p.company, 'Northwind Games', 'profiles.json company preserved (suspect prospect company NOT overlaid)');
});

test('overlayProspectEnrichment: non-array input → []; non-object entries pass through', () => {
  assert.deepEqual(overlayProspectEnrichment(null, new Map(), normalizeUrl), []);
  const out = overlayProspectEnrichment([null, 'x'], new Map(), normalizeUrl);
  assert.deepEqual(out, [null, 'x']);
});
