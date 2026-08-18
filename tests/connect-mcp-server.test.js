const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const fs = require('fs');

const { createServer, TOOL_DEFS, _private } = require('../connect-mcp-server');
const SdrAgentManager = require('../sdr-agent-manager');
const WorkflowTemplateStore = require('../workflow-template-store');
const WorkflowRunManager = require('../workflow-run-manager');
const ProspectQueueStore = require('../prospect-queue-store');
const GroupDataStore = require('../group-data-store');
const ScheduledPostStore = require('../scheduled-post-store');
const ActivityEventStore = require('../activity-event-store');
const ActivityAnalyticsService = require('../activity-analytics');
const LinkedInReplyMonitor = require('../linkedin-reply-monitor');
const LinkedInAccountHealthStore = require('../linkedin-account-health-store');
const RuntimeLogStore = require('../runtime-log-store');
const AgentPersonaStore = require('../agent-persona-store');
const DailyReportService = require('../daily-report-service');
const ReportScheduleStore = require('../report-schedule-store');
const ApolloSyncStore = require('../apollo-sync-store');
const ApolloSyncService = require('../apollo-sync-service');
const { createTempWorkspace, writeJson, writeJsonLines } = require('./test-helpers');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildTestStores(workspace) {
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
  const templates = new WorkflowTemplateStore({
    storePath: workspace.path('templates.json'),
    legacyWorkflowsDir: workspace.path('legacy-workflows')
  });
  const groups = new GroupDataStore({ paths: [workspace.path('groups.json')] });
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
      groups,
      clientFactory: () => ({
        apiRequest: async ({ method = 'GET', path, query, body }) => ({
          ok: true,
          method,
          path,
          query: query || null,
          body: body || null
        }),
        searchPeople: async (filters = {}) => ({
          totalEntries: 1,
          page: Number(filters.page || 1),
          perPage: Number(filters.per_page || 25),
          people: [{
            id: 'person-1',
            name: 'Jane Doe',
            title: 'Head of AI',
            organizationName: 'Acme'
          }],
          raw: { people: [{ id: 'person-1' }] }
        }),
        searchSequences: async () => [],
        listEmailAccounts: async () => [],
        searchContacts: async () => [],
        searchAccounts: async () => ({ totalEntries: 0, page: 1, perPage: 25, accounts: [], raw: {} }),
        getAccount: async (accountId) => ({ id: accountId, name: 'Acme' }),
        createAccount: async (payload) => ({ ok: true, payload }),
        updateAccount: async (accountId, payload) => ({ ok: true, accountId, payload }),
        listUsers: async () => [],
        listLabels: async () => [],
        listFields: async () => [],
        listContactStages: async () => [],
        updateContactStages: async (payload) => ({ ok: true, payload }),
        updateContactOwners: async (payload) => ({ ok: true, payload }),
        bulkCreateContacts: async (payload) => ({ ok: true, payload }),
        bulkUpdateContacts: async (payload) => ({ ok: true, payload }),
        searchDeals: async () => [],
        getDeal: async (dealId) => ({ id: dealId, name: 'Deal 1' }),
        createDeal: async (payload) => ({ ok: true, payload }),
        updateDeal: async (dealId, payload) => ({ ok: true, dealId, payload }),
        listDealStages: async () => [],
        searchTasks: async () => [],
        createTask: async (payload) => ({ ok: true, payload }),
        bulkCreateTasks: async (payload) => ({ ok: true, payload }),
        createCallRecord: async (payload) => ({ ok: true, payload }),
        searchCalls: async () => [],
        updateCallRecord: async (callId, payload) => ({ ok: true, callId, payload }),
        updateSequenceContactStatus: async (payload) => ({ ok: true, payload }),
        activateSequence: async (sequenceId) => ({ ok: true, sequenceId }),
        matchPerson: async () => null,
        createContact: async () => null,
        addContactsToSequence: async () => ({ success: true })
      }),
      getApolloApiKey: async () => 'apollo-test',
      hasApolloApiKey: async () => true,
      setApolloApiKey: async () => true,
      deleteApolloApiKey: async () => true
    })
  };
}

function request(serverRef, method, urlPath, body, options = {}) {
  return new Promise((resolve, reject) => {
    const handler = serverRef?.handler;
    if (typeof handler !== 'function') {
      reject(new Error('Missing HTTP request handler'));
      return;
    }

    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = new PassThrough();
    req.method = method;
    req.url = urlPath;
    req.headers = {
      'content-type': 'application/json',
      ...(serverRef.defaultHeaders || {}),
      ...(options.headers || {}),
      ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {})
    };

    let statusCode = 200;
    const headers = {};
    const res = {
      writeHead(code, nextHeaders = {}) {
        statusCode = code;
        Object.assign(headers, nextHeaders);
        return this;
      },
      end(chunk = '') {
        try {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
          resolve({
            status: statusCode,
            headers,
            body: text ? JSON.parse(text) : null
          });
        } catch (error) {
          reject(new Error(`Non-JSON response: ${error.message}`));
        }
      }
    };

    Promise.resolve(handler(req, res)).catch(reject);
    process.nextTick(() => {
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  });
}

function get(serverRef, path, options) { return request(serverRef, 'GET', path, undefined, options); }
function post(serverRef, path, body, options) { return request(serverRef, 'POST', path, body, options); }

async function withServer(workspace, fn, serverOptions = {}) {
  const server = createServer({
    stores: buildTestStores(workspace),
    createScheduledPostSyncSession: async () => null,
    ...serverOptions
  });
  const httpToken = serverOptions.httpToken === undefined ? 'test-connect-token' : serverOptions.httpToken;
  const platformWriteToken = serverOptions.platformWriteToken === undefined
    ? 'test-platform-write-token'
    : serverOptions.platformWriteToken;
  const handler = server.createHttpHandler(httpToken, {
    allowUnauthenticated: serverOptions.allowUnauthenticatedHttp === true,
    platformWriteToken,
    auditLogPath: workspace.path('mcp-platform-write-audit.jsonl')
  });
  const serverRef = {
    handler,
    defaultHeaders: {
      ...(httpToken ? { authorization: `Bearer ${httpToken}` } : {}),
      ...(platformWriteToken ? { 'x-platform-write-token': platformWriteToken } : {})
    }
  };
  await fn(serverRef);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('GET /api/health returns ok with uptime', async () => {
  const workspace = createTempWorkspace('mcp-health-');
  try {
    await withServer(workspace, async (port) => {
      const { status, body } = await get(port, '/api/health');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.server, 'connect-ability');
      assert.equal(typeof body.uptime, 'number');
      assert.ok(body.uptime >= 0);
    });
  } finally {
    workspace.cleanup();
  }
});

test('startHttp requires a token by default for the localhost HTTP API', async () => {
  const workspace = createTempWorkspace('mcp-auth-required-');
  try {
    const server = createServer({
      stores: buildTestStores(workspace),
      createScheduledPostSyncSession: async () => null
    });

    await assert.rejects(
      async () => server.startHttp(0),
      /HTTP API token required/
    );
  } finally {
    workspace.cleanup();
  }
});

test('HTTP API returns 401 when the configured token is missing or invalid', async () => {
  const workspace = createTempWorkspace('mcp-auth-401-');
  try {
    await withServer(workspace, async (serverRef) => {
      const missing = await get(serverRef, '/api/health', { headers: { authorization: '' } });
      assert.equal(missing.status, 401);
      assert.equal(missing.body.ok, false);

      const wrong = await get(serverRef, '/api/health', {
        headers: { authorization: 'Bearer wrong-token' }
      });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.body.error, 'Unauthorized');
    });
  } finally {
    workspace.cleanup();
  }
});

test('HTTP API can still run without auth only when explicit unauthenticated localhost mode is enabled', async () => {
  const workspace = createTempWorkspace('mcp-auth-allow-localhost-');
  try {
    await withServer(workspace, async (serverRef) => {
      const { status, body } = await get(serverRef, '/api/health');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    }, {
      httpToken: '',
      allowUnauthenticatedHttp: true
    });
  } finally {
    workspace.cleanup();
  }
});

test('GET /api/functions returns all registered tool names', async () => {
  const workspace = createTempWorkspace('mcp-functions-');
  try {
    await withServer(workspace, async (port) => {
      const { status, body } = await get(port, '/api/functions');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.functions));
      assert.ok(body.functions.includes('list_agents'));
      assert.ok(body.functions.includes('save_agent'));
      assert.ok(body.functions.includes('list_scheduled_posts'));
      assert.ok(body.functions.includes('save_scheduled_posts'));
      assert.ok(body.functions.includes('get_analytics'));
      assert.ok(body.functions.includes('get_account_health'));
      assert.ok(body.functions.includes('get_runtime_logs'));
      assert.ok(body.functions.includes('get_daily_report'));
      assert.ok(body.functions.includes('list_activity_events'));
      assert.ok(body.functions.includes('schedule_daily_report'));
      assert.ok(body.functions.includes('list_report_schedules'));
      assert.ok(body.functions.includes('delete_report_schedule'));
      assert.ok(body.functions.includes('get_apollo_integration'));
      assert.ok(body.functions.includes('list_apollo_api_capabilities'));
      assert.ok(body.functions.includes('call_apollo_api'));
      assert.ok(body.functions.includes('search_apollo_people'));
      assert.ok(body.functions.includes('search_apollo_contacts'));
      assert.ok(body.functions.includes('search_apollo_accounts'));
      assert.ok(body.functions.includes('create_apollo_deal'));
      assert.ok(body.functions.includes('create_apollo_task'));
      assert.ok(body.functions.includes('create_apollo_call_record'));
      assert.ok(body.functions.includes('sync_workflow_to_apollo_sequence'));
      assert.equal(body.functions.length, TOOL_DEFS.length);
    });
  } finally {
    workspace.cleanup();
  }
});

test('GET /api/schema returns operations with function, description, inputSchema', async () => {
  const workspace = createTempWorkspace('mcp-schema-');
  try {
    await withServer(workspace, async (port) => {
      const { status, body } = await get(port, '/api/schema');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.operations));
      assert.equal(body.operations.length, TOOL_DEFS.length);
      for (const op of body.operations) {
        assert.ok(typeof op.function === 'string' && op.function.length > 0, `op.function missing on ${JSON.stringify(op)}`);
        assert.ok(typeof op.description === 'string' && op.description.length > 0, `op.description missing for ${op.function}`);
        assert.ok(op.inputSchema && typeof op.inputSchema === 'object', `op.inputSchema missing for ${op.function}`);
      }

      const analyticsOp = body.operations.find((op) => op.function === 'get_analytics');
      assert.ok(analyticsOp);
      assert.ok(analyticsOp.description.includes('step outcome breakdown'));
      assert.ok(analyticsOp.inputSchema.properties.accountId);
      assert.ok(analyticsOp.inputSchema.properties.since);
      assert.ok(analyticsOp.inputSchema.properties.until);
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call list_agents returns empty array on fresh store', async () => {
  const workspace = createTempWorkspace('mcp-list-agents-');
  try {
    await withServer(workspace, async (port) => {
      const { status, body } = await post(port, '/api/call', { function: 'list_agents', args: [] });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.result));
      assert.equal(body.result.length, 0);
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call platform-write tools require the platform write token while local writes do not', async () => {
  const workspace = createTempWorkspace('mcp-platform-write-gate-');
  try {
    writeJson(workspace.path('linkedin-accounts.json'), {
      accounts: [
        {
          id: 'account-1',
          name: 'Alice SDR',
          email: 'alice@example.com'
        }
      ],
      activeAccountId: 'account-1'
    });

    await withServer(workspace, async (serverRef) => {
      const templateResp = await post(serverRef, '/api/call', {
        function: 'save_workflow_template',
        args: [{
          name: 'Safe Template',
          kind: 'automation',
          steps: [{ order: 1, type: 'view_profile' }]
        }]
      });
      assert.equal(templateResp.status, 200);
      assert.equal(templateResp.body.ok, true);

      const denied = await post(serverRef, '/api/call', {
        function: 'run_linkedin_action',
        args: [{
          profileUrl: 'https://www.linkedin.com/in/jane-doe/',
          accountId: 'account-1',
          actionType: 'view_profile'
        }]
      }, {
        headers: {
          'x-platform-write-token': ''
        }
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.ok, false);
      assert.match(denied.body.error, /Platform write token required/i);

      const enrichDenied = await post(serverRef, '/api/call', {
        function: 'enrich_prospect_email',
        args: [{
          firstName: 'Jane',
          lastName: 'Doe',
          companyName: 'Acme'
        }]
      }, {
        headers: {
          'x-platform-write-token': ''
        }
      });
      assert.equal(enrichDenied.status, 403);
      assert.equal(enrichDenied.body.ok, false);
      assert.match(enrichDenied.body.error, /Platform write token required/i);
    });
  } finally {
    workspace.cleanup();
  }
});

test('platform-write audit prune keeps only entries newer than the 365 day cutoff and rewrites valid JSONL', async () => {
  const workspace = createTempWorkspace('mcp-audit-prune-');
  try {
    const auditLogPath = workspace.path('mcp-platform-write-audit.jsonl');
    const nowMs = Date.UTC(2026, 3, 20, 12, 0, 0);
    const freshTimestamp = new Date(nowMs - (30 * 24 * 60 * 60 * 1000)).toISOString();
    const staleTimestamp = new Date(nowMs - (366 * 24 * 60 * 60 * 1000)).toISOString();

    writeJsonLines(auditLogPath, [
      {
        id: 'audit-fresh',
        timestamp: freshTimestamp,
        toolName: 'run_linkedin_action',
        outcome: 'allowed'
      },
      {
        id: 'audit-stale',
        timestamp: staleTimestamp,
        toolName: 'save_scheduled_posts',
        outcome: 'allowed'
      }
    ]);

    const result = _private.prunePlatformWriteAuditLog(auditLogPath, { nowMs });

    assert.equal(result.pruned, true);
    assert.equal(result.keptCount, 1);
    assert.equal(result.removedCount, 1);
    assert.equal(result.invalidCount, 0);
    assert.ok(result.bytesFreed > 0);

    const lines = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const persisted = lines.map((line) => JSON.parse(line));
    assert.deepEqual(persisted.map((entry) => entry.id), ['audit-fresh']);
  } finally {
    workspace.cleanup();
  }
});

test('platform-write audit prune emits telemetry_prune_completed into the activity event stream', async () => {
  const workspace = createTempWorkspace('mcp-audit-prune-telemetry-');
  try {
    const auditLogPath = workspace.path('mcp-platform-write-audit.jsonl');
    writeJsonLines(auditLogPath, [
      {
        id: 'old-audit-entry',
        timestamp: '2025-04-19T11:59:59.000Z',
        toolName: 'run_linkedin_action',
        outcome: 'allowed'
      },
      {
        id: 'fresh-audit-entry',
        timestamp: '2026-04-20T10:00:00.000Z',
        toolName: 'run_linkedin_action',
        outcome: 'allowed'
      }
    ]);

    const server = createServer({
      stores: buildTestStores(workspace),
      createScheduledPostSyncSession: async () => null
    });
    server.createHttpHandler('test-connect-token', {
      platformWriteToken: 'test-platform-write-token',
      auditLogPath
    });

    const events = fs.readFileSync(workspace.path('events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const pruneEvent = events.find((event) => event.type === 'telemetry_prune_completed');

    assert.ok(pruneEvent, 'expected telemetry_prune_completed event to be recorded');
    assert.equal(pruneEvent.targetValue, 'mcp_audit_log');
    assert.equal(pruneEvent.metadata.target, 'mcp_audit_log');
    assert.equal(pruneEvent.metadata.removedCount, 1);
    assert.equal(pruneEvent.metadata.backend, 'jsonl');
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call get_analytics includes workflow step outcome breakdown', async () => {
  const workspace = createTempWorkspace('mcp-get-analytics-breakdown-');
  try {
    writeJsonLines(workspace.path('events.jsonl'), [
      {
        id: 'evt-1',
        type: 'workflow_step_completed',
        timestamp: '2026-03-21T10:00:00.000Z',
        accountId: 'account-1',
        agentId: 'agent-1',
        workflowId: 'workflow-1',
        status: 'ok',
        metadata: {
          stepType: 'view_profile',
          outcomeType: 'completed'
        }
      },
      {
        id: 'evt-2',
        type: 'workflow_step_completed',
        timestamp: '2026-03-21T10:01:00.000Z',
        accountId: 'account-1',
        agentId: 'agent-1',
        workflowId: 'workflow-1',
        status: 'skipped',
        metadata: {
          stepType: 'view_profile',
          outcomeType: 'skipped_quota_exceeded'
        }
      },
      {
        id: 'evt-3',
        type: 'workflow_step_failed',
        timestamp: '2026-03-21T10:02:00.000Z',
        accountId: 'account-1',
        agentId: 'agent-1',
        workflowId: 'workflow-1',
        status: 'failed',
        metadata: {
          stepType: 'send_dm',
          outcomeType: 'failed_transient'
        }
      }
    ]);

    await withServer(workspace, async (port) => {
      const { status, body } = await post(port, '/api/call', {
        function: 'get_analytics',
        args: [{ accountId: 'account-1', workflowId: 'workflow-1' }]
      });

      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.ok(body.result.stepOutcomeBreakdown);
      assert.equal(body.result.stepOutcomeBreakdown.totals.total, 3);
      assert.equal(body.result.stepOutcomeBreakdown.totals.completed, 1);
      assert.equal(body.result.stepOutcomeBreakdown.totals.skipped, 1);
      assert.equal(body.result.stepOutcomeBreakdown.totals.failed, 1);
      assert.equal(body.result.stepOutcomeBreakdown.byStepType[0].stepType, 'view_profile');
      assert.deepEqual(
        body.result.stepOutcomeBreakdown.byStepType[0].breakdown
          .slice()
          .sort((left, right) => left.outcomeType.localeCompare(right.outcomeType)),
        [
          { outcomeType: 'completed', count: 1 },
          { outcomeType: 'skipped_quota_exceeded', count: 1 }
        ]
      );
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call get_analytics applies days lookback when since is not provided', async () => {
  const workspace = createTempWorkspace('mcp-get-analytics-days-');
  try {
    const now = Date.now();
    const recentTimestamp = new Date(now - (2 * 60 * 60 * 1000)).toISOString();
    const oldTimestamp = new Date(now - (5 * 24 * 60 * 60 * 1000)).toISOString();

    writeJsonLines(workspace.path('events.jsonl'), [
      {
        id: 'evt-recent',
        type: 'workflow_step_completed',
        timestamp: recentTimestamp,
        accountId: 'account-1',
        status: 'ok',
        metadata: {
          stepType: 'view_profile',
          outcomeType: 'completed'
        }
      },
      {
        id: 'evt-old',
        type: 'workflow_step_completed',
        timestamp: oldTimestamp,
        accountId: 'account-1',
        status: 'skipped',
        metadata: {
          stepType: 'view_profile',
          outcomeType: 'skipped_outside_working_hours'
        }
      }
    ]);

    await withServer(workspace, async (port) => {
      const { status, body } = await post(port, '/api/call', {
        function: 'get_analytics',
        args: [{ accountId: 'account-1', days: 1 }]
      });

      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.result.stepOutcomeBreakdown.totals.total, 1);
      assert.equal(body.result.stepOutcomeBreakdown.byStepType[0].breakdown[0].outcomeType, 'completed');
      assert.equal(typeof body.result.stepOutcomeBreakdown.filters.since, 'string');
      assert.equal(typeof body.result.stepOutcomeBreakdown.filters.until, 'string');
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call get_analytics includes account health breakdown', async () => {
  const workspace = createTempWorkspace('mcp-get-analytics-account-health-');
  try {
    writeJson(workspace.path('linkedin-accounts.json'), {
      accounts: [
        { id: 'account-1', name: 'Alice SDR', email: 'alice@example.com' },
        { id: 'account-2', name: 'Bob SDR', email: 'bob@example.com' }
      ]
    });

    writeJson(workspace.path('health.json'), {
      version: 2,
      accounts: {
        'account-1': {
          workflow: {
            status: 'cooldown',
            lastSuccessAt: null,
            lastErrorAt: '2026-03-21T10:00:00.000Z',
            lastError: 'selector timeout',
            consecutiveFailures: 3,
            cooldownUntil: '2099-03-21T11:00:00.000Z',
            cooldownReason: 'challenge',
            lastUpdatedAt: '2026-03-21T10:00:00.000Z'
          },
          replyMonitor: {
            status: 'healthy',
            lastSuccessAt: null,
            lastErrorAt: null,
            lastError: null,
            consecutiveFailures: 0,
            cooldownUntil: null,
            cooldownReason: null,
            lastUpdatedAt: '2026-03-21T10:00:00.000Z'
          },
          challenged: {
            at: '2026-03-21T10:05:00.000Z',
            type: 'captcha',
            source: 'verify_session'
          },
          updatedAt: '2026-03-21T10:05:00.000Z'
        },
        'account-2': {
          workflow: {
            status: 'healthy',
            lastSuccessAt: '2026-03-21T10:00:00.000Z',
            lastErrorAt: null,
            lastError: null,
            consecutiveFailures: 0,
            cooldownUntil: null,
            cooldownReason: null,
            lastUpdatedAt: '2026-03-21T10:00:00.000Z'
          },
          replyMonitor: {
            status: 'cooldown',
            lastSuccessAt: null,
            lastErrorAt: '2026-03-21T10:02:00.000Z',
            lastError: 'HTTP 429 rate limit',
            consecutiveFailures: 2,
            cooldownUntil: '2099-03-21T12:00:00.000Z',
            cooldownReason: 'rate_limit',
            lastUpdatedAt: '2026-03-21T10:02:00.000Z'
          },
          challenged: null,
          updatedAt: '2026-03-21T10:02:00.000Z'
        }
      }
    });

    writeJson(workspace.path('transport-health.json'), {
      version: 1,
      entries: {
        'private_api::send_dm::alice@example.com': {
          transport: 'private_api',
          action: 'send_dm',
          accountEmail: 'alice@example.com',
          successCount: 1,
          failureCount: 3,
          lastSuccessAt: '2026-03-21T09:55:00.000Z',
          lastFailureAt: '2026-03-21T09:59:00.000Z',
          lastFailureReason: 'messaging_canary_failed',
          lastUpdatedAt: '2026-03-21T09:59:00.000Z',
          disabled: true,
          disabledUntil: '2099-03-21T10:30:00.000Z'
        },
        'dom::send_connection::alice@example.com': {
          transport: 'dom',
          action: 'send_connection',
          accountEmail: 'alice@example.com',
          successCount: 0,
          failureCount: 1,
          lastSuccessAt: null,
          lastFailureAt: '2026-03-21T09:58:00.000Z',
          lastFailureReason: 'selector_canary_exception',
          lastUpdatedAt: '2026-03-21T09:58:00.000Z',
          disabled: false,
          disabledUntil: null
        },
        'private_api::send_connection::bob@example.com': {
          transport: 'private_api',
          action: 'send_connection',
          accountEmail: 'bob@example.com',
          successCount: 0,
          failureCount: 3,
          lastSuccessAt: null,
          lastFailureAt: '2026-03-21T09:50:00.000Z',
          lastFailureReason: 'identity_canary_failed',
          lastUpdatedAt: '2026-03-21T09:50:00.000Z',
          disabled: true,
          disabledUntil: '2099-03-21T10:20:00.000Z'
        }
      }
    });

    writeJson(workspace.path('session-registry.json'), {
      version: 1,
      accounts: {
        'alice@example.com': {
          email: 'alice@example.com',
          profilePath: workspace.path('profiles', 'alice'),
          lastVerifiedAt: '2026-03-21T09:45:00.000Z',
          lastVerifiedBy: 'action',
          lastAuthFailureAt: null,
          lastChallengeAt: null,
          updatedAt: '2026-03-21T09:56:00.000Z'
        },
        'bob@example.com': {
          email: 'bob@example.com',
          profilePath: workspace.path('profiles', 'bob'),
          lastVerifiedAt: '2026-03-21T09:30:00.000Z',
          lastVerifiedBy: 'canary',
          lastAuthFailureAt: null,
          lastChallengeAt: null,
          updatedAt: '2026-03-21T09:30:00.000Z'
        }
      }
    });

    writeJsonLines(workspace.path('logs.jsonl'), [
      {
        id: 'log-1',
        timestamp: '2026-03-21T09:56:30.000Z',
        type: 'warning',
        source: 'workflow-worker',
        message: 'Session verification failed: LinkedIn session could not be verified',
        accountId: 'account-1',
        accountName: 'Alice SDR'
      },
      {
        id: 'log-2',
        timestamp: '2026-03-21T09:57:00.000Z',
        type: 'info',
        source: 'private-api-canary',
        message: 'Identity private API canary passed using profileByVanityNamePrimary.',
        accountId: 'account-1',
        accountName: 'Alice SDR'
      },
      {
        id: 'log-3',
        timestamp: '2026-03-21T09:58:00.000Z',
        type: 'warning',
        source: 'selector-canary',
        message: 'Connection DOM selector canary failed: no matching selectors.',
        accountId: 'account-1',
        accountName: 'Alice SDR'
      },
      {
        id: 'log-4',
        timestamp: '2026-03-21T09:59:00.000Z',
        type: 'warning',
        source: 'private-api-canary',
        message: 'Messaging private API canary failed: timeout.',
        accountId: 'account-2',
        accountName: 'Bob SDR'
      }
    ]);

    await withServer(workspace, async (port) => {
      const { status, body } = await post(port, '/api/call', {
        function: 'get_analytics',
        args: [{ accountId: 'account-1' }]
      });

      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.ok(body.result.accountHealth);
      assert.equal(body.result.accountHealth.byAccount.length, 1);

      const alice = body.result.accountHealth.byAccount[0];
      assert.equal(alice.accountId, 'account-1');
      assert.equal(alice.accountName, 'Alice SDR');
      assert.equal(alice.accountEmail, 'alice@example.com');
      assert.equal(alice.challengeCount, 1);
      assert.equal(alice.cooldownCount, 1);
      assert.equal(alice.transportDisableCount, 1);
      assert.equal(alice.verificationFailureRate, 50);
      assert.equal(alice.canaryFailureRate, 50);
      assert.equal(body.result.accountHealth.totals.accounts, 1);
      assert.equal(body.result.accountHealth.totals.challengeCount, 1);
      assert.equal(body.result.accountHealth.totals.cooldownCount, 1);
      assert.equal(body.result.accountHealth.totals.transportDisableCount, 1);
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call list_agents filters by accountId', async () => {
  const workspace = createTempWorkspace('mcp-list-agents-account-filter-');
  try {
    await withServer(workspace, async (port) => {
      await post(port, '/api/call', {
        function: 'save_agent',
        args: [{
          name: 'Robert SDR',
          accountId: 'account-robert',
          accountName: 'Robert Henderson'
        }]
      });

      await post(port, '/api/call', {
        function: 'save_agent',
        args: [{
          name: 'Ivan SDR',
          accountId: 'account-ivan',
          accountName: 'Ivan Dans'
        }]
      });

      const { status, body } = await post(port, '/api/call', {
        function: 'list_agents',
        args: [{ accountId: 'account-robert' }]
      });

      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.deepEqual(body.result.map((agent) => agent.name), ['Robert SDR']);
      assert.deepEqual(body.result.map((agent) => agent.accountId), ['account-robert']);
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call exposes Apollo passthrough and search helpers', async () => {
  const workspace = createTempWorkspace('mcp-apollo-tools-');
  try {
    await withServer(workspace, async (port) => {
      const capabilitiesResp = await post(port, '/api/call', {
        function: 'list_apollo_api_capabilities',
        args: [{}]
      });
      assert.equal(capabilitiesResp.status, 200);
      assert.equal(capabilitiesResp.body.ok, true);
      assert.equal(capabilitiesResp.body.result.apiBaseUrl, 'https://api.apollo.io/api/v1');
      assert.ok(Array.isArray(capabilitiesResp.body.result.categories));

      const searchResp = await post(port, '/api/call', {
        function: 'search_apollo_people',
        args: [{ personTitles: ['Head of AI'], limit: 5 }]
      });
      assert.equal(searchResp.status, 200);
      assert.equal(searchResp.body.ok, true);
      assert.equal(searchResp.body.result.totalEntries, 1);
      assert.equal(searchResp.body.result.people[0].title, 'Head of AI');

      const apiResp = await post(port, '/api/call', {
        function: 'call_apollo_api',
        args: [{
          method: 'POST',
          path: '/contacts/search',
          query: { q_keywords: 'Jane Doe' },
          body: { page: 1 }
        }]
      });
      assert.equal(apiResp.status, 200);
      assert.equal(apiResp.body.ok, true);
      assert.equal(apiResp.body.result.path, '/contacts/search');
      assert.equal(apiResp.body.result.method, 'POST');
      assert.equal(apiResp.body.result.query.q_keywords, 'Jane Doe');

      const dealResp = await post(port, '/api/call', {
        function: 'create_apollo_deal',
        args: [{ deal: { name: 'Enterprise Expansion' } }]
      });
      assert.equal(dealResp.status, 200);
      assert.equal(dealResp.body.ok, true);
      assert.equal(dealResp.body.result.payload.name, 'Enterprise Expansion');
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call save_agent + get_agent round-trip persists and retrieves agent', async () => {
  const workspace = createTempWorkspace('mcp-agent-roundtrip-');
  try {
    await withServer(workspace, async (port) => {
      const saveResp = await post(port, '/api/call', {
        function: 'save_agent',
        args: [{
          name: 'CoS Outreach Agent',
          niche: 'Chiefs of Staff at scale-ups and enterprise',
          personaTitles: ['Chief of Staff', 'CoS'],
          searchKeywords: ['chief of staff', 'strategy and operations'],
          dmTemplatePrimary: 'Hi {{firstName}}, saw your profile and thought you might enjoy connecting about offsites.',
          contentPillars: ['offsite ROI', 'team culture', 'remote collaboration'],
          metadata: {
            soul: 'warm, direct, never pushy',
            personality: 'professional with a sense of humor',
            replyStyle: 'witty, 2-3 sentences, always ends with a question',
            contentTone: ['professional', 'funny', 'witty']
          }
        }]
      });
      assert.equal(saveResp.status, 200);
      assert.equal(saveResp.body.ok, true);
      const agent = saveResp.body.result;
      assert.equal(agent.name, 'CoS Outreach Agent');
      assert.ok(agent.id, 'Agent should have an ID');
      assert.equal(agent.metadata.soul, 'warm, direct, never pushy');
      assert.deepEqual(agent.metadata.contentTone, ['professional', 'funny', 'witty']);
      // New agents should have no persona files yet
      assert.equal(agent.personaStatus.hasPersona, false);
      assert.equal(agent.personaStatus.complete, false);
      assert.deepEqual(agent.personaStatus.existingFiles, []);

      const getResp = await post(port, '/api/call', {
        function: 'get_agent',
        args: [{ agentId: agent.id }]
      });
      assert.equal(getResp.status, 200);
      assert.equal(getResp.body.ok, true);
      assert.equal(getResp.body.result.id, agent.id);
      assert.equal(getResp.body.result.niche, 'Chiefs of Staff at scale-ups and enterprise');
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call save_workflow_template + list_workflow_templates round-trip', async () => {
  const workspace = createTempWorkspace('mcp-template-roundtrip-');
  try {
    await withServer(workspace, async (port) => {
      const saveResp = await post(port, '/api/call', {
        function: 'save_workflow_template',
        args: [{
          name: 'CoS 7-Day Sequence',
          kind: 'automation',
          steps: [
            { order: 1, type: 'view_profile' },
            { order: 2, type: 'delay', delayValue: 24, delayUnit: 'hours' },
            { order: 3, type: 'view_profile' },
            { order: 4, type: 'delay', delayValue: 24, delayUnit: 'hours' },
            { order: 5, type: 'like_posts' },
            { order: 6, type: 'delay', delayValue: 24, delayUnit: 'hours' },
            { order: 7, type: 'send_dm', messageTemplate: 'Hi {{firstName}}, noticed your profile — would love to connect about offsites.' }
          ]
        }]
      });
      assert.equal(saveResp.status, 200);
      assert.equal(saveResp.body.ok, true);
      const template = saveResp.body.result;
      assert.equal(template.name, 'CoS 7-Day Sequence');
      assert.equal(template.steps.length, 7);
      assert.equal(template.steps[6].type, 'send_dm');

      const listResp = await post(port, '/api/call', { function: 'list_workflow_templates', args: [{}] });
      assert.equal(listResp.status, 200);
      assert.equal(listResp.body.ok, true);
      assert.equal(listResp.body.result.length, 1);
      assert.equal(listResp.body.result[0].id, template.id);
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call list_prospects and get_prospect expose persisted lead score fields', async () => {
  const workspace = createTempWorkspace('mcp-prospect-scores-');
  try {
    const stores = buildTestStores(workspace);
    const prospect = stores.prospects.upsertProspect({
      accountId: 'account-1',
      agentId: 'agent-1',
      fullName: 'Jane Doe',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      title: 'Chief of Staff'
    });
    stores.prospects.applyLeadScores([{
      prospectId: prospect.id,
      score: 91,
      scoreUpdatedAt: '2026-03-23T12:00:00.000Z',
      scoreBreakdown: {
        total: 0.91,
        factors: {
          titleMatch: {
            score: 1,
            weight: 0.45,
            weighted: 0.45,
            matchedKeyword: 'Chief of Staff'
          }
        }
      }
    }]);

    const server = createServer({
      stores,
      createScheduledPostSyncSession: async () => null
    });
    const httpToken = 'test-connect-token';
    const serverRef = {
      handler: server.createHttpHandler(httpToken),
      defaultHeaders: { authorization: `Bearer ${httpToken}` }
    };

    const listResp = await post(serverRef, '/api/call', {
      function: 'list_prospects',
      args: [{ accountId: 'account-1' }]
    });
    assert.equal(listResp.status, 200);
    assert.equal(listResp.body.ok, true);
    assert.equal(listResp.body.result.length, 1);
    assert.equal(listResp.body.result[0].score, 91);
    assert.equal(listResp.body.result[0].scoreBreakdown.total, 0.91);

    const getResp = await post(serverRef, '/api/call', {
      function: 'get_prospect',
      args: [{ prospectId: prospect.id }]
    });
    assert.equal(getResp.status, 200);
    assert.equal(getResp.body.ok, true);
    assert.equal(getResp.body.result.scoreUpdatedAt, '2026-03-23T12:00:00.000Z');
    assert.equal(
      getResp.body.result.scoreBreakdown.factors.titleMatch.matchedKeyword,
      'Chief of Staff'
    );
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call save_scheduled_posts + list_scheduled_posts round-trip', async () => {
  const workspace = createTempWorkspace('mcp-posts-roundtrip-');
  try {
    await withServer(workspace, async (port) => {
      const posts = [
        {
          content: 'Why your team\'s next offsite could save $200K in turnover costs. A thread 🧵',
          scheduledDate: '2026-04-01',
          scheduledTime: '09:00',
          agentId: 'agent-001',
          agentName: 'CoS Outreach Agent',
          contentPillar: 'offsite ROI',
          contentAngle: 'economic benefits',
          hashtags: ['offsite', 'teambuilding', 'leadership']
        },
        {
          content: 'The 3 things Chiefs of Staff tell me they wish they\'d done differently before the offsite.',
          scheduledDate: '2026-04-02',
          scheduledTime: '09:00',
          agentId: 'agent-001',
          agentName: 'CoS Outreach Agent',
          contentPillar: 'team culture',
          contentAngle: 'social benefits'
        }
      ];

      const saveResp = await post(port, '/api/call', {
        function: 'save_scheduled_posts',
        args: [{ posts }]
      });
      assert.equal(saveResp.status, 200);
      assert.equal(saveResp.body.ok, true);
      assert.equal(saveResp.body.result.saved, 2);

      const listResp = await post(port, '/api/call', { function: 'list_scheduled_posts', args: [{}] });
      assert.equal(listResp.status, 200);
      assert.equal(listResp.body.ok, true);
      assert.equal(listResp.body.result.length, 2);

      const agentFilter = await post(port, '/api/call', {
        function: 'list_scheduled_posts',
        args: [{ agentId: 'agent-001' }]
      });
      assert.equal(agentFilter.body.result.length, 2);

      const wrongAgent = await post(port, '/api/call', {
        function: 'list_scheduled_posts',
        args: [{ agentId: 'agent-999' }]
      });
      assert.equal(wrongAgent.body.result.length, 0);
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call save_scheduled_posts preserves other account queues when accountId is provided', async () => {
  const workspace = createTempWorkspace('mcp-posts-account-scope-');
  try {
    await withServer(workspace, async (port) => {
      await post(port, '/api/call', {
        function: 'save_scheduled_posts',
        args: [{
          accountId: 'account-ivan',
          posts: [{
            id: 'ivan-post',
            content: 'Ivan queue post',
            scheduledDate: '2026-04-01',
            scheduledTime: '09:00'
          }]
        }]
      });

      await post(port, '/api/call', {
        function: 'save_scheduled_posts',
        args: [{
          accountId: 'account-robert',
          posts: [{
            id: 'robert-post',
            content: 'Robert queue post',
            scheduledDate: '2026-04-02',
            scheduledTime: '09:00'
          }]
        }]
      });

      await post(port, '/api/call', {
        function: 'save_scheduled_posts',
        args: [{
          accountId: 'account-ivan',
          posts: [{
            id: 'ivan-post-2',
            content: 'Ivan replacement queue post',
            scheduledDate: '2026-04-03',
            scheduledTime: '09:00'
          }]
        }]
      });

      const ivanResp = await post(port, '/api/call', {
        function: 'list_scheduled_posts',
        args: [{ accountId: 'account-ivan' }]
      });
      const robertResp = await post(port, '/api/call', {
        function: 'list_scheduled_posts',
        args: [{ accountId: 'account-robert' }]
      });

      assert.deepEqual(ivanResp.body.result.map((post) => post.id), ['ivan-post-2']);
      assert.deepEqual(robertResp.body.result.map((post) => post.id), ['robert-post']);
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call save_scheduled_posts schedules supported posts on LinkedIn immediately when an account session is available', async () => {
  const workspace = createTempWorkspace('mcp-posts-linkedin-sync-');
  try {
    const scheduled = [];
    const deleted = [];
    await withServer(workspace, async (port) => {
      const firstSave = await post(port, '/api/call', {
        function: 'save_scheduled_posts',
        args: [{
          accountId: 'account-robert',
          posts: [{
            id: 'post-remote-1',
            content: 'Remote scheduled post',
            scheduledDate: '2026-04-05',
            scheduledTime: '09:00',
            postType: 'text'
          }]
        }]
      });
      assert.equal(firstSave.status, 200);
      assert.equal(firstSave.body.ok, true);
      assert.equal(firstSave.body.result.syncSummary.remoteScheduledCount, 1);
      assert.equal(firstSave.body.result.syncSummary.remoteDeletedCount, 0);

      const secondSave = await post(port, '/api/call', {
        function: 'save_scheduled_posts',
        args: [{
          accountId: 'account-robert',
          posts: [{
            id: 'post-remote-2',
            content: 'Replacement scheduled post',
            scheduledDate: '2026-04-06',
            scheduledTime: '09:00',
            postType: 'text'
          }]
        }]
      });
      assert.equal(secondSave.status, 200);
      assert.equal(secondSave.body.ok, true);
      assert.equal(secondSave.body.result.syncSummary.remoteScheduledCount, 1);
      assert.equal(secondSave.body.result.syncSummary.remoteDeletedCount, 1);

      const listResp = await post(port, '/api/call', {
        function: 'list_scheduled_posts',
        args: [{ accountId: 'account-robert' }]
      });
      assert.equal(listResp.body.result.length, 1);
      assert.equal(listResp.body.result[0].status, 'scheduled');
      assert.equal(listResp.body.result[0].linkedInResourceKey, 'urn:li:share:post-remote-2');
    }, {
      createScheduledPostSyncSession: async () => ({
        async schedulePost(post) {
          scheduled.push(post.id);
          return {
            resourceKey: `urn:li:share:${post.id}`,
            scheduledAt: '1775379600000'
          };
        },
        async deletePost(resourceKey) {
          deleted.push(resourceKey);
          return true;
        },
        async close() {}
      })
    });

    assert.deepEqual(scheduled, ['post-remote-1', 'post-remote-2']);
    assert.deepEqual(deleted, ['urn:li:share:post-remote-1']);
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call with unknown function returns ok:false and 404 status', async () => {
  const workspace = createTempWorkspace('mcp-unknown-fn-');
  try {
    await withServer(workspace, async (port) => {
      const { status, body } = await post(port, '/api/call', {
        function: 'does_not_exist',
        args: []
      });
      assert.equal(status, 404);
      assert.equal(body.ok, false);
      assert.ok(/unknown function/i.test(body.error), `Expected "unknown function" in: ${body.error}`);
    });
  } finally {
    workspace.cleanup();
  }
});

test('POST /api/call get_agent returns ok:false when agent does not exist', async () => {
  const workspace = createTempWorkspace('mcp-agent-missing-');
  try {
    await withServer(workspace, async (port) => {
      const { status, body } = await post(port, '/api/call', {
        function: 'get_agent',
        args: [{ agentId: 'nonexistent-agent-id' }]
      });
      assert.equal(status, 200);
      assert.equal(body.ok, false);
      assert.ok(/not found/i.test(body.error), `Expected "not found" in: ${body.error}`);
    });
  } finally {
    workspace.cleanup();
  }
});
