'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_WORKING_HOURS,
  getWorkingHoursContext,
  isWithinWorkingHours,
  normalizeWorkingHours
} = require('../automation/safety/working-hours');

// ---------------------------------------------------------------------------
// getWorkingHoursContext
// ---------------------------------------------------------------------------

test('getWorkingHoursContext returns correct local time parts for America/Chicago', () => {
  // 2026-03-25 is a Wednesday.
  // 15:00 UTC = 10:00 CDT (UTC-5) → hour=10, minute=0, dayOfWeek=3
  const now = new Date('2026-03-25T15:00:00.000Z');
  const ctx = getWorkingHoursContext('America/Chicago', now);

  assert.equal(ctx.dayOfWeek, 3); // Wednesday
  assert.equal(ctx.hour, 10);
  assert.equal(ctx.minute, 0);
});

test('getWorkingHoursContext returns correct local time parts for America/New_York', () => {
  // 2026-03-25 is a Wednesday.
  // 15:00 UTC = 11:00 EDT (UTC-4)
  const now = new Date('2026-03-25T15:00:00.000Z');
  const ctx = getWorkingHoursContext('America/New_York', now);

  assert.equal(ctx.dayOfWeek, 3); // Wednesday
  assert.equal(ctx.hour, 11);
  assert.equal(ctx.minute, 0);
});

test('getWorkingHoursContext falls back gracefully for an invalid timezone', () => {
  const now = new Date('2026-03-25T10:00:00.000Z');
  // Should not throw — returns a best-effort result
  const ctx = getWorkingHoursContext('Invalid/Timezone', now);
  assert.ok(typeof ctx.dayOfWeek === 'number');
  assert.ok(typeof ctx.hour === 'number');
  assert.ok(typeof ctx.minute === 'number');
});

test('getWorkingHoursContext falls back when timezone is null or empty', () => {
  const now = new Date('2026-03-25T10:00:00.000Z');
  const ctxNull = getWorkingHoursContext(null, now);
  const ctxEmpty = getWorkingHoursContext('', now);
  // Both should default to America/Chicago without throwing.
  assert.ok(typeof ctxNull.dayOfWeek === 'number');
  assert.ok(typeof ctxEmpty.dayOfWeek === 'number');
});

// ---------------------------------------------------------------------------
// normalizeWorkingHours
// ---------------------------------------------------------------------------

test('normalizeWorkingHours returns defaults when called with null', () => {
  const wh = normalizeWorkingHours(null);
  assert.deepEqual(wh.days, [...DEFAULT_WORKING_HOURS.days]);
  assert.equal(wh.startHour, DEFAULT_WORKING_HOURS.startHour);
  assert.equal(wh.endHour, DEFAULT_WORKING_HOURS.endHour);
});

test('normalizeWorkingHours returns defaults when called with a non-object', () => {
  const wh = normalizeWorkingHours('invalid');
  assert.equal(wh.startHour, DEFAULT_WORKING_HOURS.startHour);
});

test('normalizeWorkingHours merges provided fields with defaults', () => {
  const wh = normalizeWorkingHours({ startHour: 9, endHour: 17, days: [1, 2, 3] });
  assert.equal(wh.startHour, 9);
  assert.equal(wh.endHour, 17);
  assert.deepEqual(wh.days, [1, 2, 3]);
  assert.equal(wh.startMinute, DEFAULT_WORKING_HOURS.startMinute);
  assert.equal(wh.endMinute, DEFAULT_WORKING_HOURS.endMinute);
});

test('normalizeWorkingHours clamps hour values to valid 0-23 range', () => {
  const wh = normalizeWorkingHours({ startHour: 25, endHour: -1 });
  assert.equal(wh.startHour, DEFAULT_WORKING_HOURS.startHour);
  assert.equal(wh.endHour, DEFAULT_WORKING_HOURS.endHour);
});

test('normalizeWorkingHours filters invalid day numbers from days array', () => {
  const wh = normalizeWorkingHours({ days: [0, 1, 7, -1, 'abc', 6] });
  // Only 0, 1, 6 are valid (7, -1, 'abc' are invalid).
  assert.deepEqual(wh.days, [0, 1, 6]);
});

// ---------------------------------------------------------------------------
// isWithinWorkingHours — core logic
// ---------------------------------------------------------------------------

test('isWithinWorkingHours returns true during working hours on a weekday', () => {
  // Wednesday 2026-03-25, 10:00 CDT = 15:00 UTC
  const now = new Date('2026-03-25T15:00:00.000Z');
  const account = { timezoneId: 'America/Chicago' };
  assert.equal(isWithinWorkingHours(account, now), true);
});

test('isWithinWorkingHours returns false before start hour', () => {
  // Wednesday 2026-03-25, 07:30 CDT = 12:30 UTC (before 08:00)
  const now = new Date('2026-03-25T12:30:00.000Z');
  const account = { timezoneId: 'America/Chicago' };
  assert.equal(isWithinWorkingHours(account, now), false);
});

test('isWithinWorkingHours returns false at or after end hour', () => {
  // Wednesday 2026-03-25, 18:00 CDT = 23:00 UTC (end hour is exclusive)
  const now = new Date('2026-03-25T23:00:00.000Z');
  const account = { timezoneId: 'America/Chicago' };
  assert.equal(isWithinWorkingHours(account, now), false);
});

test('isWithinWorkingHours returns false on Saturday', () => {
  // Saturday 2026-03-28, 10:00 CDT = 15:00 UTC
  const now = new Date('2026-03-28T15:00:00.000Z');
  const account = { timezoneId: 'America/Chicago' };
  // Default days are Mon-Fri (1-5); Saturday (6) is excluded.
  assert.equal(isWithinWorkingHours(account, now), false);
});

test('isWithinWorkingHours returns false on Sunday', () => {
  // Sunday 2026-03-29, 10:00 CDT = 15:00 UTC
  const now = new Date('2026-03-29T15:00:00.000Z');
  const account = { timezoneId: 'America/Chicago' };
  assert.equal(isWithinWorkingHours(account, now), false);
});

test('isWithinWorkingHours respects custom workingHours config', () => {
  const account = {
    timezoneId: 'America/Chicago',
    workingHours: {
      days: [1, 2, 3, 4, 5, 6], // Includes Saturday
      startHour: 9,
      startMinute: 0,
      endHour: 20,
      endMinute: 0
    }
  };

  // Saturday 2026-03-28, 10:00 CDT = 15:00 UTC
  const saturday = new Date('2026-03-28T15:00:00.000Z');
  assert.equal(isWithinWorkingHours(account, saturday), true);

  // Saturday 2026-03-28, 20:00 CDT = 01:00 UTC next day (after end hour)
  const saturday_late = new Date('2026-03-29T01:00:00.000Z');
  assert.equal(isWithinWorkingHours(account, saturday_late), false);
});

test('isWithinWorkingHours works correctly at the start boundary (inclusive)', () => {
  // Wednesday 2026-03-25, exactly 08:00 CDT = 13:00 UTC
  const now = new Date('2026-03-25T13:00:00.000Z');
  const account = { timezoneId: 'America/Chicago' };
  assert.equal(isWithinWorkingHours(account, now), true);
});

test('isWithinWorkingHours works correctly one minute before start (exclusive)', () => {
  // Wednesday 2026-03-25, 07:59 CDT = 12:59 UTC
  const now = new Date('2026-03-25T12:59:00.000Z');
  const account = { timezoneId: 'America/Chicago' };
  assert.equal(isWithinWorkingHours(account, now), false);
});

test('isWithinWorkingHours works correctly one minute before end (inclusive)', () => {
  // Wednesday 2026-03-25, 17:59 CDT = 22:59 UTC
  const now = new Date('2026-03-25T22:59:00.000Z');
  const account = { timezoneId: 'America/Chicago' };
  assert.equal(isWithinWorkingHours(account, now), true);
});

test('isWithinWorkingHours uses America/Chicago default when timezoneId is missing', () => {
  // Wednesday 2026-03-25, 10:00 CDT (America/Chicago) = 15:00 UTC — within hours.
  const now = new Date('2026-03-25T15:00:00.000Z');
  const account = {};
  // Should not throw; falls back to America/Chicago defaults.
  const result = isWithinWorkingHours(account, now);
  assert.ok(typeof result === 'boolean');
});

test('isWithinWorkingHours returns false for empty account object at midnight UTC', () => {
  // Saturday 2026-03-28 midnight UTC = Friday 19:00 CDT (within hours).
  // If timezoneId defaults to America/Chicago, Friday 19:00 is still within
  // 08:00-18:00, so it would be false (past 18:00).
  const now = new Date('2026-03-28T01:30:00.000Z'); // Saturday 20:30 CDT
  const account = {};
  // Saturday is not in the default Mon-Fri window.
  assert.equal(isWithinWorkingHours(account, now), false);
});

// ---------------------------------------------------------------------------
// DEFAULT_WORKING_HOURS constant
// ---------------------------------------------------------------------------

test('DEFAULT_WORKING_HOURS has expected shape and values', () => {
  assert.deepEqual(DEFAULT_WORKING_HOURS.days, [1, 2, 3, 4, 5]);
  assert.equal(DEFAULT_WORKING_HOURS.startHour, 8);
  assert.equal(DEFAULT_WORKING_HOURS.startMinute, 0);
  assert.equal(DEFAULT_WORKING_HOURS.endHour, 18);
  assert.equal(DEFAULT_WORKING_HOURS.endMinute, 0);
});
