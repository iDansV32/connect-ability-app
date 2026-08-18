'use strict';

/**
 * tests/timing-trends-analytics.test.js
 *
 * Targeted tests for Ticket 16 — time-to-reply, time-to-accept, and weekly trends.
 *
 * Covers:
 *  1. timeToReply correctly measures elapsed time from most recent prior dm_sent
 *  2. timeToReply leaves unattributable replies out of the stats
 *  3. timeToAccept correctly measures elapsed time from most recent prior connection_requested
 *  4. timeToAccept leaves unattributable acceptances out of the stats
 *  5. median and average calculations correct for small fixed datasets
 *  6. weeklyTrends buckets events into correct weeks
 *  7. get_analytics response backward compatible with new fields
 *  8. empty events produce clean zero/null results
 *  9. timeToReply uses most recent prior DM when multiple exist
 * 10. weeklyTrends includes all tracked event types
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTempWorkspace } = require('./test-helpers');
const ActivityAnalyticsService = require('../activity-analytics');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnalyticsService(events) {
  const ws = createTempWorkspace('timing-analytics-');
  const eventsPath = ws.path('events.jsonl');
  const fs = require('fs');
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(eventsPath, lines, 'utf8');
  return new ActivityAnalyticsService({
    eventsPath,
    profilesPath: ws.path('profiles.json'),
    accountHealthPath: ws.path('health.json'),
    transportHealthPath: ws.path('transport.json'),
    runtimeLogsPath: ws.path('logs.jsonl'),
    sessionRegistryPath: ws.path('sessions.json'),
    linkedInAccountsPath: ws.path('accounts.json')
  });
}

function makeEvent(type, profileUrl, extra = {}) {
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    timestamp: extra.timestamp || '2026-03-22T10:00:00.000Z',
    accountId: extra.accountId || 'acc-1',
    agentId: extra.agentId || 'agent-1',
    workflowId: extra.workflowId || 'wf-1',
    profileUrl,
    targetValue: extra.targetValue || profileUrl,
    prospectId: extra.prospectId || null,
    status: extra.status || 'ok',
    metadata: extra.metadata || {}
  };
}

const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1. timeToReply correctly measures elapsed time from most recent prior dm_sent
// ---------------------------------------------------------------------------

test('getTimeToReply measures correct delta between dm_sent and dm_reply_received', () => {
  const events = [
    // DM sent at 10:00, reply at 12:00 → 2 hours
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-22T10:00:00.000Z'
    }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-22T12:00:00.000Z'
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getTimeToReply();

  assert.equal(result.count, 1);
  assert.equal(result.averageMs, 2 * HOUR_MS);
  assert.equal(result.medianMs, 2 * HOUR_MS);
  assert.equal(result.averageHours, 2);
  assert.equal(result.medianHours, 2);
});

// ---------------------------------------------------------------------------
// 2. timeToReply leaves unattributable replies out
// ---------------------------------------------------------------------------

test('getTimeToReply excludes replies with no prior dm_sent', () => {
  const events = [
    // Reply from bob, but no dm_sent to bob
    makeEvent('dm_reply_received', 'https://linkedin.com/in/bob', {
      timestamp: '2026-03-22T12:00:00.000Z'
    }),
    // DM sent to alice, reply from alice
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-22T10:00:00.000Z'
    }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-22T14:00:00.000Z'
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getTimeToReply();

  assert.equal(result.count, 1, 'only alice reply should count');
  assert.equal(result.averageMs, 4 * HOUR_MS);
});

test('getTimeToReply excludes replies that occur before any dm_sent', () => {
  const events = [
    // Reply at 10:00, DM sent at 12:00 (reply is before the DM)
    makeEvent('dm_reply_received', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-22T10:00:00.000Z'
    }),
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-22T12:00:00.000Z'
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getTimeToReply();

  assert.equal(result.count, 0);
  assert.equal(result.averageMs, null);
  assert.equal(result.medianMs, null);
});

// ---------------------------------------------------------------------------
// 3. timeToAccept correctly measures elapsed time from most recent prior connection_requested
// ---------------------------------------------------------------------------

test('getTimeToAccept measures correct delta between connection_requested and connection_accepted', () => {
  const events = [
    makeEvent('connection_requested', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-20T10:00:00.000Z'
    }),
    makeEvent('connection_accepted', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-22T10:00:00.000Z'  // 48 hours later
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getTimeToAccept();

  assert.equal(result.count, 1);
  assert.equal(result.averageMs, 48 * HOUR_MS);
  assert.equal(result.averageHours, 48);
});

// ---------------------------------------------------------------------------
// 4. timeToAccept leaves unattributable acceptances out
// ---------------------------------------------------------------------------

test('getTimeToAccept excludes acceptances with no prior connection_requested', () => {
  const events = [
    // Acceptance for bob, but no connection_requested to bob
    makeEvent('connection_accepted', 'https://linkedin.com/in/bob', {
      timestamp: '2026-03-22T12:00:00.000Z'
    }),
    // Request to alice, acceptance from alice
    makeEvent('connection_requested', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-22T10:00:00.000Z'
    }),
    makeEvent('connection_accepted', 'https://linkedin.com/in/alice', {
      timestamp: '2026-03-22T16:00:00.000Z'
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getTimeToAccept();

  assert.equal(result.count, 1, 'only alice acceptance should count');
  assert.equal(result.averageMs, 6 * HOUR_MS);
});

// ---------------------------------------------------------------------------
// 5. median and average calculations correct for small fixed datasets
// ---------------------------------------------------------------------------

test('median and average are correct for odd-count dataset', () => {
  const events = [
    // 3 DM+reply pairs: 1h, 3h, 5h
    makeEvent('dm_sent', 'https://linkedin.com/in/a', { timestamp: '2026-03-22T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/a', { timestamp: '2026-03-22T11:00:00.000Z' }),
    makeEvent('dm_sent', 'https://linkedin.com/in/b', { timestamp: '2026-03-22T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/b', { timestamp: '2026-03-22T13:00:00.000Z' }),
    makeEvent('dm_sent', 'https://linkedin.com/in/c', { timestamp: '2026-03-22T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/c', { timestamp: '2026-03-22T15:00:00.000Z' })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getTimeToReply();

  assert.equal(result.count, 3);
  // Average: (1+3+5)/3 = 3 hours
  assert.equal(result.averageMs, 3 * HOUR_MS);
  assert.equal(result.averageHours, 3);
  // Median: middle value = 3 hours
  assert.equal(result.medianMs, 3 * HOUR_MS);
  assert.equal(result.medianHours, 3);
  assert.equal(result.minMs, 1 * HOUR_MS);
  assert.equal(result.maxMs, 5 * HOUR_MS);
});

test('median is correct for even-count dataset (average of two middle values)', () => {
  const events = [
    // 4 DM+reply pairs: 1h, 2h, 4h, 8h
    makeEvent('dm_sent', 'https://linkedin.com/in/a', { timestamp: '2026-03-22T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/a', { timestamp: '2026-03-22T11:00:00.000Z' }),
    makeEvent('dm_sent', 'https://linkedin.com/in/b', { timestamp: '2026-03-22T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/b', { timestamp: '2026-03-22T12:00:00.000Z' }),
    makeEvent('dm_sent', 'https://linkedin.com/in/c', { timestamp: '2026-03-22T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/c', { timestamp: '2026-03-22T14:00:00.000Z' }),
    makeEvent('dm_sent', 'https://linkedin.com/in/d', { timestamp: '2026-03-22T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/d', { timestamp: '2026-03-22T18:00:00.000Z' })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getTimeToReply();

  assert.equal(result.count, 4);
  // Median of [1h, 2h, 4h, 8h] = (2+4)/2 = 3 hours
  assert.equal(result.medianMs, 3 * HOUR_MS);
  assert.equal(result.medianHours, 3);
  // Average: (1+2+4+8)/4 = 3.75 hours
  assert.equal(result.averageHours, 3.8);  // rounded to 1 decimal
});

// ---------------------------------------------------------------------------
// 6. weeklyTrends buckets events into correct weeks
// ---------------------------------------------------------------------------

test('getWeeklyTrends buckets events into correct ISO weeks', () => {
  // 2026-03-16 is a Monday, 2026-03-23 is the next Monday
  const events = [
    makeEvent('profile_viewed', 'https://linkedin.com/in/a', { timestamp: '2026-03-16T10:00:00.000Z' }),
    makeEvent('profile_viewed', 'https://linkedin.com/in/b', { timestamp: '2026-03-18T10:00:00.000Z' }),
    makeEvent('dm_sent', 'https://linkedin.com/in/a', { timestamp: '2026-03-17T10:00:00.000Z' }),
    // Next week
    makeEvent('profile_viewed', 'https://linkedin.com/in/c', { timestamp: '2026-03-23T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/a', { timestamp: '2026-03-24T10:00:00.000Z' })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getWeeklyTrends();

  assert.equal(result.weeks.length, 2);

  // First week: March 16–22
  const week1 = result.weeks[0];
  assert.equal(week1.weekStart, '2026-03-16');
  assert.equal(week1.counts.profile_viewed, 2);
  assert.equal(week1.counts.dm_sent, 1);
  assert.equal(week1.counts.dm_reply_received, 0);

  // Second week: March 23–29
  const week2 = result.weeks[1];
  assert.equal(week2.weekStart, '2026-03-23');
  assert.equal(week2.counts.profile_viewed, 1);
  assert.equal(week2.counts.dm_reply_received, 1);
});

test('weeklyTrends handles Sunday events (belong to prior week per ISO-8601)', () => {
  // 2026-03-22 is a Sunday — belongs to the week starting 2026-03-16 (Monday)
  const events = [
    makeEvent('dm_sent', 'https://linkedin.com/in/a', { timestamp: '2026-03-22T23:59:00.000Z' })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getWeeklyTrends();

  assert.equal(result.weeks.length, 1);
  assert.equal(result.weeks[0].weekStart, '2026-03-16');
});

// ---------------------------------------------------------------------------
// 7. get_analytics response backward compatible with new fields
// ---------------------------------------------------------------------------

test('get_analytics response includes timing and trends alongside existing fields', () => {
  const events = [
    makeEvent('profile_viewed', 'https://linkedin.com/in/alice'),
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', { timestamp: '2026-03-22T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/alice', { timestamp: '2026-03-22T12:00:00.000Z' })
  ];

  const service = makeAnalyticsService(events);
  const filters = {};
  const response = {
    ...service.getOverview(filters),
    accountHealth: service.getAccountHealthBreakdown(filters),
    stepOutcomeBreakdown: service.getStepOutcomeBreakdown(filters),
    funnel: service.getFunnelAnalytics(filters),
    variantPerformance: service.getVariantPerformance(filters),
    timeToReply: service.getTimeToReply(filters),
    timeToAccept: service.getTimeToAccept(filters),
    weeklyTrends: service.getWeeklyTrends(filters)
  };

  // Existing fields preserved
  assert.ok(response.totals);
  assert.ok(response.rates);
  assert.ok(response.funnel);
  assert.ok(response.variantPerformance);

  // New fields present with expected shapes
  assert.ok(response.timeToReply);
  assert.equal(typeof response.timeToReply.count, 'number');
  assert.ok('averageMs' in response.timeToReply);
  assert.ok('medianMs' in response.timeToReply);
  assert.ok('averageHours' in response.timeToReply);

  assert.ok(response.timeToAccept);
  assert.equal(typeof response.timeToAccept.count, 'number');

  assert.ok(response.weeklyTrends);
  assert.ok(Array.isArray(response.weeklyTrends.weeks));
});

// ---------------------------------------------------------------------------
// 8. empty events produce clean zero/null results
// ---------------------------------------------------------------------------

test('getTimeToReply returns zero count and null stats with no events', () => {
  const service = makeAnalyticsService([]);
  const result = service.getTimeToReply();

  assert.equal(result.count, 0);
  assert.equal(result.averageMs, null);
  assert.equal(result.medianMs, null);
  assert.equal(result.minMs, null);
  assert.equal(result.maxMs, null);
  assert.equal(result.averageHours, null);
});

test('getTimeToAccept returns zero count and null stats with no events', () => {
  const service = makeAnalyticsService([]);
  const result = service.getTimeToAccept();
  assert.equal(result.count, 0);
  assert.equal(result.averageMs, null);
});

test('getWeeklyTrends returns empty weeks array with no events', () => {
  const service = makeAnalyticsService([]);
  const result = service.getWeeklyTrends();
  assert.equal(result.weeks.length, 0);
});

// ---------------------------------------------------------------------------
// 9. timeToReply uses most recent prior DM when multiple exist
// ---------------------------------------------------------------------------

test('getTimeToReply uses most recent prior dm_sent when prospect has multiple DMs', () => {
  const events = [
    // DM sent at 08:00, another at 11:00, reply at 12:00
    // Should use 11:00 → 12:00 = 1 hour, not 08:00 → 12:00 = 4 hours
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', { timestamp: '2026-03-22T08:00:00.000Z' }),
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', { timestamp: '2026-03-22T11:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/alice', { timestamp: '2026-03-22T12:00:00.000Z' })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getTimeToReply();

  assert.equal(result.count, 1);
  assert.equal(result.averageMs, 1 * HOUR_MS, 'should measure from 11:00, not 08:00');
  assert.equal(result.averageHours, 1);
});

// ---------------------------------------------------------------------------
// 10. weeklyTrends includes all tracked event types
// ---------------------------------------------------------------------------

test('getWeeklyTrends includes follow, unfollow, endorse, and comment event types', () => {
  const events = [
    makeEvent('profile_followed', 'https://linkedin.com/in/a', { timestamp: '2026-03-16T10:00:00.000Z' }),
    makeEvent('profile_unfollowed', 'https://linkedin.com/in/b', { timestamp: '2026-03-16T11:00:00.000Z' }),
    makeEvent('skill_endorsed', 'https://linkedin.com/in/c', { timestamp: '2026-03-16T12:00:00.000Z' }),
    makeEvent('post_commented', 'https://linkedin.com/in/d', { timestamp: '2026-03-16T13:00:00.000Z' })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getWeeklyTrends();

  assert.equal(result.weeks.length, 1);
  const counts = result.weeks[0].counts;
  assert.equal(counts.profile_followed, 1);
  assert.equal(counts.profile_unfollowed, 1);
  assert.equal(counts.skill_endorsed, 1);
  assert.equal(counts.post_commented, 1);
});
