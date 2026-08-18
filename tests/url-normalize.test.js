'use strict';

/**
 * tests/url-normalize.test.js
 *
 * Pins the canonical SQL-join-key contract for normalizeProfileUrl. Two
 * profile URLs that should be considered the same prospect must normalize
 * to the same string here. The legacy importer and the runtime write path
 * both depend on this — if these cases ever diverge, profile rows will
 * silently fail to deduplicate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProfileUrl, MAX_URL_LENGTH } = require('../automation/url/normalize');

// ---------------------------------------------------------------------------
// Core canonical form
// ---------------------------------------------------------------------------

test('canonical input is preserved (idempotent)', () => {
  const canonical = 'https://www.linkedin.com/in/john-doe';
  assert.equal(normalizeProfileUrl(canonical), canonical);
  // Running twice must produce the same result.
  assert.equal(normalizeProfileUrl(normalizeProfileUrl(canonical)), canonical);
});

test('trailing slash is stripped', () => {
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/john-doe/'),
    'https://www.linkedin.com/in/john-doe'
  );
  // Multiple trailing slashes
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/john-doe///'),
    'https://www.linkedin.com/in/john-doe'
  );
});

test('case folds to lowercase', () => {
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/JOHN-DOE'),
    'https://www.linkedin.com/in/john-doe'
  );
  assert.equal(
    normalizeProfileUrl('HTTPS://WWW.LINKEDIN.COM/IN/john-doe'),
    'https://www.linkedin.com/in/john-doe'
  );
});

test('query string is stripped', () => {
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/john-doe/?trk=public_profile'),
    'https://www.linkedin.com/in/john-doe'
  );
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/john-doe?utm_source=feed'),
    'https://www.linkedin.com/in/john-doe'
  );
});

test('fragment is stripped', () => {
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/john-doe#section'),
    'https://www.linkedin.com/in/john-doe'
  );
});

// ---------------------------------------------------------------------------
// Subpath suffixes from LinkedIn navigation
// ---------------------------------------------------------------------------

test('/recent-activity suffix is stripped (with sub-paths)', () => {
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/john-doe/recent-activity'),
    'https://www.linkedin.com/in/john-doe'
  );
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/john-doe/recent-activity/all/'),
    'https://www.linkedin.com/in/john-doe'
  );
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/john-doe/recent-activity/posts/?trk=x'),
    'https://www.linkedin.com/in/john-doe'
  );
});

test('/details suffix is stripped', () => {
  assert.equal(
    normalizeProfileUrl('https://www.linkedin.com/in/john-doe/details/experience/'),
    'https://www.linkedin.com/in/john-doe'
  );
});

// ---------------------------------------------------------------------------
// Protocol / host normalization
// ---------------------------------------------------------------------------

test('http:// is canonicalized to https://www.', () => {
  assert.equal(
    normalizeProfileUrl('http://www.linkedin.com/in/john-doe'),
    'https://www.linkedin.com/in/john-doe'
  );
});

test('linkedin.com without www. is canonicalized', () => {
  assert.equal(
    normalizeProfileUrl('https://linkedin.com/in/john-doe'),
    'https://www.linkedin.com/in/john-doe'
  );
  assert.equal(
    normalizeProfileUrl('http://linkedin.com/in/john-doe/'),
    'https://www.linkedin.com/in/john-doe'
  );
});

test('protocol-less input gets a bare https:// prefix (NOT www.)', () => {
  // The current implementation prepends just `https://`, not `https://www.`,
  // for protocol-less inputs. This is asymmetric with the protocol-present
  // case (which normalizes to `https://www.`) but is the historic behavior
  // — pin it so we notice if it ever changes.
  assert.equal(
    normalizeProfileUrl('linkedin.com/in/john-doe'),
    'https://linkedin.com/in/john-doe'
  );
});

test('non-LinkedIn URLs are still normalized (host gets `www.` prepended, lowercased)', () => {
  // The protocol-replace regex /https?:\/\/(www\.)?/i is NOT
  // LinkedIn-specific — it adds www. to any http(s) URL. Pin the actual
  // behavior. Callers using this for non-LinkedIn URLs would get a
  // mangled host; in practice no caller does that, but documenting.
  assert.equal(
    normalizeProfileUrl('https://example.com/profile/x'),
    'https://www.example.com/profile/x'
  );
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('empty / null / undefined → empty string', () => {
  assert.equal(normalizeProfileUrl(''), '');
  assert.equal(normalizeProfileUrl(null), '');
  assert.equal(normalizeProfileUrl(undefined), '');
});

test('non-string input is coerced via String(), then normalized', () => {
  // Historic behavior of the pre-extraction implementation in
  // prospect-queue-store.js: any value goes through String(...).trim()
  // first, then the normal pipeline. Non-LinkedIn output passes through
  // as a lowercased string. Pinning so callers know the contract:
  // garbage in → garbage out (lowercased), NOT thrown.
  assert.equal(normalizeProfileUrl(123), '123');
  assert.equal(normalizeProfileUrl({}), '[object object]');
});

test('whitespace around input is trimmed', () => {
  assert.equal(
    normalizeProfileUrl('  https://www.linkedin.com/in/john-doe/  '),
    'https://www.linkedin.com/in/john-doe'
  );
});

test('input longer than MAX_URL_LENGTH is truncated', () => {
  const long = 'https://www.linkedin.com/in/' + 'x'.repeat(MAX_URL_LENGTH + 100);
  const out = normalizeProfileUrl(long);
  assert.ok(out.length <= MAX_URL_LENGTH, `expected ≤ ${MAX_URL_LENGTH}, got ${out.length}`);
  assert.ok(out.startsWith('https://www.linkedin.com/in/'));
});

// ---------------------------------------------------------------------------
// The load-bearing equivalence claim: forms that callers expect to dedupe
// ---------------------------------------------------------------------------

test('all common variants of the same profile normalize to the same key', () => {
  const variants = [
    'https://www.linkedin.com/in/john-doe',
    'https://www.linkedin.com/in/john-doe/',
    'https://www.linkedin.com/in/JOHN-DOE/',
    'https://www.linkedin.com/in/john-doe/?trk=public_profile',
    'https://www.linkedin.com/in/john-doe#about',
    'https://www.linkedin.com/in/john-doe/recent-activity/all/',
    'https://www.linkedin.com/in/john-doe/details/experience/',
    'http://www.linkedin.com/in/john-doe',
    'https://linkedin.com/in/john-doe',
    '  https://www.linkedin.com/in/john-doe/  '
  ];
  const expected = 'https://www.linkedin.com/in/john-doe';
  for (const v of variants) {
    assert.equal(normalizeProfileUrl(v), expected, `variant did not normalize correctly: ${v}`);
  }
});
