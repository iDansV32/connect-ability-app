'use strict';

/**
 * tests/retry-after.test.js
 *
 * Pure-helper coverage for the Retry-After / cooldown resolver. Pins:
 *   - parseRetryAfterMs handles delta-seconds and HTTP-date forms
 *   - Invalid / negative / past-date inputs return null
 *   - resolveRetryAfterCooldownMs preference order:
 *       options.retryAfterMs → error.retryAfterMs → error.retryAfterHeader → message regex
 *   - Clamp floor 60s, cap 24h
 *   - isRateLimitSignal: structured httpStatus wins; message regex fallback
 *
 * All tests use injected nowMs so they're deterministic regardless of clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRetryAfterMs,
  resolveRetryAfterCooldownMs,
  isRateLimitSignal,
  FLOOR_MS,
  CAP_MS
} = require('../automation/safety/retry-after');

const FIXED_NOW = Date.parse('2026-05-26T12:00:00.000Z');

// ---------------------------------------------------------------------------
// parseRetryAfterMs
// ---------------------------------------------------------------------------

test('parseRetryAfterMs: delta-seconds form returns milliseconds', () => {
  assert.equal(parseRetryAfterMs('120', FIXED_NOW), 120 * 1000);
  assert.equal(parseRetryAfterMs('1', FIXED_NOW), 1000);
  assert.equal(parseRetryAfterMs('3600', FIXED_NOW), 3600 * 1000);
});

test('parseRetryAfterMs: numeric input is accepted and treated as seconds', () => {
  assert.equal(parseRetryAfterMs(60, FIXED_NOW), 60_000);
  assert.equal(parseRetryAfterMs(3600, FIXED_NOW), 3_600_000);
});

test('parseRetryAfterMs: HTTP-date form returns future-relative ms', () => {
  // 5 minutes in the future from FIXED_NOW.
  const fiveMinutesLater = new Date(FIXED_NOW + 5 * 60 * 1000).toUTCString();
  const result = parseRetryAfterMs(fiveMinutesLater, FIXED_NOW);
  assert.ok(result !== null);
  // Allow ±1s tolerance for any rounding in toUTCString.
  assert.ok(Math.abs(result - 5 * 60 * 1000) <= 1000, `expected ~5min, got ${result}ms`);
});

test('parseRetryAfterMs: past dates return null', () => {
  const oneHourAgo = new Date(FIXED_NOW - 60 * 60 * 1000).toUTCString();
  assert.equal(parseRetryAfterMs(oneHourAgo, FIXED_NOW), null);
});

test('parseRetryAfterMs: zero / negative / non-finite returns null', () => {
  assert.equal(parseRetryAfterMs('0', FIXED_NOW), null);
  assert.equal(parseRetryAfterMs(0, FIXED_NOW), null);
  assert.equal(parseRetryAfterMs(-5, FIXED_NOW), null);
  assert.equal(parseRetryAfterMs(NaN, FIXED_NOW), null);
  assert.equal(parseRetryAfterMs(Infinity, FIXED_NOW), null);
});

test('parseRetryAfterMs: empty/null/undefined returns null', () => {
  assert.equal(parseRetryAfterMs(null, FIXED_NOW), null);
  assert.equal(parseRetryAfterMs(undefined, FIXED_NOW), null);
  assert.equal(parseRetryAfterMs('', FIXED_NOW), null);
  assert.equal(parseRetryAfterMs('   ', FIXED_NOW), null);
});

test('parseRetryAfterMs: malformed strings return null', () => {
  assert.equal(parseRetryAfterMs('not a number', FIXED_NOW), null);
  assert.equal(parseRetryAfterMs('120 seconds', FIXED_NOW), null);
  assert.equal(parseRetryAfterMs('Tomorrow at noon', FIXED_NOW), null);
});

// ---------------------------------------------------------------------------
// resolveRetryAfterCooldownMs — preference order
// ---------------------------------------------------------------------------

test('resolveRetryAfterCooldownMs: options.retryAfterMs override wins over error fields', () => {
  const error = { retryAfterMs: 10 * 60 * 1000, retryAfterHeader: '999' };
  const result = resolveRetryAfterCooldownMs(error, { retryAfterMs: 5 * 60 * 1000 });
  assert.equal(result, 5 * 60 * 1000, 'explicit override wins');
});

test('resolveRetryAfterCooldownMs: error.retryAfterMs wins over error.retryAfterHeader', () => {
  const error = { retryAfterMs: 5 * 60 * 1000, retryAfterHeader: '999' };
  const result = resolveRetryAfterCooldownMs(error, { nowMs: FIXED_NOW });
  assert.equal(result, 5 * 60 * 1000);
});

test('resolveRetryAfterCooldownMs: error.retryAfterHeader is parsed when retryAfterMs absent', () => {
  const error = { retryAfterHeader: '600' };
  const result = resolveRetryAfterCooldownMs(error, { nowMs: FIXED_NOW });
  assert.equal(result, 600 * 1000);
});

test('resolveRetryAfterCooldownMs: message-regex fallback when no structured fields present', () => {
  // Some legacy throw sites only embed the header in the message string.
  const error = { message: 'LinkedIn API failed: 429 Too Many Requests. Retry-After: 300' };
  const result = resolveRetryAfterCooldownMs(error, { nowMs: FIXED_NOW });
  assert.equal(result, 300 * 1000);
});

test('resolveRetryAfterCooldownMs: returns null when no signal anywhere', () => {
  assert.equal(resolveRetryAfterCooldownMs(null), null);
  assert.equal(resolveRetryAfterCooldownMs({}), null);
  assert.equal(resolveRetryAfterCooldownMs({ message: 'some unrelated error' }), null);
  assert.equal(resolveRetryAfterCooldownMs({ httpStatus: 500 }), null);
});

// ---------------------------------------------------------------------------
// Clamp bounds — floor 60s, cap 24h
// ---------------------------------------------------------------------------

test('resolveRetryAfterCooldownMs: sub-floor values are raised to 60s', () => {
  // LinkedIn says "wait 1 second" — burning a claim cycle on instant retry
  // isn't a useful cooldown. Floor it.
  assert.equal(
    resolveRetryAfterCooldownMs({ retryAfterHeader: '1' }, { nowMs: FIXED_NOW }),
    FLOOR_MS
  );
  assert.equal(
    resolveRetryAfterCooldownMs({ retryAfterHeader: '30' }, { nowMs: FIXED_NOW }),
    FLOOR_MS
  );
});

test('resolveRetryAfterCooldownMs: above-cap values are clamped to 24h', () => {
  // Malformed/malicious header — "wait 1 year." Cap to 24h.
  const oneYearSeconds = String(60 * 60 * 24 * 365);
  assert.equal(
    resolveRetryAfterCooldownMs({ retryAfterHeader: oneYearSeconds }, { nowMs: FIXED_NOW }),
    CAP_MS
  );
});

test('resolveRetryAfterCooldownMs: values within bounds pass through unchanged', () => {
  // 5 minutes is well within [60s, 24h].
  const result = resolveRetryAfterCooldownMs(
    { retryAfterHeader: '300' },
    { nowMs: FIXED_NOW }
  );
  assert.equal(result, 5 * 60 * 1000);
});

test('resolveRetryAfterCooldownMs: custom floor/cap options are honored', () => {
  // 10s with floor=5s, cap=20s → 10s (within bounds).
  assert.equal(
    resolveRetryAfterCooldownMs({ retryAfterHeader: '10' }, { floorMs: 5000, capMs: 20000, nowMs: FIXED_NOW }),
    10_000
  );
  // 100s with cap=20s → 20s.
  assert.equal(
    resolveRetryAfterCooldownMs({ retryAfterHeader: '100' }, { floorMs: 5000, capMs: 20000, nowMs: FIXED_NOW }),
    20_000
  );
});

// ---------------------------------------------------------------------------
// isRateLimitSignal
// ---------------------------------------------------------------------------

test('isRateLimitSignal: structured httpStatus === 429 returns true', () => {
  assert.equal(isRateLimitSignal({ httpStatus: 429 }), true);
  assert.equal(isRateLimitSignal({ httpStatus: 429, message: 'whatever' }), true);
});

test('isRateLimitSignal: non-429 structured status returns false', () => {
  assert.equal(isRateLimitSignal({ httpStatus: 500 }), false);
  assert.equal(isRateLimitSignal({ httpStatus: 400 }), false);
  assert.equal(isRateLimitSignal({ httpStatus: 503 }), false);
});

test('isRateLimitSignal: message regex fallback matches the same patterns the health classifier uses', () => {
  assert.equal(isRateLimitSignal({ message: 'LinkedIn API failed: 429 Too Many Requests' }), true);
  assert.equal(isRateLimitSignal({ message: 'rate limited' }), true);
  assert.equal(isRateLimitSignal({ message: 'too many requests' }), true);
  assert.equal(isRateLimitSignal({ message: 'Please slow down' }), true);
});

test('isRateLimitSignal: unrelated errors return false', () => {
  assert.equal(isRateLimitSignal(null), false);
  assert.equal(isRateLimitSignal({}), false);
  assert.equal(isRateLimitSignal({ message: 'Network timeout' }), false);
  assert.equal(isRateLimitSignal({ message: 'Unauthorized' }), false);
});

test('isRateLimitSignal: does NOT match incidental occurrences of "429" as substring', () => {
  // The regex uses \b429\b — guards against false positives on URLs etc.
  assert.equal(isRateLimitSignal({ message: 'fetched /api/v4291/foo' }), false);
});
