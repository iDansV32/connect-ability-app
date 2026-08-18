'use strict';

/**
 * tests/mcp-sqlite-analytics.test.js
 *
 * Targeted tests for Ticket 6A — connect-mcp-server reads live SQLite state
 * for analytics and account health.
 *
 * Covers:
 *  1. get_analytics reads step breakdown from SQLite-backed ActivityAnalyticsService
 *  2. get_analytics days filter works with SQLite-backed events
 *  3. get_account_health reads from SQLite-backed LinkedInAccountHealthStore
 *  4. Fallback: when db is absent, JSON-backed stores still serve correct data
 *  5. Response shapes are backward-compatible regardless of backend
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

const { createServer } = require('../connect-mcp-server');
const ActivityEventStore          = require('../activity-event-store');
const ActivityAnalyticsService    = require('../activity-analytics');
const LinkedInAccountHealthStore  = require('../linkedin-account-health-store');
const SdrAgentManager             = require('../sdr-agent-manager');
const WorkflowTemplateStore       = require('../workflow-template-store');
const WorkflowRunManager          = require('../workflow-run-manager');
const ProspectQueueStore          = require('../prospect-queue-store');
const GroupDataStore              = require('../group-data-store');
const ScheduledPostStore          = require('../scheduled-post-store');
const LinkedInReplyMonitor        = require('../linkedin-reply-monitor');
const RuntimeLogStore             = require('../runtime-log-store');
const AgentPersonaStore           = require('../agent-persona-store');
const DailyReportService          = require('../daily-report-service');
const ReportScheduleStore         = require('../report-schedule-store');
const ApolloSyncStore             = require('../apollo-sync-store');
const ApolloSyncService           = require('../apollo-sync-service');
const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const { createTempWorkspace, writeJson, writeJsonLines } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Build a complete stores object wired to a SQLite db + workspace paths. */
function buildSqliteStores(workspace, db) {
  const analytics = new ActivityAnalyticsService({
    eventsPath:         workspace.path('events.jsonl'),
    profilesPath:       workspace.path('profiles.json'),
    accountHealthPath:  workspace.path('health.json'),
    transportHealthPath: workspace.path('transport-health.json'),
    runtimeLogsPath:    workspace.path('logs.jsonl'),
    sessionRegistryPath: workspace.path('session-registry.json'),
    linkedInAccountsPath: workspace.path('linkedin-accounts.json'),
    db
  });
  const prospects  = new ProspectQueueStore({ storePath: workspace.path('prospects.json') });
  const templates  = new WorkflowTemplateStore({
    storePath: workspace.path('templates.json'),
    legacyWorkflowsDir: workspace.path('legacy-workflows')
  });
  const groups     = new GroupDataStore({ paths: [workspace.path('groups.json')] });
  const apolloSync = new ApolloSyncStore({ storePath: workspace.path('apollo-sync.json') });
  return {
    agents:        new SdrAgentManager({ storePath: workspace.path('agents.json') }),
    templates,
    runs:          new WorkflowRunManager({
      runsPath: workspace.path('runs.json'),
      jobsPath: workspace.path('jobs.json')
    }),
    prospects,
    groups,
    posts:         new ScheduledPostStore({ storePath: workspace.path('posts.json') }),
    analytics,
    monitor:       new LinkedInReplyMonitor({ statePath: workspace.path('monitor.json') }),
    health:        new LinkedInAccountHealthStore({ storePath: workspace.path('health.json'), db }),
    logs:          new RuntimeLogStore({ logsPath: workspace.path('logs.jsonl') }),
    personas:      new AgentPersonaStore({ personasDir: workspace.path('personas') }),
    schedules:     new ReportScheduleStore({ storePath: workspace.path('schedules.json') }),
    reportService: new DailyReportService({ analytics, prospects }),
    apolloSync,
    apollo:        new ApolloSyncService({
      syncStore: apolloSync,
      prospects,
      templates,
      groups,
      clientFactory: () => ({ apiRequest: async () => ({}) })
    })
  };
}

/** Build stores using JSON files only (no db). */
function buildJsonStores(workspace) {
  const analytics = new ActivityAnalyticsService({
    eventsPath:         workspace.path('events.jsonl'),
    profilesPath:       workspace.path('profiles.json'),
    accountHealthPath:  workspace.path('health.json'),
    transportHealthPath: workspace.path('transport-health.json'),
    runtimeLogsPath:    workspace.path('logs.jsonl'),
    sessionRegistryPath: workspace.path('session-registry.json'),
    linkedInAccountsPath: workspace.path('linkedin-accounts.json')
  });
  const prospects  = new ProspectQueueStore({ storePath: workspace.path('prospects.json') });
  const templates  = new WorkflowTemplateStore({
    storePath: workspace.path('templates.json'),
    legacyWorkflowsDir: workspace.path('legacy-workflows')
  });
  const groups     = new GroupDataStore({ paths: [workspace.path('groups.json')] });
  const apolloSync = new ApolloSyncStore({ storePath: workspace.path('apollo-sync.json') });
  return {
    agents:        new SdrAgentManager({ storePath: workspace.path('agents.json') }),
    templates,
    runs:          new WorkflowRunManager({
      runsPath: workspace.path('runs.json'),
      jobsPath: workspace.path('jobs.json')
    }),
    prospects,
    groups,
    posts:         new ScheduledPostStore({ storePath: workspace.path('posts.json') }),
    analytics,
    monitor:       new LinkedInReplyMonitor({ statePath: workspace.path('monitor.json') }),
    health:        new LinkedInAccountHealthStore({ storePath: workspace.path('health.json') }),
    logs:          new RuntimeLogStore({ logsPath: workspace.path('logs.jsonl') }),
    personas:      new AgentPersonaStore({ personasDir: workspace.path('personas') }),
    schedules:     new ReportScheduleStore({ storePath: workspace.path('schedules.json') }),
    reportService: new DailyReportService({ analytics, prospects }),
    apolloSync,
    apollo:        new ApolloSyncService({
      syncStore: apolloSync,
      prospects,
      templates,
      groups,
      clientFactory: () => ({ apiRequest: async () => ({}) })
    })
  };
}

function makeRequest(handler, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = new PassThrough();
    req.method = method;
    req.url = urlPath;
    req.headers = {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
      ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      ...headers
    };
    let statusCode = 200;
    const res = {
      writeHead(code) { statusCode = code; return this; },
      end(chunk = '') {
        try {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
          resolve({ status: statusCode, body: text ? JSON.parse(text) : null });
        } catch (err) { reject(err); }
      }
    };
    Promise.resolve(handler(req, res)).catch(reject);
    process.nextTick(() => { if (payload) req.write(payload); req.end(); });
  });
}

async function withServer(stores, fn) {
  const server = createServer({ stores, createScheduledPostSyncSession: async () => null });
  const handler = server.createHttpHandler('test-token');
  await fn(handler);
}

function post(handler, urlPath, body) {
  return makeRequest(handler, 'POST', urlPath, body);
}

// ---------------------------------------------------------------------------
// 1. get_analytics reads from SQLite
// ---------------------------------------------------------------------------

describe('1 — get_analytics reads step breakdown from SQLite', () => {

  test('step outcomes written via ActivityEventStore are visible via get_analytics', async () => {
    const db = openDatabase(':memory:');
    const ws = createTempWorkspace('mcp-sqlite-analytics-');
    try {
      const eventStore = new ActivityEventStore({ db });

      eventStore.append({
        type: 'workflow_step_completed',
        accountId: 'acc-1', agentId: 'agent-1',
        status: 'ok',
        metadata: { stepType: 'send_dm', outcomeType: 'dm_sent' }
      });
      eventStore.append({
        type: 'workflow_step_completed',
        accountId: 'acc-1', agentId: 'agent-1',
        status: 'skipped',
        metadata: { stepType: 'send_dm', outcomeType: 'skipped_quota_exceeded' }
      });
      eventStore.append({
        type: 'workflow_step_failed',
        accountId: 'acc-1', agentId: 'agent-1',
        status: 'failed',
        metadata: { stepType: 'view_profile', outcomeType: 'failed_transient' }
      });

      await withServer(buildSqliteStores(ws, db), async (handler) => {
        const { status, body } = await post(handler, '/api/call', {
          function: 'get_analytics',
          args: [{}]
        });

        assert.equal(status, 200);
        assert.equal(body.ok, true);
        const sob = body.result.stepOutcomeBreakdown;
        assert.equal(sob.totals.total,     3);
        assert.equal(sob.totals.completed, 1);
        assert.equal(sob.totals.skipped,   1);
        assert.equal(sob.totals.failed,    1);

        const dmStep = sob.byStepType.find((s) => s.stepType === 'send_dm');
        assert.ok(dmStep, 'send_dm step must appear');
        assert.equal(dmStep.total, 2);
      });
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

  test('JSONL file is not read when db is present (no JSONL file written)', async () => {
    const db = openDatabase(':memory:');
    const ws = createTempWorkspace('mcp-sqlite-no-jsonl-');
    try {
      // Write event only to SQLite — no JSONL file exists
      const eventStore = new ActivityEventStore({ db });
      eventStore.append({
        type: 'dm_sent',
        accountId: 'acc-x',
        status: 'ok',
        metadata: {}
      });

      await withServer(buildSqliteStores(ws, db), async (handler) => {
        const { body } = await post(handler, '/api/call', {
          function: 'get_analytics',
          args: [{}]
        });
        assert.equal(body.ok, true);
        // Overview totals — dm_sent event must be counted
        assert.equal(body.result.totals.dmsSent, 1,
          'dm_sent event from SQLite must appear in analytics totals');
      });
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 2. get_analytics days filter with SQLite
// ---------------------------------------------------------------------------

describe('2 — get_analytics days filter works with SQLite-backed events', () => {

  test('days filter excludes old events, includes recent ones', async () => {
    const db = openDatabase(':memory:');
    const ws = createTempWorkspace('mcp-sqlite-days-');
    try {
      const store = new ActivityEventStore({ db });
      const recentTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();  // 1 hour ago
      const oldTs    = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago

      store.append({
        type: 'workflow_step_completed', accountId: 'acc-1',
        status: 'ok', metadata: { stepType: 'view_profile', outcomeType: 'completed' }
      });
      // Manually set timestamps using direct DB insert via a second store
      const row = db.prepare('SELECT id FROM activity_events ORDER BY rowid DESC LIMIT 1').get();
      db.prepare("UPDATE activity_events SET event_timestamp = ? WHERE id = ?")
        .run(recentTs, row.id);

      store.append({
        type: 'workflow_step_completed', accountId: 'acc-1',
        status: 'skipped', metadata: { stepType: 'view_profile', outcomeType: 'skipped_quota_exceeded' }
      });
      const row2 = db.prepare('SELECT id FROM activity_events ORDER BY rowid DESC LIMIT 1').get();
      db.prepare("UPDATE activity_events SET event_timestamp = ? WHERE id = ?")
        .run(oldTs, row2.id);

      await withServer(buildSqliteStores(ws, db), async (handler) => {
        const { body } = await post(handler, '/api/call', {
          function: 'get_analytics',
          args: [{ days: 1 }]
        });
        assert.equal(body.ok, true);
        // Only the recent event should be in the breakdown
        const sob = body.result.stepOutcomeBreakdown;
        assert.equal(sob.totals.total, 1, 'only 1 event within last 1 day');
        assert.equal(sob.totals.completed, 1);
        assert.equal(typeof sob.filters.since, 'string');
        assert.equal(typeof sob.filters.until, 'string');
      });
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 3. get_account_health reads from SQLite
// ---------------------------------------------------------------------------

describe('3 — get_account_health reads from SQLite-backed store', () => {

  test('health state written via LinkedInAccountHealthStore is returned by get_account_health', async () => {
    const db = openDatabase(':memory:');
    const ws = createTempWorkspace('mcp-sqlite-health-');
    try {
      // Write health state directly via the store (uses SQLite because db is injected)
      const healthStore = new LinkedInAccountHealthStore({ db });
      healthStore.recordSuccess('acc-health-1', 'workflow', {
        timestamp: '2026-03-31T08:00:00.000Z'
      });
      healthStore.recordChallenge('acc-health-1', 'captcha', null, {
        timestamp: '2026-03-31T09:00:00.000Z'
      });

      await withServer(buildSqliteStores(ws, db), async (handler) => {
        const { status, body } = await post(handler, '/api/call', {
          function: 'get_account_health',
          args: [{}]
        });

        assert.equal(status, 200);
        assert.equal(body.ok, true);
        const accountState = body.result['acc-health-1'];
        assert.ok(accountState, 'account must be present');
        assert.equal(accountState.workflow.status, 'healthy');
        assert.ok(accountState.challenged, 'challenge state must be present');
        assert.equal(accountState.challenged.type, 'captcha');
      });
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

  test('cooldown state is visible via get_account_health through SQLite', async () => {
    const db = openDatabase(':memory:');
    const ws = createTempWorkspace('mcp-sqlite-cooldown-');
    try {
      const healthStore = new LinkedInAccountHealthStore({ db });

      // 3 failures → cooldown
      healthStore.recordFailure('acc-cd', 'workflow', 'Rate limit hit');
      healthStore.recordFailure('acc-cd', 'workflow', 'Rate limit hit');
      healthStore.recordFailure('acc-cd', 'workflow', 'Rate limit hit');

      await withServer(buildSqliteStores(ws, db), async (handler) => {
        const { body } = await post(handler, '/api/call', {
          function: 'get_account_health',
          args: [{}]
        });
        assert.equal(body.ok, true);
        const accountState = body.result['acc-cd'];
        assert.ok(accountState);
        // With 3 transient failures the workflow subsystem should be in cooldown
        assert.equal(accountState.workflow.status, 'cooldown');
        assert.ok(accountState.workflow.cooldownUntil);
      });
    } finally {
      closeDatabase(db);
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 4. Fallback: JSON-backed stores still work when db is absent
// ---------------------------------------------------------------------------

describe('4 — fallback: JSON stores serve correct data when db is absent', () => {

  test('get_analytics with JSON-backed stores returns correct step breakdown', async () => {
    const ws = createTempWorkspace('mcp-json-fallback-analytics-');
    try {
      writeJsonLines(ws.path('events.jsonl'), [
        {
          id: 'fallback-e1', type: 'workflow_step_completed',
          timestamp: new Date().toISOString(),
          accountId: 'acc-j', agentId: 'agent-j',
          status: 'ok', metadata: { stepType: 'send_dm', outcomeType: 'dm_sent' }
        }
      ]);

      await withServer(buildJsonStores(ws), async (handler) => {
        const { body } = await post(handler, '/api/call', {
          function: 'get_analytics',
          args: [{}]
        });
        assert.equal(body.ok, true);
        assert.equal(body.result.stepOutcomeBreakdown.totals.total, 1);
        assert.equal(body.result.stepOutcomeBreakdown.totals.completed, 1);
      });
    } finally {
      ws.cleanup();
    }
  });

  test('get_account_health with JSON-backed store returns correct health state', async () => {
    const ws = createTempWorkspace('mcp-json-fallback-health-');
    try {
      const now = new Date().toISOString();
      writeJson(ws.path('health.json'), {
        version: 2,
        accounts: {
          'acc-json': {
            workflow: {
              status: 'healthy', lastSuccessAt: now, lastErrorAt: null,
              lastError: null, consecutiveFailures: 0, cooldownUntil: null,
              cooldownReason: null, lastUpdatedAt: now
            },
            replyMonitor: {
              status: 'healthy', lastSuccessAt: null, lastErrorAt: null,
              lastError: null, consecutiveFailures: 0, cooldownUntil: null,
              cooldownReason: null, lastUpdatedAt: now
            },
            challenged: null, updatedAt: now
          }
        }
      });

      await withServer(buildJsonStores(ws), async (handler) => {
        const { body } = await post(handler, '/api/call', {
          function: 'get_account_health',
          args: [{}]
        });
        assert.equal(body.ok, true);
        assert.ok(body.result['acc-json'], 'account must be present');
        assert.equal(body.result['acc-json'].workflow.status, 'healthy');
      });
    } finally {
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 5. Response shape backward-compatibility
// ---------------------------------------------------------------------------

describe('5 — response shapes are backward-compatible', () => {

  test('get_analytics SQLite response has same top-level keys as JSON response', async () => {
    const db   = openDatabase(':memory:');
    const wsDb = createTempWorkspace('mcp-shape-sqlite-');
    const wsJs = createTempWorkspace('mcp-shape-json-');
    try {
      // SQLite path — empty DB
      let sqliteResult;
      await withServer(buildSqliteStores(wsDb, db), async (handler) => {
        const { body } = await post(handler, '/api/call', {
          function: 'get_analytics', args: [{}]
        });
        sqliteResult = body.result;
      });

      // JSON path — empty workspace
      let jsonResult;
      await withServer(buildJsonStores(wsJs), async (handler) => {
        const { body } = await post(handler, '/api/call', {
          function: 'get_analytics', args: [{}]
        });
        jsonResult = body.result;
      });

      // Both must have the same top-level keys
      const sqliteKeys = Object.keys(sqliteResult).sort();
      const jsonKeys   = Object.keys(jsonResult).sort();
      assert.deepEqual(sqliteKeys, jsonKeys,
        `SQLite keys: ${sqliteKeys}, JSON keys: ${jsonKeys}`);

      // stepOutcomeBreakdown shape must match
      assert.ok('totals' in sqliteResult.stepOutcomeBreakdown);
      assert.ok('byStepType' in sqliteResult.stepOutcomeBreakdown);
      assert.ok('filters' in sqliteResult.stepOutcomeBreakdown);
    } finally {
      closeDatabase(db);
      wsDb.cleanup();
      wsJs.cleanup();
    }
  });

});
