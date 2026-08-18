'use strict';

const {
  createId,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');

const STORE_VERSION = 1;
const DEFAULT_STORE = { version: STORE_VERSION, schedules: [] };
const ALLOWED_FREQUENCIES = new Set(['daily']);

class ReportScheduleStore {
  constructor(options = {}) {
    this.storePath = options.storePath || resolveInternalStatePath('report-schedules.json');
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  getAllSchedules(filters = {}) {
    const store = this.readStore();
    let schedules = store.schedules.map(normalizeSchedule).filter(Boolean);
    if (filters.agentId) schedules = schedules.filter((s) => s.agentId === filters.agentId);
    return schedules;
  }

  getSchedule(scheduleId) {
    const id = String(scheduleId || '').trim();
    if (!id) return null;
    return this.getAllSchedules().find((s) => s.id === id) || null;
  }

  getSchedulesDue(now = new Date()) {
    const ts = now instanceof Date ? now.getTime() : new Date(now).getTime();
    return this.getAllSchedules().filter((s) => {
      if (!s.enabled) return false;
      if (!s.nextRunAt) return false;
      return new Date(s.nextRunAt).getTime() <= ts;
    });
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  saveSchedule(input = {}) {
    const store = this.readStore();
    const now = new Date().toISOString();
    const existingIndex = store.schedules.findIndex(
      (s) => s.id === String(input.id || '').trim()
    );
    const existing = existingIndex >= 0 ? store.schedules[existingIndex] : null;
    const normalized = normalizeForSave(input, existing, now);

    if (existingIndex >= 0) {
      store.schedules[existingIndex] = normalized;
    } else {
      store.schedules.push(normalized);
    }

    writeJsonFileAtomic(this.storePath, store);
    return normalizeSchedule(normalized);
  }

  deleteSchedule(scheduleId) {
    const id = String(scheduleId || '').trim();
    if (!id) return { deleted: false };
    const store = this.readStore();
    const next = store.schedules.filter((s) => s.id !== id);
    const deleted = next.length !== store.schedules.length;
    if (deleted) {
      store.schedules = next;
      writeJsonFileAtomic(this.storePath, store);
    }
    return { deleted };
  }

  markScheduleRan(scheduleId, ranAt = new Date().toISOString()) {
    const store = this.readStore();
    const idx = store.schedules.findIndex((s) => s.id === scheduleId);
    if (idx < 0) return null;

    const existing = store.schedules[idx];
    const ranDate = new Date(ranAt);
    const nextRunAt = computeNextRunAt(existing.hour, existing.minute, existing.timezone, ranDate);

    store.schedules[idx] = {
      ...existing,
      lastRunAt: ranDate.toISOString(),
      nextRunAt
    };

    writeJsonFileAtomic(this.storePath, store);
    return normalizeSchedule(store.schedules[idx]);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  readStore() {
    const raw = readJsonFile(this.storePath, DEFAULT_STORE);
    return {
      version: STORE_VERSION,
      // Spread to avoid mutating the DEFAULT_STORE.schedules reference
      // when readJsonFile returns a shallow-cloned fallback.
      schedules: Array.isArray(raw.schedules) ? [...raw.schedules] : []
    };
  }
}

// ─── Normalize ─────────────────────────────────────────────────────────────────

function normalizeForSave(input = {}, existing = null, now = new Date().toISOString()) {
  const agentId = clean(input.agentId, 160) || clean(existing?.agentId, 160) || null;
  if (!agentId) throw new Error('agentId is required');

  const frequency = normalizeFrequency(input.frequency || existing?.frequency);
  const hour = normalizeHour(input.hour ?? existing?.hour);
  const minute = normalizeMinute(input.minute ?? existing?.minute);
  const timezone = clean(input.timezone || existing?.timezone, 80) || 'UTC';
  const enabled = typeof input.enabled === 'boolean' ? input.enabled
    : (typeof existing?.enabled === 'boolean' ? existing.enabled : true);

  const id = (existing?.id) || clean(input.id, 160) || createId('rsched');

  const nextRunAt = computeNextRunAt(hour, minute, timezone, new Date(now));

  return {
    id,
    agentId,
    agentName: clean(input.agentName || existing?.agentName, 160) || null,
    accountId: clean(input.accountId || existing?.accountId, 160) || null,
    frequency,
    hour,
    minute,
    timezone,
    enabled,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt || null,
    nextRunAt
  };
}

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: raw.id || null,
    agentId: raw.agentId || null,
    agentName: raw.agentName || null,
    accountId: raw.accountId || null,
    frequency: raw.frequency || 'daily',
    hour: typeof raw.hour === 'number' ? raw.hour : 18,
    minute: typeof raw.minute === 'number' ? raw.minute : 0,
    timezone: raw.timezone || 'UTC',
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    lastRunAt: raw.lastRunAt || null,
    nextRunAt: raw.nextRunAt || null
  };
}

// ─── nextRunAt computation ──────────────────────────────────────────────────────

/**
 * Compute the next wall-clock time (in UTC ISO) when `hour:minute` will occur
 * in the given `timezone`, starting from (or after) `fromDate`.
 *
 * Uses Intl.DateTimeFormat to determine the current local hour in the target timezone,
 * then offsets to find the next occurrence.
 */
function computeNextRunAt(hour, minute, timezone, fromDate = new Date()) {
  const safeHour = typeof hour === 'number' ? hour : 18;
  const safeMinute = typeof minute === 'number' ? minute : 0;
  const safeTz = String(timezone || 'UTC');

  // Get the current local date/time in the target timezone
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(fromDate);

    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    const localYear = get('year');
    const localMonth = get('month'); // 1-based
    const localDay = get('day');
    const localHour = get('hour');
    const localMinute = get('minute');

    // Build a UTC Date that corresponds to today's target time in the timezone
    // by working from the local date components.
    const todayTarget = localDateToUtc(localYear, localMonth, localDay, safeHour, safeMinute, 0, safeTz);
    const localNowMinutes = localHour * 60 + localMinute;
    const targetMinutes = safeHour * 60 + safeMinute;

    if (localNowMinutes < targetMinutes) {
      // Target time is still ahead today
      return todayTarget.toISOString();
    }

    // Target time already passed today — schedule for tomorrow
    const tomorrowTarget = localDateToUtc(localYear, localMonth, localDay + 1, safeHour, safeMinute, 0, safeTz);
    return tomorrowTarget.toISOString();
  } catch (_) {
    // Fallback: add 24h from fromDate
    return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }
}

/**
 * Convert a local date/time in `timezone` to a UTC Date object.
 * Uses a binary-search-free approach: build a string, parse it, correct the offset.
 */
function localDateToUtc(year, month, day, hour, minute, second, timezone) {
  // Build a test UTC Date and measure how much Intl shifts it
  const testUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = getUtcOffsetMinutes(testUtc, timezone);
  // local = UTC + offset → UTC = local - offset
  return new Date(testUtc.getTime() - offset * 60 * 1000);
}

function getUtcOffsetMinutes(date, timezone) {
  try {
    const utc = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).format(date);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).format(date);

    const toMinutes = (str) => {
      const [h, m] = str.replace('24', '0').split(':').map(Number);
      return h * 60 + m;
    };
    return toMinutes(local) - toMinutes(utc);
  } catch (_) {
    return 0;
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────────────

function normalizeFrequency(value) {
  const v = String(value || '').toLowerCase().trim();
  return ALLOWED_FREQUENCIES.has(v) ? v : 'daily';
}

function normalizeHour(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 23) return 18;
  return Math.floor(n);
}

function normalizeMinute(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 59) return 0;
  return Math.floor(n);
}

function clean(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = ReportScheduleStore;
