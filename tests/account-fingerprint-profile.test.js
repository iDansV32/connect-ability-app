'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeFingerprintProfileSeed,
  buildFingerprintProfileFromSeed,
  buildFingerprintSessionSeed,
  resolveAccountFingerprintProfile,
  resolveSessionViewport,
  resolveViewportForFingerprint
} = require('../automation/safety/account-fingerprint-profile');

test('normalizeFingerprintProfileSeed preserves an explicit seed', () => {
  assert.equal(
    normalizeFingerprintProfileSeed('fingerprint-seed-abc', 'alice@example.com'),
    'fingerprint-seed-abc'
  );
});

test('normalizeFingerprintProfileSeed derives a deterministic seed from account identity when absent', () => {
  const first = normalizeFingerprintProfileSeed(null, ' Alice@example.com ');
  const second = normalizeFingerprintProfileSeed('', 'alice@example.com');

  assert.equal(first, second);
  assert.match(first, /^li-fingerprint-[a-f0-9]{20}$/);
});

test('buildFingerprintProfileFromSeed is deterministic for the same seed', () => {
  const first = buildFingerprintProfileFromSeed('fingerprint-seed-abc');
  const second = buildFingerprintProfileFromSeed('fingerprint-seed-abc');

  assert.deepEqual(first, second);
});

test('buildFingerprintProfileFromSeed varies the viewport and plugin pack across seeds', () => {
  const first = buildFingerprintProfileFromSeed('fingerprint-seed-abc');
  const second = buildFingerprintProfileFromSeed('fingerprint-seed-def');

  assert.notDeepEqual(first.viewport, second.viewport);
  assert.notDeepEqual(first.pluginDescriptors, second.pluginDescriptors);
});

test('buildFingerprintProfileFromSeed returns realistic plugin and mime type descriptors', () => {
  const profile = buildFingerprintProfileFromSeed('fingerprint-seed-abc');

  assert.ok(profile.pluginDescriptors.length >= 3);
  assert.ok(profile.pluginDescriptors.every((plugin) => typeof plugin.name === 'string' && plugin.name.length > 0));
  assert.ok(profile.mimeTypeDescriptors.every((mimeType) => typeof mimeType.type === 'string' && mimeType.type.length > 0));
  assert.ok(Array.isArray(profile.clientHints.brands));
  assert.ok(profile.clientHints.brands.length >= 2);
  assert.equal(typeof profile.clientHints.platform, 'string');
  assert.equal(profile.pdfViewerEnabled, true);
});

test('resolveViewportForFingerprint preserves explicit viewport overrides', () => {
  assert.deepEqual(
    resolveViewportForFingerprint({ width: 1600, height: 900 }, 'fingerprint-seed-abc'),
    { width: 1600, height: 900 }
  );
});

test('resolveViewportForFingerprint falls back to the seed-derived viewport when explicit viewport is missing', () => {
  const profile = buildFingerprintProfileFromSeed('fingerprint-seed-abc');
  assert.deepEqual(resolveViewportForFingerprint(null, 'fingerprint-seed-abc'), profile.viewport);
});

test('buildFingerprintSessionSeed is deterministic for the same identity and day', () => {
  const first = buildFingerprintSessionSeed('alice@example.com', '2026-03-27T12:00:00.000Z');
  const second = buildFingerprintSessionSeed('alice@example.com', '2026-03-27T23:59:59.000Z');

  assert.equal(first, second);
  assert.match(first, /^li-session-[a-f0-9]{20}$/);
});

test('resolveAccountFingerprintProfile derives the same seeded profile from account identity', () => {
  const first = resolveAccountFingerprintProfile({ email: 'Alice@example.com' });
  const second = resolveAccountFingerprintProfile({ email: 'alice@example.com' });

  assert.deepEqual(first, second);
  assert.equal(first.seed, normalizeFingerprintProfileSeed(null, 'alice@example.com'));
});

test('resolveSessionViewport is deterministic for the same session seed and varies across session seeds', () => {
  const profile = buildFingerprintProfileFromSeed('fingerprint-seed-abc');
  const first = resolveSessionViewport(profile, 'session-seed-a');
  const second = resolveSessionViewport(profile, 'session-seed-a');
  const third = resolveSessionViewport(profile, 'session-seed-b');

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, third);
});
