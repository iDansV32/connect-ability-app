'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ActivityAnalyticsService = require('../activity-analytics');
const DailyReportService = require('../daily-report-service');
const { createTempWorkspace, writeJsonLines } = require('./test-helpers');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAnalytics(workspace) {
  return new ActivityAnalyticsService({
    eventsPath: workspace.path('events.jsonl'),
    profilesPath: workspace.path('profiles.json')
  });
}

const RANGE = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T23:59:59.000Z' };

// ─── Tests ───────────────────────────────────────────────────────────────────

test('empty event store yields all-zero summary and empty detail arrays', () => {
  const workspace = createTempWorkspace('rpt-empty-');
  try {
    const service = new DailyReportService({ analytics: makeAnalytics(workspace) });
    const report = service.generateReport('agent-1', RANGE);

    assert.equal(report.agentId, 'agent-1');
    assert.equal(report.summary.profilesViewed, 0);
    assert.equal(report.summary.dmsSent, 0);
    assert.equal(report.summary.dmsReceived, 0);
    assert.equal(report.summary.postsPublished, 0);
    assert.equal(report.summary.connectionsRequested, 0);
    assert.equal(report.summary.connectionsAccepted, 0);
    assert.equal(report.summary.postsLikedByUs, 0);
    assert.equal(report.summary.workflowsCompleted, 0);
    assert.equal(report.summary.workflowsFailed, 0);
    assert.deepEqual(report.detail.profilesViewed, []);
    assert.deepEqual(report.detail.dmsSent, []);
    assert.deepEqual(report.detail.dmsReceived, []);
    assert.deepEqual(report.detail.postsPublished, []);
  } finally {
    workspace.cleanup();
  }
});

test('profile_viewed event appears in profilesViewed with name from targetValue', () => {
  const workspace = createTempWorkspace('rpt-profile-');
  try {
    writeJsonLines(workspace.path('events.jsonl'), [
      {
        id: 'evt-1',
        type: 'profile_viewed',
        timestamp: '2026-01-01T10:00:00.000Z',
        agentId: 'agent-1',
        agentName: 'Johnny Bones',
        profileUrl: 'https://linkedin.com/in/janesmith',
        targetValue: 'Jane Smith'
      }
    ]);

    const service = new DailyReportService({ analytics: makeAnalytics(workspace) });
    const report = service.generateReport('agent-1', RANGE);

    assert.equal(report.agentName, 'Johnny Bones');
    assert.equal(report.summary.profilesViewed, 1);
    assert.equal(report.detail.profilesViewed.length, 1);

    const entry = report.detail.profilesViewed[0];
    assert.equal(entry.name, 'Jane Smith');
    assert.equal(entry.profileUrl, 'https://linkedin.com/in/janesmith');
    assert.ok(entry.timestamp, 'timestamp should be present');
  } finally {
    workspace.cleanup();
  }
});

test('dm_sent and dm_reply_received events appear in dmsSent and dmsReceived', () => {
  const workspace = createTempWorkspace('rpt-dms-');
  try {
    writeJsonLines(workspace.path('events.jsonl'), [
      {
        id: 'evt-2',
        type: 'dm_sent',
        timestamp: '2026-01-01T11:00:00.000Z',
        agentId: 'agent-1',
        profileUrl: 'https://linkedin.com/in/janesmith',
        targetValue: 'Jane Smith',
        metadata: { messageTemplate: 'Hi Jane, I noticed your profile and thought you might enjoy connecting.' }
      },
      {
        id: 'evt-3',
        type: 'dm_reply_received',
        timestamp: '2026-01-01T14:00:00.000Z',
        agentId: 'agent-1',
        profileUrl: 'https://linkedin.com/in/janesmith',
        targetValue: 'Jane Smith',
        metadata: { text: 'Thanks for reaching out!' }
      }
    ]);

    const service = new DailyReportService({ analytics: makeAnalytics(workspace) });
    const report = service.generateReport('agent-1', RANGE);

    assert.equal(report.summary.dmsSent, 1);
    assert.equal(report.summary.dmsReceived, 1);
    assert.equal(report.detail.dmsSent.length, 1);
    assert.equal(report.detail.dmsReceived.length, 1);

    assert.ok(report.detail.dmsSent[0].preview.includes('Hi Jane'), 'dm preview should include message start');
    assert.equal(report.detail.dmsSent[0].name, 'Jane Smith');

    assert.equal(report.detail.dmsReceived[0].text, 'Thanks for reaching out!');
    assert.equal(report.detail.dmsReceived[0].name, 'Jane Smith');
  } finally {
    workspace.cleanup();
  }
});

test('events outside the time range are excluded', () => {
  const workspace = createTempWorkspace('rpt-filter-');
  try {
    writeJsonLines(workspace.path('events.jsonl'), [
      {
        id: 'evt-in',
        type: 'profile_viewed',
        timestamp: '2026-01-01T10:00:00.000Z', // inside range
        agentId: 'agent-1',
        profileUrl: 'https://linkedin.com/in/inside',
        targetValue: 'Inside Range'
      },
      {
        id: 'evt-out',
        type: 'profile_viewed',
        timestamp: '2026-01-02T10:00:00.000Z', // next day — outside range
        agentId: 'agent-1',
        profileUrl: 'https://linkedin.com/in/outside',
        targetValue: 'Outside Range'
      }
    ]);

    const service = new DailyReportService({ analytics: makeAnalytics(workspace) });
    const report = service.generateReport('agent-1', RANGE);

    assert.equal(report.summary.profilesViewed, 1);
    assert.equal(report.detail.profilesViewed.length, 1);
    assert.equal(report.detail.profilesViewed[0].name, 'Inside Range');
  } finally {
    workspace.cleanup();
  }
});

test('prospect enrichment replaces targetValue with fullName and adds title + company', () => {
  const workspace = createTempWorkspace('rpt-enrich-');
  try {
    writeJsonLines(workspace.path('events.jsonl'), [
      {
        id: 'evt-4',
        type: 'profile_viewed',
        timestamp: '2026-01-01T10:00:00.000Z',
        agentId: 'agent-1',
        profileUrl: 'https://linkedin.com/in/janesmith',
        targetValue: 'raw-fallback-name', // should be overridden by prospect.fullName
        prospectId: 'prospect-1'
      }
    ]);

    // Minimal mock — only needs getAllProspects
    const mockProspects = {
      getAllProspects: () => [
        { id: 'prospect-1', fullName: 'Jane Smith', title: 'Chief of Staff', company: 'Acme Corp' }
      ]
    };

    const service = new DailyReportService({ analytics: makeAnalytics(workspace), prospects: mockProspects });
    const report = service.generateReport('agent-1', RANGE);

    assert.equal(report.detail.profilesViewed.length, 1);
    const entry = report.detail.profilesViewed[0];
    assert.equal(entry.name, 'Jane Smith', 'prospect fullName should override targetValue');
    assert.equal(entry.title, 'Chief of Staff @ Acme Corp', 'title should combine title and company');
  } finally {
    workspace.cleanup();
  }
});
