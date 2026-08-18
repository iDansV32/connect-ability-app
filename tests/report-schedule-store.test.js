'use strict';

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const ReportScheduleStore = require('../report-schedule-store');
const { createTempWorkspace } = require('./test-helpers');

// ─── Tests ───────────────────────────────────────────────────────────────────

test('saveSchedule + getSchedule round-trip persists schedule with computed nextRunAt', () => {
  const workspace = createTempWorkspace('rsched-save-');
  try {
    const store = new ReportScheduleStore({ storePath: workspace.path('schedules.json') });

    const saved = store.saveSchedule({
      agentId: 'agent-1',
      agentName: 'Johnny Bones',
      hour: 18,
      minute: 0,
      timezone: 'UTC'
    });

    assert.ok(saved.id, 'schedule should have an id');
    assert.equal(saved.agentId, 'agent-1');
    assert.equal(saved.agentName, 'Johnny Bones');
    assert.equal(saved.hour, 18);
    assert.equal(saved.minute, 0);
    assert.equal(saved.timezone, 'UTC');
    assert.equal(saved.frequency, 'daily');
    assert.equal(saved.enabled, true);
    assert.ok(saved.nextRunAt, 'nextRunAt should be computed on save');
    assert.ok(saved.createdAt, 'createdAt should be set');
    assert.equal(saved.lastRunAt, null);

    // Round-trip: re-read from disk
    const fetched = store.getSchedule(saved.id);
    assert.ok(fetched, 'schedule should be retrievable by id');
    assert.equal(fetched.id, saved.id);
    assert.equal(fetched.agentId, 'agent-1');
    assert.equal(fetched.nextRunAt, saved.nextRunAt);

    // getAllSchedules should include it
    const all = store.getAllSchedules();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, saved.id);

    // getSchedule with unknown id returns null
    assert.equal(store.getSchedule('nonexistent'), null);
  } finally {
    workspace.cleanup();
  }
});

test('getSchedulesDue returns only overdue schedules, skips future ones', () => {
  const workspace = createTempWorkspace('rsched-due-');
  try {
    const store = new ReportScheduleStore({ storePath: workspace.path('schedules.json') });

    store.saveSchedule({ agentId: 'agent-past', hour: 18, minute: 0, timezone: 'UTC' });
    store.saveSchedule({ agentId: 'agent-future', hour: 18, minute: 0, timezone: 'UTC' });

    // Patch nextRunAt directly so we control which ones are "due"
    const raw = JSON.parse(fs.readFileSync(workspace.path('schedules.json'), 'utf8'));
    raw.schedules.find((s) => s.agentId === 'agent-past').nextRunAt = '2026-01-01T12:00:00.000Z'; // past
    raw.schedules.find((s) => s.agentId === 'agent-future').nextRunAt = '2099-01-01T18:00:00.000Z'; // far future
    fs.writeFileSync(workspace.path('schedules.json'), JSON.stringify(raw));

    const now = new Date('2026-03-21T18:00:00.000Z');
    const due = store.getSchedulesDue(now);

    assert.equal(due.length, 1);
    assert.equal(due[0].agentId, 'agent-past');

    // Disabled schedules are never due even if overdue
    raw.schedules.find((s) => s.agentId === 'agent-past').enabled = false;
    fs.writeFileSync(workspace.path('schedules.json'), JSON.stringify(raw));
    assert.equal(store.getSchedulesDue(now).length, 0);
  } finally {
    workspace.cleanup();
  }
});

test('markScheduleRan updates lastRunAt and advances nextRunAt past the run time', () => {
  const workspace = createTempWorkspace('rsched-ran-');
  try {
    const store = new ReportScheduleStore({ storePath: workspace.path('schedules.json') });
    const saved = store.saveSchedule({ agentId: 'agent-1', hour: 18, minute: 0, timezone: 'UTC' });

    assert.equal(saved.lastRunAt, null, 'lastRunAt should start null');

    const ranAt = '2026-01-01T18:00:00.000Z';
    const updated = store.markScheduleRan(saved.id, ranAt);

    assert.equal(updated.lastRunAt, ranAt, 'lastRunAt should reflect the run time');
    assert.ok(updated.nextRunAt, 'nextRunAt should still be set');

    // nextRunAt must be strictly after ranAt (schedule advances to next day)
    const nextTs = new Date(updated.nextRunAt).getTime();
    const ranTs = new Date(ranAt).getTime();
    assert.ok(nextTs > ranTs, 'nextRunAt should be in the future relative to ranAt');

    // Round-trip: changes should persist to disk
    const fetched = store.getSchedule(saved.id);
    assert.equal(fetched.lastRunAt, ranAt);
    assert.equal(fetched.nextRunAt, updated.nextRunAt);

    // markScheduleRan on unknown id returns null
    assert.equal(store.markScheduleRan('nonexistent-id'), null);
  } finally {
    workspace.cleanup();
  }
});

test('deleteSchedule removes schedule and getAllSchedules returns empty', () => {
  const workspace = createTempWorkspace('rsched-delete-');
  try {
    const store = new ReportScheduleStore({ storePath: workspace.path('schedules.json') });

    const saved = store.saveSchedule({ agentId: 'agent-1', hour: 18, minute: 0, timezone: 'UTC' });
    assert.equal(store.getAllSchedules().length, 1);

    const result = store.deleteSchedule(saved.id);
    assert.equal(result.deleted, true);
    assert.equal(store.getAllSchedules().length, 0);
    assert.equal(store.getSchedule(saved.id), null);

    // Deleting non-existent returns { deleted: false }
    const result2 = store.deleteSchedule('nonexistent-id');
    assert.equal(result2.deleted, false);

    // Deleting with empty id returns { deleted: false }
    const result3 = store.deleteSchedule('');
    assert.equal(result3.deleted, false);
  } finally {
    workspace.cleanup();
  }
});
