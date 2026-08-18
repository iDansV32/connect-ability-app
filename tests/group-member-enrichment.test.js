'use strict';

/**
 * tests/group-member-enrichment.test.js
 *
 * Pins read-time group member enrichment: groups keep URL-string members
 * (backward-compatible), and the read surface joins them against the enriched
 * profile list to attach a parallel memberProfiles array. Pure — no I/O.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProfileLookupIndex,
  enrichGroupMembers
} = require('../automation/profile/group-member-enrichment');

const normalizeUrl = (u) => String(u || '')
  .split('?')[0]
  .replace(/\/+$/, '')
  .replace(/^https?:\/\/(www\.)?/, '')
  .toLowerCase() || '';

const PROFILES = [
  { url: 'https://www.linkedin.com/in/harper-l-b7c395021', fullName: 'Harper L.', title: 'Software Engineer @ Marisol Telecom', company: 'Marisol Telecom' },
  { url: 'https://www.linkedin.com/in/nkarlsson', fullName: 'Nils Karlsson', position: 'Senior Software Engineer', company: 'Brightloom' },
  { url: 'https://www.linkedin.com/in/placeholder', fullName: 'Unknown Profile', title: 'Not Available', company: '' }
];

test('buildProfileLookupIndex: keys by normalized URL, uses title|position, drops placeholders', () => {
  const idx = buildProfileLookupIndex(PROFILES, normalizeUrl);
  assert.equal(idx.get('linkedin.com/in/harper-l-b7c395021').title, 'Software Engineer @ Marisol Telecom');
  assert.equal(idx.get('linkedin.com/in/nkarlsson').title, 'Senior Software Engineer', 'falls back to position');
  const ph = idx.get('linkedin.com/in/placeholder');
  assert.equal(ph.fullName, null);
  assert.equal(ph.title, null);
  assert.equal(ph.company, null);
});

test('enrichGroupMembers: adds memberProfiles, leaves members (URL strings) unchanged', () => {
  const groups = [{
    id: 'g1', name: 'Test Group',
    members: ['https://www.linkedin.com/in/harper-l-b7c395021/', 'https://www.linkedin.com/in/nkarlsson']
  }];
  const idx = buildProfileLookupIndex(PROFILES, normalizeUrl);
  const [g] = enrichGroupMembers(groups, idx, normalizeUrl);

  // members untouched (back-compat)
  assert.deepEqual(g.members, ['https://www.linkedin.com/in/harper-l-b7c395021/', 'https://www.linkedin.com/in/nkarlsson']);
  // memberProfiles enriched, in order
  assert.equal(g.memberProfiles.length, 2);
  assert.deepEqual(g.memberProfiles[0], { url: 'https://www.linkedin.com/in/harper-l-b7c395021/', name: 'Harper L.', title: 'Software Engineer @ Marisol Telecom', company: 'Marisol Telecom' });
  assert.deepEqual(g.memberProfiles[1], { url: 'https://www.linkedin.com/in/nkarlsson', name: 'Nils Karlsson', title: 'Senior Software Engineer', company: 'Brightloom' });
});

test('enrichGroupMembers: unmatched member → url with null fields', () => {
  const groups = [{ id: 'g', name: 'G', members: ['https://www.linkedin.com/in/nobody-here'] }];
  const [g] = enrichGroupMembers(groups, buildProfileLookupIndex(PROFILES, normalizeUrl), normalizeUrl);
  assert.deepEqual(g.memberProfiles[0], { url: 'https://www.linkedin.com/in/nobody-here', name: null, title: null, company: null });
});

test('enrichGroupMembers: object members + inline name fallback; existing fields preserved', () => {
  const groups = [{
    id: 'g', name: 'G', description: 'keep me', color: '#0a66c2',
    members: [{ url: 'https://www.linkedin.com/in/nkarlsson', name: 'Inline Name' }, { value: 'https://www.linkedin.com/in/no-match', name: 'Only Inline' }]
  }];
  const [g] = enrichGroupMembers(groups, buildProfileLookupIndex(PROFILES, normalizeUrl), normalizeUrl);
  // matched object member → enriched name wins over inline
  assert.equal(g.memberProfiles[0].name, 'Nils Karlsson');
  assert.equal(g.memberProfiles[0].company, 'Brightloom');
  // unmatched object member → inline name fallback
  assert.equal(g.memberProfiles[1].name, 'Only Inline');
  assert.equal(g.memberProfiles[1].title, null);
  // other group fields preserved
  assert.equal(g.description, 'keep me');
  assert.equal(g.color, '#0a66c2');
});

test('enrichGroupMembers: tolerant of empty/missing members and non-array input', () => {
  assert.deepEqual(enrichGroupMembers(null, new Map(), normalizeUrl), []);
  const [g] = enrichGroupMembers([{ id: 'g', name: 'Empty' }], new Map(), normalizeUrl);
  assert.deepEqual(g.memberProfiles, []);
});
