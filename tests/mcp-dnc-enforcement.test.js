'use strict';

/**
 * tests/mcp-dnc-enforcement.test.js
 *
 * Regression tests for do-not-contact enforcement on the MCP
 * run_linkedin_action handler.
 *
 * Properties pinned:
 *   1. An archived prospect blocks all 5 LinkedIn actions, including
 *      view_profile (DNC means "no touch", not just "no message").
 *   2. A prospect with metadata.doNotContact = true blocks identically.
 *   3. The lookup is cross-account: a DNC record under one accountId blocks
 *      a call made under a different accountId.
 *   4. An unknown profile URL passes through and creates a run (DNC suppresses
 *      known opt-outs, not unknown targets).
 *   5. An active prospect with no DNC metadata passes through.
 *   6. The blocked result is structured (outcomeType: skipped_do_not_contact)
 *      and creates NO workflow run.
 *
 * Tests run under any Node version because they exercise the JSON-backed
 * ProspectQueueStore and never touch SQLite. The runs backend uses an
 * in-memory SQLite DB to satisfy the requireRunsBackend guard.
 *
 * Note: opens better-sqlite3, so will fail under Node versions whose ABI
 * doesn't match the locally-built native module. The non-SQLite-positive
 * cases (DNC blocks) don't strictly need SQLite, but we use it uniformly
 * to keep stores construction identical to production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

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
  _private: {
    findBlockedRelatedProspect,
    buildDoNotContactSkipResult,
    _resetDoNotContactWarningStateForTests
  }
} = require('../connect-mcp-server');

const { createTempWorkspace } = require('./test-helpers');

const ALL_ACTIONS = ['view_profile', 'send_connection', 'send_dm', 'like_posts', 'follow_profile'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStores(workspace, db) {
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

function setupServer(workspace) {
  const db = openDatabase(':memory:');
  const stores = buildStores(workspace, db);
  const server = createServer({ stores });
  return { server, stores, db };
}

function countWorkflowRunsForProfile(db, profileUrl) {
  // SQLite workflow_runs stores targets in JSON; for a one-shot
  // run_linkedin_action call, the run's targets_json includes the URL.
  // We don't filter on URL specifically here — we just count total runs and
  // assert "no runs created" by total == 0 in a clean DB.
  return db.prepare('SELECT COUNT(*) as n FROM workflow_runs').get().n;
}

const TARGET_URL = 'https://www.linkedin.com/in/dnc-target/';

// ---------------------------------------------------------------------------
// 1. Archived prospect blocks all five actions
// ---------------------------------------------------------------------------

test('archived prospect blocks all 5 LinkedIn actions (including view_profile)', () => {
  const workspace = createTempWorkspace('mcp-dnc-archived-');
  const { server, stores, db } = setupServer(workspace);
  try {
    // Seed: archived prospect with the DNC metadata that archiveProspect
    // would set in production.
    stores.prospects.upsertProspect({
      profileUrl: TARGET_URL,
      accountId: 'acc-origin',
      fullName: 'DNC Target',
      state: 'archived',
      metadata: { doNotContact: true, archiveReason: 'unsubscribe_received' }
    });

    for (const actionType of ALL_ACTIONS) {
      const result = server.toolHandlers.run_linkedin_action({
        profileUrl: TARGET_URL,
        accountId: 'acc-origin',
        actionType
      });

      assert.equal(result.ok, false, `action=${actionType} should be blocked`);
      assert.equal(result.outcomeType, 'skipped_do_not_contact');
      assert.equal(result.reason, 'prospect_archived');
      assert.equal(result.archived, true);
      assert.equal(result.doNotContact, true);
      assert.equal(result.actionType, actionType);
      assert.equal(result.profileUrl, TARGET_URL);
      assert.equal(result.archiveReason, 'unsubscribe_received');
    }

    // Zero runs should have been created across all 5 attempts.
    assert.equal(countWorkflowRunsForProfile(db, TARGET_URL), 0,
      'no workflow_runs row should be created for any blocked action');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. metadata.doNotContact = true (without archived state) blocks
// ---------------------------------------------------------------------------

test('metadata.doNotContact prospect blocks even when state is not archived', () => {
  const workspace = createTempWorkspace('mcp-dnc-metadata-');
  const { server, stores, db } = setupServer(workspace);
  try {
    stores.prospects.upsertProspect({
      profileUrl: TARGET_URL,
      accountId: 'acc-origin',
      fullName: 'DNC Target',
      state: 'active',
      metadata: { doNotContact: true }
    });

    const result = server.toolHandlers.run_linkedin_action({
      profileUrl: TARGET_URL,
      accountId: 'acc-origin',
      actionType: 'send_dm'
    });

    assert.equal(result.ok, false);
    assert.equal(result.outcomeType, 'skipped_do_not_contact');
    assert.equal(result.reason, 'do_not_contact');
    assert.equal(result.doNotContact, true);
    assert.equal(result.archived, false);

    assert.equal(countWorkflowRunsForProfile(db, TARGET_URL), 0);
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Cross-account DNC: blocked regardless of caller accountId
// ---------------------------------------------------------------------------

test('DNC enforcement is cross-account: blocks even when caller uses a different accountId', () => {
  const workspace = createTempWorkspace('mcp-dnc-cross-account-');
  const { server, stores, db } = setupServer(workspace);
  try {
    // The opt-out was recorded under acc-origin.
    stores.prospects.upsertProspect({
      profileUrl: TARGET_URL,
      accountId: 'acc-origin',
      fullName: 'DNC Target',
      state: 'archived',
      metadata: { doNotContact: true, archiveReason: 'manual_archive' }
    });

    // Caller attempts the action under a different account.
    const result = server.toolHandlers.run_linkedin_action({
      profileUrl: TARGET_URL,
      accountId: 'acc-different',
      actionType: 'view_profile'
    });

    assert.equal(result.ok, false);
    assert.equal(result.outcomeType, 'skipped_do_not_contact');
    // matchedAccountId records WHERE the opt-out came from, while accountId
    // records WHO tried — useful for operators auditing why a call was blocked.
    assert.equal(result.matchedAccountId, 'acc-origin');
    assert.equal(result.accountId, 'acc-different');

    assert.equal(countWorkflowRunsForProfile(db, TARGET_URL), 0);
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Unknown profile URL passes through (DNC blocks known opt-outs only)
// ---------------------------------------------------------------------------

test('unknown profile URL is not blocked: action creates an immediate visible manual run', () => {
  const workspace = createTempWorkspace('mcp-dnc-unknown-');
  const { server, stores, db } = setupServer(workspace);
  try {
    const result = server.toolHandlers.run_linkedin_action({
      profileUrl: 'https://www.linkedin.com/in/never-seen-before/',
      accountId: 'acc-test',
      actionType: 'view_profile'
    });

    assert.equal(result.ok, true);
    assert.ok(result.runId, 'expected runId for unknown-target action');
    assert.equal(result.status, 'queued');
    assert.equal(result.bypassWorkingHours, true);
    assert.equal(result.headless, false);

    // The run should be in SQLite.
    const row = db.prepare('SELECT id FROM workflow_runs WHERE id = ?').get(result.runId);
    assert.ok(row);

    // MCP one-shots are explicit operator commands. They must retain the same
    // immediate, visible execution semantics after persistence so the durable
    // scheduler cannot block them on account working hours.
    const persisted = stores.runs.getRun(result.runId);
    assert.equal(persisted.bypassWorkingHours, true);
    assert.equal(persisted.headless, false);
    assert.equal(persisted.launchSource, 'mcp_one_shot');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Active prospect (no DNC) passes through
// ---------------------------------------------------------------------------

test('active prospect with no DNC metadata does not block the action', () => {
  const workspace = createTempWorkspace('mcp-dnc-active-passthrough-');
  const { server, stores, db } = setupServer(workspace);
  try {
    stores.prospects.upsertProspect({
      profileUrl: TARGET_URL,
      accountId: 'acc-origin',
      fullName: 'Active Target',
      state: 'active',
      metadata: {} // explicitly no DNC
    });

    const result = server.toolHandlers.run_linkedin_action({
      profileUrl: TARGET_URL,
      accountId: 'acc-origin',
      actionType: 'send_dm',
      message: 'hello'
    });

    assert.equal(result.ok, true);
    assert.ok(result.runId);
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Helper-level unit tests for findBlockedRelatedProspect
// ---------------------------------------------------------------------------

test('findBlockedRelatedProspect returns null on falsy input', () => {
  assert.equal(findBlockedRelatedProspect(null, 'https://www.linkedin.com/in/x/'), null);
  assert.equal(findBlockedRelatedProspect({}, ''), null);
  assert.equal(findBlockedRelatedProspect({ prospects: {} }, ''), null);
});

test('findBlockedRelatedProspect swallows store errors, returns null, and warns once', () => {
  // A throwing prospect store should not crash the MCP handler. Returning null
  // means the action-router downstream gets to make the call with its own
  // independent DNC check. Catching here trades a small risk of bypass on a
  // corrupt store for resilience — and we log the first failure so an
  // operator can find it.
  _resetDoNotContactWarningStateForTests();

  const stores = {
    prospects: {
      getRelatedProspects() { throw new Error('store corrupted'); }
    }
  };

  // Capture stderr to verify the warning fires once and only once.
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    assert.equal(findBlockedRelatedProspect(stores, TARGET_URL), null);
    assert.equal(findBlockedRelatedProspect(stores, TARGET_URL), null);
    assert.equal(findBlockedRelatedProspect(stores, TARGET_URL), null);
  } finally {
    process.stderr.write = origWrite;
  }

  const warnings = captured.filter((line) => line.includes('DNC lookup failed'));
  assert.equal(warnings.length, 1, 'first failure logs; subsequent failures stay silent');
  assert.ok(warnings[0].includes('store corrupted'), 'warning should include the underlying error message');
  // The warning should redact the URL to a sha256 prefix, not log the raw URL.
  // This keeps the third party's profile slug out of stderr-redirected logs.
  assert.ok(warnings[0].includes('profileUrlHash='), 'warning should log a URL hash, not the raw URL');
  assert.equal(warnings[0].includes(TARGET_URL), false, 'warning should NOT contain the raw profile URL');
});

test('buildDoNotContactSkipResult emits the documented structure', () => {
  const result = buildDoNotContactSkipResult({
    summary: {
      blocked: true,
      reason: 'prospect_archived',
      doNotContact: true,
      archived: true,
      archiveReason: 'unsubscribe_received'
    },
    prospect: { id: 'p-1', accountId: 'acc-x' },
    profileUrl: TARGET_URL,
    accountId: 'acc-caller',
    actionType: 'send_dm'
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcomeType, 'skipped_do_not_contact');
  assert.equal(result.reason, 'prospect_archived');
  assert.equal(result.prospectId, 'p-1');
  assert.equal(result.matchedAccountId, 'acc-x');
  assert.equal(result.accountId, 'acc-caller');
  assert.equal(result.actionType, 'send_dm');
  assert.equal(result.archived, true);
  assert.equal(result.doNotContact, true);
  assert.equal(result.archiveReason, 'unsubscribe_received');
});
