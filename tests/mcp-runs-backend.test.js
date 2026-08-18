'use strict';

/**
 * tests/mcp-runs-backend.test.js
 *
 * Regression tests that pin the MCP server's workflow-runs backend behavior:
 *
 *  1. When SQLite is available, run_linkedin_action lands the new run in
 *     SQLite and never creates workflow-runs.json. (Closes the split-backend
 *     bug where MCP was defaulting to JsonWorkflowRepository while the
 *     Electron scheduler was reading SQLite.)
 *  2. authorizeToolCall refuses run_linkedin_action and the workflow read
 *     tools with code='backend_unavailable' when policy.sqliteAvailable is
 *     false.
 *  3. tools/list / /api/schema / /api/functions filtering excludes
 *     PLATFORM_WRITE_TOOL_NAMES and CANONICAL_BACKEND_TOOL_NAMES when
 *     sqliteAvailable is false.
 *  4. The defensive requireRunsBackend handler guard fires when
 *     stores.sqliteAvailable is false (covers direct handler calls that
 *     bypass authorizeToolCall).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { PassThrough } = require('stream');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const SqliteWorkflowRepository = require('../storage/sqlite-workflow-repository');
const WorkflowRunManager = require('../workflow-run-manager');
const ProspectQueueStore = require('../prospect-queue-store');
const ActivityEventStore = require('../activity-event-store');
const ActivityAnalyticsService = require('../activity-analytics');
const SdrAgentManager = require('../sdr-agent-manager');
const WorkflowTemplateStore = require('../workflow-template-store');
const GroupDataStore = require('../group-data-store');
const ScheduledPostStore = require('../scheduled-post-store');
const LinkedInReplyMonitor = require('../linkedin-reply-monitor');
const LinkedInAccountHealthStore = require('../linkedin-account-health-store');
const RuntimeLogStore = require('../runtime-log-store');
const AgentPersonaStore = require('../agent-persona-store');
const ReportScheduleStore = require('../report-schedule-store');
const ApolloSyncStore = require('../apollo-sync-store');
const ApolloSyncService = require('../apollo-sync-service');
const DailyReportService = require('../daily-report-service');

const {
  createServer,
  TOOL_DEFS,
  _private: {
    authorizeToolCall,
    resolvePlatformWritePolicy,
    filterToolDefsByPolicy,
    filterToolNamesByPolicy,
    requireRunsBackend,
    requirePostsBackend,
    CANONICAL_BACKEND_TOOL_NAMES,
    POSTS_BACKEND_TOOL_NAMES,
    PLATFORM_WRITE_TOOL_NAMES
  }
} = require('../connect-mcp-server');

const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStoresWithSqlite(workspace, db) {
  // Workflow repo is the canonical SQLite-backed repo. We still pass workspace
  // paths so the WorkflowRunManager records what it *would* have written —
  // those files should never appear when SQLite is in play.
  const runs = new WorkflowRunManager({
    repo: new SqliteWorkflowRepository(db),
    runsPath: workspace.path('workflow-runs.json'),
    jobsPath: workspace.path('workflow-step-jobs.json')
  });

  const events = new ActivityEventStore({ eventsPath: workspace.path('events.jsonl') });
  const analytics = new ActivityAnalyticsService({
    eventsPath: workspace.path('events.jsonl'),
    profilesPath: workspace.path('profiles.json'),
    accountHealthPath: workspace.path('health.json'),
    transportHealthPath: workspace.path('transport-health.json'),
    runtimeLogsPath: workspace.path('logs.jsonl'),
    sessionRegistryPath: workspace.path('session-registry.json'),
    linkedInAccountsPath: workspace.path('linkedin-accounts.json')
  });
  const prospects = new ProspectQueueStore({ storePath: workspace.path('prospects.json') });
  const templates = new WorkflowTemplateStore({ storePath: workspace.path('templates.json') });
  const apolloSync = new ApolloSyncStore({ storePath: workspace.path('apollo-sync.json') });

  return {
    agents:        new SdrAgentManager({ storePath: workspace.path('agents.json') }),
    templates,
    runs,
    sqliteAvailable: true,
    prospects,
    groups:        new GroupDataStore({ paths: [workspace.path('groups.json')] }),
    posts:         new ScheduledPostStore({ storePath: workspace.path('posts.json') }),
    events,
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
      groups: new GroupDataStore({ paths: [workspace.path('groups.json')] })
    })
  };
}

function buildStoresWithoutSqlite(workspace) {
  // sqliteAvailable=false; runs is null. This mirrors the production state when
  // better-sqlite3 fails to open the canonical DB. The gate should refuse
  // run_linkedin_action and the workflow read tools.
  const events = new ActivityEventStore({ eventsPath: workspace.path('events.jsonl') });
  const analytics = new ActivityAnalyticsService({
    eventsPath: workspace.path('events.jsonl'),
    profilesPath: workspace.path('profiles.json'),
    accountHealthPath: workspace.path('health.json'),
    transportHealthPath: workspace.path('transport-health.json'),
    runtimeLogsPath: workspace.path('logs.jsonl'),
    sessionRegistryPath: workspace.path('session-registry.json'),
    linkedInAccountsPath: workspace.path('linkedin-accounts.json')
  });
  const prospects = new ProspectQueueStore({ storePath: workspace.path('prospects.json') });
  const templates = new WorkflowTemplateStore({ storePath: workspace.path('templates.json') });
  const apolloSync = new ApolloSyncStore({ storePath: workspace.path('apollo-sync.json') });

  return {
    agents:        new SdrAgentManager({ storePath: workspace.path('agents.json') }),
    templates,
    runs:          null,
    sqliteAvailable: false,
    prospects,
    groups:        new GroupDataStore({ paths: [workspace.path('groups.json')] }),
    posts:         new ScheduledPostStore({ storePath: workspace.path('posts.json') }),
    events,
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
      groups: new GroupDataStore({ paths: [workspace.path('groups.json')] })
    })
  };
}

// ---------------------------------------------------------------------------
// 1. run_linkedin_action writes to SQLite, never to workflow-runs.json
// ---------------------------------------------------------------------------

test('run_linkedin_action with SQLite available lands the run in SQLite, not JSON', () => {
  const workspace = createTempWorkspace('mcp-runs-sqlite-');
  const db = openDatabase(':memory:');
  try {
    const stores = buildStoresWithSqlite(workspace, db);
    const server = createServer({ stores });

    const result = server.toolHandlers.run_linkedin_action({
      profileUrl: 'https://www.linkedin.com/in/sqlite-target/',
      accountId: 'acc-sqlite',
      actionType: 'view_profile'
    });

    assert.equal(result.ok, true);
    assert.ok(result.runId, 'expected runId in result');

    // The run must exist in the SQLite workflow_runs table.
    const row = db.prepare('SELECT id, run_status FROM workflow_runs WHERE id = ?').get(result.runId);
    assert.ok(row, `expected workflow_runs row for ${result.runId}, got none`);
    assert.equal(row.id, result.runId);

    // And the JSON repository paths must NEVER have been touched. If they had,
    // the JsonWorkflowRepository's atomic-rename would have created these
    // files. Their absence proves the SQLite repo handled the write.
    assert.equal(
      fs.existsSync(workspace.path('workflow-runs.json')),
      false,
      'workflow-runs.json should not exist when SQLite is the backend'
    );
    assert.equal(
      fs.existsSync(workspace.path('workflow-step-jobs.json')),
      false,
      'workflow-step-jobs.json should not exist when SQLite is the backend'
    );
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. authorizeToolCall refuses backend-dependent tools when SQLite is down
// ---------------------------------------------------------------------------

test('authorizeToolCall refuses run_linkedin_action when sqliteAvailable is false', () => {
  const workspace = createTempWorkspace('mcp-runs-gate-');
  try {
    const policy = resolvePlatformWritePolicy({
      auditLogPath: workspace.path('audit.jsonl'),
      sqliteAvailable: false,
      // Stdio-style: allow platform writes by policy so we know the refusal
      // is coming from the canonical-backend gate, not the platform-write gate.
      allowStdioPlatformWrites: true
    });

    assert.throws(
      () => authorizeToolCall('run_linkedin_action', {
        profileUrl: 'x',
        accountId: 'y',
        actionType: 'view_profile'
      }, policy, { transport: 'stdio' }),
      (err) => err && err.code === 'backend_unavailable' && err.statusCode === 503
    );
  } finally {
    workspace.cleanup();
  }
});

test('authorizeToolCall refuses list_workflow_runs when sqliteAvailable is false', () => {
  const workspace = createTempWorkspace('mcp-runs-gate-read-');
  try {
    const policy = resolvePlatformWritePolicy({
      auditLogPath: workspace.path('audit.jsonl'),
      sqliteAvailable: false,
      allowStdioPlatformWrites: true
    });

    assert.throws(
      () => authorizeToolCall('list_workflow_runs', {}, policy, { transport: 'stdio' }),
      (err) => err && err.code === 'backend_unavailable' && err.statusCode === 503
    );
  } finally {
    workspace.cleanup();
  }
});

test('authorizeToolCall refuses all PLATFORM_WRITE_TOOL_NAMES when sqliteAvailable is false', () => {
  const workspace = createTempWorkspace('mcp-runs-gate-writes-');
  try {
    const policy = resolvePlatformWritePolicy({
      auditLogPath: workspace.path('audit.jsonl'),
      sqliteAvailable: false,
      allowStdioPlatformWrites: true
    });

    // Pick a platform-write tool that is NOT in the canonical-backend set,
    // so we know the refusal is coming from the platform-write SQLite gate.
    const sample = 'call_apollo_api';
    assert.equal(PLATFORM_WRITE_TOOL_NAMES.has(sample), true);
    assert.equal(CANONICAL_BACKEND_TOOL_NAMES.has(sample), false);

    assert.throws(
      () => authorizeToolCall(sample, { method: 'GET', path: '/api/v1/health' }, policy, { transport: 'stdio' }),
      (err) => err && err.code === 'backend_unavailable' && err.statusCode === 503
    );
  } finally {
    workspace.cleanup();
  }
});

test('authorizeToolCall permits read-only non-runs tools even when sqliteAvailable is false', () => {
  const workspace = createTempWorkspace('mcp-runs-gate-readonly-');
  try {
    const policy = resolvePlatformWritePolicy({
      auditLogPath: workspace.path('audit.jsonl'),
      sqliteAvailable: false,
      allowStdioPlatformWrites: true
    });

    // list_agents is a plain read tool with no canonical backend dependency.
    // It should remain callable while the backend is degraded.
    assert.doesNotThrow(() => {
      authorizeToolCall('list_agents', {}, policy, { transport: 'stdio' });
    });
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. tools/list filtering hides gated tools when SQLite is down
// ---------------------------------------------------------------------------

test('filterToolDefsByPolicy hides PLATFORM_WRITE + CANONICAL_BACKEND tools when SQLite is down', () => {
  const filtered = filterToolDefsByPolicy(TOOL_DEFS, { sqliteAvailable: false });
  const filteredNames = new Set(filtered.map((def) => def.name));

  for (const name of PLATFORM_WRITE_TOOL_NAMES) {
    assert.equal(filteredNames.has(name), false, `tools/list should hide platform-write tool ${name}`);
  }
  for (const name of CANONICAL_BACKEND_TOOL_NAMES) {
    assert.equal(filteredNames.has(name), false, `tools/list should hide canonical-backend tool ${name}`);
  }

  // Read-only tools should remain visible.
  assert.equal(filteredNames.has('list_agents'), true);
  assert.equal(filteredNames.has('get_analytics'), true);
});

test('filterToolDefsByPolicy is a no-op when SQLite is available', () => {
  const filtered = filterToolDefsByPolicy(TOOL_DEFS, { sqliteAvailable: true });
  assert.equal(filtered.length, TOOL_DEFS.length);
});

test('filterToolNamesByPolicy hides gated tool names when SQLite is down', () => {
  const allNames = TOOL_DEFS.map((def) => def.name);
  const filtered = filterToolNamesByPolicy(allNames, { sqliteAvailable: false });
  const filteredSet = new Set(filtered);

  assert.equal(filteredSet.has('run_linkedin_action'), false);
  assert.equal(filteredSet.has('list_workflow_runs'), false);
  assert.equal(filteredSet.has('call_apollo_api'), false);
  assert.equal(filteredSet.has('list_agents'), true);
});

// ---------------------------------------------------------------------------
// 3b. HTTP surface: /api/schema and /api/functions hide gated tools
// ---------------------------------------------------------------------------

function httpRequest(handler, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.method = method;
    req.url = urlPath;
    req.headers = headers;

    let statusCode = 200;
    const res = {
      writeHead(code) {
        statusCode = code;
        return this;
      },
      end(chunk = '') {
        try {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
          resolve({ status: statusCode, body: text ? JSON.parse(text) : null });
        } catch (err) {
          reject(new Error(`Non-JSON response: ${err.message}`));
        }
      }
    };

    Promise.resolve(handler(req, res)).catch(reject);
    process.nextTick(() => req.end());
  });
}

test('GET /api/schema hides backend-dependent tools when SQLite is unavailable', async () => {
  const workspace = createTempWorkspace('mcp-runs-http-schema-');
  try {
    const stores = buildStoresWithoutSqlite(workspace);
    const server = createServer({ stores });
    const handler = server.createHttpHandler('test-token', {
      platformWriteToken: 'test-platform-write',
      auditLogPath: workspace.path('audit.jsonl')
    });

    const response = await httpRequest(handler, 'GET', '/api/schema', {
      authorization: 'Bearer test-token'
    });

    assert.equal(response.status, 200);
    const operations = response.body.operations || [];
    const operationNames = new Set(operations.map((op) => op.function));

    // The bug we are pinning: this exact tool must not appear when the
    // canonical backend is unavailable.
    assert.equal(
      operationNames.has('run_linkedin_action'),
      false,
      'run_linkedin_action must be hidden from /api/schema when SQLite is unavailable'
    );
    assert.equal(operationNames.has('list_workflow_runs'), false);
    assert.equal(operationNames.has('call_apollo_api'), false);

    // Read-only non-backend tools should still appear.
    assert.equal(operationNames.has('list_agents'), true);
    assert.equal(operationNames.has('get_analytics'), true);
  } finally {
    workspace.cleanup();
  }
});

test('GET /api/functions hides backend-dependent tool names when SQLite is unavailable', async () => {
  const workspace = createTempWorkspace('mcp-runs-http-functions-');
  try {
    const stores = buildStoresWithoutSqlite(workspace);
    const server = createServer({ stores });
    const handler = server.createHttpHandler('test-token', {
      platformWriteToken: 'test-platform-write',
      auditLogPath: workspace.path('audit.jsonl')
    });

    const response = await httpRequest(handler, 'GET', '/api/functions', {
      authorization: 'Bearer test-token'
    });

    assert.equal(response.status, 200);
    const functions = new Set(response.body.functions || []);

    assert.equal(functions.has('run_linkedin_action'), false);
    assert.equal(functions.has('list_workflow_runs'), false);
    assert.equal(functions.has('call_apollo_api'), false);
    assert.equal(functions.has('list_agents'), true);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Defensive handler guard fires when stores.sqliteAvailable is false
// ---------------------------------------------------------------------------

test('run_linkedin_action handler refuses when stores.sqliteAvailable is false', () => {
  const workspace = createTempWorkspace('mcp-runs-handler-guard-');
  try {
    const stores = buildStoresWithoutSqlite(workspace);
    const server = createServer({ stores });

    assert.throws(
      () => server.toolHandlers.run_linkedin_action({
        profileUrl: 'https://www.linkedin.com/in/anyone/',
        accountId: 'acc-x',
        actionType: 'view_profile'
      }),
      (err) => err && err.code === 'backend_unavailable'
    );

    // And no JSON workflow file should have been created either.
    assert.equal(fs.existsSync(workspace.path('workflow-runs.json')), false);
  } finally {
    workspace.cleanup();
  }
});

test('list_workflow_runs handler refuses when stores.sqliteAvailable is false', () => {
  const workspace = createTempWorkspace('mcp-runs-handler-read-guard-');
  try {
    const stores = buildStoresWithoutSqlite(workspace);
    const server = createServer({ stores });

    assert.throws(
      () => server.toolHandlers.list_workflow_runs({}),
      (err) => err && err.code === 'backend_unavailable'
    );
  } finally {
    workspace.cleanup();
  }
});

test('requireRunsBackend throws backend_unavailable on null stores.runs', () => {
  assert.throws(
    () => requireRunsBackend({ sqliteAvailable: false, runs: null }, 'run_linkedin_action'),
    (err) => err && err.code === 'backend_unavailable'
  );
  assert.throws(
    () => requireRunsBackend({ sqliteAvailable: true, runs: null }, 'run_linkedin_action'),
    (err) => err && err.code === 'backend_unavailable'
  );
  // Does not throw when both are healthy.
  assert.doesNotThrow(() => {
    requireRunsBackend({ sqliteAvailable: true, runs: {} }, 'run_linkedin_action');
  });
});

// ---------------------------------------------------------------------------
// Scheduled-post mixed-repo gate
//
// Mirrors the workflow-repo gate but for the scheduled-post repo. The
// failure mode this guards against: SQLite is up and workflowRepo bound
// successfully, but scheduledPostRepo failed to bind. Without these gates,
// save_scheduled_posts would silently fall back to JSON while everything
// else writes to SQLite — exactly the split-backend bug we fixed for runs.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// postsAvailable discovery gate — hides list_scheduled_posts in partial-bind
// state to match the handler-level requirePostsBackend refusal.
// ---------------------------------------------------------------------------

test('filterToolDefsByPolicy hides POSTS_BACKEND_TOOL_NAMES when postsAvailable is false', () => {
  const filtered = filterToolDefsByPolicy(TOOL_DEFS, {
    sqliteAvailable: true,
    postsAvailable: false
  });
  const filteredNames = new Set(filtered.map((def) => def.name));

  for (const name of POSTS_BACKEND_TOOL_NAMES) {
    assert.equal(filteredNames.has(name), false, `tools/list should hide posts-backend tool ${name}`);
  }
  // Workflow tools should still appear — they depend on sqliteAvailable,
  // not postsAvailable. The two gates are independent.
  assert.equal(filteredNames.has('list_workflow_runs'), true);
  assert.equal(filteredNames.has('run_linkedin_action'), true);
});

test('filterToolNamesByPolicy hides posts-backend tool names when postsAvailable is false', () => {
  const allNames = TOOL_DEFS.map((def) => def.name);
  const filtered = filterToolNamesByPolicy(allNames, {
    sqliteAvailable: true,
    postsAvailable: false
  });
  const filteredSet = new Set(filtered);

  assert.equal(filteredSet.has('list_scheduled_posts'), false);
  assert.equal(filteredSet.has('list_workflow_runs'), true);
});

test('filterToolDefsByPolicy is a no-op when both backends are available', () => {
  // The original sqliteAvailable=true path keeps working unchanged.
  const filtered = filterToolDefsByPolicy(TOOL_DEFS, {
    sqliteAvailable: true,
    postsAvailable: true
  });
  assert.equal(filtered.length, TOOL_DEFS.length);
});

test('authorizeToolCall refuses list_scheduled_posts when postsAvailable is false', () => {
  const workspace = createTempWorkspace('mcp-posts-discovery-gate-');
  try {
    const policy = resolvePlatformWritePolicy({
      auditLogPath: workspace.path('audit.jsonl'),
      // sqliteAvailable true — only posts backend is down. The gate must
      // still fire so discovery and execution agree.
      sqliteAvailable: true,
      postsAvailable: false,
      allowStdioPlatformWrites: true
    });

    assert.throws(
      () => authorizeToolCall('list_scheduled_posts', {}, policy, { transport: 'stdio' }),
      (err) => err && err.code === 'backend_unavailable' && err.statusCode === 503
    );
  } finally {
    workspace.cleanup();
  }
});

test('authorizeToolCall permits list_scheduled_posts when postsAvailable is true', () => {
  const workspace = createTempWorkspace('mcp-posts-discovery-permit-');
  try {
    const policy = resolvePlatformWritePolicy({
      auditLogPath: workspace.path('audit.jsonl'),
      sqliteAvailable: true,
      postsAvailable: true,
      allowStdioPlatformWrites: true
    });

    assert.doesNotThrow(() => {
      authorizeToolCall('list_scheduled_posts', {}, policy, { transport: 'stdio' });
    });
  } finally {
    workspace.cleanup();
  }
});

test('postsAvailable defaults true when option is not passed (backward compat)', () => {
  const workspace = createTempWorkspace('mcp-posts-default-');
  try {
    const policy = resolvePlatformWritePolicy({
      auditLogPath: workspace.path('audit.jsonl')
      // No sqliteAvailable or postsAvailable — both should default true
      // so legacy callers (older tests, integrations) get the pre-slice
      // behavior.
    });
    assert.equal(policy.sqliteAvailable, true);
    assert.equal(policy.postsAvailable, true);
  } finally {
    workspace.cleanup();
  }
});

test('requirePostsBackend throws backend_unavailable when stores.posts is null', () => {
  // The triggering condition: SQLite was attempted but scheduledPostRepo
  // bind failed. connect-mcp-server then sets stores.posts to null rather
  // than falling back to JSON.
  assert.throws(
    () => requirePostsBackend({ posts: null }, 'save_scheduled_posts'),
    (err) => err && err.code === 'backend_unavailable'
  );
  assert.throws(
    () => requirePostsBackend({ posts: undefined }, 'list_scheduled_posts'),
    (err) => err && err.code === 'backend_unavailable'
  );
  // Does NOT throw when posts is a usable store — note this is different
  // from requireRunsBackend, which also checks sqliteAvailable. Posts can
  // legitimately be JSON-backed in a no-SQLite deployment, so we only
  // refuse on the explicit null marker that the partial-bind path sets.
  assert.doesNotThrow(() => requirePostsBackend({ posts: {} }, 'list_scheduled_posts'));
});

test('save_scheduled_posts and list_scheduled_posts handlers refuse when stores.posts is null', async () => {
  // Direct handler invocation to mimic the "SQLite up, scheduled-post repo
  // failed" path: posts is null on the stores bundle.
  const workspace = createTempWorkspace('mcp-posts-null-');
  try {
    // Minimal stores bundle: just enough for the handler dispatch to reach
    // requirePostsBackend. Other fields are unused for this test.
    const stores = {
      posts: null,
      sqliteAvailable: false  // matches the gate's expectation
    };
    const server = createServer({ stores });

    assert.throws(
      () => server.toolHandlers.list_scheduled_posts({}),
      (err) => err && err.code === 'backend_unavailable',
      'list_scheduled_posts must refuse when posts is null'
    );

    await assert.rejects(
      () => server.toolHandlers.save_scheduled_posts({ posts: [] }),
      (err) => err && err.code === 'backend_unavailable',
      'save_scheduled_posts must refuse when posts is null'
    );
  } finally {
    workspace.cleanup();
  }
});
