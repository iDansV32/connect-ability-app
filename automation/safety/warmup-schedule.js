'use strict';

// Warm-up stages define what fraction of the configured daily limit is
// actually allowed.  A brand-new account starts at 25 % and graduates to
// full capacity after 28 days.  The multiplier is applied to the ceiling
// *before* the daily randomisation step so both features compose cleanly.
//
// Stage boundaries are in whole days elapsed since `warmUpStartedAt`.
const WARMUP_STAGES = Object.freeze([
  // { minDay (inclusive), maxDay (exclusive), multiplier }
  Object.freeze({ minDay: 0, maxDay: 7, multiplier: 0.25 }),
  Object.freeze({ minDay: 7, maxDay: 14, multiplier: 0.40 }),
  Object.freeze({ minDay: 14, maxDay: 21, multiplier: 0.60 }),
  Object.freeze({ minDay: 21, maxDay: 28, multiplier: 0.80 }),
  Object.freeze({ minDay: 28, maxDay: Infinity, multiplier: 1.00 })
]);

const WARMUP_DURATION_DAYS = 28;

/**
 * Return the warm-up multiplier (0 < m ≤ 1) that should be applied to the
 * daily action limit ceiling for `account`.
 *
 * - If `account.warmUpStartedAt` is absent or null the account is considered
 *   fully ramped (returns 1.0).
 * - If `warmUpStartedAt` is in the future (clock skew / misconfiguration)
 *   we treat it as day 0 so the account still gets the safest stage.
 *
 * @param {object} account          - Account record with optional `warmUpStartedAt` (ISO string).
 * @param {Date}   [now]            - Reference time (default: current time).
 * @returns {number}                - Multiplier in the range (0, 1].
 */
function getWarmUpMultiplier(account = {}, now = new Date()) {
  const raw = cleanString(account.warmUpStartedAt, 80);
  if (!raw) {
    return 1.0; // Not in warm-up — use full limits.
  }

  const startedAt = parseDate(raw);
  if (!startedAt) {
    return 1.0; // Unparseable date — fail safe to full limits.
  }

  const elapsedMs = now.getTime() - startedAt.getTime();
  // If clock is behind startedAt treat as day 0.
  const elapsedDays = Math.max(0, Math.floor(elapsedMs / DAY_MS));

  const stage = WARMUP_STAGES.find(
    (s) => elapsedDays >= s.minDay && elapsedDays < s.maxDay
  );

  return stage ? stage.multiplier : 1.0;
}

/**
 * Apply a warm-up multiplier to a raw configured ceiling, returning the
 * effective ceiling (always at least 1 so the account is never fully blocked).
 *
 * @param {number} ceiling     - The configured action limit (e.g. 30).
 * @param {number} multiplier  - Value from getWarmUpMultiplier (0 < m ≤ 1).
 * @returns {number}           - Effective ceiling, minimum 1.
 */
function applyWarmUpToLimit(ceiling, multiplier) {
  const raw = Math.floor(Number(ceiling || 0) * Number(multiplier || 1));
  return Math.max(1, raw);
}

/**
 * Return true when the account is currently in the warm-up period
 * (i.e. fewer than WARMUP_DURATION_DAYS days have elapsed since warm-up started).
 *
 * @param {object} account
 * @param {Date}   [now]
 * @returns {boolean}
 */
function isInWarmUp(account = {}, now = new Date()) {
  return getWarmUpMultiplier(account, now) < 1.0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(value) {
  try {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch (_) {
    return null;
  }
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  WARMUP_DURATION_DAYS,
  WARMUP_STAGES,
  applyWarmUpToLimit,
  getWarmUpMultiplier,
  isInWarmUp
};
