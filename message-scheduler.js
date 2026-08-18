// message-scheduler.js
'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const logAction = (message) => console.log(`[MessageScheduler] ${message}`);
const logError = (message, error) => console.error(`[MessageScheduler Error] ${message}`, error || '');
const ALLOWED_SCHEDULE_STATUSES = new Set(['pending', 'executing', 'sent', 'failed', 'cancelled']);

function cleanString(value, maxLength = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength = 3000) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\0/g, '').trim().slice(0, maxLength);
}

function normalizeScheduleFilters(filters = {}) {
  return {
    accountId: cleanString(filters?.accountId, 120) || null,
    status: cleanString(filters?.status, 40).toLowerCase() || null
  };
}

function matchesScheduleFilters(schedule, filters = {}) {
  if (filters.accountId && schedule.accountId !== filters.accountId) return false;
  if (filters.status && schedule.status !== filters.status) return false;
  return true;
}

function normalizeProfileUrls(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  return values
    .map((value) => cleanString(value, 400))
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

function resolveScheduledTime(schedule = {}) {
  const directCandidates = [
    schedule.scheduledAt,
    schedule.runAt,
    schedule.timestamp,
    schedule.when
  ];

  for (const candidate of directCandidates) {
    const text = cleanString(candidate, 80);
    if (!text) continue;
    const timestamp = Date.parse(text);
    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }

  const rawScheduledTime = cleanString(schedule.scheduledTime, 80);
  if (rawScheduledTime) {
    const parsedDirect = Date.parse(rawScheduledTime);
    if (!Number.isNaN(parsedDirect)) {
      return new Date(parsedDirect).toISOString();
    }
  }

  const scheduledDate = cleanString(schedule.scheduledDate, 32);
  const timeCandidate = cleanString(
    schedule.scheduledClock || schedule.time || schedule.scheduledHour || schedule.scheduledTime,
    32
  );
  if (scheduledDate && timeCandidate && /^\d{2}:\d{2}(:\d{2})?$/.test(timeCandidate)) {
    const timestamp = Date.parse(`${scheduledDate}T${timeCandidate}`);
    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }

  return new Date().toISOString();
}

function normalizeScheduleRecord(schedule = {}, overrides = {}) {
  const options = normalizeOptions(schedule.options || schedule.meta || {});
  const accountId = cleanString(
    overrides.accountId ?? schedule.accountId ?? options.accountId,
    120
  ) || null;
  const accountName = cleanString(
    overrides.accountName ?? schedule.accountName ?? options.accountName,
    160
  ) || null;
  const scheduledTime = resolveScheduledTime(schedule);

  let status = cleanString(schedule.status, 40).toLowerCase();
  if (typeof schedule.sent === 'boolean' && !status) {
    status = schedule.sent ? 'sent' : 'pending';
  }
  if (!ALLOWED_SCHEDULE_STATUSES.has(status)) {
    status = 'pending';
  }

  const normalizedOptions = {
    ...options,
    accountId,
    accountName
  };

  return {
    id: cleanString(schedule.id, 160) || String(Date.now()),
    profileUrls: normalizeProfileUrls(schedule.profileUrls || schedule.profileIds || []),
    message: cleanMultiline(schedule.message, 3000),
    scheduledTime,
    status,
    created: cleanString(schedule.created, 80) || new Date().toISOString(),
    modified: cleanString(schedule.modified, 80) || null,
    sentAt: cleanString(schedule.sentAt, 80) || null,
    result: schedule.result ?? null,
    lastError: cleanMultiline(schedule.lastError, 1200) || null,
    currentRecurrence: Number.isInteger(schedule.currentRecurrence) ? schedule.currentRecurrence : null,
    sendNow: Boolean(schedule.sendNow),
    accountId,
    accountName,
    options: normalizedOptions
  };
}

class MessageScheduler extends EventEmitter {
  constructor(options = {}) {
    super();
    this._initialized = false;
    this._tickHandle = null;
    this._storePath = options.storePath || this._resolveStore();
    this.schedules = []; // unified in-memory store
  }

  _resolveStore() {
    const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
    const dir  = path.join(home, 'Documents', 'Connect-Ability');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'message-schedules.json');
  }

  _readAll() {
    try {
      if (!fs.existsSync(this._storePath)) return [];
      const raw = fs.readFileSync(this._storePath, 'utf8');
      return JSON.parse(raw || '[]');
    } catch (e) {
      logError(`Failed reading schedules: ${e.message}`, e);
      return [];
    }
  }

  _writeAll(all) {
    try {
      fs.writeFileSync(this._storePath, JSON.stringify(all, null, 2));
    } catch (e) {
      logError(`Failed writing schedules: ${e.message}`, e);
    }
  }

  _loadSchedules() {
    const raw = this._readAll();
    this.schedules = raw.map((item) => normalizeScheduleRecord(item));
  }

  _saveSchedules() {
    this._writeAll(this.schedules);
  }

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    this._loadSchedules();
    this._tickHandle = setInterval(() => this._tick(), 15_000);
    this._tickHandle.unref?.();
    this.emit('ready');
  }

  // Some code in main.js calls this older name — make it an alias
  async initializeTimers() {
    return this.init();
  }

  async _tick() {
    const now = Date.now();
    // consider due those pending whose scheduledTime <= now
    const due = this.schedules.filter(
      (s) => (s.status === 'pending') && s.scheduledTime && new Date(s.scheduledTime).getTime() <= now
    );

    for (const job of due) {
      // Move to executing right before emitting
      job.status = 'executing';
      // Emit both events for backward + new handler compatibility
      // Old-style:
      this.emit('schedule-triggered', {
        id: job.id,
        accountId: job.accountId || null,
        accountName: job.accountName || null,
        profileIds: job.profileUrls || [], // legacy field name kept
        message: job.message || '',
        options: job.options || {},
        meta: job.options || {}
      });
      // New-style:
      this.emit('schedule-ready', job);
    }

    if (due.length) this._saveSchedules();
  }

  /**
   * Backward-compatible add() — accepts legacy { when, profileIds } format
   * and stores as new format.
   */
  async add(schedule) {
    const scheduled = normalizeScheduleRecord({
      ...schedule,
      id: schedule.id || Date.now(),
      profileUrls: schedule.profileUrls || schedule.profileIds || [],
      scheduledTime: schedule.scheduledTime || schedule.when,
      status: 'pending',
      created: new Date().toISOString(),
      options: schedule.options || schedule.meta || {}
    });
    this.schedules.push(scheduled);
    this._saveSchedules();
    return true;
  }

  /**
   * Clear all scheduled message logs (completed, failed, cancelled)
   * @param {boolean} keepPending - Whether to keep pending messages
   * @returns {number} - Number of messages cleared
   */
  clearScheduledLogs(keepPending = true, filters = {}) {
    try {
      const normalizedFilters = normalizeScheduleFilters(filters);
      const before = this.schedules.length;

      this.schedules = this.schedules.filter((schedule) => {
        if (!matchesScheduleFilters(schedule, normalizedFilters)) {
          return true;
        }
        if (!keepPending) {
          return false;
        }
        return schedule.status === 'pending' || schedule.status === 'executing';
      });

      const cleared = before - this.schedules.length;
      this._saveSchedules();

      logAction(`Cleared ${cleared} scheduled message logs`);
      return cleared;
    } catch (error) {
      logError(`Error clearing scheduled logs: ${error.message}`, error);
      return 0;
    }
  }

  /**
   * Clear specific status types
   * @param {Array<string>} statusTypes - Status types to clear
   * @returns {number} - Number of messages cleared
   */
  clearByStatus(statusTypes = ['sent', 'failed', 'cancelled'], filters = {}) {
    try {
      const normalizedFilters = normalizeScheduleFilters(filters);
      const before = this.schedules.length;

      this.schedules = this.schedules.filter((schedule) => {
        if (!matchesScheduleFilters(schedule, normalizedFilters)) {
          return true;
        }
        return !statusTypes.includes(schedule.status);
      });

      const cleared = before - this.schedules.length;
      this._saveSchedules();

      logAction(`Cleared ${cleared} messages with status: ${statusTypes.join(', ')}`);
      return cleared;
    } catch (error) {
      logError(`Error clearing by status: ${error.message}`, error);
      return 0;
    }
  }

  /**
   * Schedule a message with option to send immediately
   * @param {Object} schedule - { profileUrls, message, scheduledTime, options }
   * @param {boolean} sendNow - Whether to send immediately
   * @returns {string|Object} - Schedule ID or immediate send result
   */
  scheduleMessage(schedule, sendNow = false) {
    const id = Date.now().toString();
    const options = {
      ...(schedule.options || {})
    };
    if (typeof schedule.recurring !== 'undefined' && typeof options.recurring === 'undefined') {
      options.recurring = !!schedule.recurring;
    }
    if (typeof schedule.recurringPattern !== 'undefined' && typeof options.recurringPattern === 'undefined') {
      options.recurringPattern = schedule.recurringPattern;
    }
    if (typeof schedule.maxRecurrences !== 'undefined' && typeof options.maxRecurrences === 'undefined') {
      options.maxRecurrences = schedule.maxRecurrences;
    }

    const scheduledMessage = normalizeScheduleRecord({
      id,
      profileUrls: schedule.profileUrls || schedule.profileIds || [],
      message: schedule.message,
      scheduledTime: sendNow ? new Date().toISOString() : schedule.scheduledTime,
      status: sendNow ? 'executing' : 'pending',
      created: new Date().toISOString(),
      options,
      accountId: schedule.accountId || options.accountId || null,
      accountName: schedule.accountName || options.accountName || null,
      sendNow: sendNow
    });

    this.schedules.push(scheduledMessage);
    this._saveSchedules();

    if (sendNow) {
      logAction(`Triggering immediate send for message ${id}`);
      // Emit immediately for execution
      setImmediate(() => {
        // Keep compatibility with both listeners
        this.emit('schedule-ready', scheduledMessage);
        this.emit('schedule-triggered', {
          id,
          accountId: scheduledMessage.accountId || null,
          accountName: scheduledMessage.accountName || null,
          profileIds: scheduledMessage.profileUrls,
          message: scheduledMessage.message,
          options: scheduledMessage.options || {},
          meta: scheduledMessage.options
        });
      });
      return { id, sendNow: true };
    } else {
      logAction(`Scheduled message ${id} for ${new Date(schedule.scheduledTime).toLocaleString()}`);
      return id;
    }
  }

  /**
   * Optionally used by UI to list schedules
   */
  getScheduledMessages(filters = {}) {
    const normalizedFilters = normalizeScheduleFilters(filters);
    return this.schedules
      .filter((schedule) => matchesScheduleFilters(schedule, normalizedFilters))
      .map((s) => ({
      ...s,
      profileIds: Array.isArray(s.profileUrls) ? s.profileUrls : [],
      accountId: s.accountId || s.options?.accountId || null,
      accountName: s.accountName || s.options?.accountName || null,
      recurring: s.options?.recurring ?? false,
      recurringPattern: s.options?.recurringPattern ?? null,
      maxRecurrences: s.options?.maxRecurrences ?? 1,
      currentRecurrence: s.currentRecurrence ?? (s.status === 'sent' ? 1 : 0)
      }));
  }

  getScheduledMessage(id, filters = {}) {
    const scheduleId = cleanString(id, 160);
    if (!scheduleId) return null;
    return this.getScheduledMessages(filters).find((schedule) => schedule.id === scheduleId) || null;
  }

  getOverdueSchedules() {
    const now = Date.now();
    return this.schedules.filter((s) => {
      if (s.status !== 'pending') return false;
      const when = s.scheduledTime ? new Date(s.scheduledTime).getTime() : NaN;
      return Number.isFinite(when) && when <= now;
    });
  }

  triggerSchedule(scheduleLike, filters = {}) {
    const id = cleanString(scheduleLike?.id, 160);
    const idx = this.schedules.findIndex((schedule) => (
      schedule.id === id && matchesScheduleFilters(schedule, normalizeScheduleFilters(filters))
    ));
    if (idx === -1) return false;

    this.schedules[idx].status = 'executing';
    this.schedules[idx].modified = new Date().toISOString();
    this._saveSchedules();
    const job = this.schedules[idx];
    this.emit('schedule-ready', job);
    this.emit('schedule-triggered', {
      id: job.id,
      accountId: job.accountId || null,
      accountName: job.accountName || null,
      profileIds: job.profileUrls || [],
      message: job.message || '',
      options: job.options || {},
      meta: job.options || {}
    });
    return true;
  }

  triggerNow(id, filters = {}) {
    return this.triggerSchedule({ id }, filters);
  }

  cancelSchedule(id, filters = {}) {
    const scheduleId = cleanString(id, 160);
    const normalizedFilters = normalizeScheduleFilters(filters);
    const idx = this.schedules.findIndex((schedule) => (
      schedule.id === scheduleId && matchesScheduleFilters(schedule, normalizedFilters)
    ));
    if (idx === -1) return false;
    if (this.schedules[idx].status === 'sent') return false;
    this.schedules[idx].status = 'cancelled';
    this.schedules[idx].modified = new Date().toISOString();
    this._saveSchedules();
    return true;
  }

  updateSchedule(id, updates = {}, filters = {}) {
    const scheduleId = cleanString(id, 160);
    const normalizedFilters = normalizeScheduleFilters(filters);
    const idx = this.schedules.findIndex((schedule) => (
      schedule.id === scheduleId && matchesScheduleFilters(schedule, normalizedFilters)
    ));
    if (idx === -1) return false;

    const current = this.schedules[idx];
    if (current.status !== 'pending') return false;

    const nextOptions = updates.options && typeof updates.options === 'object'
      ? { ...current.options, ...normalizeOptions(updates.options) }
      : current.options;
    const nextSchedule = normalizeScheduleRecord({
      ...current,
      message: typeof updates.message === 'string' ? updates.message : current.message,
      scheduledTime: updates.scheduledTime || current.scheduledTime,
      profileUrls: Array.isArray(updates.profileUrls)
        ? updates.profileUrls
        : (Array.isArray(updates.profileIds) ? updates.profileIds : current.profileUrls),
      options: nextOptions,
      modified: new Date().toISOString()
    }, {
      accountId: current.accountId,
      accountName: current.accountName
    });
    nextSchedule.status = current.status;
    nextSchedule.created = current.created;
    nextSchedule.sentAt = current.sentAt;
    nextSchedule.result = current.result;
    nextSchedule.lastError = current.lastError;
    nextSchedule.currentRecurrence = current.currentRecurrence;
    nextSchedule.sendNow = current.sendNow;
    this.schedules[idx] = nextSchedule;
    this._saveSchedules();
    return true;
  }

  markAsSent(id, result = null) {
    const idx = this.schedules.findIndex((s) => s.id === String(id));
    if (idx === -1) return false;
    this.schedules[idx].status = 'sent';
    this.schedules[idx].sentAt = new Date().toISOString();
    this.schedules[idx].modified = new Date().toISOString();
    if (result) this.schedules[idx].result = result;
    this._saveSchedules();
    return true;
  }

  markAsFailed(id, reason = null) {
    const idx = this.schedules.findIndex((s) => s.id === String(id));
    if (idx === -1) return false;
    this.schedules[idx].status = 'failed';
    this.schedules[idx].lastError = reason || null;
    this.schedules[idx].modified = new Date().toISOString();
    this._saveSchedules();
    return true;
  }

  /**
   * Mark a schedule as finished (sent/failed/cancelled)
   * @param {string} id
   * @param {'sent'|'failed'|'cancelled'} status
   */
  markStatus(id, status) {
    const idx = this.schedules.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.schedules[idx].status = status;
    if (status === 'sent') this.schedules[idx].sentAt = new Date().toISOString();
    this.schedules[idx].modified = new Date().toISOString();
    this._saveSchedules();
    return true;
  }

  async cleanupOldSchedules({ keepDays = 14 } = {}) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const before = this.schedules.length;

    // Keep: pending/executing OR anything updated/sent recently
    this.schedules = this.schedules.filter((it) => {
      if (it.status === 'pending' || it.status === 'executing') return true;
      const ref = new Date(it.sentAt || it.created || 0).getTime();
      return ref >= cutoff;
    });

    const removed = before - this.schedules.length;
    if (removed) this._saveSchedules();
    return { removed, kept: this.schedules.length };
  }

  async stop() {
    if (this._tickHandle) clearInterval(this._tickHandle);
    this._tickHandle = null;
    this._initialized = false;
  }
}

module.exports = new MessageScheduler();
module.exports.MessageScheduler = MessageScheduler;
