'use strict';

/**
 * tests/external-api-policy.test.js
 *
 * Pins the three external-API policy decisions the production main.js
 * delegates to. Everything is pure — no http, no Electron, no I/O.
 *
 * The senior-review motivation: a fresh install with no token configured
 * was silently exposing the API surface (every page on the user's machine
 * could hit it) with `Access-Control-Allow-Origin: *` and a non-constant-
 * time compare. These tests lock the corrected defaults so a future edit
 * can't quietly regress safe-by-default.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAllowedOrigins,
  isOriginAllowed,
  buildCorsHeaders,
  resolveServerBindDecision,
  compareTokenSafely
} = require('../external-api-policy');

// ---------------------------------------------------------------------------
// parseAllowedOrigins
// ---------------------------------------------------------------------------

test('parseAllowedOrigins: undefined/null/empty → []', () => {
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(null), []);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins('   '), []);
});

test('parseAllowedOrigins: comma-separated, trims whitespace, drops empties, dedupes', () => {
  const out = parseAllowedOrigins(
    'https://app.example, http://localhost:3000,, https://app.example , http://localhost:3000'
  );
  assert.deepEqual(out, ['https://app.example', 'http://localhost:3000']);
});

test('parseAllowedOrigins: single origin without comma works', () => {
  assert.deepEqual(parseAllowedOrigins('https://app.example'), ['https://app.example']);
});

// ---------------------------------------------------------------------------
// isOriginAllowed
// ---------------------------------------------------------------------------

test('isOriginAllowed: empty allowlist always rejects (safe default)', () => {
  assert.equal(isOriginAllowed('https://attacker.example', []), false);
  assert.equal(isOriginAllowed('https://app.example', []), false);
});

test('isOriginAllowed: missing origin always rejects (no Origin header)', () => {
  assert.equal(isOriginAllowed('', ['https://app.example']), false);
  assert.equal(isOriginAllowed(null, ['https://app.example']), false);
  assert.equal(isOriginAllowed(undefined, ['https://app.example']), false);
});

test('isOriginAllowed: exact match accepts; suffix/subdomain does not', () => {
  const list = ['https://app.example'];
  assert.equal(isOriginAllowed('https://app.example', list), true);
  // Substring tricks the audit flagged elsewhere — must NOT match
  assert.equal(isOriginAllowed('https://app.example.attacker.com', list), false);
  assert.equal(isOriginAllowed('https://evil-app.example', list), false);
  assert.equal(isOriginAllowed('http://app.example', list), false, 'scheme matters');
});

test('isOriginAllowed: case-sensitive comparison (Origin spec)', () => {
  const list = ['https://App.Example'];
  assert.equal(isOriginAllowed('https://App.Example', list), true);
  assert.equal(isOriginAllowed('https://app.example', list), false);
});

// ---------------------------------------------------------------------------
// buildCorsHeaders
// ---------------------------------------------------------------------------

test('buildCorsHeaders: empty allowlist → no CORS headers (browser blocks; CLI unaffected)', () => {
  assert.deepEqual(buildCorsHeaders('https://attacker.example', []), {});
});

test('buildCorsHeaders: allowed origin → headers echo Origin, never "*"', () => {
  const headers = buildCorsHeaders('https://app.example', ['https://app.example']);
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://app.example');
  assert.notEqual(headers['Access-Control-Allow-Origin'], '*');
  assert.equal(headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization, X-API-Token');
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET,POST,OPTIONS');
  assert.equal(headers.Vary, 'Origin', 'Vary: Origin so caches do not collide responses');
});

test('buildCorsHeaders: disallowed origin → {} even with non-empty allowlist', () => {
  assert.deepEqual(buildCorsHeaders('https://attacker.example', ['https://app.example']), {});
});

test('buildCorsHeaders: no Origin header (e.g. curl, MCP) → {} (not an error)', () => {
  assert.deepEqual(buildCorsHeaders('', ['https://app.example']), {});
  assert.deepEqual(buildCorsHeaders(undefined, ['https://app.example']), {});
});

// ---------------------------------------------------------------------------
// resolveServerBindDecision
// ---------------------------------------------------------------------------

test('resolveServerBindDecision: token configured → start in token mode', () => {
  const d = resolveServerBindDecision({ tokenConfigured: true, devUnauth: false });
  assert.equal(d.start, true);
  assert.equal(d.mode, 'token');
  assert.match(d.reason, /token/i);
});

test('resolveServerBindDecision: no token, dev override → start in dev_unauth mode with CORS warning in reason', () => {
  const d = resolveServerBindDecision({ tokenConfigured: false, devUnauth: true });
  assert.equal(d.start, true);
  assert.equal(d.mode, 'dev_unauth');
  // The reason text must explicitly call out CORS independence so operators
  // don't assume the dev override also opens browser access.
  assert.match(d.reason, /CONNECT_API_ALLOWED_ORIGINS/);
  assert.match(d.reason, /does NOT relax CORS/);
});

test('resolveServerBindDecision: no token, no override → do NOT start (safe default)', () => {
  const d = resolveServerBindDecision({ tokenConfigured: false, devUnauth: false });
  assert.equal(d.start, false);
  assert.equal(d.mode, 'disabled');
  // The disabled reason must mention both remediations so a future operator
  // debugging "why is port 3030 dead?" sees the cause + both fixes on one line.
  assert.match(d.reason, /no API token configured/);
  assert.match(d.reason, /secrets\/api-token/);
  assert.match(d.reason, /CONNECT_API_DEV_UNAUTH=1/);
  assert.match(d.reason, /local-only development/);
});

test('resolveServerBindDecision: token AND override → token wins (auth always takes precedence)', () => {
  const d = resolveServerBindDecision({ tokenConfigured: true, devUnauth: true });
  assert.equal(d.mode, 'token');
});

test('resolveServerBindDecision: missing params → safe default (disabled)', () => {
  assert.equal(resolveServerBindDecision().start, false);
  assert.equal(resolveServerBindDecision({}).start, false);
});

// ---------------------------------------------------------------------------
// compareTokenSafely
// ---------------------------------------------------------------------------

test('compareTokenSafely: equal strings → true', () => {
  assert.equal(compareTokenSafely('sekret-123', 'sekret-123'), true);
});

test('compareTokenSafely: unequal same-length strings → false', () => {
  assert.equal(compareTokenSafely('sekret-123', 'sekret-XYZ'), false);
});

test('compareTokenSafely: length mismatch → false (and does not throw)', () => {
  assert.doesNotThrow(() => compareTokenSafely('short', 'much-longer-expected-token'));
  assert.equal(compareTokenSafely('short', 'much-longer-expected-token'), false);
  assert.equal(compareTokenSafely('much-longer-provided-token', 'short'), false);
});

test('compareTokenSafely: empty provided rejects', () => {
  assert.equal(compareTokenSafely('', 'expected'), false);
});

test('compareTokenSafely: empty expected rejects (would otherwise match everything)', () => {
  assert.equal(compareTokenSafely('anything', ''), false);
  assert.equal(compareTokenSafely('', ''), false);
});

test('compareTokenSafely: non-string inputs → false (no coercion)', () => {
  assert.equal(compareTokenSafely(null, 'x'), false);
  assert.equal(compareTokenSafely('x', null), false);
  assert.equal(compareTokenSafely(undefined, 'x'), false);
  assert.equal(compareTokenSafely(123, '123'), false, 'no number coercion');
  assert.equal(compareTokenSafely({ toString: () => 'x' }, 'x'), false);
});

test('compareTokenSafely: unicode tokens compare byte-for-byte', () => {
  assert.equal(compareTokenSafely('tóken-é', 'tóken-é'), true);
  assert.equal(compareTokenSafely('tóken-é', 'token-e'), false);
});
