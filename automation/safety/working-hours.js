'use strict';

// Default working-hours window: Mon–Fri, 08:00–18:00 local time.
// Accounts can override any field via their `workingHours` config.
const DEFAULT_WORKING_HOURS = Object.freeze({
  // Days of the week on which automation is allowed (0 = Sunday, 6 = Saturday).
  days: Object.freeze([1, 2, 3, 4, 5]),
  // Start and end are in local time (24-hour clock, inclusive/exclusive).
  startHour: 8,
  startMinute: 0,
  endHour: 18,
  endMinute: 0
});

/**
 * Return the local date/time parts for `now` in `timezoneId`.
 *
 * @param {string} timezoneId - IANA timezone (e.g. "America/Chicago").
 * @param {Date}   now        - Reference timestamp (default: current time).
 * @returns {{ dayOfWeek: number, hour: number, minute: number }}
 */
function getWorkingHoursContext(timezoneId, now = new Date()) {
  const tz = cleanTimezoneId(timezoneId) || 'America/Chicago';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).formatToParts(now);

    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekdayPart = parts.find((p) => p.type === 'weekday');
    const hourPart = parts.find((p) => p.type === 'hour');
    const minutePart = parts.find((p) => p.type === 'minute');

    const rawHour = parseInt(hourPart?.value ?? '0', 10);
    // `hour12: false` can return 24 for midnight in some environments — normalise.
    const hour = rawHour === 24 ? 0 : rawHour;
    const minute = parseInt(minutePart?.value ?? '0', 10);
    const dayOfWeek = weekdayMap[weekdayPart?.value] ?? now.getDay();

    return { dayOfWeek, hour, minute };
  } catch (_) {
    // Fall back to UTC-local values — safer than blocking all automation.
    return {
      dayOfWeek: now.getDay(),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes()
    };
  }
}

/**
 * Normalise the raw `workingHours` config stored on an account record.
 * Missing fields fall back to DEFAULT_WORKING_HOURS.
 *
 * @param {object|null} raw
 * @returns {{ days: number[], startHour: number, startMinute: number, endHour: number, endMinute: number }}
 */
function normalizeWorkingHours(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_WORKING_HOURS, days: [...DEFAULT_WORKING_HOURS.days] };
  }

  const days = Array.isArray(raw.days)
    ? raw.days
        .map((d) => parseInt(d, 10))
        .filter((d) => Number.isFinite(d) && d >= 0 && d <= 6)
    : [...DEFAULT_WORKING_HOURS.days];

  return {
    days,
    startHour: clampHour(raw.startHour, DEFAULT_WORKING_HOURS.startHour),
    startMinute: clampMinute(raw.startMinute, DEFAULT_WORKING_HOURS.startMinute),
    endHour: clampHour(raw.endHour, DEFAULT_WORKING_HOURS.endHour),
    endMinute: clampMinute(raw.endMinute, DEFAULT_WORKING_HOURS.endMinute)
  };
}

/**
 * Return true when `now` falls inside the account's configured working window.
 *
 * If the account has no `workingHours` config **and** no `timezoneId`, we fall
 * back to DEFAULT_WORKING_HOURS in America/Chicago — a safe default that keeps
 * automation within reasonable business hours rather than running 24/7.
 *
 * @param {object} account - Account record (may include `timezoneId`, `workingHours`).
 * @param {Date}   [now]   - Reference time (default: current time).
 * @returns {boolean}
 */
function isWithinWorkingHours(account = {}, now = new Date()) {
  const timezoneId = cleanTimezoneId(account.timezoneId) || 'America/Chicago';
  const config = normalizeWorkingHours(account.workingHours ?? null);
  const { dayOfWeek, hour, minute } = getWorkingHoursContext(timezoneId, now);

  // Day check.
  if (!config.days.includes(dayOfWeek)) {
    return false;
  }

  // Convert current local time to minutes-since-midnight for range comparison.
  const currentMinutes = hour * 60 + minute;
  const startMinutes = config.startHour * 60 + config.startMinute;
  const endMinutes = config.endHour * 60 + config.endMinute;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampHour(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
}

function clampMinute(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 && n <= 59 ? n : fallback;
}

function cleanTimezoneId(value) {
  return String(value || '').replace(/\s+/g, '').trim().slice(0, 80) || null;
}

module.exports = {
  DEFAULT_WORKING_HOURS,
  getWorkingHoursContext,
  isWithinWorkingHours,
  normalizeWorkingHours,
  _private: {
    clampHour,
    clampMinute,
    cleanTimezoneId
  }
};
