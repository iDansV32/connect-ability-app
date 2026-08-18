'use strict';

/**
 * Retry-After parsing and cooldown resolution.
 *
 * One pure module so the scheduler / health-store / IPC layers can stay
 * boring. Two public surfaces:
 *
 *   parseRetryAfterMs(raw, nowMs)
 *     RFC 7231 §7.1.3 — Retry-After is either a delta-seconds value
 *     ("Retry-After: 120") or an HTTP-date
 *     ("Retry-After: Wed, 21 Oct 2026 07:28:00 GMT"). Both forms appear in
 *     the wild from LinkedIn. Returns milliseconds-from-now, or null when
 *     the input is unparseable / negative / not a real signal.
 *
 *   resolveRetryAfterCooldownMs(errorOrPayload, options)
 *     Picks the cooldown duration to honor for a 429-ish failure.
 *     Preference order: explicit numeric retryAfterMs on the input (e.g.
 *     IPC payload that already parsed) → raw retryAfterHeader on the input
 *     → message-string fallback (look for "Retry-After: <seconds>" pattern
 *     in the error message). Clamped to floor/cap bounds.
 *
 *     Returns null when no signal is present — callers should fall back to
 *     their existing classification-based default.
 *
 * Clamp bounds:
 *   Floor 60s — sub-minute values would burn the next scheduler tick on
 *     instant retry; not a useful cooldown.
 *   Cap   24h — guards against malformed/malicious headers ("Retry-After:
 *     999999999"). If LinkedIn really wants longer, it can issue another
 *     429 on the next attempt.
 *
 * Operator note: ALL bounds and default behaviors live here. Do not
 * duplicate parse/clamp logic at call sites — extend this module instead.
 */

const FLOOR_MS = 60 * 1000;
const CAP_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a Retry-After header value to a future-relative duration in ms.
 *
 * @param {string|number|null|undefined} raw
 * @param {number} [nowMs=Date.now()] injectable for tests
 * @returns {number|null} milliseconds until the indicated retry time, or
 *   null when the input is missing, malformed, zero, or in the past
 */
function parseRetryAfterMs(raw, nowMs = Date.now()) {
  if (raw === null || raw === undefined) return null;
  // Accept a numeric value (already-parsed seconds) for convenience.
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.round(raw * 1000);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Delta-seconds form: a non-negative integer literal.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds * 1000;
  }

  // HTTP-date form. Date.parse handles RFC 1123 / RFC 850 / asctime
  // formats well enough for the cases LinkedIn actually emits. Reject
  // anything where the resulting timestamp is in the past — that's a
  // useless cooldown signal.
  const targetMs = Date.parse(trimmed);
  if (!Number.isFinite(targetMs)) return null;
  const delta = targetMs - nowMs;
  if (delta <= 0) return null;
  return delta;
}

/**
 * Resolve the cooldown duration (ms) to apply when an error looks like a
 * 429 / rate-limit signal. Returns null when no signal is present.
 *
 * Lookup order:
 *   1. options.retryAfterMs (explicit override, e.g. test fixtures)
 *   2. error.retryAfterMs (already-parsed structured field)
 *   3. error.retryAfterHeader (raw header value)
 *   4. error.message regex fallback ("Retry-After: <seconds>")
 *
 * @param {object|null} error error or IPC error-payload object
 * @param {object} [options]
 * @param {number} [options.retryAfterMs] explicit override (already in ms)
 * @param {number} [options.nowMs] for tests
 * @param {number} [options.floorMs=FLOOR_MS] clamp floor
 * @param {number} [options.capMs=CAP_MS] clamp ceiling
 * @returns {number|null} clamped cooldown ms, or null when no signal
 */
function resolveRetryAfterCooldownMs(error, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const floorMs = Math.max(0, Number(options.floorMs) || FLOOR_MS);
  const capMs = Math.max(floorMs, Number(options.capMs) || CAP_MS);

  let candidate = null;

  // 1. Explicit override on options.
  if (Number.isFinite(Number(options.retryAfterMs)) && Number(options.retryAfterMs) > 0) {
    candidate = Number(options.retryAfterMs);
  }

  // 2. Structured field already on the error.
  if (candidate === null && error && Number.isFinite(Number(error.retryAfterMs)) && Number(error.retryAfterMs) > 0) {
    candidate = Number(error.retryAfterMs);
  }

  // 3. Raw header on the error — parse via parseRetryAfterMs.
  if (candidate === null && error && error.retryAfterHeader) {
    candidate = parseRetryAfterMs(error.retryAfterHeader, nowMs);
  }

  // 4. Message-string fallback. Some legacy throw sites only stamp the
  //    header value into the message; preserve interop with them. Matches
  //    "Retry-After: 120" or "retry-after: 120" anywhere in the message.
  if (candidate === null && error && typeof error.message === 'string') {
    const match = error.message.match(/retry-after:\s*(\d{1,7})/i);
    if (match) {
      candidate = parseRetryAfterMs(match[1], nowMs);
    }
  }

  if (candidate === null) return null;
  if (!Number.isFinite(candidate) || candidate <= 0) return null;

  // Clamp to [floor, cap].
  if (candidate < floorMs) return floorMs;
  if (candidate > capMs) return capMs;
  return candidate;
}

/**
 * Returns true when the error/payload looks like a 429 rate-limit
 * response. Used by the scheduler to decide whether to consult
 * resolveRetryAfterCooldownMs vs. let the classifier pick a default.
 *
 * Structured signal (httpStatus === 429) wins. Falls back to message
 * regex for legacy throw sites that only stamp the status in the string.
 *
 * @param {object|null} error
 * @returns {boolean}
 */
function isRateLimitSignal(error) {
  if (!error) return false;
  if (Number(error.httpStatus) === 429) return true;
  if (typeof error.message !== 'string') return false;
  return /\b429\b|too many requests|rate limit(?:ed)?|slow down/i.test(error.message);
}

module.exports = {
  parseRetryAfterMs,
  resolveRetryAfterCooldownMs,
  isRateLimitSignal,
  FLOOR_MS,
  CAP_MS
};
