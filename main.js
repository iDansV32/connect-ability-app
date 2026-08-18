// main.js (TOP OF FILE)
const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
require('dotenv').config();
const { terminateChildProcess } = require('./automation/core/process-control');
const { buildSpawnEnv } = require('./automation/safety/spawn-env-allowlist');

// Child env is built from an allowlist of process.env keys; secrets do not
// leak unless a call site explicitly opts in via options.env. See
// automation/safety/spawn-env-allowlist.js for the policy and the rationale
// behind each allowlisted key.

/**
 * Per-spawn additions for the LEGACY automation.js direct-login path.
 *
 * automation.js reads LINKEDIN_EMAIL / LINKEDIN_PASSWORD from process.env as
 * a credentials fallback (gated internally by CONNECT_ALLOW_ENV_CREDENTIALS).
 * Modern workers receive credentials via IPC and do NOT need these in their
 * env — only the legacy automation.js spawn sites do, and each one is already
 * fenced by assertLegacyDirectLoginAllowed at its IPC handler.
 *
 * We forward whatever the parent has (empty strings if unset) so the child's
 * own readEnvCredential gate decides whether to use them. If credentials live
 * in keychain, both LINKEDIN_EMAIL and LINKEDIN_PASSWORD will be empty here
 * and automation.js will fall back to the keychain path.
 */
function legacyAutomationSpawnEnv() {
  return {
    LINKEDIN_EMAIL: process.env.LINKEDIN_EMAIL || '',
    LINKEDIN_PASSWORD: process.env.LINKEDIN_PASSWORD || ''
  };
}

function spawnNodeRuntime(scriptPath, args = [], options = {}) {
  const env = buildSpawnEnv({
    additions: options.env || {},
    packaged: app.isPackaged
  });
  // Drop options.env from the spawn options spread so it doesn't clobber our
  // computed env when the caller also passed one.
  const { env: _ignoredEnv, ...spawnOptions } = options;

  if (app.isPackaged) {
    return spawn(process.execPath, [scriptPath, ...args], {
      ...spawnOptions,
      env
    });
  }

  return spawn('node', [scriptPath, ...args], {
    ...spawnOptions,
    env
  });
}

const messageScheduler = require('./message-scheduler');
const automation = require('./automation');
// linkedin-posting.js kept for reference; posting now dispatches through the account worker.
// const { publishLinkedInPostTask } = require('./linkedin-posting');
const {
  LINKEDIN_POST_PUBLISH_MAX_ATTEMPTS,
  getLinkedInPostPublishRetryDelayMs,
  isRetriableLinkedInPostPublishError
} = require('./post-publish-retry');
const { createLinkedInScheduledPostSession } = require('./linkedin-remote-scheduled-post-session');
const { syncScheduledPostsForAccount } = require('./scheduled-post-sync');
const SdrAgentManager = require('./sdr-agent-manager');
const AgentPersonaStore = require('./agent-persona-store');
const ActivityEventStore = require('./activity-event-store');
const ActivityAnalyticsService = require('./activity-analytics');
const ActivityExportService = require('./activity-export-service');
const DiagnosticsExportService = require('./diagnostics-export-service');
const LinkedInAccountHealthStore = require('./linkedin-account-health-store');
const RuntimeLogStore = require('./runtime-log-store');
const WorkflowRunManager = require('./workflow-run-manager');
const LinkedInReplyMonitor = require('./linkedin-reply-monitor');
const InboxStore = require('./inbox-store');
const ScheduledPostStore = require('./scheduled-post-store');
const WorkflowTemplateStore = require('./workflow-template-store');
const { mergeLegacyWorkflowUpdate } = require('./workflow-template-store');
const CampaignRunManager = require('./campaign-run-manager');
const ApolloPollStore = require('./apollo-poll-store');
const CampaignController = require('./campaign-controller');
const ProspectQueueStore = require('./prospect-queue-store');
const GroupDataStore = require('./group-data-store');
const ApolloSyncStore = require('./apollo-sync-store');
const ApolloSyncService = require('./apollo-sync-service');
const { shouldRouteWorkflowToCampaignController } = require('./campaign-routing');
const {
  pauseWorkflowRunFromLinkedIn,
  cancelWorkflowRunFromLinkedIn,
  resumeWorkflowRunFromLinkedIn
} = require('./linkedin-campaign-propagation');
const AccountWorkerProcessManager = require('./automation/runtime/account-worker-process-manager');
const { ACCOUNT_WORKER_MESSAGE_TYPES } = require('./automation/runtime/account-worker-protocol');
const { AccountSessionRegistry } = require('./automation/runtime/account-session-registry');
const {
  assertLegacyDirectLoginAllowed,
  isLegacyDirectLoginAllowed
} = require('./automation/runtime/legacy-direct-login-guard');
const { recordLegacyDirectLoginUsage } = require('./automation/runtime/legacy-direct-login-telemetry');
const { isWithinWorkingHours } = require('./automation/safety/working-hours');
const { evaluateLegacyScheduledMessageGate } = require('./automation/safety/legacy-schedule-gate');
const { normalizeDelayProfileSeed } = require('./automation/safety/account-delay-profile');
const { normalizeFingerprintProfileSeed } = require('./automation/safety/account-fingerprint-profile');
const { readEnvCredential } = require('./automation/safety/secret-source');
const { resolveRetryAfterCooldownMs, isRateLimitSignal } = require('./automation/safety/retry-after');
const {
  applyExternalApiSafety,
  filterExternalApiFunctions,
  filterExternalApiCatalog,
  filterExternalApiExamples
} = require('./external-api-safety');
const {
  parseAllowedOrigins,
  buildCorsHeaders,
  resolveServerBindDecision,
  compareTokenSafely
} = require('./external-api-policy');
const { normalizeSearchProvenance } = require('./automation/search/people-search-results');
const { buildProspectEnrichmentIndex, overlayProspectEnrichment } = require('./automation/profile/prospect-overlay');
const { buildProfileLookupIndex, enrichGroupMembers } = require('./automation/profile/group-member-enrichment');
const { buildAgentSearchPresets } = require('./agent-search-service');
const { buildAgentContentPlan } = require('./agent-content-plan-service');
const { classifyIntent } = require('./agents/reply-intent-service');
const { scoreProspect } = require('./agents/lead-score-service');
const { resolveAcceptedConnectionFollowUpPlan } = require('./accepted-connection-followup');
const { buildLinkedInAccountHealthSnapshot } = require('./linkedin-account-health-snapshot');
const { getMessageQuota } = require('./message-quota-store');
const {
  createWorkflowStepResult,
  didWorkflowStepPerformAction,
  getWorkflowStepEventStatus,
  isWorkflowStepFailure,
  isWorkflowStepSkipped,
  shouldStopWorkflowAfterStepResult,
  shouldRetryWorkflowStepResult
} = require('./workflow-step-result');
const { resolveDerivedWorkflowActivityEvents } = require('./workflow-derived-events');
const {
  deleteLinkedInAccountPassword,
  hasLinkedInAccountPassword,
  resolveLinkedInAccountCredentials,
  setLinkedInAccountPassword
} = require('./linkedin-credential-store');
const { createDurableWorkflowScheduler } = require('./automation/runtime/durable-workflow-scheduler');
const { installCrashHandlers } = require('./automation/runtime/crash-telemetry');
const { normalizeProxyConfig } = require('./automation/runtime/proxy-config');
const { resolveInternalStatePath, getConnectAbilityAppStateDir, writeJsonFileAtomic } = require('./connect-documents');
const { resolveSecret } = require('./automation/safety/secret-source');
const { openDatabase, closeDatabase } = require('./storage/sqlite-db');
const SqliteWorkflowRepository = require('./storage/sqlite-workflow-repository');
const SqliteScheduledPostRepository = require('./storage/sqlite-scheduled-post-repository');
const SqliteGroupRepository = require('./storage/sqlite-group-repository');
const { reconstructGroups } = require('./storage/group-reconstruction');
const { resolveGroupsReadSource } = require('./storage/groups-read-source');
const { importLegacyWorkflowData } = require('./storage/workflow-legacy-importer');
const { importScheduledPosts } = require('./storage/scheduled-post-legacy-importer');
const { importActivityEvents, importAccountHealth } = require('./storage/health-legacy-importer');
const { importProspects } = require('./storage/prospect-legacy-importer');
const { runLegacyImporters } = require('./storage/run-legacy-importers');
const {
  importNotifications,
  importReplyMonitorState,
  importInboxConversations
} = require('./storage/reply-monitor-legacy-importer');

// ---------------------------------------------------------------------------
// Process-level crash telemetry (installed before any side-effectful setup)
//
// Before this, an unhandledRejection or uncaughtException in main, scheduler,
// or one of the IPC handlers terminated the process with no record — the user
// saw the window disappear with no diagnostic. The handlers below write a
// JSON crash file per event into <userData>/crash-logs/ and continue. They
// deliberately do NOT change Node's default exit policy; their job is to make
// crashes *visible* so a future Electron/Node upgrade has a baseline to
// compare against. CONNECT_CRASH_LOG_DIR is stamped on the env so spawned
// workers (which inherit the spawn-env allowlist) write to the same dir.
// ---------------------------------------------------------------------------
const crashLogDir = path.join(app.getPath('userData'), 'crash-logs');
process.env.CONNECT_CRASH_LOG_DIR = crashLogDir;
installCrashHandlers({
  role: 'main',
  logDir: crashLogDir,
  context: { appVersion: app.getVersion(), electronVersion: process.versions.electron }
});

// Use console directly for logging
const logAction = (message) => console.log(`[MessageScheduler] ${message}`);
const logError = (message, error) => console.error(`[MessageScheduler Error] ${message}`, error || '');

// ⛔️ Remove logAction/logError from this destructure:
// If you still need functions from automation, list only those that exist.
const {
  processMessageSending,   // if you really use it
  sendBulkMessages,        // if you really use it
  personalizeMessage,
  getStoredProfileDetails,
  loginToLinkedIn
} = automation;

function waitMs(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, durationMs || 0)));
}

async function createScheduledPostSyncSession(accountId = null, emitLog = () => {}) {
  const credentials = await loadLinkedInCredentialsForPosting(accountId || null);
  if (!credentials) {
    return null;
  }
  return createLinkedInScheduledPostSession(credentials, emitLog);
}

const activePostPublishes = new Set();
const linkedInRuntimeJobs = new Map();
const sdrAgentManager = new SdrAgentManager();
const agentPersonaStore = new AgentPersonaStore();
// Initialized without SQLite here; re-assigned inside the try block below when
// better-sqlite3 is available.  Use `let` so closures always see the final value.
let activityEventStore = new ActivityEventStore();
let activityAnalyticsService = new ActivityAnalyticsService();
const activityExportService = new ActivityExportService();
const diagnosticsExportService = new DiagnosticsExportService();
let linkedInAccountHealthStore = new LinkedInAccountHealthStore();
const accountSessionRegistry = new AccountSessionRegistry();
const runtimeLogStore = new RuntimeLogStore();
// ---------------------------------------------------------------------------
// Open SQLite database and (on first run) import legacy JSON workflow data.
// Falls back to the JSON backend gracefully if better-sqlite3 is unavailable.
// ---------------------------------------------------------------------------
let _workflowDb = null;
let _workflowRepo = null;
// Phase C C2b-1: shared SQLite group writer for the save-groups-data
// dual-write. Null when SQLite is unavailable (JSON-only fallback).
let _sqliteGroupRepo = null;
try {
  const _dbPath = resolveInternalStatePath('connect-ability.db');
  _workflowDb = openDatabase(_dbPath);

  // One-time import: no-op when workflow_runs/workflow_jobs already have rows.
  const _importResult = importLegacyWorkflowData(_workflowDb, {
    runsPath: resolveInternalStatePath('workflow-runs.json'),
    jobsPath:  resolveInternalStatePath('workflow-step-jobs.json')
  });
  if (_importResult.imported) {
    console.log(
      `[sqlite] Migrated ${_importResult.runsCount} runs + ${_importResult.jobsCount} jobs from legacy JSON`
    );
  }

  _workflowRepo = new SqliteWorkflowRepository(_workflowDb);
  console.log('[sqlite] Workflow runs/jobs now backed by SQLite');

  // Phase C C2b-1: bind the shared group writer. Read path stays on JSON
  // until C2b-2; this only enables the save-groups-data best-effort sync.
  _sqliteGroupRepo = new SqliteGroupRepository(_workflowDb);

  // -------------------------------------------------------------------------
  // Migrate and activate SQLite for activity events and account health.
  // -------------------------------------------------------------------------
  const _eventsImport = importActivityEvents(_workflowDb, {
    eventsPath: resolveInternalStatePath('activity-events.jsonl')
  });
  if (_eventsImport.imported) {
    console.log(`[sqlite] Migrated ${_eventsImport.count} activity events from legacy JSONL`);
  }

  const _healthImport = importAccountHealth(_workflowDb, {
    storePath: resolveInternalStatePath('linkedin-account-health.json')
  });
  if (_healthImport.imported) {
    console.log(`[sqlite] Migrated ${_healthImport.count} account health records from legacy JSON`);
  }

  activityEventStore        = new ActivityEventStore({ db: _workflowDb, enableRetentionPrune: true });
  activityAnalyticsService  = new ActivityAnalyticsService({ db: _workflowDb });
  linkedInAccountHealthStore = new LinkedInAccountHealthStore({ db: _workflowDb });
  console.log('[sqlite] Activity events + account health now backed by SQLite');
} catch (_sqliteErr) {
  console.warn('[sqlite] SQLite unavailable — falling back to JSON store:', _sqliteErr.message);
}
const workflowRunManager = new WorkflowRunManager(_workflowRepo ? { repo: _workflowRepo } : {});
const campaignRunManager = new CampaignRunManager();
const apolloPollStore = new ApolloPollStore();
// Scheduled posts: migrate legacy JSON into SQLite once (idempotent), then
// construct the store with the SQLite-backed repo when available. This is
// the cross-process consistency fix discussed in the hardening series — MCP
// and the app now write to the same backend rather than racing on a JSON
// file.
//
// Import and repo-bind are split into two try blocks for a reason: an
// importer failure (malformed legacy JSON, partial write, etc.) is
// recoverable — the SQLite table may still be usable; warn and continue to
// the bind step. A repo bind failure when SQLite is otherwise up is NOT
// recoverable — silently falling back to the JSON store would recreate the
// split-backend class of bug. We throw to abort startup so the operator
// sees the failure immediately rather than discovering it via data drift.
let _scheduledPostRepo = null;
if (_workflowDb) {
  // Step 1: import. Best-effort; failure warns but does not block bind.
  try {
    const _scheduledPostsImport = importScheduledPosts(_workflowDb, {
      storePath: resolveInternalStatePath('scheduled-posts.json')
    });
    if (_scheduledPostsImport.imported) {
      const { count, skipped, skippedDuplicates } = _scheduledPostsImport;
      let skipSuffix = '';
      if (skipped) {
        // Split the count: malformed vs duplicate-id. Operator gets the
        // exact breakdown when something is dropped, nothing when the
        // migration is clean.
        const malformed = skipped - (Number(skippedDuplicates) || 0);
        const parts = [];
        if (malformed > 0) parts.push(`${malformed} malformed`);
        if (skippedDuplicates > 0) parts.push(`${skippedDuplicates} duplicate id`);
        skipSuffix = ` (${skipped} skipped: ${parts.join(', ')})`;
      }
      console.log(`[sqlite] Migrated ${count} scheduled posts from legacy JSON${skipSuffix}`);
    }
  } catch (_scheduledPostsImportErr) {
    console.warn(
      '[sqlite] Scheduled-post legacy import failed; the SQLite table may still be usable:',
      _scheduledPostsImportErr.message
    );
  }
  // Step 2: bind. Failure here means SQLite is up but the scheduled-post
  // repo cannot be constructed — fail closed.
  try {
    _scheduledPostRepo = new SqliteScheduledPostRepository(_workflowDb);
  } catch (_scheduledPostsBindErr) {
    console.error(
      '[sqlite] FATAL: scheduled-post repo bind failed while SQLite is otherwise available.',
      _scheduledPostsBindErr.message,
      '— refusing JSON fallback to prevent split-brain state. Investigate the DB or rebuild better-sqlite3.'
    );
    throw _scheduledPostsBindErr;
  }
}
// posts store: SQLite-backed when bound, JSON fallback only when SQLite
// wasn't attempted at all (no db). When _workflowDb is set but the repo
// bind threw above, we never reach here.
const scheduledPostStore = _scheduledPostRepo
  ? new ScheduledPostStore({ repo: _scheduledPostRepo })
  : new ScheduledPostStore();
const workflowTemplateStore = new WorkflowTemplateStore();
// Prospect store: use SQLite when available; fall back to JSON if not.
if (_workflowDb) {
  try {
    const _prospectsImport = importProspects(_workflowDb, {
      storePath: resolveInternalStatePath('prospect-queue.json')
    });
    if (_prospectsImport.imported) {
      console.log(`[sqlite] Migrated ${_prospectsImport.count} prospects from legacy JSON`);
    }
  } catch (_prospectsImportErr) {
    console.warn('[sqlite] Prospect import failed:', _prospectsImportErr.message);
  }
}
const prospectQueueStore = new ProspectQueueStore(_workflowDb ? { db: _workflowDb } : {});

// Phase B step 5 of roadmap #7: import legacy profiles.json + groups.json
// into the SQLite tables added by Phase A. The pure helper is responsible
// for orchestration; main.js owns the env check and the Electron path
// resolution. Gated by CONNECT_DISABLE_LEGACY_IMPORT=1 (operator escape
// hatch). All importer failure modes are absorbed into counters by the
// pure modules; this site only logs a final summary line per importer
// and never throws upward.
if (_workflowDb) {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE || '';
    const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
    const userDataDir = app.getPath('userData');
    runLegacyImporters({
      db: _workflowDb,
      prospectStore: prospectQueueStore,
      documentsDir,
      userDataDir,
      disabled: process.env.CONNECT_DISABLE_LEGACY_IMPORT === '1',
      logger: (msg) => console.log(msg)
    });
  } catch (_legacyImportErr) {
    console.warn('[legacy-import] startup wiring failed:', _legacyImportErr.message);
  }
}

// Inbox + reply-monitor state: migrate then switch to SQLite when available.
if (_workflowDb) {
  try {
    const _notifImport = importNotifications(_workflowDb, {
      statePath: resolveInternalStatePath('dm-reply-monitor.json')
    });
    if (_notifImport.imported) {
      console.log(`[sqlite] Migrated ${_notifImport.count} reply notifications from legacy JSON`);
    }
    const _monitorImport = importReplyMonitorState(_workflowDb, {
      statePath: resolveInternalStatePath('dm-reply-monitor.json')
    });
    if (_monitorImport.imported) {
      console.log(`[sqlite] Migrated ${_monitorImport.count} reply-monitor account states from legacy JSON`);
    }
    const _inboxImport = importInboxConversations(_workflowDb, {
      storePath: resolveInternalStatePath('inbox.json')
    });
    if (_inboxImport.imported) {
      console.log(`[sqlite] Migrated ${_inboxImport.count} inbox conversations from legacy JSON`);
    }
  } catch (_importErr) {
    console.warn('[sqlite] Reply-monitor/inbox import failed:', _importErr.message);
  }
}
const inboxStore = new InboxStore(_workflowDb ? { db: _workflowDb } : {});
const groupDataStore = new GroupDataStore();
const apolloSyncStore = new ApolloSyncStore();
const apolloSyncService = new ApolloSyncService({
  syncStore: apolloSyncStore,
  prospects: prospectQueueStore,
  templates: workflowTemplateStore,
  groups: groupDataStore
});
const campaignController = new CampaignController({
  campaignRuns: campaignRunManager,
  apolloPolls: apolloPollStore,
  workflowRuns: workflowRunManager,
  prospects: prospectQueueStore,
  createApolloClient: () => apolloSyncService.createClient()
});
const accountWorkerProcessManager = new AccountWorkerProcessManager({
  // P1-0 selected long-lived per-account child workers rather than in-process execution.
  spawnProcess: (workerScriptPath, args = [], spawnOptions = {}) => spawnNodeRuntime(workerScriptPath, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    ...spawnOptions
  }),
  recordActivityEvent: (eventInput) => recordActivityEventSafe(eventInput),
  onChallengeDetected: (payload) => handleLinkedInWorkerChallengeDetected(payload)
});
// Scheduler instance — owns activeDurableWorkflowJobs, schedulerBusy, and all execution logic.
// Use durableScheduler.getActiveJobs() instead of the old activeDurableWorkflowJobs map.
const durableScheduler = createDurableWorkflowScheduler({
  workflowRunManager,
  accountWorkerProcessManager,
  linkedInAccountHealthStore,
  prospectQueueStore,
  sdrAgentManager,
  campaignController,
  isWithinWorkingHours,
  scoreProspect,
  loadLinkedInCredentials:          (accountId) => loadLinkedInCredentialsForPosting(accountId),
  ensureLinkedInAccountsStore:      () => ensureLinkedInAccountsStore(),
  recordActivityEvent:              (eventInput) => recordActivityEventSafe(eventInput),
  updateProspectWorkflowProgress:   (prospectId, progress) => updateProspectWorkflowProgressSafe(prospectId, progress),
  emitWorkflowLog:                  (message, type, extra) => emitWorkflowLogMessage(message, type, extra),
  onRunStatusChange:                (status, runId) => {
    if (mainWindow) {
      mainWindow.webContents.send('workflow-done', { code: status === 'completed' ? 0 : 1, runId });
    }
  },
  broadcastWorkflowRunsUpdated:     (accountId) => broadcastSdrWorkflowRunsUpdated(accountId),
  broadcastCampaignRunsUpdated:     (accountId) => broadcastCampaignRunsUpdated(accountId),
  broadcastProspectsUpdated:        (accountId) => broadcastProspectsUpdated(accountId),
  retryApolloHeldRuns:              () => retryDueApolloHeldCampaignRuns(),
  processApolloCampaignPolls:       () => processDueApolloCampaignPolls(),
  registerRuntimeJob:               (opts) => registerLinkedInRuntimeJob(opts),
  unregisterRuntimeJob:             (jobId) => unregisterLinkedInRuntimeJob(jobId),
  createRuntimeJobId:               (type, accountId) => createLinkedInRuntimeJobId(type, accountId),
  recordWorkflowHealthSuccess:      (accountId) => recordLinkedInWorkflowHealthSuccess(accountId),
  // Accepts a string reason (legacy) OR an error/IPC-payload object so the
  // wrapper can extract httpStatus + retryAfterMs and pick a Retry-After-
  // aware cooldown duration. Scheduler call sites pass whatever they have.
  recordWorkflowHealthFailure:      (accountId, reasonOrError, meta) => recordLinkedInWorkflowHealthFailure(accountId, reasonOrError, meta),
  isAppReady:                       () => app.isReady()
});

const recentLinkedInChallengeNotifications = new Map();
let linkedInAccountsStoreReadyPromise = null;
let linkedInAccountsStoreReady = false;
const CAMPAIGN_APOLLO_HOLD_RETRY_INTERVAL_MS = 60 * 1000;
const CAMPAIGN_APOLLO_HOLD_MAX_ATTEMPTS = 5;
const CAMPAIGN_APOLLO_POLL_BATCH_LIMIT = 5;
const LINKEDIN_CHALLENGE_NOTIFICATION_THROTTLE_MS = 15 * 60 * 1000;
const CAMPAIGN_RUN_ORPHAN_TTL_MS = 5 * 60 * 1000;
const ALLOWED_WORKFLOW_STEP_TYPES = new Set(['view_profile', 'like_posts', 'send_connection', 'send_dm', 'delay', 'apollo_enroll_sequence']);
const MAIN_PROCESS_WORKFLOW_STEP_TYPES = new Set(['apollo_enroll_sequence']);
const ALLOWED_DELAY_UNITS = new Set(['hours', 'days', 'weeks', 'months']);
const ALLOWED_WORKFLOW_TARGET_TYPES = new Set(['group', 'profiles', 'manual']);
const ALLOWED_RECURRING_PATTERNS = new Set(['daily', 'weekly', 'monthly']);
const replyMonitor = new LinkedInReplyMonitor({
  db: _workflowDb || undefined,
  accountWorkerProcessManager,
  readAccounts: () => getLinkedInAccountsWithCredentials(),
  readAgents: () => sdrAgentManager.getAllAgents(),
  recordEvent: (eventInput) => recordActivityEventSafe(eventInput),
  notify: (notification) => notifyDmReplyReceived(notification),
  matchWorkflowRun: (payload) => matchDmReplyToWorkflowRun(payload),
  inboxStore,
  pauseWorkflowRun: (runId, options = {}) => {
    const outcome = pauseWorkflowRunFromLinkedIn({
      runId,
      options,
      workflowRuns: workflowRunManager,
      campaignController
    });
    if (outcome.workflowRun) {
      syncInboxStatusesForRun(runId, 'paused');
      broadcastSdrWorkflowRunsUpdated(outcome.workflowRun.accountId || outcome.previousRun?.accountId || null);
      if (outcome.campaignTransition?.campaignRun) {
        broadcastCampaignRunsUpdated(outcome.campaignTransition.campaignRun.accountId || outcome.previousRun?.accountId || null);
      }
    }
    return outcome.workflowRun;
  },
  cancelWorkflowRun: (runId, reason = 'Cancelled by user') => {
    const outcome = cancelWorkflowRunFromLinkedIn({
      runId,
      reason,
      workflowRuns: workflowRunManager,
      campaignController
    });
    if (outcome.workflowResult?.cancelled) {
      broadcastSdrWorkflowRunsUpdated(outcome.previousRun?.accountId || null);
      if (outcome.campaignTransition?.campaignRun) {
        broadcastCampaignRunsUpdated(outcome.campaignTransition.campaignRun.accountId || outcome.previousRun?.accountId || null);
      }
    }
    return outcome.workflowResult;
  },
  archiveProspect: (prospectId, options = {}) => archiveProspectSafe(prospectId, options),
  classifyIntent: (messageText) => classifyIntent(messageText),
  onInboxUpdated: (conversation) => broadcastInboxUpdated(conversation),
  extraShouldPollAccount: (account) => (
    !linkedInAccountHealthStore.isCoolingDown(account.id, 'replyMonitor')
    && !linkedInAccountHealthStore.isChallenged(account.id)
  ),
  onPollResult: ({ account, success, error }) => {
    if (!account?.id) return;
    if (success) {
      linkedInAccountHealthStore.recordSuccess(account.id, 'replyMonitor');
    } else {
      linkedInAccountHealthStore.recordFailure(account.id, 'replyMonitor', error?.message || error || 'Reply monitor poll failed');
    }
    broadcastLinkedInAccountHealthUpdated();
  }
});

function createLinkedInRuntimeJobId(type, accountId) {
  const safeType = String(type || 'runtime').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const safeAccountId = String(accountId || 'default').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  return `${safeType}-${safeAccountId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getLinkedInRuntimeJobsSnapshot() {
  return Array.from(linkedInRuntimeJobs.values())
    .map((job) => ({
      jobId: job.jobId,
      type: job.type,
      accountId: job.accountId,
      accountName: job.accountName,
      startedAt: job.startedAt,
      meta: job.meta || {}
    }))
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());
}

function broadcastLinkedInRuntimeJobs() {
  if (mainWindow) {
    mainWindow.webContents.send('linkedin-runtime-updated', getLinkedInRuntimeJobsSnapshot());
  }
}

function getLinkedInAccountHealthSnapshot() {
  const store = readLinkedInAccountsStore();
  return buildLinkedInAccountHealthSnapshot(
    store.accounts,
    linkedInAccountHealthStore.getAllAccountHealth(),
    accountSessionRegistry.readStore()
  );
}

function broadcastLinkedInAccountHealthUpdated() {
  if (mainWindow) {
    mainWindow.webContents.send('linkedin-account-health-updated', getLinkedInAccountHealthSnapshot());
  }
}

function broadcastInboxUpdated(conversation = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('inbox-updated', conversation || null);
  }
}

function recordLinkedInWorkflowHealthSuccess(accountId) {
  if (!accountId) return;
  linkedInAccountHealthStore.recordSuccess(accountId, 'workflow');
  broadcastLinkedInAccountHealthUpdated();
}

/**
 * Record a workflow-runtime failure for an account, optionally honoring a
 * Retry-After-derived cooldown.
 *
 * @param {string} accountId
 * @param {string|Error|object} reasonOrError
 *   - When a string: the failure reason (existing behavior).
 *   - When an Error/payload: the function reads `.message` for the reason
 *     and `.httpStatus` / `.retryAfterMs` / `.retryAfterHeader` for cooldown
 *     resolution. Worker IPC payloads in `msg.errorMeta` shape are also
 *     accepted (just pass them as the second arg).
 * @param {object} [meta]
 *   - `cooldownMs` — explicit override that wins over any extraction
 *
 * When the error is a 429-ish rate-limit signal AND we can resolve a
 * Retry-After-derived cooldown in ms, we pass it to
 * `linkedInAccountHealthStore.recordFailure` as `meta.cooldownMs`. The
 * store then honors it instead of the policy-default 6-hour
 * `severeCooldownMs`. Clamped to floor 60s / cap 24h inside the resolver.
 */
function recordLinkedInWorkflowHealthFailure(accountId, reasonOrError, meta = {}) {
  if (!accountId) return;

  // Normalize input. Accept string, Error, or worker-IPC errorMeta-style
  // payload — all flow through the same resolver path.
  const isStringReason = typeof reasonOrError === 'string';
  const reasonText = isStringReason
    ? reasonOrError
    : (reasonOrError?.message || reasonOrError?.error || 'Workflow runtime failure');

  // Build the cooldown signal. Honors meta.cooldownMs first, then falls
  // back to retry-after extraction from the error/payload.
  const errorLike = isStringReason ? { message: reasonOrError } : reasonOrError;
  let cooldownMs;
  if (Number.isFinite(Number(meta?.cooldownMs)) && Number(meta.cooldownMs) > 0) {
    cooldownMs = Number(meta.cooldownMs);
  } else if (isRateLimitSignal(errorLike)) {
    const resolved = resolveRetryAfterCooldownMs(errorLike);
    if (resolved !== null) cooldownMs = resolved;
  }

  const recordMeta = cooldownMs ? { cooldownMs } : undefined;
  linkedInAccountHealthStore.recordFailure(
    accountId,
    'workflow',
    reasonText || 'Workflow runtime failure',
    recordMeta
  );
  broadcastLinkedInAccountHealthUpdated();
}

function filterReplyMonitorState(state = {}, accountId = null) {
  const normalizedAccountId = String(accountId || '').trim() || null;
  if (!normalizedAccountId) {
    return state && typeof state === 'object' ? { ...state } : {};
  }

  const accounts = state?.accounts && typeof state.accounts === 'object'
    ? Object.fromEntries(
        Object.entries(state.accounts).filter(([nextAccountId]) => nextAccountId === normalizedAccountId)
      )
    : {};
  const notifications = state?.notifications && typeof state.notifications === 'object'
    ? Object.fromEntries(
        Object.entries(state.notifications).filter(([, notification]) => notification?.accountId === normalizedAccountId)
      )
    : {};

  return {
    version: state?.version || null,
    lastPolledAt: state?.lastPolledAt || null,
    accounts,
    notifications
  };
}

function syncInboxStatusesForRun(runId, status) {
  const normalizedRunId = String(runId || '').trim();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!normalizedRunId || !normalizedStatus) {
    return [];
  }

  const conversations = inboxStore.getAll();
  const updated = conversations
    .filter((conversation) => conversation.runId === normalizedRunId)
    .map((conversation) => inboxStore.setStatus(conversation.conversationUrn, normalizedStatus))
    .filter(Boolean);
  if (updated.length > 0) {
    broadcastInboxUpdated();
  }
  return updated;
}

function buildAccountWorkerDispatchAccount(credentials = {}) {
  if (!credentials?.email || !credentials?.password) {
    return null;
  }

  return {
    accountId: credentials.id || null,
    accountName: credentials.name || credentials.email,
    id: credentials.id || null,
    name: credentials.name || credentials.email,
    email: credentials.email,
    password: credentials.password,
    warmUpStartedAt: credentials.warmUpStartedAt || null,
    fingerprintProfileSeed: credentials.fingerprintProfileSeed || null,
    delayProfileSeed: credentials.delayProfileSeed || null,
    strictStealth: credentials.strictStealth === true,
    proxy: credentials.proxy || null,
    headless: false,
    slowMo: 50
  };
}

async function verifyLinkedInAccountSession(accountId) {
  const credentials = await loadLinkedInAccountCredentials(accountId);
  const account = buildAccountWorkerDispatchAccount(credentials);
  if (!account) {
    throw new Error('LinkedIn account credentials are unavailable');
  }

  const requestId = `verify-session-${account.id || account.email || 'account'}-${Date.now()}`;
  const response = await accountWorkerProcessManager.dispatchAndAwaitMessage(
    account,
    {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.VERIFY_SESSION,
      requestId
    },
    {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.VERIFY_SESSION_RESULT,
      timeoutMs: 2 * 60 * 1000,
      timeoutLabel: `session verification for ${account.email}`,
      closedLabel: `session verification for ${account.email}`,
      matchMessage: (message) => (
        message?.type === ACCOUNT_WORKER_MESSAGE_TYPES.VERIFY_SESSION_RESULT
        && message?.requestId === requestId
      )
    }
  );

  if (response?.ok) {
    return response;
  }

  throw new Error(response?.error || 'LinkedIn session verification failed');
}

async function getInboxConversationThread(conversationUrn, options = {}) {
  const normalizedConversationUrn = String(conversationUrn || '').trim();
  if (!normalizedConversationUrn) {
    throw new Error('conversationUrn is required');
  }

  const conversation = inboxStore.getConversation(normalizedConversationUrn);
  if (!conversation) {
    throw new Error('Conversation not found');
  }

  if (options.refresh === false) {
    return conversation;
  }

  if (!conversation.accountId) {
    throw new Error('Conversation is not linked to a LinkedIn account');
  }

  const credentials = await loadLinkedInAccountCredentials(conversation.accountId);
  const account = buildAccountWorkerDispatchAccount(credentials);
  if (!account) {
    throw new Error('LinkedIn account credentials are unavailable for this conversation');
  }

  const requestId = `inbox-thread-${normalizedConversationUrn}-${Date.now()}`;
  const result = await accountWorkerProcessManager.dispatchAndAwaitMessage(
    account,
    {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.FETCH_INBOX_THREAD,
      requestId,
      conversationUrn: normalizedConversationUrn,
      mailboxUrn: conversation.mailboxUrn || null
    },
    {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.FETCH_INBOX_THREAD_RESULT,
      timeoutMs: 2 * 60 * 1000,
      timeoutLabel: `inbox thread for ${normalizedConversationUrn}`,
      closedLabel: `inbox thread for ${normalizedConversationUrn}`,
      matchMessage: (payload) => (
        payload?.type === ACCOUNT_WORKER_MESSAGE_TYPES.FETCH_INBOX_THREAD_RESULT
        && payload?.requestId === requestId
      )
    }
  );

  if (result?.error) {
    throw new Error(result.error);
  }

  const thread = result?.thread || {};
  const updatedConversation = inboxStore.upsert(normalizedConversationUrn, {
    mailboxUrn: thread.mailboxUrn || conversation.mailboxUrn || null,
    participantProfileUrn: thread.participantProfileUrn || conversation.participantProfileUrn || null,
    messages: Array.isArray(thread.messages) ? thread.messages : []
  });
  broadcastInboxUpdated(updatedConversation);
  return updatedConversation;
}

async function sendInboxConversationReply(payload = {}) {
  const conversationUrn = String(payload?.conversationUrn || '').trim();
  const text = String(payload?.text || '').trim();
  if (!conversationUrn) {
    throw new Error('conversationUrn is required');
  }
  if (!text) {
    throw new Error('Reply text is required');
  }

  const conversation = inboxStore.getConversation(conversationUrn);
  if (!conversation) {
    throw new Error('Conversation not found');
  }
  if (conversation.status === 'suppressed') {
    throw new Error('Cannot reply to a do-not-contact conversation');
  }
  if (conversation.status === 'resolved') {
    throw new Error('Cannot reply to an archived conversation');
  }
  if (!conversation.accountId) {
    throw new Error('Conversation is not linked to a LinkedIn account');
  }

  const credentials = await loadLinkedInAccountCredentials(conversation.accountId);
  const account = buildAccountWorkerDispatchAccount(credentials);
  if (!account) {
    throw new Error('LinkedIn account credentials are unavailable for this conversation');
  }

  const requestId = `inbox-reply-${conversationUrn}-${Date.now()}`;
  const result = await accountWorkerProcessManager.dispatchAndAwaitMessage(
    account,
    {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.SEND_INBOX_REPLY,
      requestId,
      conversationUrn,
      mailboxUrn: conversation.mailboxUrn || null,
      recipientProfileUrn: conversation.participantProfileUrn || null,
      text
    },
    {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.SEND_INBOX_REPLY_RESULT,
      timeoutMs: 3 * 60 * 1000,
      timeoutLabel: `inbox reply for ${conversationUrn}`,
      closedLabel: `inbox reply for ${conversationUrn}`,
      matchMessage: (message) => (
        message?.type === ACCOUNT_WORKER_MESSAGE_TYPES.SEND_INBOX_REPLY_RESULT
        && message?.requestId === requestId
      )
    }
  );

  if (result?.error) {
    throw new Error(result.error);
  }

  const replyResult = result?.replyResult || {};
  const updatedConversation = inboxStore.appendMessages(conversationUrn, [replyResult.message].filter(Boolean), {
    mailboxUrn: replyResult.mailboxUrn || conversation.mailboxUrn || null,
    participantProfileUrn: replyResult.participantProfileUrn || conversation.participantProfileUrn || null,
    lastMessagePreview: replyResult.message?.text || conversation.lastMessagePreview || null
  }) || conversation;
  broadcastInboxUpdated(updatedConversation);

  return {
    conversation: updatedConversation,
    message: replyResult.message || null,
    response: replyResult.response || null
  };
}

function registerLinkedInRuntimeJob({ jobId, type, accountId, accountName, process, meta = {} }) {
  const runtimeJobId = jobId || createLinkedInRuntimeJobId(type, accountId);
  linkedInRuntimeJobs.set(runtimeJobId, {
    jobId: runtimeJobId,
    type: type || 'runtime',
    accountId: accountId || null,
    accountName: accountName || null,
    process,
    meta,
    startedAt: new Date().toISOString()
  });
  broadcastLinkedInRuntimeJobs();
  return runtimeJobId;
}

function unregisterLinkedInRuntimeJob(jobId) {
  if (!jobId) return;
  linkedInRuntimeJobs.delete(jobId);
  broadcastLinkedInRuntimeJobs();
}

function cleanupTempConfig(configPath, contextLabel = 'temporary config') {
  if (!configPath) return;
  try {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  } catch (error) {
    console.error(`Failed to delete ${contextLabel}:`, error);
  }
}

function stopLinkedInRuntimeJobs(filters = {}) {
  const matchedJobs = Array.from(linkedInRuntimeJobs.values()).filter((job) => {
    if (filters.jobId && job.jobId !== filters.jobId) return false;
    if (filters.accountId && job.accountId !== filters.accountId) return false;
    if (filters.type && job.type !== filters.type) return false;
    return true;
  });

  matchedJobs.forEach((job) => {
    terminateChildProcess(job.process);
  });

  return matchedJobs.length;
}

function broadcastSdrAgentsUpdated(accountId = null) {
  if (mainWindow) {
    mainWindow.webContents.send('sdr-agents-updated', getVisibleSdrAgents({ accountId }));
  }
}

function broadcastSdrWorkflowRunsUpdated(accountId = null) {
  if (mainWindow) {
    mainWindow.webContents.send('sdr-workflow-runs-updated', getVisibleSdrWorkflowRuns({ accountId }));
  }
}

function broadcastCampaignRunsUpdated(accountId = null) {
  if (mainWindow) {
    mainWindow.webContents.send('campaign-runs-updated', getVisibleCampaignRuns({ accountId }));
  }
}

function getVisibleSdrProspects(filters = {}) {
  return prospectQueueStore.getAllProspects(getScopedProspectFilters(filters));
}

function broadcastProspectsUpdated(accountId = null) {
  if (mainWindow) {
    mainWindow.webContents.send('prospects-updated', getVisibleSdrProspects({ accountId }));
  }
}

function getLinkedInAccountScope(accountId = null) {
  const store = ensureLinkedInAccountsStore();
  const requestedAccountId = sanitizeOptionalId(accountId, 120);
  const matchedAccount = requestedAccountId
    ? store.accounts.find((account) => account.id === requestedAccountId) || null
    : getActiveLinkedInAccountRecord(store);

  return {
    accountId: matchedAccount?.id || requestedAccountId || null,
    accountName: matchedAccount?.name || matchedAccount?.email || null,
    isMultiAccount: (store?.accounts?.length || 0) > 1
  };
}

function isRecordVisibleForAccount(record, scope = getLinkedInAccountScope()) {
  const recordAccountId = sanitizeOptionalId(record?.accountId, 120);
  if (scope.accountId) {
    if (recordAccountId) {
      return recordAccountId === scope.accountId;
    }
    return !scope.isMultiAccount;
  }
  return !recordAccountId;
}

function getVisibleSdrAgents(filters = {}) {
  const scope = getLinkedInAccountScope(filters?.accountId || null);
  return sdrAgentManager
    .getAllAgents()
    .filter((agent) => isRecordVisibleForAccount(agent, scope));
}

function getVisibleSdrWorkflowRuns(filters = {}) {
  const scope = getLinkedInAccountScope(filters?.accountId || null);
  return workflowRunManager
    .getAllRuns()
    .filter((run) => isRecordVisibleForAccount(run, scope));
}

function getVisibleCampaignRuns(filters = {}) {
  const scope = getLinkedInAccountScope(filters?.accountId || null);
  return campaignRunManager
    .getAllRuns()
    .filter((run) => isRecordVisibleForAccount(run, scope));
}

function getScopedProspectFilters(filters = {}) {
  return {
    ...(filters && typeof filters === 'object' ? filters : {}),
    accountId: sanitizeOptionalId(filters?.accountId, 120) || getLinkedInAccountScope().accountId || null
  };
}

function getVisibleScheduledPosts(accountId = null) {
  const scope = getLinkedInAccountScope(accountId);
  return scheduledPostStore
    .getAllPosts()
    .filter((post) => isRecordVisibleForAccount(post, scope));
}

function replaceVisibleScheduledPosts(posts = [], accountId = null) {
  const scope = getLinkedInAccountScope(accountId);
  const persistedPosts = scheduledPostStore.replacePostsForAccount(scope.accountId || null, posts, {
    accountName: scope.accountName || null
  });
  return persistedPosts.filter((post) => isRecordVisibleForAccount(post, scope));
}

function getVisibleScheduledMessages(accountId = null) {
  if (!messageScheduler || typeof messageScheduler.getScheduledMessages !== 'function') {
    return [];
  }
  const scope = getLinkedInAccountScope(accountId);
  return messageScheduler
    .getScheduledMessages()
    .filter((schedule) => isRecordVisibleForAccount(schedule, scope));
}

function resolveScheduledMessageRequest(scheduleIdOrPayload, fallbackFilters = {}) {
  const request = scheduleIdOrPayload && typeof scheduleIdOrPayload === 'object' && !Array.isArray(scheduleIdOrPayload)
    ? scheduleIdOrPayload
    : {
        scheduleId: scheduleIdOrPayload,
        ...(fallbackFilters && typeof fallbackFilters === 'object' ? fallbackFilters : {})
      };
  const scope = getLinkedInAccountScope(request.accountId || fallbackFilters?.accountId || null);
  const scheduleId = sanitizeRequiredId(request.scheduleId ?? request.id, 160, 'scheduleId');
  const schedule = getVisibleScheduledMessages(scope.accountId || null)
    .find((candidate) => candidate.id === scheduleId) || null;
  return {
    scheduleId,
    accountId: scope.accountId || null,
    schedule
  };
}

function broadcastScheduledMessagesUpdated(accountId = null) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const activeScope = getLinkedInAccountScope();
  const targetAccountId = activeScope.accountId || sanitizeOptionalId(accountId, 120) || null;
  mainWindow.webContents.send('scheduled-messages-loaded', getVisibleScheduledMessages(targetAccountId));
}

function getProfilesStorePath() {
  const userHome = process.env.HOME || process.env.USERPROFILE;
  return path.join(userHome, 'Documents', 'Connect-Ability', 'profiles.json');
}

function ensureProfilesStoreDirectory(profilesPath = getProfilesStorePath()) {
  const profilesDir = path.dirname(profilesPath);
  if (!fs.existsSync(profilesDir)) {
    fs.mkdirSync(profilesDir, { recursive: true });
  }
  return profilesDir;
}

function getScopedProfileKey(profileUrl, accountId = null) {
  return `${sanitizeOptionalId(accountId, 120) || '__legacy__'}::${normalizeProfileUrl(profileUrl)}`;
}

function normalizeStoredProfileRecord(profile = {}) {
  const normalizedUrl = normalizeProfileUrl(
    profile.url || profile.originalUrl || profile.linkedInProfileUrl || profile.linkedInUrl || profile.profileUrl || ''
  );
  const safeFirstName = String(profile.firstName || '').trim();
  const safeLastName = String(profile.lastName || '').trim();
  const safeFullName = String(profile.fullName || `${safeFirstName} ${safeLastName}`.trim() || 'Unknown Profile').trim();
  const originalUrl = String(
    profile.originalUrl || profile.linkedInProfileUrl || profile.linkedInUrl || profile.profileUrl || profile.url || normalizedUrl
  ).trim();

  return {
    ...profile,
    url: normalizedUrl,
    originalUrl: originalUrl || normalizedUrl,
    linkedInProfileUrl: originalUrl || normalizedUrl,
    firstName: safeFirstName,
    lastName: safeLastName,
    fullName: safeFullName || 'Unknown Profile',
    title: String(profile.title || profile.position || profile.headline || '').trim(),
    company: String(profile.company || profile.companyName || profile.organization || '').trim(),
    email: String(profile.email || profile.emailAddress || profile.email_address || 'Not Available').trim() || 'Not Available',
    accountId: sanitizeOptionalId(profile.accountId, 120),
    accountName: sanitizeSingleLineText(profile.accountName || '', 160) || null,
    actions: Array.isArray(profile.actions)
      ? profile.actions
          .filter((action) => action && typeof action === 'object')
          .map((action) => ({
            ...action,
            type: String(action.type || '').trim(),
            timestamp: action.timestamp || new Date().toISOString(),
            notes: typeof action.notes === 'string' ? action.notes : '',
            searchQuery: action.searchQuery || null
          }))
      : []
  };
}

function loadAllStoredProfiles() {
  const profilesPath = getProfilesStorePath();
  if (!fs.existsSync(profilesPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    return Array.isArray(parsed) ? parsed.map((profile) => normalizeStoredProfileRecord(profile)).filter(Boolean) : [];
  } catch (error) {
    console.error('Error reading profiles file:', error);
    return [];
  }
}

function getVisibleStoredProfiles(accountId = null) {
  const scope = getLinkedInAccountScope(accountId);
  return loadAllStoredProfiles().filter((profile) => isRecordVisibleForAccount(profile, scope));
}

function findStoredProfileIndex(profiles, profileUrl, scope) {
  const normalizedUrl = normalizeProfileUrl(profileUrl);
  return profiles.findIndex((profile) => {
    const candidateUrl = normalizeProfileUrl(
      profile?.url || profile?.originalUrl || profile?.linkedInProfileUrl || profile?.linkedInUrl || profile?.profileUrl || ''
    );
    return candidateUrl === normalizedUrl && isRecordVisibleForAccount(profile, scope);
  });
}

function broadcastActivityAnalyticsUpdated(event = null) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('activity-analytics-updated', {
    accountId: event?.accountId || null,
    agentId: event?.agentId || null,
    workflowId: event?.workflowId || null,
    eventType: event?.type || null,
    timestamp: event?.timestamp || new Date().toISOString()
  });
}

function truncateNotificationText(value, maxLength = 160) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function sanitizeSingleLineText(value, maxLength = 160) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeMultilineText(value, maxLength = 2000) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\0/g, '')
    .trim()
    .slice(0, maxLength);
}

function sanitizeOptionalId(value, maxLength = 160) {
  const text = sanitizeSingleLineText(value, maxLength);
  return text || null;
}

function sanitizeRequiredId(value, maxLength = 160, fieldName = 'id') {
  const text = sanitizeSingleLineText(value, maxLength);
  if (!text) {
    throw new Error(`${fieldName} is required`);
  }
  return text;
}

function sanitizeBoolean(value, defaultValue = false) {
  return typeof value === 'boolean' ? value : defaultValue;
}

function sanitizeInteger(value, options = {}) {
  const {
    fieldName = 'value',
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    defaultValue = null
  } = options;

  if (value === null || typeof value === 'undefined' || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

function sanitizeIsoDateTime(value, options = {}) {
  const { fieldName = 'date/time', allowNull = false } = options;
  const text = sanitizeSingleLineText(value, 80);
  if (!text) {
    if (allowNull) return null;
    throw new Error(`${fieldName} is required`);
  }

  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) {
    throw new Error(`${fieldName} must be a valid date/time`);
  }

  return new Date(timestamp).toISOString();
}

function sanitizeDateString(value, fieldName = 'date') {
  const text = sanitizeSingleLineText(value, 32);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${fieldName} must be in YYYY-MM-DD format`);
  }
  const timestamp = Date.parse(`${text}T12:00:00Z`);
  if (Number.isNaN(timestamp)) {
    throw new Error(`${fieldName} must be a valid calendar date`);
  }
  return text;
}

function sanitizeTimeString(value, fieldName = 'time') {
  const text = sanitizeSingleLineText(value, 16);
  if (!text) return null;
  if (!/^\d{2}:\d{2}$/.test(text)) {
    throw new Error(`${fieldName} must be in HH:mm format`);
  }
  const [hours, minutes] = text.split(':').map((part) => Number(part));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`${fieldName} must be a valid 24-hour time`);
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function sanitizeJsonObject(value, options = {}) {
  const { fieldName = 'payload', maxBytes = 12000 } = options;
  if (value === null || typeof value === 'undefined') {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const serialized = JSON.stringify(value);
  if (!serialized) {
    return {};
  }
  if (serialized.length > maxBytes) {
    throw new Error(`${fieldName} is too large`);
  }

  return JSON.parse(serialized);
}

function sanitizeStringArray(value, options = {}) {
  const {
    fieldName = 'list',
    maxItems = 100,
    maxLength = 280,
    allowEmpty = true
  } = options;

  if (!Array.isArray(value)) {
    if (allowEmpty && (value === null || typeof value === 'undefined' || value === '')) {
      return [];
    }
    throw new Error(`${fieldName} must be an array`);
  }

  if (value.length > maxItems) {
    throw new Error(`${fieldName} exceeds the maximum of ${maxItems} items`);
  }

  const seen = new Set();
  return value
    .map((entry) => sanitizeSingleLineText(entry, maxLength))
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sanitizeWorkflowActions(actions) {
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    return {
      viewProfile: false,
      likePosts: false,
      sendConnection: false,
      sendDm: false
    };
  }

  return {
    viewProfile: !!actions.viewProfile,
    likePosts: !!actions.likePosts,
    sendConnection: !!actions.sendConnection,
    sendDm: !!actions.sendDm
  };
}

function sanitizeWorkflowStep(step, index) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`steps[${index}] must be an object`);
  }

  const type = sanitizeSingleLineText(step.type, 64).toLowerCase();
  if (!ALLOWED_WORKFLOW_STEP_TYPES.has(type)) {
    throw new Error(`steps[${index}].type is invalid`);
  }

  const sanitizedStep = {
    type,
    minDelayMs: sanitizeInteger(step.minDelayMs, {
      fieldName: `steps[${index}].minDelayMs`,
      min: 0,
      max: 365 * 24 * 60 * 60 * 1000,
      defaultValue: type === 'delay' ? 60 * 60 * 1000 : 8000
    }),
    maxDelayMs: null
  };

  sanitizedStep.maxDelayMs = sanitizeInteger(step.maxDelayMs, {
    fieldName: `steps[${index}].maxDelayMs`,
    min: sanitizedStep.minDelayMs,
    max: 365 * 24 * 60 * 60 * 1000,
    defaultValue: type === 'delay' ? sanitizedStep.minDelayMs : 18000
  });

  if (type === 'delay') {
    const delayValue = sanitizeInteger(step.delayValue ?? step.delayAmount, {
      fieldName: `steps[${index}].delayValue`,
      min: 1,
      max: 365,
      defaultValue: 1
    });
    const delayUnit = sanitizeSingleLineText(step.delayUnit, 16).toLowerCase() || 'hours';
    if (!ALLOWED_DELAY_UNITS.has(delayUnit)) {
      throw new Error(`steps[${index}].delayUnit is invalid`);
    }
    sanitizedStep.delayValue = delayValue;
    sanitizedStep.delayAmount = delayValue;
    sanitizedStep.delayUnit = delayUnit;
  }

  if (type === 'send_connection' || type === 'send_dm') {
    sanitizedStep.messageTemplate = sanitizeMultilineText(step.messageTemplate, 1600);
  }

  if (type === 'apollo_enroll_sequence') {
    const sequenceId = sanitizeOptionalId(
      step.apolloSequenceId
      || step.sequenceId
      || step.sequence?.id,
      160
    );
    if (!sequenceId) {
      throw new Error(`steps[${index}].sequenceId is required for apollo_enroll_sequence`);
    }
    sanitizedStep.sequenceId = sequenceId;
    sanitizedStep.apolloSequenceId = sequenceId;
    sanitizedStep.sequenceName = sanitizeSingleLineText(step.sequenceName || step.sequence?.name, 200) || null;
    sanitizedStep.emailAccountId = sanitizeOptionalId(step.emailAccountId, 160);
  }

  return sanitizedStep;
}

function sanitizeSdrAgentPayload(agentInput) {
  if (!agentInput || typeof agentInput !== 'object' || Array.isArray(agentInput)) {
    throw new Error('Agent payload must be an object');
  }

  return {
    id: sanitizeOptionalId(agentInput.id, 160),
    name: sanitizeSingleLineText(agentInput.name, 120),
    accountId: sanitizeOptionalId(agentInput.accountId, 120),
    accountName: sanitizeSingleLineText(agentInput.accountName, 160) || null,
    niche: sanitizeSingleLineText(agentInput.niche, 240),
    personaTitles: sanitizeStringArray(agentInput.personaTitles, {
      fieldName: 'personaTitles',
      maxItems: 30,
      maxLength: 120
    }),
    searchKeywords: sanitizeStringArray(agentInput.searchKeywords, {
      fieldName: 'searchKeywords',
      maxItems: 40,
      maxLength: 120
    }),
    connectionNoteTemplate: sanitizeMultilineText(agentInput.connectionNoteTemplate, 500),
    dmTemplatePrimary: sanitizeMultilineText(agentInput.dmTemplatePrimary, 1200),
    dmTemplateFollowUp: sanitizeMultilineText(agentInput.dmTemplateFollowUp, 1200),
    contentPillars: sanitizeStringArray(agentInput.contentPillars, {
      fieldName: 'contentPillars',
      maxItems: 20,
      maxLength: 120
    }),
    postCadence: sanitizeSingleLineText(agentInput.postCadence, 40) || 'daily',
    timezone: sanitizeSingleLineText(agentInput.timezone, 80) || 'America/Chicago',
    notifications: {
      dmReplies: sanitizeBoolean(agentInput.notifications?.dmReplies, true),
      workflowFailures: sanitizeBoolean(agentInput.notifications?.workflowFailures, true)
    },
    status: sanitizeSingleLineText(agentInput.status, 40) || 'active',
    metadata: sanitizeJsonObject(agentInput.metadata, {
      fieldName: 'agent metadata',
      maxBytes: 4000
    })
  };
}

function sanitizeSdrAgentContentPlanPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Content plan payload must be an object');
  }

  const startDate = sanitizeDateString(payload.startDate, 'startDate') || null;
  if (startDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const requestedStart = new Date(`${startDate}T00:00:00`);
    if (requestedStart.getTime() < today.getTime()) {
      throw new Error('startDate must be today or later');
    }
  }

  return {
    agentId: sanitizeRequiredId(payload.agentId, 160, 'agentId'),
    days: sanitizeInteger(payload.days, {
      fieldName: 'days',
      min: 7,
      max: 90,
      defaultValue: 90
    }),
    startDate,
    postingTime: sanitizeTimeString(payload.postingTime, 'postingTime') || '09:00',
    replaceExisting: sanitizeBoolean(payload.replaceExisting, true)
  };
}

function sanitizePublishPostPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Post payload must be an object');
  }

  const content = sanitizeMultilineText(payload.content ?? payload.text ?? payload.postText, 3200);
  if (!content) {
    throw new Error('Post content is required');
  }

  const immediate = typeof payload.immediate === 'boolean'
    ? payload.immediate
    : !(payload.scheduledDate || payload.scheduledTime);
  const includeImage = !!payload.includeImage;
  const imagePath = includeImage ? sanitizeSingleLineText(payload.imagePath, 1024) : null;

  if (includeImage && !imagePath) {
    throw new Error('Image path is required when image upload is enabled');
  }

  return {
    ...payload,
    postId: sanitizeOptionalId(payload.postId, 160),
    accountId: sanitizeOptionalId(payload.accountId, 160),
    accountName: sanitizeSingleLineText(payload.accountName, 160) || null,
    workflowId: sanitizeOptionalId(payload.workflowId, 160),
    workflowName: sanitizeSingleLineText(payload.workflowName, 160) || null,
    content,
    text: content,
    postText: content,
    immediate,
    includeImage,
    imagePath,
    visibility: sanitizeSingleLineText(payload.visibility, 40) || 'public',
    scheduledDate: immediate ? null : sanitizeSingleLineText(payload.scheduledDate, 32),
    scheduledTime: immediate ? null : sanitizeSingleLineText(payload.scheduledTime, 32),
    launchSource: sanitizeSingleLineText(payload.launchSource, 40) || null
  };
}

function sanitizeGroupRecord(group, index) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new Error(`groups[${index}] must be an object`);
  }

  const name = sanitizeSingleLineText(group.name, 160) || 'Untitled Group';
  return {
    id: sanitizeOptionalId(group.id, 160) || `group-${index + 1}`,
    name,
    description: sanitizeMultilineText(group.description, 500),
    members: sanitizeStringArray(group.members, {
      fieldName: `groups[${index}].members`,
      maxItems: 5000,
      maxLength: 400
    }),
    color: sanitizeSingleLineText(group.color, 32) || '#0a66c2',
    createdAt: sanitizeIsoDateTime(group.createdAt, {
      fieldName: `groups[${index}].createdAt`,
      allowNull: true
    }),
    updatedAt: sanitizeIsoDateTime(group.updatedAt, {
      fieldName: `groups[${index}].updatedAt`,
      allowNull: true
    })
  };
}

function sanitizeGroupsPayload(groups) {
  if (!Array.isArray(groups)) {
    throw new Error('Groups payload must be an array');
  }

  if (groups.length > 500) {
    throw new Error('Groups payload exceeds the maximum of 500 groups');
  }

  return groups.map((group, index) => sanitizeGroupRecord(group, index));
}

function sanitizeScheduleMessageInput(messageData) {
  if (!messageData || typeof messageData !== 'object' || Array.isArray(messageData)) {
    throw new Error('Scheduled message payload must be an object');
  }

  const options = sanitizeJsonObject(messageData.options, {
    fieldName: 'message options',
    maxBytes: 4000
  });
  const recurringPattern = sanitizeSingleLineText(
    options.recurringPattern ?? messageData.recurringPattern,
    32
  ).toLowerCase();

  if (recurringPattern && !ALLOWED_RECURRING_PATTERNS.has(recurringPattern)) {
    throw new Error('Recurring pattern is invalid');
  }

  return {
    profileIds: sanitizeStringArray(messageData.profileIds, {
      fieldName: 'profileIds',
      maxItems: 5000,
      maxLength: 400,
      allowEmpty: false
    }),
    message: sanitizeMultilineText(messageData.message, 3000),
    scheduledTime: sanitizeIsoDateTime(messageData.scheduledTime || new Date().toISOString(), {
      fieldName: 'scheduledTime'
    }),
    accountId: sanitizeOptionalId(messageData.accountId ?? options.accountId, 120),
    options: {
      ...options,
      accountId: sanitizeOptionalId(options.accountId ?? messageData.accountId, 120),
      recurring: sanitizeBoolean(options.recurring ?? messageData.recurring, false),
      recurringPattern: recurringPattern || null,
      maxRecurrences: sanitizeInteger(options.maxRecurrences ?? messageData.maxRecurrences, {
        fieldName: 'maxRecurrences',
        min: 1,
        max: 365,
        defaultValue: 1
      })
    }
  };
}

function sanitizeLegacyWorkflowPayload(workflowData) {
  if (!workflowData || typeof workflowData !== 'object' || Array.isArray(workflowData)) {
    throw new Error('Workflow payload must be an object');
  }

  const name = sanitizeSingleLineText(workflowData.name, 160);
  if (!name) {
    throw new Error('Workflow name is required');
  }

  return {
    name,
    description: sanitizeMultilineText(workflowData.description, 1000),
    profileIds: sanitizeStringArray(workflowData.profileIds, {
      fieldName: 'profileIds',
      maxItems: 5000,
      maxLength: 400
    }),
    actions: sanitizeWorkflowActions(workflowData.actions),
    settings: sanitizeJsonObject(workflowData.settings, {
      fieldName: 'workflow settings',
      maxBytes: 4000
    })
  };
}

function buildLegacyWorkflowUpdatePayload(existingWorkflow, updates) {
  // mergeLegacyWorkflowUpdate is null-guarded: a null/array/non-object actions
  // or settings in the partial is ignored (existing value preserved) rather
  // than clobbered, and valid object partials are deep-merged.
  const merged = mergeLegacyWorkflowUpdate(existingWorkflow, updates);

  const sanitized = sanitizeLegacyWorkflowPayload(merged);
  const completed = Number(existingWorkflow.progress?.completed || 0);
  const total = sanitized.profileIds.length;

  return {
    ...sanitized,
    status: sanitizeSingleLineText(updates.status || existingWorkflow.status, 40) || existingWorkflow.status || 'pending',
    progress: {
      ...(existingWorkflow.progress || {}),
      completed: Math.min(Number.isFinite(completed) ? completed : 0, total),
      total
    }
  };
}

function sanitizeAutomationWorkflowTarget(targetInput) {
  if (!targetInput || typeof targetInput !== 'object' || Array.isArray(targetInput)) {
    throw new Error('Workflow target is required');
  }

  const targetType = sanitizeSingleLineText(targetInput.type, 40).toLowerCase();
  if (!ALLOWED_WORKFLOW_TARGET_TYPES.has(targetType)) {
    throw new Error('Workflow target type is invalid');
  }

  if (targetType === 'group') {
    return {
      type: 'group',
      label: sanitizeSingleLineText(targetInput.label, 200) || 'Group Target',
      groupId: sanitizeOptionalId(targetInput.groupId, 160),
      members: sanitizeStringArray(targetInput.members, {
        fieldName: 'target.members',
        maxItems: 5000,
        maxLength: 400
      })
    };
  }

  if (targetType === 'profiles') {
    return {
      type: 'profiles',
      label: sanitizeSingleLineText(targetInput.label, 200) || 'Stored Profiles',
      profileUrls: sanitizeStringArray(targetInput.profileUrls, {
        fieldName: 'target.profileUrls',
        maxItems: 5000,
        maxLength: 400
      })
    };
  }

  return {
    type: 'manual',
    label: sanitizeSingleLineText(targetInput.label, 200) || 'Manual Names',
    names: sanitizeStringArray(targetInput.names, {
      fieldName: 'target.names',
      maxItems: 5000,
      maxLength: 240
    })
  };
}

function sanitizeAutomationWorkflowTemplatePayload(workflowInput) {
  if (!workflowInput || typeof workflowInput !== 'object' || Array.isArray(workflowInput)) {
    throw new Error('Automation workflow payload must be an object');
  }

  const name = sanitizeSingleLineText(workflowInput.name, 160);
  if (!name) {
    throw new Error('Workflow name is required');
  }

  const steps = Array.isArray(workflowInput.steps)
    ? workflowInput.steps.map((step, index) => sanitizeWorkflowStep(step, index))
    : [];
  if (!steps.length) {
    throw new Error('Workflow must contain at least one step');
  }

  return {
    id: sanitizeOptionalId(workflowInput.id, 160),
    kind: 'automation',
    name,
    description: sanitizeMultilineText(workflowInput.description, 2000),
    agentId: sanitizeOptionalId(workflowInput.agentId, 160),
    target: sanitizeAutomationWorkflowTarget(workflowInput.target),
    steps,
    headless: sanitizeBoolean(workflowInput.headless, false),
    status: sanitizeSingleLineText(workflowInput.status, 40) || 'draft',
    createdAt: workflowInput.createdAt
      ? sanitizeIsoDateTime(workflowInput.createdAt, { fieldName: 'createdAt' })
      : null,
    updatedAt: workflowInput.updatedAt
      ? sanitizeIsoDateTime(workflowInput.updatedAt, { fieldName: 'updatedAt' })
      : null,
    lastRunAt: workflowInput.lastRunAt
      ? sanitizeIsoDateTime(workflowInput.lastRunAt, { fieldName: 'lastRunAt' })
      : null
  };
}

/**
 * Sanitize a single structured workflow target record (e.g. an entry from a
 * People-search receipt). Unlike groupMembers (a flat string array), this
 * preserves the search provenance so a like/connect can be traced back to the
 * exact People-search rank that produced it. Accepts a bare URL string too.
 * Returns null when there's no usable profile value.
 */
function sanitizeWorkflowTargetRecord(record) {
  if (record == null) return null;
  if (typeof record === 'string') {
    const url = sanitizeSingleLineText(record, 400);
    return url ? { value: url, profileUrl: url, searchProvenance: null } : null;
  }
  if (typeof record !== 'object' || Array.isArray(record)) return null;

  const profileUrl = sanitizeSingleLineText(record.profileUrl || record.url || record.value, 400);
  const value = profileUrl || sanitizeSingleLineText(record.value, 400);
  if (!value) return null;

  return {
    value,
    profileUrl: profileUrl || null,
    label: sanitizeSingleLineText(record.label || record.name || record.fullName, 240) || null,
    name: sanitizeSingleLineText(record.name || record.fullName, 240) || null,
    title: sanitizeSingleLineText(record.headline || record.title, 240) || null,
    company: sanitizeSingleLineText(record.company, 200) || null,
    // normalizeSearchProvenance clamps/validates and returns null when empty.
    searchProvenance: normalizeSearchProvenance({
      source: record.source,
      searchTerm: record.searchTerm,
      searchRank: record.searchRank,
      searchResultIndex: record.searchResultIndex,
      searchPageUrl: record.searchPageUrl
    })
  };
}

function sanitizeRunGroupWorkflowConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Workflow config must be an object');
  }

  const steps = Array.isArray(config.steps)
    ? config.steps.map((step, index) => sanitizeWorkflowStep(step, index))
    : [];
  const actions = sanitizeWorkflowActions(config.actions);
  const targetType = sanitizeSingleLineText(config.targetType, 40).toLowerCase();

  if (targetType && !ALLOWED_WORKFLOW_TARGET_TYPES.has(targetType)) {
    throw new Error('Workflow target type is invalid');
  }

  return {
    groupId: sanitizeOptionalId(config.groupId, 160),
    steps,
    actions,
    connectionMessage: sanitizeMultilineText(config.connectionMessage, 500),
    accountId: sanitizeOptionalId(config.accountId, 160),
    browserProfile: sanitizeSingleLineText(config.browserProfile, 80) || 'random',
    headless: sanitizeBoolean(config.headless, false),
    slowMo: sanitizeInteger(config.slowMo, {
      fieldName: 'slowMo',
      min: 0,
      max: 1000,
      defaultValue: 50
    }),
    groupMembers: sanitizeStringArray(config.groupMembers, {
      fieldName: 'groupMembers',
      maxItems: 5000,
      maxLength: 400
    }),
    groupName: sanitizeSingleLineText(config.groupName, 160) || null,
    // Structured targets (search receipts). Distinct from groupMembers (flat
    // strings) so search provenance survives sanitization. Capped to match
    // groupMembers' item ceiling.
    targets: Array.isArray(config.targets)
      ? config.targets.slice(0, 5000).map(sanitizeWorkflowTargetRecord).filter(Boolean)
      : [],
    targetType: targetType || 'group',
    workflowId: sanitizeOptionalId(config.workflowId, 160),
    workflowName: sanitizeSingleLineText(config.workflowName, 160) || null,
    agentId: sanitizeOptionalId(config.agentId, 160),
    bypassWorkingHours: sanitizeBoolean(config.bypassWorkingHours, false),
    launchSource: sanitizeSingleLineText(config.launchSource, 40) || null
  };
}

function notifyDmReplyReceived(notificationInput = {}) {
  const payload = {
    notificationId: notificationInput.id || notificationInput.notificationId || null,
    accountId: notificationInput.accountId || null,
    accountName: notificationInput.accountName || null,
    senderName: notificationInput.senderName || 'LinkedIn reply',
    text: truncateNotificationText(notificationInput.text || 'New LinkedIn reply received.', 220),
    deliveredAt: notificationInput.deliveredAt || Date.now(),
    workflowId: notificationInput.workflowId || null,
    workflowName: notificationInput.workflowName || null,
    runId: notificationInput.runId || null,
    agentId: notificationInput.agentId || null,
    agentName: notificationInput.agentName || null,
    readAt: notificationInput.readAt || null,
    timestamp: new Date().toISOString()
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dm-reply-notification', payload);
  }

  try {
    if (Notification?.isSupported?.()) {
      const titleSuffix = payload.accountName ? ` on ${payload.accountName}` : '';
      const desktopNotification = new Notification({
        title: `${payload.senderName} replied${titleSuffix}`,
        body: payload.text || 'New LinkedIn reply received.',
        silent: false
      });
      desktopNotification.show();
    }
  } catch (error) {
    console.warn('Failed to show DM reply notification:', error.message || error);
  }
}

function handleLinkedInWorkerChallengeDetected(challengeInput = {}) {
  const payload = buildLinkedInChallengeNotificationPayload(challengeInput);
  if (!payload.accountEmail && !payload.accountId) {
    return;
  }

  if (payload.accountId) {
    linkedInAccountHealthStore.recordChallenge(
      payload.accountId,
      classifyLinkedInChallengeType(payload),
      payload.source || null,
      { timestamp: payload.detectedAt || null }
    );
  }

  try {
    runtimeLogStore.append({
      timestamp: payload.detectedAt || new Date().toISOString(),
      source: 'linkedin-challenge',
      message: payload.reason || 'LinkedIn challenge detected',
      type: 'warning',
      accountId: payload.accountId || null,
      accountName: payload.accountName || null,
      metadata: {
        accountEmail: payload.accountEmail || null,
        currentUrl: payload.currentUrl || null,
        challengeSource: payload.source || null
      }
    });
  } catch (error) {
    console.warn('Failed to persist LinkedIn challenge runtime log:', error.message || error);
  }

  broadcastLinkedInAccountHealthUpdated();

  if (!shouldNotifyLinkedInChallenge(payload)) {
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('linkedin-challenge-detected', payload);
  }

  try {
    if (Notification?.isSupported?.()) {
      const titleTarget = payload.accountName || payload.accountEmail || 'LinkedIn account';
      const desktopNotification = new Notification({
        title: `LinkedIn challenge detected on ${titleTarget}`,
        body: truncateNotificationText(
          payload.reason || 'LinkedIn requires verification before automation can continue.',
          220
        ),
        silent: false
      });
      desktopNotification.show();
    }
  } catch (error) {
    console.warn('Failed to show LinkedIn challenge notification:', error.message || error);
  }
}

function buildLinkedInChallengeNotificationPayload(challengeInput = {}) {
  const accountStore = readLinkedInAccountsStore();
  const accountEmail = String(challengeInput.accountEmail || '').trim().toLowerCase() || null;
  const matchedAccount = challengeInput.accountId
    ? accountStore.accounts.find((account) => account.id === challengeInput.accountId)
    : accountStore.accounts.find((account) => String(account.email || '').trim().toLowerCase() === accountEmail);

  return {
    accountId: challengeInput.accountId || matchedAccount?.id || null,
    accountName: challengeInput.accountName || matchedAccount?.name || null,
    accountEmail: accountEmail || matchedAccount?.email || null,
    currentUrl: String(challengeInput.currentUrl || '').trim() || null,
    source: String(challengeInput.source || '').trim() || null,
    reason: truncateNotificationText(
      challengeInput.reason || 'LinkedIn requires verification before automation can continue.',
      220
    ),
    detectedAt: challengeInput.detectedAt || new Date().toISOString()
  };
}

function classifyLinkedInChallengeType(challengeInput = {}) {
  const challengeUrl = String(challengeInput.currentUrl || '').trim().toLowerCase();
  const challengeSource = String(challengeInput.source || '').trim().toLowerCase();
  const challengeReason = String(challengeInput.reason || '').trim().toLowerCase();
  const combined = `${challengeReason} ${challengeSource} ${challengeUrl}`;

  if (/device|pin|one[- ]time|two[- ]factor|2fa|email code|verification code/.test(combined)) {
    return 'device_verification';
  }
  if (/captcha|recaptcha|arkose/.test(combined)) {
    return 'captcha';
  }
  if (/checkpoint|challenge|security|verification|restricted/.test(combined)) {
    return 'checkpoint';
  }
  return 'unknown';
}

function shouldNotifyLinkedInChallenge(payload = {}, now = Date.now()) {
  const dedupeKey = String(payload.accountEmail || payload.accountId || '').trim().toLowerCase();
  if (!dedupeKey) {
    return true;
  }

  const lastNotifiedAt = recentLinkedInChallengeNotifications.get(dedupeKey) || 0;
  if (now - lastNotifiedAt < LINKEDIN_CHALLENGE_NOTIFICATION_THROTTLE_MS) {
    return false;
  }

  recentLinkedInChallengeNotifications.set(dedupeKey, now);
  return true;
}

function emitWorkflowLogMessage(message, type = 'info', extra = {}) {
  const payload = {
    message,
    type,
    ...extra
  };

  try {
    runtimeLogStore.append({
      timestamp: payload.timestamp || new Date().toISOString(),
      source: payload.source || 'main',
      message: payload.message,
      type: payload.type,
      accountId: payload.accountId || null,
      accountName: payload.accountName || null,
      workflowId: payload.workflowId || null,
      workflowName: payload.workflowName || null,
      runId: payload.runId || null,
      targetId: payload.targetId || null,
      prospectId: payload.prospectId || null,
      stepIndex: payload.stepIndex,
      stepType: payload.stepType || null,
      correlationId: payload.correlationId || null,
      rootCorrelationId: payload.rootCorrelationId || null,
      metadata: payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata
        : {}
    });
  } catch (error) {
    console.error('Failed to persist runtime log entry:', error);
  }

  if (mainWindow) {
    mainWindow.webContents.send('workflow-log', payload);
  }
}

async function retryDueApolloHeldCampaignRuns() {
  const updates = await campaignController.retryApolloHoldCampaignRuns({
    retryIntervalMs: CAMPAIGN_APOLLO_HOLD_RETRY_INTERVAL_MS,
    maxAttempts: CAMPAIGN_APOLLO_HOLD_MAX_ATTEMPTS,
    checkApolloHold: async () => ({ cleared: false, holdCause: 'unreachable' })
  });

  if (!updates.length) {
    return updates;
  }

  for (const update of updates) {
    const previousRun = update?.previousRun || null;
    const currentRun = update?.currentRun || previousRun || null;
    if (!currentRun) {
      continue;
    }

    const campaignLabel = formatCampaignRunLabel(currentRun);
    const logExtra = {
      source: 'apollo-hold',
      accountId: currentRun.accountId || null,
      accountName: currentRun.accountName || null,
      prospectId: currentRun.prospectId || null,
      metadata: {
        campaignRunId: currentRun.id,
        holdCause: currentRun.holdCause || update?.probe?.holdCause || null,
        holdAttempts: Number(currentRun.holdAttempts) || 0
      }
    };

    if (currentRun.status === 'failed' && currentRun.terminalReason === 'apollo_hold_max_retries_exceeded') {
      emitWorkflowLogMessage(
        `Campaign ${campaignLabel} failed after exhausting Apollo hold retries.`,
        'warning',
        logExtra
      );
      continue;
    }

    if (currentRun.status === 'queued' && previousRun?.waitReason === 'apollo_hold') {
      emitWorkflowLogMessage(
        `Apollo hold cleared for campaign ${campaignLabel}.`,
        'success',
        logExtra
      );
      continue;
    }

    if (currentRun.status === 'waiting' && currentRun.waitReason === 'apollo_hold') {
      emitWorkflowLogMessage(
        `Campaign ${campaignLabel} is waiting on Apollo (${currentRun.holdCause || 'unreachable'}, attempt ${Math.max(1, Number(currentRun.holdAttempts) || 1)}/${CAMPAIGN_APOLLO_HOLD_MAX_ATTEMPTS}).`,
        'warning',
        logExtra
      );
    }
  }

  const affectedAccountIds = Array.from(new Set(
    updates
      .map((entry) => entry?.currentRun?.accountId || entry?.previousRun?.accountId || null)
      .filter(Boolean)
  ));
  if (affectedAccountIds.length === 1) {
    broadcastCampaignRunsUpdated(affectedAccountIds[0]);
    broadcastSdrWorkflowRunsUpdated(affectedAccountIds[0]);
  } else {
    broadcastCampaignRunsUpdated();
    broadcastSdrWorkflowRunsUpdated();
  }

  return updates;
}

async function processDueApolloCampaignPolls() {
  const updates = await campaignController.processDueApolloPolls({
    limit: CAMPAIGN_APOLLO_POLL_BATCH_LIMIT
  });
  if (!updates.length) {
    return updates;
  }

  const affectedAccountIds = new Set();
  for (const update of updates) {
    const currentPoll = update?.currentPoll || update?.previousPoll || null;
    const currentRun = update?.currentCampaignRun || update?.campaignRun || null;
    if (currentRun?.accountId) {
      affectedAccountIds.add(currentRun.accountId);
    }
    if (!currentPoll || !currentRun) {
      continue;
    }

    const campaignLabel = formatCampaignRunLabel(currentRun);
    const logExtra = {
      source: 'apollo-poll',
      accountId: currentRun.accountId || null,
      accountName: currentRun.accountName || null,
      prospectId: currentRun.prospectId || null,
      metadata: {
        campaignRunId: currentRun.id,
        pollStatus: currentPoll.status,
        pollCount: Number(currentPoll.pollCount) || 0,
        maxPolls: Number(currentPoll.maxPolls) || 0,
        nextPollAt: currentPoll.nextPollAt || null,
        lastPollResult: currentPoll.lastPollResult || null
      }
    };

    if (update?.transition?.type === 'suppressed') {
      emitWorkflowLogMessage(
        `Apollo poll suppressed campaign ${campaignLabel}: ${update.transition.reason}.`,
        'warning',
        {
          ...logExtra,
          metadata: {
            ...logExtra.metadata,
            transition: update.transition.type,
            matchedSignals: Array.isArray(update.transition.matchedSignals)
              ? update.transition.matchedSignals.map((signal) => signal?.name || signal)
              : [],
            drainedChildRunIds: update.transition.drainedChildRunIds || []
          }
        }
      );
    } else if (currentPoll.status === 'failed') {
      emitWorkflowLogMessage(
        `Apollo polling reached a terminal failure for campaign ${campaignLabel}.`,
        'warning',
        logExtra
      );
    } else if (currentPoll.status === 'completed') {
      emitWorkflowLogMessage(
        `Apollo polling completed for campaign ${campaignLabel}.`,
        'info',
        logExtra
      );
    } else {
      emitWorkflowLogMessage(
        `Apollo polling recorded a new observation for campaign ${campaignLabel}.`,
        'info',
        logExtra
      );
    }
  }

  if (affectedAccountIds.size === 1) {
    broadcastCampaignRunsUpdated(Array.from(affectedAccountIds)[0]);
    if (updates.some((entry) => Array.isArray(entry?.transition?.drainedChildRunIds) && entry.transition.drainedChildRunIds.length > 0)) {
      broadcastSdrWorkflowRunsUpdated(Array.from(affectedAccountIds)[0]);
    }
  } else if (affectedAccountIds.size > 1) {
    broadcastCampaignRunsUpdated();
    if (updates.some((entry) => Array.isArray(entry?.transition?.drainedChildRunIds) && entry.transition.drainedChildRunIds.length > 0)) {
      broadcastSdrWorkflowRunsUpdated();
    }
  }

  return updates;
}

function formatCampaignRunLabel(campaignRun = {}) {
  const label = sanitizeSingleLineText(
    campaignRun.prospectLabel
      || campaignRun.campaignTemplateName
      || campaignRun.prospectId
      || campaignRun.id,
    160
  );
  return label ? `"${label}"` : `"${campaignRun.id || 'campaign'}"`;
}

function recordActivityEventSafe(eventInput) {
  try {
    const nextEventInput = eventInput && typeof eventInput === 'object'
      ? {
          ...eventInput,
          correlationId: eventInput.correlationId || eventInput.metadata?.correlationId || null,
          rootCorrelationId:
            eventInput.rootCorrelationId
            || eventInput.metadata?.rootCorrelationId
            || eventInput.correlationId
            || eventInput.metadata?.correlationId
            || null,
          metadata: eventInput.metadata && typeof eventInput.metadata === 'object'
            ? {
                ...eventInput.metadata,
                correlationId:
                  eventInput.metadata.correlationId
                  || eventInput.correlationId
                  || null,
                rootCorrelationId:
                  eventInput.metadata.rootCorrelationId
                  || eventInput.rootCorrelationId
                  || eventInput.metadata.correlationId
                  || eventInput.correlationId
                  || null
              }
            : {}
        }
      : {};
    const targetContext = resolveWorkflowTargetContext(nextEventInput.runId, nextEventInput.targetId);

    if (!nextEventInput.prospectId && targetContext?.prospectId) {
      nextEventInput.prospectId = targetContext.prospectId;
    }

    if (!nextEventInput.prospectId && shouldHydrateProspectFromEvent(nextEventInput, targetContext)) {
      const prospect = upsertProspectSafe(buildProspectInputFromActivityEvent(nextEventInput, targetContext));
      if (prospect?.id) {
        nextEventInput.prospectId = prospect.id;
      }
    }

    const event = activityEventStore.append(nextEventInput);
    let updatedProspect = null;
    if (event?.prospectId) {
      updatedProspect = recordProspectActivitySafe(event);
      maybeQueueAcceptedConnectionFollowUp(event, updatedProspect);
    }
    broadcastActivityAnalyticsUpdated(event);
    return event;
  } catch (error) {
    console.error('Failed to persist activity event:', error);
    return null;
  }
}

function recordProspectActivitySafe(eventInput) {
  try {
    const prospect = prospectQueueStore.recordActivity(eventInput);
    if (prospect?.id) {
      broadcastProspectsUpdated(prospect.accountId || eventInput?.accountId || null);
    }
    return prospect;
  } catch (error) {
    console.error('Failed to update prospect activity:', error);
    return null;
  }
}

function upsertProspectSafe(prospectInput) {
  try {
    const prospect = prospectQueueStore.upsertProspect(prospectInput);
    if (prospect?.id) {
      broadcastProspectsUpdated(prospect.accountId || prospectInput?.accountId || null);
    }
    return prospect;
  } catch (error) {
    console.error('Failed to upsert prospect:', error);
    return null;
  }
}

function updateProspectWorkflowProgressSafe(prospectId, progress) {
  if (!prospectId) return null;
  try {
    const prospect = prospectQueueStore.updateWorkflowProgress(prospectId, progress);
    if (prospect?.id) {
      broadcastProspectsUpdated(prospect.accountId || progress?.accountId || null);
    }
    return prospect;
  } catch (error) {
    console.error('Failed to update prospect workflow progress:', error);
    return null;
  }
}

function updateProspectMetadataSafe(prospectId, metadataPatch = {}) {
  if (!prospectId) return null;
  try {
    const prospect = prospectQueueStore.updateProspectMetadata(prospectId, metadataPatch);
    if (prospect?.id) {
      broadcastProspectsUpdated(prospect.accountId || null);
    }
    return prospect;
  } catch (error) {
    console.error('Failed to update prospect metadata:', error);
    return null;
  }
}

function archiveProspectSafe(prospectId, options = {}) {
  if (!prospectId) return null;
  try {
    const prospect = prospectQueueStore.archiveProspect(prospectId, options);
    if (prospect?.id) {
      broadcastProspectsUpdated(prospect.accountId || options?.accountId || null);
    }
    return prospect;
  } catch (error) {
    console.error('Failed to archive prospect:', error);
    return null;
  }
}

function maybeQueueAcceptedConnectionFollowUp(event, prospect) {
  try {
    const plan = resolveAcceptedConnectionFollowUpPlan({
      event,
      prospect,
      agent: sdrAgentManager.getAgent(prospect?.agentId || event?.agentId || null) || null,
      jobs: workflowRunManager.getJobs()
    });
    if (!plan?.shouldQueue) {
      return null;
    }

    const created = workflowRunManager.createRun(plan.runInput);
    const firstTarget = Array.isArray(created.run?.targets) ? created.run.targets[0] || null : null;

    updateProspectMetadataSafe(prospect.id, {
      ...plan.metadataPatch,
      acceptedConnectionFollowUpRunId: created.run.id,
      acceptedConnectionFollowUpWorkflowId: created.run.workflowId || null
    });

    recordActivityEventSafe({
      type: 'workflow_started',
      accountId: created.run.accountId,
      accountName: created.run.accountName,
      agentId: created.run.agentId,
      agentName: created.run.agentName,
      workflowId: created.run.workflowId || created.run.id,
      workflowName: created.run.workflowName,
      runId: created.run.id,
      correlationId: created.run.correlationId || null,
      rootCorrelationId: created.run.correlationId || null,
      targetId: firstTarget?.targetId || null,
      prospectId: prospect.id,
      targetValue: firstTarget?.label || firstTarget?.value || prospect.fullName || prospect.profileUrl || null,
      profileUrl: prospect.profileUrl || firstTarget?.value || null,
      status: 'ok',
      metadata: {
        correlationId: created.run.correlationId || null,
        rootCorrelationId: created.run.correlationId || null,
        workflowName: created.run.workflowName,
        targetCount: created.run.targets.length,
        targetType: created.run.targetType || 'profiles',
        autoAcceptedConnectionFollowUp: true,
        triggerEventType: event.type,
        triggerEventId: event.id || null,
        templateSlot: plan.templateInfo?.slot || null
      }
    });

    emitWorkflowLogMessage(
      `Queued accepted-connection DM follow-up for ${firstTarget?.label || firstTarget?.value || prospect.fullName || prospect.profileUrl}.`,
      'info',
      buildWorkflowCorrelationContext(created.run, created.jobs[0] || null, {
        prospectId: prospect.id,
        source: 'connection-accepted-follow-up',
        metadata: {
          autoAcceptedConnectionFollowUp: true,
          triggerEventId: event.id || null,
          templateSlot: plan.templateInfo?.slot || null
        }
      })
    );

    broadcastSdrWorkflowRunsUpdated(created.run.accountId || null);
    startDueDurableWorkflowJobs().catch((error) => {
      console.error('Failed to start accepted-connection follow-up workflow:', error);
    });
    return created;
  } catch (error) {
    console.error('Failed to queue accepted-connection follow-up:', error);
    return null;
  }
}

function resolveWorkflowTargetContext(runId, targetId) {
  const normalizedRunId = String(runId || '').trim();
  const normalizedTargetId = String(targetId || '').trim();
  if (!normalizedRunId || !normalizedTargetId) {
    return null;
  }

  const run = workflowRunManager.getRun(normalizedRunId);
  if (!run) {
    return null;
  }

  const target = Array.isArray(run.targets)
    ? run.targets.find((entry) => entry.targetId === normalizedTargetId)
    : null;
  if (!target) {
    return null;
  }

  const prospect = target.prospectId ? prospectQueueStore.getProspect(target.prospectId) : null;
  return {
    prospectId: target.prospectId || null,
    targetValue: target.value || null,
    targetLabel: target.label || null,
    profileUrl: prospect?.profileUrl || (isLinkedInProfileUrl(target.value) ? target.value : null)
  };
}

function shouldHydrateProspectFromEvent(eventInput, targetContext = null) {
  if (!eventInput || typeof eventInput !== 'object') return false;
  const type = String(eventInput.type || '').trim();
  if (!type) return false;
  if (eventInput.prospectId) return true;
  if (targetContext?.prospectId) return true;

  const targetValue = String(eventInput.targetValue || targetContext?.targetValue || '').trim();
  const profileUrl = String(eventInput.profileUrl || targetContext?.profileUrl || '').trim();
  if (!targetValue && !profileUrl) {
    return false;
  }

  return new Set([
    'profile_viewed',
    'post_liked',
    'connection_requested',
    'connection_accepted',
    'dm_sent',
    'dm_reply_received',
    'workflow_step_completed',
    'workflow_step_failed'
  ]).has(type);
}

function buildProspectInputFromActivityEvent(eventInput, targetContext = null) {
  const metadata = eventInput.metadata && typeof eventInput.metadata === 'object' ? eventInput.metadata : {};
  return {
    prospectId: eventInput.prospectId || targetContext?.prospectId || null,
    accountId: eventInput.accountId || null,
    accountName: eventInput.accountName || null,
    agentId: eventInput.agentId || null,
    agentName: eventInput.agentName || null,
    fullName: metadata.recipientName || metadata.senderName || targetContext?.targetLabel || eventInput.targetValue || null,
    profileUrl: eventInput.profileUrl || targetContext?.profileUrl || null,
    state: inferProspectStateFromEventType(eventInput.type),
    sourceType: eventInput.workflowId || eventInput.runId ? 'workflow' : 'activity',
    sourceLabel: metadata.searchQuery || metadata.source || eventInput.workflowName || eventInput.type || null,
    workflowAssignment: {
      workflowId: eventInput.workflowId || null,
      workflowName: eventInput.workflowName || null,
      runId: eventInput.runId || null,
      targetId: eventInput.targetId || null,
      targetType: metadata.targetType || null,
      assignedAt: eventInput.timestamp || new Date().toISOString()
    },
    metadata: {
      lastEventType: eventInput.type || null
    }
  };
}

function inferProspectStateFromEventType(eventType) {
  switch (String(eventType || '').trim()) {
    case 'profile_viewed':
      return 'active';
    case 'post_liked':
      return 'active';
    case 'connection_requested':
      return 'active';
    case 'connection_accepted':
      return 'active';
    case 'dm_sent':
      return 'active';
    case 'dm_reply_received':
      return 'responded';
    case 'workflow_step_failed':
      return 'failed';
    default:
      return 'discovered';
  }
}

function mapLegacyActionToEventType(actionType) {
  switch (String(actionType || '').trim()) {
    case 'Profile Viewed':
      return 'profile_viewed';
    case 'Post Liked':
      return 'post_liked';
    case 'Connection Request Sent':
      return 'connection_requested';
    case 'Connection Accepted':
      return 'connection_accepted';
    case 'Message Sent':
      return 'dm_sent';
    default:
      return null;
  }
}

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, '')
    .replace(/linkedin\.com\/in\//g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildComparableReplyTokens(values = []) {
  const tokens = new Set();
  values
    .flat()
    .forEach((value) => {
      const normalized = normalizeComparableText(value);
      if (!normalized) return;
      tokens.add(normalized);
      const condensed = normalized.replace(/\s+/g, ' ');
      if (condensed) tokens.add(condensed);
    });
  return Array.from(tokens).filter((token) => token.length >= 3);
}

function matchDmReplyToWorkflowRun(payload = {}) {
  const accountId = String(payload.accountId || '').trim();
  if (!accountId) {
    return null;
  }

  const replyTokens = buildComparableReplyTokens([
    payload.participantNames || [],
    payload.message?.senderName || ''
  ]);
  if (!replyTokens.length) {
    return null;
  }

  const maxAgeMs = 180 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const candidateRuns = workflowRunManager.getAllRuns()
    .filter((run) => run.accountId === accountId)
    .filter((run) => now - new Date(run.updatedAt || run.createdAt || now).getTime() <= maxAgeMs)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());

  for (const run of candidateRuns) {
    const targets = Array.isArray(run.targets) ? run.targets : [];
    for (const target of targets) {
      const prospect = target.prospectId ? prospectQueueStore.getProspect(target.prospectId) : null;
      const targetTokens = buildComparableReplyTokens([
        target.label,
        target.value,
        prospect?.fullName || '',
        prospect?.profileUrl || ''
      ]);
      if (!targetTokens.length) continue;

      const matched = replyTokens.some((replyToken) => {
        return targetTokens.some((targetToken) => {
          if (replyToken === targetToken) return true;
          if (replyToken.length >= 6 && targetToken.includes(replyToken)) return true;
          if (targetToken.length >= 6 && replyToken.includes(targetToken)) return true;
          return false;
        });
      });

      if (matched) {
        return {
          runId: run.id,
          workflowId: run.workflowId || run.id,
          workflowName: run.workflowName || null,
          agentId: run.agentId || null,
          agentName: run.agentName || null,
          targetId: target.targetId || null,
          prospectId: target.prospectId || null
        };
      }
    }
  }

  return null;
}

// mapWorkflowStepToEventType, chooseDelayMs, addDelayToIso, resolveNextExecutableStep,
// and applySchedulingJitter have moved into automation/runtime/durable-workflow-scheduler.js




// Removed MessageScheduler constructor usage; already required above


// Add this function to main.js
function repairProfilesData() {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const profilesPath = path.join(userHome, 'Documents', 'Connect-Ability', 'profiles.json');

    if (!fs.existsSync(profilesPath)) {
      console.log('No profiles file found to repair');
      return false;
    }

    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    let modified = false;

    // Check and repair each profile
    profiles.forEach(profile => {
      // Ensure company field exists
      if (!profile.company && (profile.companyName || profile.organization)) {
        profile.company = profile.companyName || profile.organization;
        modified = true;
      }

      // Ensure email field exists
      if (!profile.email && profile.emailAddress) {
        profile.email = profile.emailAddress;
        modified = true;
      }

      // Ensure title field exists
      if (!profile.title && (profile.position || profile.headline)) {
        profile.title = profile.position || profile.headline;
        modified = true;
      }
    });

    if (modified) {
      writeJsonFileAtomic(profilesPath, profiles);
      console.log('Profiles data repaired and saved');
      return true;
    }

    console.log('No repairs needed for profiles data');
    return false;
  } catch (error) {
    console.error('Error repairing profiles data:', error);
    return false;
  }
}

// Function to update workflow status
function updateWorkflowStatus(workflowId, status) {
  try {
    const timestamp = new Date().toISOString();
    workflowTemplateStore.updateLegacyWorkflow(workflowId, (workflow) => ({
      ...workflow,
      status,
      updatedAt: timestamp,
      lastRunAt: status === 'running' ? timestamp : (workflow.lastRunAt || null),
      startedAt: status === 'running' ? timestamp : (workflow.startedAt || null),
      completedAt: status === 'completed' ? timestamp : (workflow.completedAt || null),
      pausedAt: status === 'paused' ? timestamp : (workflow.pausedAt || null)
    }));
  } catch (error) {
    console.error(`Failed to update workflow status: ${error.message}`);
  }
}

// Handle getting all workflows
ipcMain.handle('get-all-workflows', async (event) => {
  try {
    return workflowTemplateStore.getLegacyWorkflows();
  } catch (error) {
    console.error('Error getting all workflows:', error);
    return [];
  }
});

ipcMain.handle('update-workflow', async (_event, workflowId, updates) => {
  try {
    const id = sanitizeRequiredId(workflowId, 160, 'workflowId');
    const existing = workflowTemplateStore.getLegacyWorkflow(id);
    if (!existing) {
      // [not_found] token is the reliable cross-boundary signal: only the error
      // *message* survives ipcMain.handle → invoke → executeJavaScript, so the
      // injected renderer JS detects this token and surfaces a structured
      // code:'not_found' that /api/call maps to HTTP 404 (vs the default 400).
      throw new Error(`Workflow ${id} not found [not_found]`);
    }

    const sanitizedUpdates = buildLegacyWorkflowUpdatePayload(existing, updates);
    const updated = workflowTemplateStore.updateLegacyWorkflow(id, sanitizedUpdates);
    if (!updated) {
      throw new Error(`Failed to update workflow ${id}`);
    }
    return updated;
  } catch (error) {
    console.error('Error updating workflow:', error);
    throw error;
  }
});

ipcMain.handle('get-automation-workflows', async () => {
  try {
    return workflowTemplateStore.getAutomationWorkflows();
  } catch (error) {
    console.error('Error getting automation workflows:', error);
    return [];
  }
});

ipcMain.handle('save-automation-workflow', async (event, workflowInput) => {
  try {
    const sanitizedWorkflow = sanitizeAutomationWorkflowTemplatePayload(workflowInput);
    return workflowTemplateStore.saveAutomationWorkflow(sanitizedWorkflow);
  } catch (error) {
    console.error('Error saving automation workflow:', error);
    throw error;
  }
});

ipcMain.handle('delete-automation-workflow', async (event, workflowId) => {
  try {
    return workflowTemplateStore.deleteWorkflow(workflowId);
  } catch (error) {
    console.error('Error deleting automation workflow:', error);
    throw error;
  }
});

ipcMain.on('export-emails', (event) => {
  try {
    const profiles = getVisibleStoredProfiles();
    if (!profiles.length) {
      event.reply('automation-log', { message: 'No profiles found to export emails', type: 'warning' });
      return;
    }

    // Filter profiles with valid emails
    const profilesWithEmail = profiles.filter(profile =>
      profile.email &&
      profile.email !== 'Not Available' &&
      profile.email !== 'Not available'
    );

    if (profilesWithEmail.length === 0) {
      event.reply('automation-log', { message: 'No profiles with valid emails found', type: 'warning' });
      return;
    }

    // Create CSV content
    let csvContent = 'Name,Email,Title,Company,LinkedIn URL,First Interaction,Last Interaction\n';
    profilesWithEmail.forEach(profile => {
      csvContent += `"${profile.firstName} ${profile.lastName}","${profile.email}","${profile.title}","${profile.company}","${profile.url}","${profile.firstInteraction}","${profile.lastInteraction}"\n`;
    });

    dialog.showSaveDialog(mainWindow, {
      title: 'Export LinkedIn Emails',
      defaultPath: path.join(app.getPath('documents'), 'linkedin-emails.csv'),
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    }).then(result => {
      if (!result.canceled && result.filePath) {
        try {
          fs.writeFileSync(result.filePath, csvContent);
          event.reply('automation-log', { message: `Exported ${profilesWithEmail.length} emails to ${result.filePath}`, type: 'success' });
        } catch (error) {
          event.reply('automation-log', { message: `Failed to export emails: ${error.message}`, type: 'error' });
        }
      }
    });
  } catch (error) {
    event.reply('automation-log', { message: `Error exporting emails: ${error.message}`, type: 'error' });
  }
});

// Send message immediately (Send Now button)
ipcMain.on('send-now', async (event, messageData) => {
  try {
    logAction(`Send Now triggered for message: ${messageData.message}`);
    const credentials = await getStoredCredentials(messageData?.accountId || null);
    if (!credentials?.email || !credentials?.password) {
      throw new Error('No LinkedIn credentials found for the selected profile.');
    }

    const result = await automation.executeSendNow({
      ...messageData,
      linkedinEmail: credentials.email,
      linkedinPassword: credentials.password
    });

    event.reply('automation-log', {
      message: `Send Now completed: ${result.sent} sent, ${result.failed} failed`,
      type: 'success'
    });
  } catch (error) {
    logError('Error executing Send Now:', error);
    event.reply('automation-log', {
      message: `Send Now failed: ${error.message}`,
      type: 'error'
    });
  }
});


ipcMain.on('send-scheduled-now', async (event, scheduleRequest) => {
  try {
    if (!messageScheduler._initialized) await messageScheduler.init();
    const { scheduleId, accountId, schedule } = resolveScheduledMessageRequest(scheduleRequest);
    const ok = schedule
      ? messageScheduler.triggerNow(scheduleId, schedule.accountId ? { accountId: schedule.accountId } : {})
      : false;

    if (ok) {
      logAction(`Scheduled message ${scheduleId} queued for immediate sending`);
      event.reply('automation-log', {
        message: `Message ${scheduleId} is being sent now`,
        type: 'info'
      });
    } else {
      event.reply('automation-log', {
        message: `Could not trigger message ${scheduleId} (not found)`,
        type: 'warning'
      });
    }

    event.reply('scheduled-messages-loaded', getVisibleScheduledMessages(accountId));
  } catch (error) {
    logError(`send-scheduled-now failed: ${error.message}`, error);
    event.reply('automation-log', {
      message: `Failed to send now: ${error.message}`,
      type: 'error'
    });
  }
});

// Add this to your main.js or main Electron process file



// Helper function to start messaging automation
async function startMessagingAutomation(config, scheduleId = null) {
  // This should call your existing automation system
  // You might already have a function like this for regular automation
  
  try {
    // Start the browser automation
    const result = await automationManager.startMessageAutomation(config);
    
    // If this was triggered from a scheduled message, update its status
    if (scheduleId) {
      if (result.success) {
        await updateScheduledMessageStatus(scheduleId, 'sent');
      } else {
        await updateScheduledMessageStatus(scheduleId, 'failed');
      }
    }
    
    return result;
    
  } catch (error) {
    console.error('Messaging automation failed:', error);
    
    if (scheduleId) {
      await updateScheduledMessageStatus(scheduleId, 'failed');
    }
    
    throw error;
  }
}

// Helper functions for database operations
async function getScheduledMessage(scheduleId) {
  // Implement this to get a scheduled message from your database
  // This should return the scheduled message object with:
  // { id, profileIds, message, scheduledDate, scheduledTime, status, recurring, recurringInterval }
  
  // Example implementation (you'll need to adapt this to your database):
  try {
    const db = await getDatabase(); // Your database connection
    const query = 'SELECT * FROM scheduled_messages WHERE id = ?';
    const result = await db.get(query, [scheduleId]);
    return result;
  } catch (error) {
    console.error('Error getting scheduled message:', error);
    return null;
  }
}

async function updateScheduledMessageStatus(scheduleId, status) {
  // Update the status of a scheduled message
  try {
    const db = await getDatabase();
    const query = 'UPDATE scheduled_messages SET status = ? WHERE id = ?';
    await db.run(query, [status, scheduleId]);
    console.log(`Updated scheduled message ${scheduleId} status to ${status}`);
  } catch (error) {
    console.error('Error updating scheduled message status:', error);
  }
}

async function getProfilesByIds(profileIds) {
  // Get profile details by their IDs
  try {
    const db = await getDatabase();
    const placeholders = profileIds.map(() => '?').join(',');
    const query = `SELECT * FROM profiles WHERE url IN (${placeholders})`;
    const profiles = await db.all(query, profileIds);
    return profiles;
  } catch (error) {
    console.error('Error getting profiles by IDs:', error);
    return [];
  }
}

async function getAllScheduledMessages() {
  // Get all scheduled messages for the UI
  try {
    const db = await getDatabase();
    const query = 'SELECT * FROM scheduled_messages ORDER BY scheduledDate, scheduledTime';
    const messages = await db.all(query);
    return messages;
  } catch (error) {
    console.error('Error getting all scheduled messages:', error);
    return [];
  }
}

function killExistingAutomationProcess() {
  stopLinkedInRuntimeJobs();

  // Reset all variables
  globalAutomationProcess = null;
  automationProcess = null;
  scheduledMessageProcess = null;
  workflowManagerProcess = null;
  if (global.currentWorkflowProcess) {
    global.currentWorkflowProcess = null;
  }
}

// ---------------- Scheduled Messaging (cleaned & safe) ----------------

// Single shared process handle for scheduled runs
let scheduledMessageProcess = null;
let globalAutomationProcess = null;

/**
 * Execute a scheduled message job.
 * @param {Object} schedule - { id, profileIds, message, ... }
 */
// Replace your executeScheduledMessage function with this enhanced version
async function executeScheduledMessage(schedule) {
  let configPath = null;
  try {
    // Validate schedule object
    if (!schedule || !schedule.id) {
      throw new Error('Invalid schedule object');
    }
    
    logAction(`Starting scheduled message execution for schedule ${schedule.id}`);
    logAction(`Processing ${schedule.profileIds?.length || 0} profiles`);
    
    const scheduleOptions = schedule.options || schedule.meta || {};
    const account = await loadLinkedInCredentialsForPosting(schedule.accountId || scheduleOptions.accountId || null);
    if (!account?.email || !account?.password) {
      throw new Error('No LinkedIn credentials found for the scheduled account');
    }

    // Safety gate: this legacy path spawns a cold-login browser outside the
    // durable scheduler, so apply the same challenge/cooldown/working-hours
    // screening the canonical path enforces before any LinkedIn activity.
    // Blocked schedules are marked failed (triggerSchedule has already set
    // them to 'executing', so a silent return would strand them).
    const gateDecision = evaluateLegacyScheduledMessageGate({
      account,
      healthStore: linkedInAccountHealthStore
    });
    if (!gateDecision.allowed) {
      logAction(`Blocked scheduled message ${schedule.id}: ${gateDecision.reason} (${gateDecision.code})`);
      if (messageScheduler && typeof messageScheduler.markAsFailed === 'function') {
        messageScheduler.markAsFailed(schedule.id, gateDecision.reason);
      }
      if (mainWindow) {
        mainWindow.webContents.send('automation-log', {
          message: `⛔ Scheduled message blocked: ${gateDecision.reason}`,
          type: 'warning'
        });
      }
      broadcastScheduledMessagesUpdated(schedule.accountId || scheduleOptions.accountId || null);
      return { blocked: true, code: gateDecision.code };
    }


    // Prepare config for automation with proper mode
    const messageConfig = {
      mode: 'send-scheduled-messages', // New mode specifically for scheduled messages
      profileIds: schedule.profileIds || [],
      message: schedule.message || '',
      accountId: account.id,
      accountName: account.name,
      accountEmail: account.email,
      scheduleId: schedule.id,
      headless: false,
      slowMo: 100,
      searchAndMessage: true, // Flag to indicate we need to search for profiles
      messageOnly: true // Flag to indicate we're only sending messages, not connecting
    };
    
    console.log('Executing scheduled message with enhanced config:', messageConfig);
    
    // Save config to temp file
    const jobId = createLinkedInRuntimeJobId('scheduled-message', account.id);
    configPath = path.join(app.getPath('temp'), `scheduled-message-${schedule.id}-${jobId}.json`);
    fs.writeFileSync(configPath, JSON.stringify(messageConfig));
    
    // Launch automation process with the automation.js script
    const automationScript = path.join(__dirname, 'automation.js');
    
    console.log(`Launching automation script: ${automationScript}`);
    console.log(`Config file: ${configPath}`);

    const childProcess = spawnNodeRuntime(automationScript, [configPath], {
      env: legacyAutomationSpawnEnv()
    });
    globalAutomationProcess = childProcess;
    scheduledMessageProcess = childProcess; // For compatibility
    registerLinkedInRuntimeJob({
      jobId,
      type: 'scheduled-message',
      accountId: account.id,
      accountName: account.name || account.email,
      process: childProcess,
      meta: {
        scheduleId: schedule.id,
        recipients: schedule.profileIds?.length || 0
      }
    });
    
    // Handle standard output
    childProcess.stdout.on('data', (data) => {
      const logLines = data.toString().trim().split('\n');
      
      logLines.forEach(line => {
        if (!line) return;
        
        try {
          const logData = JSON.parse(line);
          
          // Send logs to renderer
          if (mainWindow) {
            mainWindow.webContents.send('automation-log', {
              message: logData.message || line,
              type: logData.type || 'normal'
            });
          }
          
          // Check for completion
          if (logData.type === 'message-result') {
            const result = logData.result || {};
            
            if (result.sent > 0) {
              if (messageScheduler && typeof messageScheduler.markAsSent === 'function') {
                messageScheduler.markAsSent(schedule.id, result);
              }
              
              if (mainWindow) {
                mainWindow.webContents.send('automation-log', {
                  message: `✅ Scheduled messages sent to ${result.sent} recipients`,
                  type: 'success'
                });
                
                broadcastScheduledMessagesUpdated(schedule.accountId || scheduleOptions.accountId || null);
              }
            } else {
              if (messageScheduler && typeof messageScheduler.markAsFailed === 'function') {
                messageScheduler.markAsFailed(schedule.id, 'No messages sent');
              }
              
              if (mainWindow) {
                mainWindow.webContents.send('automation-log', {
                  message: `❌ Scheduled message failed - no messages sent`,
                  type: 'error'
                });
              }

              broadcastScheduledMessagesUpdated(schedule.accountId || scheduleOptions.accountId || null);
            }
          }
        } catch (e) {
          // Plain text log
          console.log('Automation output:', line);
          if (mainWindow) {
            mainWindow.webContents.send('automation-log', {
              message: line,
              type: 'normal'
            });
          }
        }
      });
    });
    
    // Handle error output
    childProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      console.error('Automation error:', errorMsg);
      
      if (mainWindow) {
        mainWindow.webContents.send('automation-log', {
          message: `Error: ${errorMsg}`,
          type: 'error'
        });
      }
    });
    
    // Handle process exit
    childProcess.on('close', (code) => {
      console.log(`Scheduled message process exited with code ${code}`);
      
      cleanupTempConfig(configPath, 'scheduled message temp config');
      
      if (code !== 0) {
        if (messageScheduler && typeof messageScheduler.markAsFailed === 'function') {
          messageScheduler.markAsFailed(schedule.id, `Process exited with code ${code}`);
        }
        
        if (mainWindow) {
          mainWindow.webContents.send('automation-log', {
            message: `Message sending process failed with exit code ${code}`,
            type: 'error'
          });
        }

        broadcastScheduledMessagesUpdated(schedule.accountId || scheduleOptions.accountId || null);
      }
      
      unregisterLinkedInRuntimeJob(jobId);
      globalAutomationProcess = null;
      scheduledMessageProcess = null;
    });
    
    // Handle process errors
    childProcess.on('error', (error) => {
      console.error('Failed to start automation process:', error);
      cleanupTempConfig(configPath, 'scheduled message temp config');
      
      if (messageScheduler && typeof messageScheduler.markAsFailed === 'function') {
        messageScheduler.markAsFailed(schedule.id, error.message);
      }
      
      if (mainWindow) {
        mainWindow.webContents.send('automation-log', {
          message: `Failed to start automation: ${error.message}`,
          type: 'error'
        });
      }

      broadcastScheduledMessagesUpdated(schedule.accountId || scheduleOptions.accountId || null);
      
      unregisterLinkedInRuntimeJob(jobId);
      globalAutomationProcess = null;
      scheduledMessageProcess = null;
    });
    
  } catch (error) {
    cleanupTempConfig(configPath, 'scheduled message temp config');
    console.error('Error executing scheduled message:', error);
    
    if (messageScheduler && typeof messageScheduler.markAsFailed === 'function') {
      messageScheduler.markAsFailed(schedule.id, error.message);
    }
    
    if (mainWindow) {
      mainWindow.webContents.send('automation-log', {
        message: `Failed to execute scheduled message: ${error.message}`,
        type: 'error'
      });
      
      broadcastScheduledMessagesUpdated(schedule.accountId || schedule.meta?.accountId || null);
    }
    
    globalAutomationProcess = null;
    scheduledMessageProcess = null;
  }
}

// Add this new handler function for the automation.js side
// This should be added to your automation.js file
async function processScheduledMessages(page, config) {
  const { 
    profileIds = [], 
    message = '',
    scheduleId
  } = config;
  
  try {
    logAction(`Processing scheduled messages for ${profileIds.length} profiles`);
    
    const results = {
      sent: 0,
      failed: 0,
      details: []
    };
    
    // Process each profile
    for (let i = 0; i < profileIds.length; i++) {
      const profileId = profileIds[i];
      logAction(`Processing profile ${i + 1}/${profileIds.length}: ${profileId}`);
      
      try {
        // Extract the name from the profile ID/URL
        let searchName = '';
        
        // If it's a URL, extract the name
        if (profileId.includes('linkedin.com/in/')) {
          const match = profileId.match(/\/in\/([^\/\?]+)/);
          if (match && match[1]) {
            // Convert URL slug to name (e.g., "john-doe" -> "John Doe")
            searchName = match[1]
              .split('-')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ');
          }
        } else if (profileId.includes(' ')) {
          // It's already a name
          searchName = profileId;
        } else {
          // Try to parse it as a name with dashes
          searchName = profileId
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
        }
        
        if (!searchName) {
          logAction(`Could not extract name from profile ID: ${profileId}`);
          results.failed++;
          results.details.push({
            profileId,
            status: 'failed',
            reason: 'Could not extract name'
          });
          continue;
        }
        
        logAction(`Searching for: "${searchName}"`);
        
        // Use the existing humanLikeSearch function from automation-functions.js
        const searchSuccess = await humanLikeSearch(page, searchName);
        
        if (!searchSuccess) {
          logAction(`Search failed for: ${searchName}`);
          results.failed++;
          results.details.push({
            profileId,
            searchName,
            status: 'failed',
            reason: 'Search failed'
          });
          continue;
        }
        
        // Wait for search results to load
        await randomDelay(3000, 5000);
        
        // Click on the first profile in search results
        const profileClicked = await page.evaluate(() => {
          // Find the first profile link in search results
          const profileLinks = document.querySelectorAll('a[href*="/in/"]');
          
          for (const link of profileLinks) {
            // Make sure it's a profile link from search results
            const href = link.href;
            if (href.includes('/in/') && !href.includes('/company/')) {
              // Check if it's visible
              const rect = link.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                link.click();
                return true;
              }
            }
          }
          return false;
        });
        
        if (!profileClicked) {
          logAction(`Could not find profile in search results for: ${searchName}`);
          results.failed++;
          results.details.push({
            profileId,
            searchName,
            status: 'failed',
            reason: 'Profile not found in search'
          });
          continue;
        }
        
        // Wait for profile page to load
        await randomDelay(3000, 5000);
        
        // Now we're on the profile page - click Message button
        logAction('Looking for Message button...');
        
        const messageButtonClicked = await page.evaluate(() => {
          // Try multiple selectors for the Message button
          const messageSelectors = [
            'button[aria-label*="Message"]',
            'button:has-text("Message")',
            '.pvs-profile-actions button:has-text("Message")',
            'button[data-control-name="message"]',
            '.artdeco-button:has-text("Message")'
          ];
          
          for (const selector of messageSelectors) {
            try {
              const buttons = document.querySelectorAll(selector);
              for (const button of buttons) {
                // Make sure it's visible and says "Message"
                const text = button.textContent.trim();
                if (text === 'Message' && button.offsetWidth > 0 && button.offsetHeight > 0) {
                  button.click();
                  return true;
                }
              }
            } catch (e) {
              continue;
            }
          }
          
          // Try the More dropdown approach
          const moreButton = document.querySelector('button[aria-label*="More"]');
          if (moreButton && moreButton.offsetWidth > 0) {
            moreButton.click();
            return 'more-clicked';
          }
          
          return false;
        });
        
        if (messageButtonClicked === 'more-clicked') {
          // Wait for dropdown to open
          await randomDelay(1000, 1500);
          
          // Click Message in dropdown
          const dropdownMessageClicked = await page.evaluate(() => {
            const dropdownItems = document.querySelectorAll('.artdeco-dropdown__content button, .artdeco-dropdown__content a');
            for (const item of dropdownItems) {
              if (item.textContent.trim() === 'Message') {
                item.click();
                return true;
              }
            }
            return false;
          });
          
          if (!dropdownMessageClicked) {
            logAction('Could not find Message in dropdown');
            results.failed++;
            continue;
          }
        } else if (!messageButtonClicked) {
          logAction('Could not find Message button on profile');
          results.failed++;
          results.details.push({
            profileId,
            searchName,
            status: 'failed',
            reason: 'Message button not found'
          });
          continue;
        }
        
        // Wait for message modal/overlay to open
        await randomDelay(2000, 3000);
        
        // Type the message
        logAction('Typing message...');
        
        const messageTyped = await page.evaluate((messageText) => {
          // Find the message input field
          const messageInputSelectors = [
            '.msg-form__contenteditable',
            'div[aria-label*="Write a message"]',
            'div[role="textbox"][contenteditable="true"]',
            '.msg-form__msg-content-container [contenteditable="true"]'
          ];
          
          for (const selector of messageInputSelectors) {
            const input = document.querySelector(selector);
            if (input) {
              // Click to focus
              input.click();
              // Clear any existing content
              input.innerHTML = '';
              // Type the message
              input.textContent = messageText;
              // Trigger input event
              const event = new Event('input', { bubbles: true });
              input.dispatchEvent(event);
              return true;
            }
          }
          return false;
        }, message);
        
        if (!messageTyped) {
          logAction('Could not type message');
          results.failed++;
          results.details.push({
            profileId,
            searchName,
            status: 'failed',
            reason: 'Could not type message'
          });
          continue;
        }
        
        // Wait a moment
        await randomDelay(1000, 2000);
        
        // Click Send button
        logAction('Clicking Send button...');
        
        const messageSent = await page.evaluate(() => {
          const sendButtonSelectors = [
            'button[type="submit"]:has-text("Send")',
            'button.msg-form__send-button',
            'button[aria-label*="Send"]',
            '.msg-form__send-btn',
            'button.msg-form__send-toggle'
          ];
          
          for (const selector of sendButtonSelectors) {
            try {
              const button = document.querySelector(selector);
              if (button && button.offsetWidth > 0 && !button.disabled) {
                button.click();
                return true;
              }
            } catch (e) {
              continue;
            }
          }
          
          // Alternative: try pressing Enter
          const input = document.querySelector('.msg-form__contenteditable');
          if (input) {
            const enterEvent = new KeyboardEvent('keypress', {
              key: 'Enter',
              code: 'Enter',
              which: 13,
              keyCode: 13,
              bubbles: true
            });
            input.dispatchEvent(enterEvent);
            return true;
          }
          
          return false;
        });
        
        if (messageSent) {
          logAction(`✅ Message sent to ${searchName}`);
          results.sent++;
          results.details.push({
            profileId,
            searchName,
            status: 'sent'
          });
        } else {
          logAction(`Failed to send message to ${searchName}`);
          results.failed++;
          results.details.push({
            profileId,
            searchName,
            status: 'failed',
            reason: 'Send button not clicked'
          });
        }
        
        // Wait before processing next profile
        if (i < profileIds.length - 1) {
          const delay = 30000 + Math.random() * 30000; // 30-60 seconds
          logAction(`Waiting ${Math.round(delay/1000)} seconds before next profile...`);
          await randomDelay(delay, delay);
        }
        
      } catch (profileError) {
        logError(`Error processing profile ${profileId}: ${profileError.message}`);
        results.failed++;
        results.details.push({
          profileId,
          status: 'failed',
          reason: profileError.message
        });
      }
    }
    
    // Log final results
    logAction(`Messaging completed: ${results.sent} sent, ${results.failed} failed`);
    
    // Send results back to main process
    console.log(JSON.stringify({
      type: 'message-result',
      result: results
    }));
    
    return results;
    
  } catch (error) {
    logError(`Error in processScheduledMessages: ${error.message}`);
    throw error;
  }
}

/** Wire up the scheduler event if available */
if (messageScheduler && typeof messageScheduler.on === 'function') {
  messageScheduler.on('schedule-triggered', async (schedule) => {
    console.log(`⏰ Schedule ${schedule.id} triggered at ${new Date().toISOString()}`);
    if (mainWindow) {
      mainWindow.webContents.send('automation-log', {
        message: `⏰ Schedule ${schedule.id} triggered`,
        type: 'info'
      });
    }
    await executeScheduledMessage(schedule);
  });
} else {
  console.warn('MessageScheduler not available or not EventEmitter-like; schedule-triggered listener not attached.');
}

/** Safely check & trigger overdue schedules */
function checkAndTriggerOverdueSchedules() {
  try {
    let overdueSchedules = [];
    if (messageScheduler && typeof messageScheduler.getOverdueSchedules === 'function') {
      overdueSchedules = messageScheduler.getOverdueSchedules() || [];
    } else if (messageScheduler && typeof messageScheduler.getScheduledMessages === 'function') {
      const now = Date.now();
      const all = messageScheduler.getScheduledMessages() || [];
      overdueSchedules = all.filter((s) => {
        const ts = s.timestamp || s.scheduledAt || s.scheduledTime || s.runAt;
        const when = ts ? new Date(ts).getTime() : null;
        return s.status === 'pending' && when && when <= now;
      });
    }

    if (Array.isArray(overdueSchedules) && overdueSchedules.length > 0) {
      console.log(`Found ${overdueSchedules.length} overdue scheduled messages`);
      overdueSchedules.forEach((sch) => {
        console.log(`Triggering overdue schedule ${sch.id}`);
        if (messageScheduler && typeof messageScheduler.triggerSchedule === 'function') {
          messageScheduler.triggerSchedule(sch);
        } else {
          executeScheduledMessage(sch);
        }
      });
    }
  } catch (e) {
    console.error('checkAndTriggerOverdueSchedules failed:', e);
  }
}

// Poll every minute
setInterval(checkAndTriggerOverdueSchedules, 60_000);

// Also run a quick check on app startup, if messageScheduler exposes init helpers
app.whenReady().then(() => {
  try {
    if (messageScheduler && typeof messageScheduler.cleanupOldSchedules === 'function') {
      messageScheduler.cleanupOldSchedules(30);
    }
    if (messageScheduler && typeof messageScheduler.initializeTimers === 'function') {
      messageScheduler.initializeTimers();
    }
    setTimeout(checkAndTriggerOverdueSchedules, 5_000);
    console.log('Message scheduler initialized and checking for overdue messages');
  } catch (err) {
    console.warn('Message scheduler init skipped:', err?.message || err);
  }
});

// ---------------- IPC: scheduled messaging UI actions ----------------

// Avoid duplicate listeners if this block is reloaded
ipcMain.removeAllListeners('send-messages-now');
ipcMain.removeAllListeners('schedule-message');
ipcMain.removeAllListeners('get-scheduled-messages');
ipcMain.removeAllListeners('cancel-scheduled-message');
ipcMain.removeAllListeners('update-scheduled-message');
ipcMain.removeAllListeners('get-scheduled-message');

// Handle immediate message sending (Send Now button)
ipcMain.on('send-messages-now', async (event, config) => {
  console.log('=== SEND MESSAGES NOW HANDLER ===');
  console.log('Received config:', {
    profileIds: config.profileIds?.length,
    hasMessage: !!config.message,
    messagePreview: config.message?.substring(0, 50)
  });
  
  // Validate the configuration
  if (!config.profileIds || config.profileIds.length === 0) {
    event.reply('automation-log', {
      message: '❌ No recipients selected for messages',
      type: 'error'
    });
    return;
  }
  
  if (!config.message || config.message.trim() === '') {
    event.reply('automation-log', {
      message: '❌ No message text provided',
      type: 'error'
    });
    return;
  }
  
  event.reply('automation-log', {
    message: `🚀 Starting to send messages to ${config.profileIds?.length || 0} recipients...`,
    type: 'info'
  });

  try {
    assertLegacyDirectLoginAllowed('main.send-messages-now', {
      onAllowed: ({ entryPoint }) => recordLegacyDirectLoginUsage({
        entryPoint,
        accountId: config?.accountId || null,
        accountName: null,
        source: 'main.send-messages-now'
      }, {
        recordEvent: (eventInput) => recordActivityEventSafe(eventInput)
      })
    });
    const account = await loadLinkedInCredentialsForPosting(config?.accountId);
    if (!account?.email || !account?.password) {
      event.reply('automation-log', {
        message: 'No LinkedIn credentials found for the selected profile.',
        type: 'error'
      });
      return;
    }

    const jobId = createLinkedInRuntimeJobId('send-messages', account.id);
    const configPath = path.join(app.getPath('temp'), `message-sending-${jobId}.json`);
    
    const messageConfig = {
      ...config,
      jobId,
      accountId: account.id,
      accountName: account.name,
      accountEmail: account.email,
      mode: 'send-messages',
      profileIds: config.profileIds || [],
      message: config.message || '',
      headless: false,
      slowMo: 100
    };
    
    fs.writeFileSync(configPath, JSON.stringify(messageConfig, null, 2));
    
    const automationScriptPath = path.join(__dirname, 'automation.js');
    
    const childProcess = spawnNodeRuntime(automationScriptPath, [configPath], {
      env: legacyAutomationSpawnEnv()
    });
    globalAutomationProcess = childProcess;
    registerLinkedInRuntimeJob({
      jobId,
      type: 'send-messages',
      accountId: account.id,
      accountName: account.name || account.email,
      process: childProcess,
      meta: {
        recipients: config.profileIds?.length || 0
      }
    });
    
    childProcess.stdout.on('data', (data) => {
      const logLines = data.toString().trim().split('\n');
      logLines.forEach((line) => {
        console.log('Automation output:', line);
        event.reply('automation-log', { 
          message: line, 
          type: 'normal' 
        });
      });
    });

    childProcess.stderr.on('data', (data) => {
      console.error('Automation error:', data.toString());
      event.reply('automation-log', { 
        message: data.toString(), 
        type: 'error' 
      });
    });

    childProcess.on('close', (code) => {
      console.log(`Message sending process exited with code ${code}`);
      event.reply('automation-log', { 
        message: `Process completed with code ${code}`, 
        type: code === 0 ? 'success' : 'error' 
      });
      
      cleanupTempConfig(configPath, 'send-messages temp config');
      
      unregisterLinkedInRuntimeJob(jobId);
      globalAutomationProcess = null;
    });

    childProcess.on('error', () => {
      cleanupTempConfig(configPath, 'send-messages temp config');
      unregisterLinkedInRuntimeJob(jobId);
    });

  } catch (error) {
    console.error('Error in send-messages-now handler:', error);
    event.reply('automation-log', {
      message: `Failed to start: ${error.message}`,
      type: 'error'
    });
  }
});

/** Load all scheduled messages */
ipcMain.on('get-scheduled-messages', (event, filters = {}) => {
  try {
    if (!messageScheduler || typeof messageScheduler.getScheduledMessages !== 'function') {
      throw new Error('MessageScheduler not available');
    }
    const messages = getVisibleScheduledMessages(filters?.accountId || null);
    event.reply('scheduled-messages-loaded', messages);
  } catch (error) {
    event.reply('automation-log', {
      message: `Failed to load scheduled messages: ${error.message}`,
      type: 'error'
    });
  }
});

/** Cancel a scheduled message */
ipcMain.on('cancel-scheduled-message', (event, scheduleIdOrPayload) => {
  try {
    if (!messageScheduler || typeof messageScheduler.cancelSchedule !== 'function') {
      throw new Error('MessageScheduler not available');
    }
    const { scheduleId, accountId, schedule } = resolveScheduledMessageRequest(scheduleIdOrPayload);
    const cancelled = schedule
      ? messageScheduler.cancelSchedule(scheduleId, schedule.accountId ? { accountId: schedule.accountId } : {})
      : false;
    event.reply('automation-log', {
      message: cancelled
        ? `Scheduled message ${scheduleId} cancelled`
        : `Could not cancel message ${scheduleId}`,
      type: cancelled ? 'success' : 'warning'
    });
    const messages = getVisibleScheduledMessages(accountId);
    event.reply('scheduled-messages-loaded', messages);
  } catch (error) {
    event.reply('automation-log', {
      message: `Failed to cancel message: ${error.message}`,
      type: 'error'
    });
  }
});

/** Update a scheduled message */
ipcMain.on('update-scheduled-message', (event, scheduleIdOrPayload, updates, filters = {}) => {
  try {
    if (!messageScheduler || typeof messageScheduler.updateSchedule !== 'function') {
      throw new Error('MessageScheduler not available');
    }
    const { scheduleId, accountId, schedule } = resolveScheduledMessageRequest(scheduleIdOrPayload, filters);
    const updated = schedule
      ? messageScheduler.updateSchedule(scheduleId, updates, schedule.accountId ? { accountId: schedule.accountId } : {})
      : false;
    event.reply('automation-log', {
      message: updated
        ? `Scheduled message ${scheduleId} updated`
        : `Could not update message ${scheduleId}`,
      type: updated ? 'success' : 'warning'
    });
    const messages = getVisibleScheduledMessages(accountId);
    event.reply('scheduled-messages-loaded', messages);
  } catch (error) {
    event.reply('automation-log', {
      message: `Failed to update message: ${error.message}`,
      type: 'error'
    });
  }
});

/** Load one scheduled message */
ipcMain.on('get-scheduled-message', (event, scheduleIdOrPayload, filters = {}) => {
  try {
    if (!messageScheduler || typeof messageScheduler.getScheduledMessages !== 'function') {
      throw new Error('MessageScheduler not available');
    }
    const { scheduleId, schedule: message } = resolveScheduledMessageRequest(scheduleIdOrPayload, filters);
    if (message) {
      event.reply('scheduled-message-loaded', message);
    } else {
      event.reply('automation-log', {
        message: `Scheduled message ${scheduleId} not found`,
        type: 'warning'
      });
    }
  } catch (error) {
    event.reply('automation-log', {
      message: `Failed to load message: ${error.message}`,
      type: 'error'
    });
  }
});


// Handle getting message statistics
ipcMain.handle('get-message-stats', async (event) => {
  try {
    const profiles = getVisibleStoredProfiles();
    if (!profiles.length) {
      return {
        totalMessages: 0,
        todayMessages: 0,
        weekMessages: 0,
        monthMessages: 0
      };
    }
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    let totalMessages = 0;
    let todayMessages = 0;
    let weekMessages = 0;
    let monthMessages = 0;
    
    profiles.forEach(profile => {
      if (profile.actions) {
        profile.actions.forEach(action => {
          if (action.type === 'Message Sent') {
            totalMessages++;
            const actionDate = new Date(action.timestamp);
            
            if (actionDate >= today) todayMessages++;
            if (actionDate >= weekAgo) weekMessages++;
            if (actionDate >= monthAgo) monthMessages++;
          }
        });
      }
    });
    
    return {
      totalMessages,
      todayMessages,
      weekMessages,
      monthMessages
    };
    
  } catch (error) {
    console.error('Error getting message stats:', error);
    return {
      totalMessages: 0,
      todayMessages: 0,
      weekMessages: 0,
      monthMessages: 0
    };
  }
});

// Handle checking message quota
ipcMain.handle('check-message-quota', async (event) => {
  try {
    return getMessageQuota();
    
  } catch (error) {
    console.error('Error checking message quota:', error);
    return {
      daily: { limit: 50, used: 0, resetTime: null },
      weekly: { limit: 250, used: 0, resetTime: null }
    };
  }
});

// Clean up scheduled messages on app startup
app.whenReady().then(() => {
  // Clean up old scheduled messages (older than 30 days)
  messageScheduler.cleanupOldSchedules(30);
  
  // Initialize timers for pending messages
  messageScheduler.initializeTimers();
  
  console.log('Message scheduler initialized');
});

// Clean up timers on app quit
app.on('before-quit', () => {
  console.log('App quitting, cleaning up all processes...');
  stopExternalApiServer();
  
  // Kill all automation processes
  killExistingAutomationProcess();
  
  // Clear any active timers
  if (messageScheduler && messageScheduler.activeTimers) {
    messageScheduler.activeTimers.forEach(timer => clearTimeout(timer));
  }
});

// Handle deleting a workflow
ipcMain.on('delete-workflow', (event, workflowId) => {
  try {
    const removed = workflowTemplateStore.deleteWorkflow(workflowId);
    if (removed) {
      event.reply('automation-log', { 
        message: `Workflow ${workflowId} deleted successfully`, 
        type: 'success'
      });
      
      event.reply('workflow-deleted', { id: workflowId });
    } else {
      event.reply('automation-log', { 
        message: `Workflow ${workflowId} not found`, 
        type: 'warning'
      });
    }
  } catch (error) {
    event.reply('automation-log', { 
      message: `Failed to delete workflow: ${error.message}`, 
      type: 'error'
    });
  }
});

// Handle pausing a workflow
ipcMain.on('pause-workflow', (event, workflowId) => {
  try {
    updateWorkflowStatus(workflowId, 'paused');
    
    event.reply('automation-log', { 
      message: `Workflow ${workflowId} paused`, 
      type: 'info'
    });
    
    event.reply('workflow-paused', { id: workflowId });
  } catch (error) {
    event.reply('automation-log', { 
      message: `Failed to pause workflow: ${error.message}`, 
      type: 'error'
    });
  }
});

// Filter profiles by interaction type
ipcMain.handle('filter-profiles-by-interaction', async (event, interactionType) => {
  try {
    const profiles = getVisibleStoredProfiles();

    // Filter profiles based on interaction type
    return profiles.filter(profile => {
      return profile.actions && profile.actions.some(action => 
        action.type === interactionType
      );
    });
  } catch (error) {
    console.error(`Error filtering profiles by interaction: ${error.message}`);
    return [];
  }
});

// Add this function to main.js
ipcMain.handle('add-profiles-to-workflow', async (event, workflowId, profileIds) => {
  try {
    const workflow = workflowTemplateStore.getLegacyWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const existingIds = new Set(workflow.profileIds || []);
    const nextProfileIds = Array.isArray(profileIds) ? profileIds : [];
    const newProfilesAdded = nextProfileIds.filter((id) => !existingIds.has(id)).length;
    const updated = workflowTemplateStore.addProfilesToLegacyWorkflow(workflowId, nextProfileIds);
    if (!updated) {
      throw new Error(`Failed to update workflow: ${workflowId}`);
    }
    
    // Log the update
    event.reply('automation-log', { 
      message: `Added ${newProfilesAdded} new profiles to workflow "${workflow.name}"`, 
      type: 'success'
    });
    
    return {
      success: true,
      workflow: updated,
      addedCount: newProfilesAdded
    };
  } catch (error) {
    console.error('Error adding profiles to workflow:', error);
    event.reply('automation-log', { 
      message: `Failed to add profiles to workflow: ${error.message}`, 
      type: 'error'
    });
    return {
      success: false,
      error: error.message
    };
  }
});

// Normalize LinkedIn profile URL for consistent comparisons
function normalizeProfileUrl(url) {
  if (!url) return '';
  
  // Remove query parameters, hashes, and trailing slashes
  let normalized = url.split('?')[0].split('#')[0];
  
  // Remove /recent-activity or other common suffixes
  normalized = normalized.split('/recent-activity')[0];
  normalized = normalized.split('/details')[0];
  
  // Remove trailing slash if present
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  
  // Convert to lowercase for case-insensitive comparison
  return normalized.toLowerCase();
}

function isLinkedInProfileUrl(value) {
  return /linkedin\.com\/in\//i.test(String(value || '').trim());
}

// Keep a global reference of the window object to prevent garbage collection
let mainWindow;
let apiServer;
let apiServerStartPromise = null;
let apiServerPort = Number(process.env.CONNECT_API_PORT || process.env.PORT || 3030);
// API token resolution matches the MCP server's: --token-style override is not
// supported here (the Electron app is launched by the user, not invoked by a
// CLI flag), so the order is secure file > env (only when
// CONNECT_ALLOW_ENV_CREDENTIALS=1). The same token file is shared with the MCP
// server so a single rotation flows through both processes.
const _resolvedApiServerToken = resolveSecret({
  name: 'CONNECT_API_TOKEN',
  filePath: path.join(getConnectAbilityAppStateDir(), 'secrets', 'api-token'),
  envVarName: 'CONNECT_API_TOKEN'
});
const apiServerToken = _resolvedApiServerToken ? _resolvedApiServerToken.value : '';
if (_resolvedApiServerToken) {
  console.log(`[main] CONNECT_API_TOKEN loaded from ${_resolvedApiServerToken.source}`);
}
// External API server hardening (see external-api-policy.js + tests).
//   - apiAllowedOrigins: explicit allowlist for Access-Control-Allow-Origin.
//     Empty (default) means no browser origin is granted CORS access at all;
//     CLI/MCP/curl-without-Origin clients are unaffected because CORS is
//     browser-only enforcement.
//   - apiDevUnauth: emergency override for local debugging when no token is
//     configured. Loud warning at startup so it can't be set accidentally
//     and forgotten in production.
const apiAllowedOrigins = parseAllowedOrigins(process.env.CONNECT_API_ALLOWED_ORIGINS || '');
const apiDevUnauth = process.env.CONNECT_API_DEV_UNAUTH === '1';

const EXTERNAL_API_FUNCTIONS = [
  'startAutomation',
  'startNameListAutomation',
  'stopAutomation',
  'saveCredentials',
  'loadCredentials',
  'clearCredentials',
  'loginLinkedIn',
  'logoutLinkedIn',
  'getLoginStatus',
  'getAllProfiles',
  'getProfileData',
  'loadProfilesFromJson',
  'storeProfileBatch',
  'storeProfileAction',
  'getAllWorkflows',
  'createWorkflow',
  'updateWorkflow',
  'startWorkflow',
  'deleteWorkflow',
  'pauseWorkflow',
  'runGroupWorkflow',
  'getGroupsData',
  'saveGroupsData',
  'publishLinkedInPost',
  'scheduleMessage',
  'getScheduledMessages',
  'getScheduledMessage',
  'cancelScheduledMessage',
  'updateScheduledMessage',
  'sendScheduledNow',
  'getMessageStats',
  'checkMessageQuota',
  'filterProfilesByInteraction',
  'addProfilesToWorkflow',
  // Visible-browser live actions (canonical worker). Safety policy in
  // external-api-safety.js stamps launchSource:'external_api' + headless:false.
  'sendNewDm',
  'findLinkedInProfilesBySearch',
  'send'
];

const API_OPERATION_CATALOG = [
  {
    id: 'health',
    method: 'GET',
    path: '/api/health',
    description: 'Health check for the local API bridge.'
  },
  {
    id: 'listFunctions',
    method: 'GET',
    path: '/api/functions',
    description: 'Returns all callable bridge functions.'
  },
  {
    id: 'schema',
    method: 'GET',
    path: '/api/schema',
    description: 'Returns machine-readable operation catalog and examples.'
  },
  {
    id: 'call',
    method: 'POST',
    path: '/api/call',
    description: 'Invokes a function from window.electronAPI.',
    body: {
      function: 'string (required)',
      args: 'array (optional)'
    }
  },
  {
    id: 'startAutomation',
    via: 'POST /api/call',
    function: 'startAutomation',
    argsShape: [
      {
        searchType: 'query | names',
        searchQuery: 'string (required if searchType=query)',
        nameList: 'string[] (required if searchType=names)',
        profileLimit: 'number',
        visitProfile: 'boolean',
        likePosts: 'boolean',
        sendConnection: 'boolean',
        sendWithNote: 'boolean',
        connectMessage: 'string',
        browserProfile: 'random|windows|mac',
        headless: 'boolean',
        slowMo: 'number'
      }
    ]
  },
  {
    id: 'startNameListAutomation',
    via: 'POST /api/call',
    function: 'startNameListAutomation',
    argsShape: [
      {
        searchType: 'names',
        nameList: 'string[]',
        visitProfile: 'boolean',
        likePosts: 'boolean',
        sendConnection: 'boolean',
        sendWithNote: 'boolean',
        connectMessage: 'string',
        browserProfile: 'random|windows|mac',
        headless: 'boolean',
        slowMo: 'number'
      }
    ]
  },
  {
    id: 'publishLinkedInPost',
    via: 'POST /api/call',
    function: 'publishLinkedInPost',
    argsShape: [
      {
        content: 'string',
        sendType: 'send-now | schedule-post',
        scheduledDate: 'YYYY-MM-DD (required for schedule-post)',
        scheduledTime: 'HH:mm (required for schedule-post)',
        postType: 'text | image | video | link',
        includeImage: 'boolean'
      }
    ]
  },
  {
    id: 'scheduleMessage',
    via: 'POST /api/call',
    function: 'scheduleMessage',
    argsShape: [
      {
        message: 'string',
        profileIds: 'string[]',
        isRecurring: 'boolean (optional)',
        recurringPattern: 'daily|weekly|monthly (optional)',
        recurrenceCount: 'number (optional)',
        sendNow: 'boolean OR scheduledTime required',
        scheduledTime: 'ISO datetime (if not sendNow)'
      }
    ]
  },
  {
    id: 'sendMessagesNow',
    via: 'POST /api/call',
    function: 'send',
    argsShape: [
      'send-messages-now',
      {
        message: 'string',
        profileIds: 'string[]'
      }
    ]
  },
  {
    id: 'listScheduledMessages',
    via: 'POST /api/call',
    function: 'getScheduledMessages',
    argsShape: []
  },
  {
    id: 'runGroupWorkflow',
    via: 'POST /api/call',
    function: 'runGroupWorkflow',
    argsShape: [
      {
        groupId: 'string',
        targets: [
          {
            profileUrl: 'string (LinkedIn /in/ URL from findLinkedInProfilesBySearch profiles[])',
            name: 'string (optional)',
            headline: 'string (optional)',
            source: 'linkedin_people_search',
            searchTerm: 'string',
            searchRank: 'number',
            searchResultIndex: 'number',
            searchPageUrl: 'string'
          }
        ],
        steps: [
          {
            type: 'view_profile | like_posts | send_connection | send_dm | delay',
            minDelayMs: 'number',
            maxDelayMs: 'number',
            messageTemplate: 'string (optional)'
          }
        ],
        headless: 'boolean'
      }
    ]
  },
  {
    id: 'updateWorkflow',
    via: 'POST /api/call',
    function: 'updateWorkflow',
    description: 'Updates an existing legacy workflow template in place. Does not launch browser automation.',
    argsShape: [
      'workflowId',
      {
        name: 'string (optional)',
        description: 'string (optional)',
        profileIds: 'string[] (optional)',
        actions: {
          viewProfile: 'boolean (optional)',
          likePosts: 'boolean (optional)',
          sendConnection: 'boolean (optional)',
          sendDm: 'boolean (optional)'
        },
        settings: 'object (optional)',
        status: 'string (optional)'
      }
    ]
  },
  {
    id: 'findLinkedInProfilesBySearch',
    via: 'POST /api/call',
    function: 'findLinkedInProfilesBySearch',
    note: 'Visible-browser. Runs people search inside the canonical worker; headless is forced false.',
    argsShape: [
      {
        searchTerm: 'string',
        accountId: 'string (optional)',
        maxResults: 'number (1-50, default 10)',
        maxPages: 'number (1-5, default 3)'
      }
    ]
  },
  {
    id: 'sendNewDm',
    via: 'POST /api/call',
    function: 'sendNewDm',
    note: 'Visible-browser. Sends a DM from the canonical worker session; headless is forced false.',
    argsShape: [
      {
        profileUrl: 'string',
        message: 'string',
        recipientName: 'string (optional)',
        accountId: 'string (optional)'
      }
    ]
  }
];

const API_CALL_EXAMPLES = {
  health: {
    method: 'GET',
    url: '/api/health'
  },
  listFunctions: {
    method: 'GET',
    url: '/api/functions'
  },
  startAutomation: {
    method: 'POST',
    url: '/api/call',
    body: {
      function: 'startAutomation',
      args: [
        {
          searchType: 'query',
          searchQuery: 'SEO specialist',
          profileLimit: 10,
          visitProfile: true,
          likePosts: true,
          sendConnection: true,
          sendWithNote: true,
          connectMessage: 'Hi {firstName}, I noticed your profile and would love to connect.',
          browserProfile: 'random',
          headless: false,
          slowMo: 50
        }
      ]
    }
  },
  scheduleMessage: {
    method: 'POST',
    url: '/api/call',
    body: {
      function: 'scheduleMessage',
      args: [
        {
          message: 'Hi {firstName}, wanted to follow up with you.',
          profileIds: ['https://www.linkedin.com/in/example-profile/'],
          sendNow: false,
          scheduledTime: '2026-02-15T18:00:00.000Z'
        }
      ]
    }
  },
  runGroupWorkflow: {
    method: 'POST',
    url: '/api/call',
    body: {
      function: 'runGroupWorkflow',
      args: [
        {
          targets: [
            {
              profileUrl: 'https://www.linkedin.com/in/example-from-search',
              name: 'Example Person',
              source: 'linkedin_people_search',
              searchTerm: 'software engineer',
              searchRank: 1,
              searchResultIndex: 1,
              searchPageUrl: 'https://www.linkedin.com/search/results/people/?keywords=software%20engineer'
            }
          ],
          workflowName: 'Software engineer search follow-up',
          steps: [
            { type: 'view_profile', minDelayMs: 8000, maxDelayMs: 18000 },
            { type: 'delay', minDelayMs: 86400000, maxDelayMs: 86400000 },
            { type: 'like_posts', minDelayMs: 8000, maxDelayMs: 18000 },
            { type: 'delay', minDelayMs: 86400000, maxDelayMs: 86400000 },
            { type: 'send_connection', messageTemplate: 'Hi {firstName}, ...', minDelayMs: 8000, maxDelayMs: 18000 },
            { type: 'delay', minDelayMs: 86400000, maxDelayMs: 86400000 },
            { type: 'send_dm', messageTemplate: 'Hi {firstName}, ...', minDelayMs: 8000, maxDelayMs: 18000 },
            { type: 'delay', minDelayMs: 86400000, maxDelayMs: 86400000 },
            { type: 'send_dm', messageTemplate: 'Quick follow up, {firstName}...', minDelayMs: 8000, maxDelayMs: 18000 }
          ],
          headless: false
        }
      ]
    }
  },
  updateWorkflow: {
    method: 'POST',
    url: '/api/call',
    body: {
      function: 'updateWorkflow',
      args: [
        'wf_legacy_123',
        {
          name: 'Edited workflow name',
          actions: {
            likePosts: false,
            sendConnection: true
          },
          settings: {
            steps: [
              { type: 'view_profile' },
              { type: 'send_connection' }
            ]
          }
        }
      ]
    }
  },
  findLinkedInProfilesBySearch: {
    method: 'POST',
    url: '/api/call',
    body: {
      function: 'findLinkedInProfilesBySearch',
      args: [
        {
          searchTerm: 'Head of People',
          maxResults: 5,
          maxPages: 3
        }
      ]
    }
  },
  sendNewDm: {
    method: 'POST',
    url: '/api/call',
    body: {
      function: 'sendNewDm',
      args: [
        {
          profileUrl: 'https://www.linkedin.com/in/example-profile/',
          message: 'Hi {firstName}, wanted to reach out directly.',
          recipientName: 'Example Person'
        }
      ]
    }
  }
};

function apiJson(req, res, statusCode, payload) {
  // CORS headers are emitted ONLY when the request's Origin is on the
  // configured allowlist. Empty allowlist (default) → no CORS headers at all,
  // which is safe by design: browsers block the cross-origin request, and
  // non-browser callers (curl, MCP, CLI) don't send an Origin header and
  // therefore don't care. The wildcard `*` is never emitted.
  const origin = String((req && req.headers && req.headers.origin) || '');
  const corsHeaders = buildCorsHeaders(origin, apiAllowedOrigins);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders
  });
  res.end(JSON.stringify(payload));
}

function isApiAuthorized(req) {
  // No token configured means we are in dev_unauth mode (the bind gate refused
  // to start the server unless either a token is set OR
  // CONNECT_API_DEV_UNAUTH=1 was explicitly opted into). Accept the request.
  if (!apiServerToken) return true;
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const tokenHeader = String(req.headers['x-api-token'] || '').trim();
  // Constant-time compare — see external-api-policy.compareTokenSafely.
  return compareTokenSafely(bearer, apiServerToken) ||
         compareTokenSafely(tokenHeader, apiServerToken);
}

async function callRendererApiFunction(functionName, args = []) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is not ready');
  }
  if (!EXTERNAL_API_FUNCTIONS.includes(functionName)) {
    throw new Error(`Unsupported function "${functionName}"`);
  }

  // External-API safety chokepoint. Runs BEFORE anything is injected into the
  // renderer: blocks legacy/bypass functions, rejects headless:true, and on
  // allowed browser functions forces headless:false + stamps
  // launchSource:'external_api'. Throws ExternalApiSafetyError (surfaced as a
  // 403 by the /api/call handler) for blocked calls. See external-api-safety.js.
  const safeArgs = applyExternalApiSafety(functionName, args);

  const js = `(async () => {
    const fnName = ${JSON.stringify(functionName)};
    const fn = window.electronAPI && window.electronAPI[fnName];
    if (typeof fn !== 'function') {
      return { ok: false, error: 'Function not available in renderer: ' + fnName };
    }
    try {
      const result = await fn(...${JSON.stringify(safeArgs)});
      return { ok: true, result: result === undefined ? null : result };
    } catch (error) {
      const rawMsg = error && error.message ? error.message : String(error);
      // A handler signals "not found" with a [not_found] token in the message
      // (the only field that survives the IPC boundaries). Surface it as a
      // structured code and strip the token from the human-facing message.
      const notFound = /\\[not_found\\]/.test(rawMsg);
      const cleanMsg = rawMsg.replace(/\\s*\\[not_found\\]\\s*/, ' ').trim();
      return { ok: false, error: cleanMsg, code: notFound ? 'not_found' : ((error && error.code) || null) };
    }
  })()`;

  return mainWindow.webContents.executeJavaScript(js, true);
}

function startExternalApiServer() {
  if (apiServer?.listening) {
    return Promise.resolve(apiServer);
  }
  if (apiServerStartPromise) {
    return apiServerStartPromise;
  }

  // Safe-by-default bind gate. Refuses to start the listener unless either a
  // token is configured (production-safe) OR CONNECT_API_DEV_UNAUTH=1 is set
  // (explicit local-debug opt-in). Without this gate a fresh install with no
  // token quietly exposed the renderer's API surface to any loopback caller —
  // including any browser tab the user happened to have open.
  const bindDecision = resolveServerBindDecision({
    tokenConfigured: Boolean(apiServerToken),
    devUnauth: apiDevUnauth
  });
  if (!bindDecision.start) {
    console.log(`[ExternalAPI] disabled: ${bindDecision.reason}`);
    return Promise.resolve(null);
  }
  if (bindDecision.mode === 'dev_unauth') {
    // Loud warning. CORS allowlist independence is repeated here so it shows
    // up at the same place the operator sees the override take effect, not
    // only buried in policy comments.
    console.warn('[ExternalAPI] WARNING: CONNECT_API_DEV_UNAUTH=1 — binding without authentication.');
    console.warn('[ExternalAPI] WARNING: This is DEV ONLY. Do not ship a build with this flag set.');
    console.warn('[ExternalAPI] WARNING: Browser origins are still controlled by CONNECT_API_ALLOWED_ORIGINS;');
    console.warn('[ExternalAPI] WARNING: this override does NOT relax CORS. Set CONNECT_API_ALLOWED_ORIGINS');
    console.warn('[ExternalAPI] WARNING: explicitly if you also need cross-origin browser access.');
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        return apiJson(req, res, 200, { ok: true });
      }
      if (!isApiAuthorized(req)) {
        return apiJson(req, res, 401, {
          ok: false,
          error: 'Unauthorized. Provide Bearer token or X-API-Token header.'
        });
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return apiJson(req, res, 200, { ok: true, status: 'ready', port: apiServerPort });
      }

      if (req.method === 'GET' && url.pathname === '/api/functions') {
        // Advertise only externally-callable functions — blocked legacy /
        // bypass / not-source-aware functions disappear from discovery so the
        // surface matches what authorizeToolCall-equivalent enforcement allows.
        return apiJson(req, res, 200, {
          ok: true,
          functions: filterExternalApiFunctions(EXTERNAL_API_FUNCTIONS),
          authRequired: Boolean(apiServerToken)
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/schema') {
        // Drop blocked operations + strip the headless knob so the schema
        // never advertises a mode the safety layer forbids.
        return apiJson(req, res, 200, {
          ok: true,
          name: 'Connect Ability External API',
          version: '1.0.0',
          authRequired: Boolean(apiServerToken),
          operations: filterExternalApiCatalog(API_OPERATION_CATALOG),
          examples: filterExternalApiExamples(API_CALL_EXAMPLES)
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/call') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 1024 * 1024) {
            req.destroy();
          }
        });
        req.on('end', async () => {
          try {
            const body = raw ? JSON.parse(raw) : {};
            const functionName = String(body.function || body.fn || '').trim();
            const args = Array.isArray(body.args) ? body.args : [];

            if (!functionName) {
              return apiJson(req, res, 400, { ok: false, error: 'Missing "function" in request body' });
            }

            const result = await callRendererApiFunction(functionName, args);
            if (!result || result.ok !== true) {
              // not_found → 404 so clients can distinguish a missing resource
              // from a generic failure; everything else stays 400.
              const status = result && result.code === 'not_found' ? 404 : 400;
              return apiJson(req, res, status, {
                ok: false,
                error: result?.error || 'Function execution failed',
                ...(result?.code ? { code: result.code } : {})
              });
            }
            return apiJson(req, res, 200, { ok: true, result: result.result });
          } catch (error) {
            // Safety-layer refusals (blocked function, headless forbidden)
            // surface as 403 with the machine-readable code so callers can
            // branch; everything else stays a 400.
            if (error && error.name === 'ExternalApiSafetyError') {
              return apiJson(req, res, 403, { ok: false, error: error.message, code: error.code });
            }
            return apiJson(req, res, 400, { ok: false, error: error.message });
          }
        });
        return;
      }

      return apiJson(req, res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      return apiJson(req, res, 500, { ok: false, error: error.message });
    }
  });

  apiServerStartPromise = new Promise((resolve) => {
    const finalize = (result) => {
      server.removeListener('listening', handleListening);
      server.removeListener('error', handleError);
      apiServerStartPromise = null;
      resolve(result);
    };

    const handleListening = () => {
      apiServer = server;
      const corsDescription = apiAllowedOrigins.length > 0
        ? `cors=[${apiAllowedOrigins.join(',')}]`
        : 'cors=none';
      console.log(
        `[ExternalAPI] Listening on http://127.0.0.1:${apiServerPort} ` +
          `(mode=${bindDecision.mode} ${corsDescription})`
      );
      finalize(server);
    };

    const handleError = (error) => {
      if (error?.code === 'EADDRINUSE') {
        console.warn(
          `[ExternalAPI] Port ${apiServerPort} is already in use on 127.0.0.1. Skipping local bridge startup for this app instance.`
        );
      } else {
        console.error('[ExternalAPI] Failed to start server:', error);
      }
      if (apiServer === server) {
        apiServer = null;
      }
      try {
        server.close();
      } catch {}
      finalize(null);
    };

    server.once('listening', handleListening);
    server.once('error', handleError);

    try {
      server.listen(apiServerPort, '127.0.0.1');
    } catch (error) {
      handleError(error);
    }
  });

  return apiServerStartPromise;
}

function stopExternalApiServer() {
  if (apiServerStartPromise) {
    apiServerStartPromise = null;
  }
  if (!apiServer) return;
  try {
    apiServer.close();
  } catch (error) {
    console.error('[ExternalAPI] Failed to close server:', error.message);
  } finally {
    apiServer = null;
  }
}

// Store the automation process
let automationProcess = null;
let workflowManagerProcess = null;

// Define correct paths to your automation scripts
const automationScript = path.join(__dirname, 'automation.js'); // Use your actual script name

// Create the browser window
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false, // Don't show until ready-to-show
    backgroundColor: '#f6f9fc'
  });

  // Load the redesigned prototype UI (React + JSX via in-browser Babel).
  // The legacy vanilla UI at app.html still exists as a fallback.
  mainWindow.loadFile('Connect.html');

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open DevTools in development mode
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    // Kill all processes when window is closed
    killExistingAutomationProcess();
    mainWindow = null;
  });

  return mainWindow;
}



// Create window when Electron has finished initialization
app.whenReady().then(() => {
  // Call repairProfilesData at startup
  repairProfilesData();

  if (process.platform === 'darwin') {
    try {
      app.dock.setIcon(path.join(__dirname, 'assets', 'icon.icns'));
    } catch (error) {
      console.error('Failed to set dock icon:', error);
    }
  }
  createWindow();
  startExternalApiServer();

  // On macOS it's common to re-create a window when the dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Clean up all processes before quitting
  killExistingAutomationProcess();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});


ipcMain.on('stop-automation', (event, payload = {}) => {
  const stoppableTypes = new Set(['search-engage', 'name-list', 'send-messages', 'scheduled-message']);
  const stoppedJobs = Array.from(linkedInRuntimeJobs.values()).filter((job) => {
    if (payload?.accountId && job.accountId !== payload.accountId) return false;
    return stoppableTypes.has(job.type);
  });

  stoppedJobs.forEach((job) => {
    terminateChildProcess(job.process);
  });
  const stopped = stoppedJobs.length;

  event.reply('automation-log', { 
    message: stopped
      ? `Stopped ${stopped} running automation job${stopped === 1 ? '' : 's'}`
      : 'No running automation jobs found to stop',
    type: stopped ? 'warning' : 'info'
  });
  event.reply('automation-completed');
});

ipcMain.on('start-name-list-automation', async (event, config) => {
  const account = await loadLinkedInCredentialsForPosting(config?.accountId);
  if (!account?.email || !account?.password) {
    event.reply('automation-log', {
      message: 'No LinkedIn credentials found for the selected profile.',
      type: 'error'
    });
    event.reply('automation-completed');
    return;
  }

  // Log the start of name list automation
  event.reply('automation-log', { 
    message: `Starting name list automation for ${config.nameList?.length || 0} names using ${account.name || account.email}...`, 
    type: 'info'
  });

  try {
    assertLegacyDirectLoginAllowed('main.start-name-list-automation', {
      onAllowed: ({ entryPoint }) => recordLegacyDirectLoginUsage({
        entryPoint,
        accountId: config?.accountId || null,
        accountName: null,
        source: 'main.start-name-list-automation'
      }, {
        recordEvent: (eventInput) => recordActivityEventSafe(eventInput)
      })
    });
    // Save config to tempfile
    const jobId = createLinkedInRuntimeJobId('name-list', account.id);
    const configPath = path.join(app.getPath('temp'), `linkedin-name-config-${jobId}.json`);
    
    // CRITICAL: Ensure the config has the correct structure for name list automation
    const nameListConfig = {
      ...config,
      jobId,
      accountId: account.id,
      accountName: account.name,
      accountEmail: account.email,
      mode: 'name-list-automation',  // Add mode identifier
      searchType: 'names'           // Ensure search type is set
    };
    
    fs.writeFileSync(configPath, JSON.stringify(nameListConfig));

    // Launch the automation script with the name list config
    const childProcess = spawnNodeRuntime(automationScript, [configPath], {
      env: legacyAutomationSpawnEnv()
    });
    automationProcess = childProcess;
    registerLinkedInRuntimeJob({
      jobId,
      type: 'name-list',
      accountId: account.id,
      accountName: account.name || account.email,
      process: childProcess,
      meta: { count: config.nameList?.length || 0 }
    });

    // Handle standard output
    childProcess.stdout.on('data', (data) => {
      const logLines = data.toString().trim().split('\n');
      
      logLines.forEach(line => {
        try {
          // Try to parse JSON logs (structured)
          const logData = JSON.parse(line);
          
          if (logData.type === 'progress') {
            // Progress updates
            event.reply('automation-progress', {
              current: logData.current,
              total: logData.total
            });
          } else {
            // Regular log messages
            event.reply('automation-log', {
              message: logData.message || line,
              type: logData.type || 'normal'
            });
          }
        } catch (e) {
          // If not JSON, treat as plain text log
          event.reply('automation-log', {
            message: line,
            type: 'normal'
          });
        }
      });
    });

    // Handle error output
    childProcess.stderr.on('data', (data) => {
      const errorMessage = data.toString().trim();
      event.reply('automation-log', { 
        message: errorMessage, 
        type: 'error'
      });
    });

    // Handle process exit
    childProcess.on('close', (code) => {
      const message = `Name list automation process exited with code ${code}`;
      const type = code === 0 ? 'success' : 'error';
      
      event.reply('automation-log', { message, type });
      event.reply('automation-completed');
      unregisterLinkedInRuntimeJob(jobId);
      
      cleanupTempConfig(configPath, 'name-list temp config');
    });

    childProcess.on('error', () => {
      cleanupTempConfig(configPath, 'name-list temp config');
      unregisterLinkedInRuntimeJob(jobId);
    });

  } catch (error) {
    event.reply('automation-log', { 
      message: `Failed to start name list automation: ${error.message}`, 
      type: 'error'
    });
    event.reply('automation-completed');
  }
});

// Handle stopping the automation process
// Account-scoped stop handler is registered earlier; keep this block inert to avoid duplicate listeners.

// Handle exporting logs
ipcMain.on('export-logs', (event, logs) => {
  dialog.showSaveDialog(mainWindow, {
    title: 'Export Automation Logs',
    defaultPath: path.join(app.getPath('documents'), 'linkedin-automation-logs.txt'),
    filters: [
      { name: 'Text Files', extensions: ['txt'] }
    ]
  }).then(result => {
    if (!result.canceled && result.filePath) {
      try {
        // Format logs for export
        const formattedLogs = logs.map(log => 
          `[${log.time}] [${log.type.toUpperCase()}] ${log.message}`
        ).join('\n');
        
        fs.writeFileSync(result.filePath, formattedLogs);
        
        event.reply('automation-log', { 
          message: `Logs exported to ${result.filePath}`, 
          type: 'success'
        });
      } catch (error) {
        event.reply('automation-log', { 
          message: `Failed to export logs: ${error.message}`, 
          type: 'error'
        });
      }
    }
  });
});

// ----- Credential Management Handlers -----

function getConnectAbilityDocumentsDir() {
  const userHome = process.env.HOME || process.env.USERPROFILE || '';
  const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
  fs.mkdirSync(documentsDir, { recursive: true });
  return documentsDir;
}

function getLinkedInAccountsStorePath() {
  return path.join(app.getPath('userData'), 'linkedin-accounts.json');
}

function getLegacyCredentialsPaths() {
  return [
    path.join(app.getPath('userData'), 'credentials.json'),
    path.join(getConnectAbilityDocumentsDir(), 'credentials.json')
  ];
}

function buildLinkedInAccountName(email = '', fallbackIndex = 0) {
  const localPart = String(email || '').split('@')[0] || '';
  const normalized = localPart
    .replace(/[._-]+/g, ' ')
    .trim();

  if (!normalized) {
    return `LinkedIn Profile ${fallbackIndex + 1}`;
  }

  return normalized
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const LEGACY_PRIMARY_LINKEDIN_ACCOUNT_ID = 'li_primary';

function normalizeLinkedInAccountRecord(account, fallbackIndex = 0, options = {}) {
  if (!account || typeof account !== 'object') {
    return null;
  }

  const requirePassword = Boolean(options.requirePassword);
  const email = String(account.email || '').trim();
  const password = String(account.password || '').trim();
  if (!email || (requirePassword && !password)) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    id: String(account.id || `li_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    name: String(account.name || account.label || '').trim() || buildLinkedInAccountName(email, fallbackIndex),
    email,
    hasPassword: typeof options.hasPassword === 'boolean'
      ? options.hasPassword
      : Boolean(account.hasPassword || password),
    createdAt: account.createdAt || now,
    updatedAt: now,
    // Stealth / safety fields — optional; default to null when absent.
    timezoneId: String(account.timezoneId || '').trim().slice(0, 80) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
    workingHours: (account.workingHours && typeof account.workingHours === 'object' && !Array.isArray(account.workingHours))
      ? account.workingHours
      : null,
    warmUpStartedAt: String(account.warmUpStartedAt || '').trim().slice(0, 80) || null,
    fingerprintProfileSeed: normalizeFingerprintProfileSeed(account.fingerprintProfileSeed, email),
    delayProfileSeed: normalizeDelayProfileSeed(account.delayProfileSeed, email),
    strictStealth: account.strictStealth === true,
    proxy: normalizeProxyConfig(account.proxy)
  };
}

function sanitizeLinkedInAccountRecord(account, fallbackIndex = 0) {
  const normalized = normalizeLinkedInAccountRecord(account, fallbackIndex, {
    requirePassword: false
  });
  if (!normalized) {
    return null;
  }

  return {
    id: normalized.id,
    name: normalized.name,
    email: normalized.email,
    hasPassword: Boolean(normalized.hasPassword),
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    timezoneId: normalized.timezoneId,
    workingHours: normalized.workingHours,
    warmUpStartedAt: normalized.warmUpStartedAt,
    fingerprintProfileSeed: normalized.fingerprintProfileSeed,
    delayProfileSeed: normalized.delayProfileSeed,
    strictStealth: normalized.strictStealth === true,
    proxy: normalized.proxy
  };
}

function readLinkedInAccountsStoreRaw() {
  const storePath = getLinkedInAccountsStorePath();
  if (!fs.existsSync(storePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (error) {
    console.error('Failed to read raw LinkedIn accounts store:', error);
    return null;
  }
}

function loadLegacyLinkedInCredentials() {
  for (const credentialsPath of getLegacyCredentialsPaths()) {
    if (!fs.existsSync(credentialsPath)) continue;

    try {
      const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      if (credentials?.email && credentials?.password) {
        return credentials;
      }
    } catch (error) {
      console.error(`Failed to parse legacy credentials at ${credentialsPath}:`, error);
    }
  }

  return null;
}

function deleteLegacyCredentialsFiles() {
  getLegacyCredentialsPaths().forEach((credentialsPath) => {
    try {
      if (fs.existsSync(credentialsPath)) {
        fs.unlinkSync(credentialsPath);
      }
    } catch (error) {
      console.error(`Failed to delete legacy credentials at ${credentialsPath}:`, error);
    }
  });
}

function readLinkedInAccountsStore() {
  const rawStore = readLinkedInAccountsStoreRaw();
  if (rawStore) {
    const accounts = Array.isArray(rawStore?.accounts)
      ? rawStore.accounts.map((account, index) => sanitizeLinkedInAccountRecord(account, index)).filter(Boolean)
      : [];
    const activeAccountId = accounts.some((account) => account.id === rawStore?.activeAccountId)
      ? rawStore.activeAccountId
      : (accounts[0]?.id || null);
    return {
      accounts,
      activeAccountId
    };
  }

  const legacyCredentials = loadLegacyLinkedInCredentials();
  if (!legacyCredentials) {
    return {
      accounts: [],
      activeAccountId: null
    };
  }

  const migratedAccount = normalizeLinkedInAccountRecord({
    id: LEGACY_PRIMARY_LINKEDIN_ACCOUNT_ID,
    name: buildLinkedInAccountName(legacyCredentials.email, 0),
    email: legacyCredentials.email,
    hasPassword: true
  }, 0);

  return {
    accounts: migratedAccount ? [migratedAccount] : [],
    activeAccountId: migratedAccount?.id || null
  };
}

function getActiveLinkedInAccountRecord(store = readLinkedInAccountsStore()) {
  if (!store?.accounts?.length) {
    return null;
  }

  return store.accounts.find((account) => account.id === store.activeAccountId) || store.accounts[0] || null;
}

function resolveLinkedInAccountRecord(accountId = null) {
  const store = ensureLinkedInAccountsStore();
  if (accountId) {
    const matchingAccount = store.accounts.find((account) => account.id === accountId);
    if (matchingAccount) {
      return matchingAccount;
    }
  }
  return getActiveLinkedInAccountRecord(store);
}

function syncLegacyCredentials(activeAccount) {
  if (activeAccount?.email) {
    process.env.LINKEDIN_EMAIL = activeAccount.email;
  } else {
    delete process.env.LINKEDIN_EMAIL;
  }

  delete process.env.LINKEDIN_PASSWORD;
  if (linkedInAccountsStoreReady) {
    deleteLegacyCredentialsFiles();
  }
}

function writeLinkedInAccountsStore(store) {
  const accounts = Array.isArray(store?.accounts)
    ? store.accounts.map((account, index) => sanitizeLinkedInAccountRecord(account, index)).filter(Boolean)
    : [];
  const activeAccountId = accounts.some((account) => account.id === store?.activeAccountId)
    ? store.activeAccountId
    : (accounts[0]?.id || null);
  const payload = {
    activeAccountId,
    accounts
  };

  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  // Atomic write — linkedin-accounts.json carries every account record
  // (session pointers, fingerprint seeds, working-hours config). A crash
  // mid-write previously could corrupt the file and leave the app unable
  // to load any LinkedIn account on the next launch.
  writeJsonFileAtomic(getLinkedInAccountsStorePath(), payload);
  syncLegacyCredentials(getActiveLinkedInAccountRecord(payload));
  return payload;
}

async function migrateLinkedInAccountsStoreToSecureStorage() {
  const rawStore = readLinkedInAccountsStoreRaw();
  const baseStore = readLinkedInAccountsStore();
  const accounts = baseStore.accounts.map((account) => ({ ...account }));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  let changed = !fs.existsSync(getLinkedInAccountsStorePath());

  if (rawStore?.accounts && Array.isArray(rawStore.accounts)) {
    rawStore.accounts.forEach((rawAccount, index) => {
      const normalized = sanitizeLinkedInAccountRecord(rawAccount, index);
      if (!normalized || accountById.has(normalized.id)) {
        return;
      }
      accountById.set(normalized.id, normalized);
      accounts.push(normalized);
      changed = true;
    });

    for (const [index, rawAccount] of rawStore.accounts.entries()) {
      const normalized = sanitizeLinkedInAccountRecord(rawAccount, index);
      const rawPassword = String(rawAccount?.password || '').trim();
      const account = normalized ? accountById.get(normalized.id) : null;
      if (!account || !rawPassword) {
        continue;
      }
      await setLinkedInAccountPassword(account.id, rawPassword);
      if (!account.hasPassword) {
        account.hasPassword = true;
      }
      changed = true;
    }
  }

  const legacyCredentials = loadLegacyLinkedInCredentials();
  if (legacyCredentials?.email && legacyCredentials?.password) {
    const matchingByEmail = accounts.find((account) => account.email.toLowerCase() === legacyCredentials.email.toLowerCase());
    const legacyAccount = matchingByEmail || sanitizeLinkedInAccountRecord({
      id: LEGACY_PRIMARY_LINKEDIN_ACCOUNT_ID,
      name: buildLinkedInAccountName(legacyCredentials.email, accounts.length),
      email: legacyCredentials.email,
      hasPassword: true
    }, accounts.length);

    if (legacyAccount && !matchingByEmail) {
      accountById.set(legacyAccount.id, legacyAccount);
      accounts.unshift(legacyAccount);
      changed = true;
    }

    if (legacyAccount) {
      await setLinkedInAccountPassword(legacyAccount.id, legacyCredentials.password);
      if (!legacyAccount.hasPassword) {
        legacyAccount.hasPassword = true;
      }
      changed = true;
    }
  }

  for (const account of accounts) {
    const hasStoredPassword = await hasLinkedInAccountPassword(account.id);
    if (Boolean(account.hasPassword) !== hasStoredPassword) {
      account.hasPassword = hasStoredPassword;
      changed = true;
    }
  }

  const activeAccountId = accounts.some((account) => account.id === baseStore.activeAccountId)
    ? baseStore.activeAccountId
    : (accounts[0]?.id || null);
  const nextStore = {
    accounts,
    activeAccountId
  };

  if (changed) {
    writeLinkedInAccountsStore(nextStore);
  } else {
    syncLegacyCredentials(getActiveLinkedInAccountRecord(nextStore));
  }

  linkedInAccountsStoreReady = true;
  deleteLegacyCredentialsFiles();
  return readLinkedInAccountsStore();
}

function ensureLinkedInAccountsStoreReady(force = false) {
  if (force || !linkedInAccountsStoreReadyPromise) {
    linkedInAccountsStoreReadyPromise = migrateLinkedInAccountsStoreToSecureStorage().catch((error) => {
      linkedInAccountsStoreReady = false;
      linkedInAccountsStoreReadyPromise = null;
      throw error;
    });
  }
  return linkedInAccountsStoreReadyPromise;
}

function ensureLinkedInAccountsStore() {
  const storePath = getLinkedInAccountsStorePath();
  const store = readLinkedInAccountsStore();

  if (!fs.existsSync(storePath)) {
    return writeLinkedInAccountsStore(store);
  }

  syncLegacyCredentials(getActiveLinkedInAccountRecord(store));
  return store;
}

async function getLinkedInAccountsWithCredentials() {
  await ensureLinkedInAccountsStoreReady();
  const store = readLinkedInAccountsStore();
  const accounts = await Promise.all(store.accounts.map(async (account) => {
    const credentials = await resolveLinkedInAccountCredentials(account);
    if (!credentials?.password) {
      return null;
    }

    return {
      ...account,
      password: credentials.password
    };
  }));

  return accounts.filter(Boolean);
}

async function loadLinkedInAccountCredentials(accountId = null) {
  await ensureLinkedInAccountsStoreReady();
  const account = resolveLinkedInAccountRecord(accountId);
  console.log('[loadLinkedInAccountCredentials] Resolved account:', account ? { id: account.id, email: account.email, hasPassword: account.hasPassword } : null);
  if (account?.email) {
    try {
      const credentials = await resolveLinkedInAccountCredentials(account);
      console.log('[loadLinkedInAccountCredentials] Keychain result:', credentials ? { hasPassword: !!credentials.password } : 'null');
      if (credentials?.password) {
        return {
          ...account,
          password: credentials.password
        };
      }
    } catch (keychainError) {
      console.error('[loadLinkedInAccountCredentials] Keychain error:', keychainError.message || keychainError);
    }
  }

  // Env-var credential fallback is gated behind CONNECT_ALLOW_ENV_CREDENTIALS.
  // Default: ignored. The keychain is the canonical source; .env is a dev-only
  // escape hatch and not relied on in production. See automation/safety/secret-source.
  const envPassword = readEnvCredential('LINKEDIN_PASSWORD', { name: 'LinkedIn password' });
  if (envPassword && process.env.LINKEDIN_EMAIL) {
    console.log('[loadLinkedInAccountCredentials] Using env credentials (CONNECT_ALLOW_ENV_CREDENTIALS enabled)');
    return {
      email: process.env.LINKEDIN_EMAIL,
      password: envPassword.value,
      hasPassword: true
    };
  }

  console.warn('[loadLinkedInAccountCredentials] No credentials found at all');
  return null;
}

function notifyActiveCredentialsLoaded(account) {
  if (mainWindow) {
    mainWindow.webContents.send('credentials-loaded', account || null);
  }
}

function notifyCredentialsSaved(success) {
  if (mainWindow) {
    mainWindow.webContents.send('credentials-saved', success);
  }
}

async function upsertLinkedInAccount(accountData = {}) {
  await ensureLinkedInAccountsStoreReady();
  const store = ensureLinkedInAccountsStore();
  const existingAccount = store.accounts.find((account) => account.id === accountData.id) || null;
  const nextPassword = typeof accountData.password === 'string' ? accountData.password.trim() : '';
  const normalizedAccount = normalizeLinkedInAccountRecord({
    ...existingAccount,
    ...accountData,
    id: accountData.id || existingAccount?.id,
    hasPassword: nextPassword ? true : Boolean(existingAccount?.hasPassword)
  }, store.accounts.length);

  if (!normalizedAccount) {
    return {
      success: false,
      error: 'LinkedIn email is required.'
    };
  }

  if (!nextPassword && !normalizedAccount.hasPassword) {
    return {
      success: false,
      error: 'A password is required for new LinkedIn profiles.'
    };
  }

  if (nextPassword) {
    await setLinkedInAccountPassword(normalizedAccount.id, nextPassword);
    normalizedAccount.hasPassword = true;
  }

  const accounts = existingAccount
    ? store.accounts.map((account) => account.id === normalizedAccount.id ? normalizedAccount : account)
    : [normalizedAccount, ...store.accounts];
  const nextStore = writeLinkedInAccountsStore({
    accounts,
    activeAccountId: accountData.makeActive === false
      ? (store.activeAccountId || normalizedAccount.id)
      : normalizedAccount.id
  });

  return {
    success: true,
    account: nextStore.accounts.find((account) => account.id === normalizedAccount.id) || normalizedAccount,
    accounts: nextStore.accounts,
    activeAccountId: nextStore.activeAccountId
  };
}

function removeLinkedInAccount(accountId) {
  return removeLinkedInAccountAsync(accountId);
}

async function removeLinkedInAccountAsync(accountId) {
  await ensureLinkedInAccountsStoreReady();
  const store = ensureLinkedInAccountsStore();
  const remainingAccounts = store.accounts.filter((account) => account.id !== accountId);
  await deleteLinkedInAccountPassword(accountId).catch((error) => {
    console.error(`Failed to delete LinkedIn password for ${accountId}:`, error);
  });
  const nextStore = writeLinkedInAccountsStore({
    accounts: remainingAccounts,
    activeAccountId: store.activeAccountId === accountId ? (remainingAccounts[0]?.id || null) : store.activeAccountId
  });

  return {
    success: true,
    accounts: nextStore.accounts,
    activeAccountId: nextStore.activeAccountId,
    activeAccount: getActiveLinkedInAccountRecord(nextStore)
  };
}

async function setActiveLinkedInAccount(accountId) {
  await ensureLinkedInAccountsStoreReady();
  const store = ensureLinkedInAccountsStore();
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) {
    return {
      success: false,
      error: 'LinkedIn profile not found.'
    };
  }

  const nextStore = writeLinkedInAccountsStore({
    accounts: store.accounts,
    activeAccountId: account.id
  });

  return {
    success: true,
    activeAccount: getActiveLinkedInAccountRecord(nextStore),
    accounts: nextStore.accounts,
    activeAccountId: nextStore.activeAccountId
  };
}

ipcMain.handle('get-linkedin-accounts', async () => {
  await ensureLinkedInAccountsStoreReady();
  const store = ensureLinkedInAccountsStore();
  return store.accounts;
});

ipcMain.handle('get-active-linkedin-account', async () => {
  await ensureLinkedInAccountsStoreReady();
  const store = ensureLinkedInAccountsStore();
  return getActiveLinkedInAccountRecord(store);
});

ipcMain.handle('get-linkedin-runtime-jobs', async () => {
  return getLinkedInRuntimeJobsSnapshot();
});

// Renderer queries this on startup to decide whether to surface legacy
// direct-login UI controls. The server-side assertLegacyDirectLoginAllowed
// guard remains the source of truth for execution; this only controls UI
// visibility. To surface the controls without enabling every legacy entry
// point, set CONNECT_ALLOW_LEGACY_DIRECT_LOGIN=renderer-ui explicitly.
ipcMain.handle('get-app-mode', async () => {
  return {
    legacyDirectLoginEnabled: isLegacyDirectLoginAllowed('renderer-ui')
  };
});

ipcMain.handle('get-linkedin-account-health', async () => {
  return getLinkedInAccountHealthSnapshot();
});

ipcMain.handle('clear-linkedin-account-challenge', async (_event, accountId) => {
  try {
    await ensureLinkedInAccountsStoreReady();
    const account = resolveLinkedInAccountRecord(accountId);
    if (!account?.id) {
      throw new Error('LinkedIn account not found');
    }

    const verification = await verifyLinkedInAccountSession(account.id);
    linkedInAccountHealthStore.clearChallenge(account.id);
    broadcastLinkedInAccountHealthUpdated();

    return {
      success: true,
      accountId: account.id,
      accountName: account.name || account.email || null,
      verifiedAt: verification?.verifiedAt || new Date().toISOString(),
      indicator: verification?.indicator || null
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('clear-campaign-apollo-hold', async (_event, campaignRunId) => {
  try {
    const run = campaignRunManager.getRun(campaignRunId);
    if (!run?.id) {
      throw new Error('Campaign run not found');
    }

    const cleared = campaignController.clearApolloHold(run.id);
    if (!cleared || cleared.status !== 'queued') {
      throw new Error('Campaign is not waiting on Apollo hold');
    }

    emitWorkflowLogMessage(
      `Apollo hold cleared for campaign ${formatCampaignRunLabel(cleared)}.`,
      'success',
      {
        source: 'apollo-hold',
        accountId: cleared.accountId || null,
        accountName: cleared.accountName || null,
        prospectId: cleared.prospectId || null,
        metadata: {
          campaignRunId: cleared.id
        }
      }
    );
    broadcastCampaignRunsUpdated(cleared.accountId || null);
    broadcastSdrWorkflowRunsUpdated(cleared.accountId || null);

    return {
      success: true,
      campaignRunId: cleared.id,
      accountId: cleared.accountId || null,
      accountName: cleared.accountName || null,
      status: cleared.status
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('drain-campaign-run', async (_event, campaignRunId) => {
  try {
    const outcome = campaignController.drainCampaignRun(campaignRunId, 'operator_cancelled');
    if (!outcome?.campaignRun) {
      return {
        success: false,
        error: 'Campaign run not found'
      };
    }

    broadcastSdrWorkflowRunsUpdated(outcome.campaignRun.accountId || null);
    broadcastCampaignRunsUpdated(outcome.campaignRun.accountId || null);
    return {
      success: true,
      campaignRun: outcome.campaignRun,
      pollRecord: outcome.pollRecord || null,
      drainedChildRunIds: Array.isArray(outcome.drainedChildRunIds) ? outcome.drainedChildRunIds : []
    };
  } catch (error) {
    console.error('Failed to drain campaign run:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('drain-all-campaign-runs', async () => {
  try {
    const outcomes = campaignController.drainAllCampaignRuns('operator_stop_all');
    broadcastSdrWorkflowRunsUpdated();
    broadcastCampaignRunsUpdated();
    return {
      success: true,
      runs: outcomes.map((outcome) => ({
        campaignRun: outcome.campaignRun,
        pollRecord: outcome.pollRecord || null,
        drainedChildRunIds: Array.isArray(outcome.drainedChildRunIds) ? outcome.drainedChildRunIds : []
      }))
    };
  } catch (error) {
    console.error('Failed to drain all campaign runs:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('save-linkedin-account', async (event, accountData) => {
  try {
    const result = await upsertLinkedInAccount(accountData);
    notifyCredentialsSaved(result.success);
    if (result.success) {
      const activeAccount = getActiveLinkedInAccountRecord({
        accounts: result.accounts,
        activeAccountId: result.activeAccountId
      });
      notifyActiveCredentialsLoaded(activeAccount);
      broadcastSdrAgentsUpdated(activeAccount?.id || null);
      broadcastSdrWorkflowRunsUpdated(activeAccount?.id || null);
    }
    return result;
  } catch (error) {
    console.error('Failed to save LinkedIn account:', error);
    notifyCredentialsSaved(false);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('delete-linkedin-account', async (event, accountId) => {
  try {
    const result = await removeLinkedInAccount(accountId);
    notifyActiveCredentialsLoaded(result.activeAccount || null);
    broadcastSdrAgentsUpdated(result.activeAccount?.id || null);
    broadcastSdrWorkflowRunsUpdated(result.activeAccount?.id || null);
    return result;
  } catch (error) {
    console.error('Failed to delete LinkedIn account:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('set-active-linkedin-account', async (event, accountId) => {
  try {
    const result = await setActiveLinkedInAccount(accountId);
    if (result.success) {
      notifyActiveCredentialsLoaded(result.activeAccount || null);
      broadcastSdrAgentsUpdated(result.activeAccount?.id || null);
      broadcastSdrWorkflowRunsUpdated(result.activeAccount?.id || null);
    }
    return result;
  } catch (error) {
    console.error('Failed to set active LinkedIn account:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

function attachPersonaStatus(agents) {
  return agents.map((agent) => {
    let personaStatus = null;
    try {
      const status = agentPersonaStore.getStatus(agent.id);
      personaStatus = {
        hasPersona: status.hasPersona,
        complete: status.complete,
        fileCount: Array.isArray(status.existingFiles) ? status.existingFiles.length : 0,
        existingFiles: status.existingFiles,
        missingFiles: status.missingFiles,
      };
    } catch (_) {
      personaStatus = { hasPersona: false, complete: false, fileCount: 0, existingFiles: [], missingFiles: [] };
    }
    return { ...agent, personaStatus };
  });
}

ipcMain.handle('get-sdr-agents', async (_event, filters = {}) => {
  // The Agents admin page passes { scope: 'all' } to manage every agent
  // regardless of the currently active LinkedIn account.
  const agents = (filters && filters.scope === 'all')
    ? sdrAgentManager.getAllAgents()
    : getVisibleSdrAgents(filters);
  return attachPersonaStatus(agents);
});

ipcMain.handle('save-sdr-agent', async (event, agentInput) => {
  try {
    const sanitizedAgentInput = sanitizeSdrAgentPayload(agentInput);
    await ensureLinkedInAccountsStoreReady();
    const activeScope = getLinkedInAccountScope(null);
    const effectiveAccountId = sanitizedAgentInput.accountId || activeScope.accountId || null;
    const account = effectiveAccountId
      ? ensureLinkedInAccountsStore().accounts.find((entry) => entry.id === effectiveAccountId) || null
      : null;
    if (effectiveAccountId && !account) {
      throw new Error('Selected LinkedIn account could not be found');
    }
    const savedAgent = sdrAgentManager.saveAgent({
      ...sanitizedAgentInput,
      accountId: effectiveAccountId,
      accountName: sanitizedAgentInput.accountName || account?.name || account?.email || activeScope.accountName || null
    });
    const visibleAccountId = activeScope.accountId || effectiveAccountId || null;
    broadcastSdrAgentsUpdated(visibleAccountId);
    return {
      success: true,
      agent: savedAgent,
      agents: getVisibleSdrAgents({ accountId: visibleAccountId })
    };
  } catch (error) {
    console.error('Failed to save SDR agent:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('get-agent-persona', async (_event, agentId) => {
  try {
    const id = String(agentId || '').trim();
    if (!id) return { success: false, error: 'agentId is required' };
    const status = agentPersonaStore.getStatus(id);
    const files = agentPersonaStore.readAll(id);
    const standard = AgentPersonaStore.STANDARD_FILES;
    const filesByName = {};
    standard.forEach(name => { filesByName[name] = files[name] != null ? files[name] : null; });
    Object.keys(files).forEach(name => {
      if (!standard.includes(name)) filesByName[name] = files[name];
    });
    return { success: true, agentId: id, status, files: filesByName };
  } catch (error) {
    console.error('Failed to read agent persona:', error);
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('write-agent-persona', async (_event, payload = {}) => {
  try {
    const id = String(payload.agentId || '').trim();
    const fileName = String(payload.fileName || '').trim();
    const content = payload.content == null ? '' : String(payload.content);
    if (!id) return { success: false, error: 'agentId is required' };
    if (!fileName) return { success: false, error: 'fileName is required' };
    agentPersonaStore.writeFile(id, fileName, content);
    const status = agentPersonaStore.getStatus(id);
    return { success: true, agentId: id, fileName, status };
  } catch (error) {
    console.error('Failed to write agent persona file:', error);
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('delete-agent-persona', async (_event, payload = {}) => {
  try {
    const id = String(payload.agentId || '').trim();
    const fileName = String(payload.fileName || '').trim();
    if (!id || !fileName) {
      return { success: false, error: 'agentId and fileName are required' };
    }
    const result = agentPersonaStore.deleteFile(id, fileName);
    const status = agentPersonaStore.getStatus(id);
    return { success: result.deleted, agentId: id, fileName, status };
  } catch (error) {
    console.error('Failed to delete agent persona file:', error);
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('delete-sdr-agent', async (event, agentId) => {
  try {
    const result = sdrAgentManager.deleteAgent(agentId);
    const visibleAccountId = getLinkedInAccountScope().accountId || null;
    broadcastSdrAgentsUpdated(visibleAccountId);
    return {
      success: result.deleted,
      agents: getVisibleSdrAgents({ accountId: visibleAccountId })
    };
  } catch (error) {
    console.error('Failed to delete SDR agent:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('get-sdr-workflow-runs', async (_event, filters = {}) => {
  return getVisibleSdrWorkflowRuns(filters);
});

ipcMain.handle('get-campaign-runs', async (_event, filters = {}) => {
  return getVisibleCampaignRuns(filters);
});

ipcMain.handle('get-sdr-agent-search-presets', async (event, agentId) => {
  const agent = sdrAgentManager.getAgent(agentId);
  if (!agent) {
    return [];
  }
  return buildAgentSearchPresets(agent);
});

ipcMain.handle('generate-sdr-agent-content-plan', async (_event, payload = {}) => {
  try {
    const sanitizedPayload = sanitizeSdrAgentContentPlanPayload(payload);
    const agent = sdrAgentManager.getAgent(sanitizedPayload.agentId);
    if (!agent) {
      throw new Error('SDR agent not found');
    }

    const plan = buildAgentContentPlan(agent, sanitizedPayload);
    const existingPosts = scheduledPostStore.getAllPosts();
    const replaceExisting = sanitizedPayload.replaceExisting !== false;
    const nextPosts = replaceExisting
      ? existingPosts.filter((post) => {
          if (post.agentId !== plan.agentId || post.sourceType !== 'agent_plan') {
            return true;
          }
          return !['pending', 'failed', 'cancelled'].includes(post.status);
        })
      : existingPosts.slice();

    const persistedPosts = scheduledPostStore.replaceAllPosts([...nextPosts, ...plan.posts]);
    return {
      success: true,
      plan: {
        planId: plan.planId,
        planName: plan.planName,
        cadence: plan.cadence,
        days: plan.days,
        startDate: plan.startDate,
        postingTime: plan.postingTime,
        timezone: plan.timezone,
        agentId: plan.agentId,
        agentName: plan.agentName,
        accountId: plan.accountId
      },
      createdPosts: plan.posts.length,
      totalScheduledPosts: persistedPosts.length
    };
  } catch (error) {
    console.error('Failed to generate SDR agent content plan:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('get-sdr-prospects', async (_event, filters = {}) => {
  return prospectQueueStore.getAllProspects(getScopedProspectFilters(filters));
});

// Read a captured profile screenshot from disk and return it as a base64 data
// URL so the renderer can render it without dealing with file:// origin rules.
ipcMain.handle('read-profile-screenshot', async (_event, payload = {}) => {
  try {
    const rawPath = String(payload && payload.path || '').trim();
    if (!rawPath) return { success: false, error: 'path is required' };
    // Only allow reads under the known screenshots directory — defense-in-depth
    // against renderer trying to read arbitrary paths. Uses the same
    // cross-platform app-state path the screenshot writer uses.
    const { getConnectAbilityAppStateDir } = require('./connect-documents');
    const allowedDir = path.join(getConnectAbilityAppStateDir(), 'profile-screenshots');
    const resolved = path.resolve(rawPath);
    if (!resolved.startsWith(path.resolve(allowedDir))) {
      return { success: false, error: 'Screenshot path is outside the allowed directory' };
    }
    if (!fs.existsSync(resolved)) {
      return { success: false, error: 'Screenshot not found' };
    }
    const buffer = fs.readFileSync(resolved);
    const ext = path.extname(resolved).toLowerCase().replace('.', '') || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
    return {
      success: true,
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      size: buffer.length,
    };
  } catch (error) {
    console.error('Failed to read profile screenshot:', error);
    return { success: false, error: error.message || String(error) };
  }
});

// List activity events with optional filters. Reads the JSONL store directly
// so the Prospect detail page can build a per-profile timeline.
ipcMain.handle('list-activity-events', async (_event, filters = {}) => {
  try {
    const prospectId = filters && filters.prospectId ? String(filters.prospectId) : null;
    const profileUrl = filters && filters.profileUrl ? String(filters.profileUrl) : null;
    const accountId = filters && filters.accountId ? String(filters.accountId) : null;
    const since = filters && filters.since ? String(filters.since) : null;
    const limit = Math.min(1000, Math.max(1, Number(filters && filters.limit) || 200));

    const eventsPath = activityEventStore.eventsPath;
    if (!eventsPath || !fs.existsSync(eventsPath)) return [];

    const raw = fs.readFileSync(eventsPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let evt;
      try { evt = JSON.parse(lines[i]); } catch { continue; }
      if (prospectId && evt.prospectId !== prospectId) continue;
      if (profileUrl) {
        const norm = (u) => String(u || '').replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
        if (norm(evt.profileUrl) !== norm(profileUrl) && norm(evt.targetValue) !== norm(profileUrl)) continue;
      }
      if (accountId && evt.accountId !== accountId) continue;
      if (since && evt.timestamp && evt.timestamp < since) continue;
      out.push(evt);
    }
    // out is newest-first because we iterated in reverse — keep that order.
    return out;
  } catch (error) {
    console.error('Failed to list activity events:', error);
    return [];
  }
});

// Operator-initiated DM. Dispatches into the account's worker so the message
// goes out from the same persistent-context browser the workflow runtime uses
// — one session, one fingerprint.
ipcMain.handle('send-new-dm', async (_event, payload = {}) => {
  const profileUrl = String(payload && payload.profileUrl || '').trim();
  const messageBody = String(payload && payload.message || '').trim();
  const recipientName = String(payload && payload.recipientName || '').trim() || null;
  const requestedAccountId = String(payload && payload.accountId || '').trim() || null;
  // Provenance marker stamped by external-api-safety for API-triggered calls.
  // Threaded into the worker account so the launch assertion + headless-reuse
  // refusal enforce visible-only for external-API DMs.
  const launchSource = String(payload && payload.launchSource || '').trim() || null;

  if (!profileUrl) return { success: false, error: 'profileUrl is required' };
  if (!messageBody) return { success: false, error: 'message is required' };

  try {
    await ensureLinkedInAccountsStoreReady();
    const store = ensureLinkedInAccountsStore();
    const account = (
      (requestedAccountId && store.accounts.find(a => a.id === requestedAccountId)) ||
      getActiveLinkedInAccountRecord(store) ||
      store.accounts[0] || null
    );
    if (!account) return { success: false, error: 'No LinkedIn account configured.' };

    const credentials = await loadLinkedInCredentialsForPosting(account.id);
    if (!credentials?.email || !credentials?.password) {
      return { success: false, error: `No saved credentials for ${account.email || account.id}.` };
    }

    const workerAccount = {
      accountId: credentials.id || null,
      accountName: credentials.name || credentials.email,
      id: credentials.id || null,
      name: credentials.name || credentials.email,
      email: credentials.email,
      password: credentials.password,
      timezoneId: credentials.timezoneId || 'America/Chicago',
      workingHours: credentials.workingHours || null,
      warmUpStartedAt: credentials.warmUpStartedAt || null,
      fingerprintProfileSeed: credentials.fingerprintProfileSeed || null,
      delayProfileSeed: credentials.delayProfileSeed || null,
      strictStealth: credentials.strictStealth === true,
      proxy: credentials.proxy || null,
      headless: false,
      launchSource,
      slowMo: 50,
    };

    const requestId = `compose-dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    emitWorkflowLogMessage(`[compose-dm] Sending to ${recipientName || profileUrl} via ${credentials.email}…`, 'info');
    const worker = accountWorkerProcessManager.getOrCreate(workerAccount);

    const response = await accountWorkerProcessManager.dispatchAndAwaitMessage(
      workerAccount,
      {
        type: ACCOUNT_WORKER_MESSAGE_TYPES.SEND_NEW_DM,
        requestId,
        profileUrl,
        message: messageBody,
        recipientName,
      },
      {
        matchMessage: (msg) => (
          msg?.type === ACCOUNT_WORKER_MESSAGE_TYPES.SEND_NEW_DM_RESULT
          && msg?.requestId === requestId
        ),
        timeoutMs: 5 * 60 * 1000,
        timeoutLabel: `DM send result for ${recipientName || profileUrl}`,
        closedLabel: `DM send result for ${recipientName || profileUrl}`,
      }
    );

    if (!response || response.success === false) {
      return { success: false, error: (response && response.error) || 'DM send failed' };
    }

    // Record activity event so it shows up in the prospect timeline + analytics.
    recordActivityEventSafe({
      type: 'dm_sent',
      accountId: credentials.id || null,
      accountName: credentials.name || credentials.email,
      profileUrl,
      targetValue: profileUrl,
      status: 'ok',
      metadata: {
        manualCompose: true,
        recipientName: response.recipientName || recipientName || null,
        conversationUrn: response.conversationUrn || null,
        messagePreview: (messageBody || '').slice(0, 280),
      },
    });

    return {
      success: true,
      profileUrl,
      recipientName: response.recipientName || recipientName || null,
      conversationUrn: response.conversationUrn || null,
    };
  } catch (error) {
    console.error('Send-new-dm failed:', error);
    return { success: false, error: error.message || String(error) };
  }
});

// Live LinkedIn people-search. Dispatches into the account's worker process so
// the search happens inside the same persistent-context Chromium that will
// later execute the workflow steps — one browser window, one session, one
// fingerprint, no double-login.
ipcMain.handle('find-linkedin-profiles-by-search', async (_event, payload = {}) => {
  const term = String(payload.searchTerm || '').trim();
  const requestedAccountId = String(payload.accountId || '').trim() || null;
  const maxResults = Math.max(1, Math.min(50, Number(payload.maxResults || 10)));
  const maxPages = Math.max(1, Math.min(5, Number(payload.maxPages || 3)));
  // Provenance marker stamped by external-api-safety for API-triggered calls;
  // threaded into the worker account to enforce visible-only via the launch
  // assertion + headless-reuse refusal.
  const launchSource = String(payload.launchSource || '').trim() || null;

  if (!term) return { success: false, error: 'searchTerm is required' };

  try {
    await ensureLinkedInAccountsStoreReady();
    const store = ensureLinkedInAccountsStore();
    const account = (
      (requestedAccountId && store.accounts.find(a => a.id === requestedAccountId)) ||
      getActiveLinkedInAccountRecord(store) ||
      store.accounts[0] ||
      null
    );
    if (!account) {
      return { success: false, error: 'No LinkedIn account configured. Add one in Credentials first.' };
    }

    const credentials = await loadLinkedInCredentialsForPosting(account.id);
    if (!credentials?.email || !credentials?.password) {
      return {
        success: false,
        error: `No saved credentials for ${account.email || account.id}. Open Credentials and save a password first.`,
      };
    }

    const workerAccount = {
      accountId: credentials.id || null,
      accountName: credentials.name || credentials.email,
      id: credentials.id || null,
      name: credentials.name || credentials.email,
      email: credentials.email,
      password: credentials.password,
      // Worker startup throws "Account timezoneId is required" without these.
      timezoneId: credentials.timezoneId || 'America/Chicago',
      workingHours: credentials.workingHours || null,
      warmUpStartedAt: credentials.warmUpStartedAt || null,
      fingerprintProfileSeed: credentials.fingerprintProfileSeed || null,
      delayProfileSeed: credentials.delayProfileSeed || null,
      strictStealth: credentials.strictStealth === true,
      proxy: credentials.proxy || null,
      headless: false,
      launchSource,
      slowMo: 50,
    };

    const requestId = `discover-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    emitWorkflowLogMessage(`[search] Dispatching "${term}" to ${credentials.email}'s session…`, 'info');

    const worker = accountWorkerProcessManager.getOrCreate(workerAccount);
    const handleWorkerLog = (payload2) => {
      if (payload2?.type !== ACCOUNT_WORKER_MESSAGE_TYPES.LOG || payload2?.jobId !== requestId) return;
      const message = typeof payload2.message === 'string' ? payload2.message.trim() : '';
      if (!message) return;
      const level = String(payload2.level || 'info').trim().toLowerCase();
      emitWorkflowLogMessage(`[search] ${message}`, level === 'error' ? 'error' : level === 'warning' || level === 'warn' ? 'warning' : 'info');
    };
    worker.on('message', handleWorkerLog);

    try {
      const response = await accountWorkerProcessManager.dispatchAndAwaitMessage(
        workerAccount,
        {
          type: ACCOUNT_WORKER_MESSAGE_TYPES.DISCOVER_BY_SEARCH,
          requestId,
          searchTerm: term,
          maxResults,
          maxPages,
        },
        {
          matchMessage: (msg) => (
            msg?.type === ACCOUNT_WORKER_MESSAGE_TYPES.DISCOVER_BY_SEARCH_RESULT
            && msg?.requestId === requestId
          ),
          timeoutMs: 5 * 60 * 1000,
          timeoutLabel: `search result for "${term}"`,
          closedLabel: `search result for "${term}"`,
        }
      );

      if (!response || response.success === false) {
        return {
          success: false,
          error: (response && response.error) || 'Search failed (no response from worker)',
        };
      }

      // Pass through the structured People-search receipt. profiles[] is the
      // source of truth (display order, rank, source marker); urls[] is kept
      // for backward compatibility with existing callers and is derived from
      // profiles when present so the two never disagree.
      const profiles = Array.isArray(response.profiles) ? response.profiles.slice(0, maxResults) : [];
      const urls = profiles.length
        ? profiles.map((p) => p.profileUrl)
        : (Array.isArray(response.urls) ? response.urls.slice(0, maxResults) : []);
      return {
        success: true,
        searchTerm: term,
        searchPageUrl: response.searchPageUrl || (profiles[0] && profiles[0].searchPageUrl) || null,
        accountId: account.id,
        accountEmail: credentials.email,
        profiles,
        urls,
        count: urls.length,
      };
    } finally {
      worker.off('message', handleWorkerLog);
    }
  } catch (error) {
    console.error('LinkedIn live search failed:', error);
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('get-apollo-integration', async () => {
  try {
    return await apolloSyncService.getIntegration();
  } catch (error) {
    console.error('Failed to load Apollo integration:', error);
    return {
      enabled: false,
      hasApiKey: false,
      bindings: [],
      recentSyncs: [],
      summary: {},
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('configure-apollo-integration', async (_event, input = {}) => {
  try {
    const config = await apolloSyncService.configureIntegration(input || {});
    return { success: true, config };
  } catch (error) {
    console.error('Failed to configure Apollo integration:', error);
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('get-apollo-sync-status', async (_event, filters = {}) => {
  try {
    return apolloSyncService.listSyncStatus({
      accountId: String(filters?.accountId || '').trim() || null,
      prospectId: String(filters?.prospectId || '').trim() || null,
      sequenceId: String(filters?.sequenceId || '').trim() || null,
      status: String(filters?.status || '').trim() || null,
      targetType: String(filters?.targetType || '').trim() || null,
      targetId: String(filters?.targetId || '').trim() || null,
      workflowId: String(filters?.workflowId || '').trim() || null,
      groupId: String(filters?.groupId || '').trim() || null,
      agentId: String(filters?.agentId || '').trim() || null,
      limit: Number(filters?.limit) || 25
    });
  } catch (error) {
    console.error('Failed to load Apollo sync status:', error);
    return [];
  }
});

ipcMain.handle('list-apollo-bindings', async (_event, filters = {}) => {
  try {
    return apolloSyncService.listBindings({
      targetType: String(filters?.targetType || '').trim() || null,
      targetId: String(filters?.targetId || '').trim() || null,
      enabled: typeof filters?.enabled === 'boolean' ? filters.enabled : null
    });
  } catch (error) {
    console.error('Failed to list Apollo bindings:', error);
    return [];
  }
});

ipcMain.handle('get-sdr-workflow-jobs', async (event, runId) => {
  return workflowRunManager.getJobs(runId || null);
});

ipcMain.handle('cancel-sdr-workflow-run', async (event, runId) => {
  try {
    const result = workflowRunManager.cancelRun(runId, 'Cancelled by user');
    durableScheduler.markRunCancelled(runId);
    broadcastSdrWorkflowRunsUpdated();
    return {
      success: result.cancelled
    };
  } catch (error) {
    console.error('Failed to cancel SDR workflow run:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('delete-sdr-workflow-run', async (_event, runId) => {
  try {
    const id = String(runId || '').trim();
    if (!id) return { success: false, error: 'runId is required' };
    const result = workflowRunManager.deleteRun(id);
    if (!result.deleted) {
      return { success: false, error: result.reason || 'Could not delete run' };
    }
    broadcastSdrWorkflowRunsUpdated();
    return {
      success: true,
      runsRemoved: result.runsRemoved || 0,
      jobsRemoved: result.jobsRemoved || 0,
    };
  } catch (error) {
    console.error('Failed to delete SDR workflow run:', error);
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('pause-workflow-run', async (_event, runId) => {
  try {
    const run = workflowRunManager.pauseRun(runId, { reason: 'Paused by operator' });
    if (!run) {
      return { success: false, error: 'Workflow run not found' };
    }
    syncInboxStatusesForRun(runId, 'paused');
    broadcastSdrWorkflowRunsUpdated(run.accountId || null);
    return {
      success: true,
      run
    };
  } catch (error) {
    console.error('Failed to pause SDR workflow run:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('resume-workflow-run', async (_event, runId) => {
  try {
    const outcome = resumeWorkflowRunFromLinkedIn({
      runId,
      workflowRuns: workflowRunManager,
      campaignController
    });
    const run = outcome.workflowRun;
    if (!run) {
      return { success: false, error: 'Workflow run not found' };
    }
    syncInboxStatusesForRun(runId, 'replied');
    broadcastSdrWorkflowRunsUpdated(run.accountId || null);
    if (outcome.campaignTransition?.campaignRun) {
      broadcastCampaignRunsUpdated(outcome.campaignTransition.campaignRun.accountId || outcome.previousRun?.accountId || null);
    }
    return {
      success: true,
      run
    };
  } catch (error) {
    console.error('Failed to resume SDR workflow run:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('get-activity-analytics', async (_event, filters = {}) => {
  try {
    return activityAnalyticsService.getOverview(filters || {});
  } catch (error) {
    console.error('Failed to load activity analytics:', error);
    return {
      filters: filters || {},
      totals: {},
      rates: {},
      recentActivity: [],
      recentReplies: [],
      byAgent: [],
      byWorkflow: [],
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('export-activity-report', async (_event, filters = {}) => {
  try {
    const normalizedFilters = {
      accountId: String(filters?.accountId || '').trim() || null,
      agentId: String(filters?.agentId || '').trim() || null,
      workflowId: String(filters?.workflowId || '').trim() || null
    };

    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Export Folder',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    });

    if (selection.canceled || !selection.filePaths?.[0]) {
      return { success: false, cancelled: true };
    }

    const workflowRuns = workflowRunManager.getAllRuns().filter((run) => {
      if (normalizedFilters.accountId && run.accountId !== normalizedFilters.accountId) return false;
      if (normalizedFilters.agentId && run.agentId !== normalizedFilters.agentId) return false;
      if (normalizedFilters.workflowId && (run.workflowId || run.id) !== normalizedFilters.workflowId) return false;
      return true;
    });
    const workflowJobs = workflowRunManager.getJobs().filter((job) => {
      if (normalizedFilters.accountId && job.accountId !== normalizedFilters.accountId) return false;
      if (normalizedFilters.agentId && job.agentId !== normalizedFilters.agentId) return false;
      if (normalizedFilters.workflowId && job.workflowId !== normalizedFilters.workflowId) return false;
      return true;
    });
    const prospects = prospectQueueStore.getAllProspects(normalizedFilters);
	    const overview = activityAnalyticsService.getOverview({
	      ...normalizedFilters,
	      activityLimit: 100
	    });
	    const replyEvents = activityAnalyticsService.getReplyEvents(normalizedFilters);
	    const stepOutcomeBreakdown = activityAnalyticsService.getStepOutcomeBreakdown(normalizedFilters);

	    const result = activityExportService.createBundle({
	      outputDir: selection.filePaths[0],
	      filters: normalizedFilters,
	      overview,
	      workflowRuns,
	      workflowJobs,
	      prospects,
	      replyEvents,
	      stepOutcomeBreakdown
	    });

    return {
      success: true,
      cancelled: false,
      path: result.bundleDir,
      fileCount: result.fileCount,
      summary: result.summary
    };
  } catch (error) {
    console.error('Error exporting activity report:', error);
    return {
      success: false,
      cancelled: false,
      error: error.message || 'Failed to export activity report'
    };
  }
});

ipcMain.handle('export-diagnostics-report', async (_event, filters = {}) => {
  try {
    const normalizedFilters = {
      accountId: String(filters?.accountId || '').trim() || null,
      agentId: String(filters?.agentId || '').trim() || null,
      workflowId: String(filters?.workflowId || '').trim() || null,
      runId: String(filters?.runId || '').trim() || null,
      correlationId: String(filters?.correlationId || '').trim() || null
    };

    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Diagnostics Export Folder',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    });

    if (selection.canceled || !selection.filePaths?.[0]) {
      return { success: false, cancelled: true };
    }

    const workflowRuns = workflowRunManager.getAllRuns().filter((run) => {
      if (normalizedFilters.accountId && run.accountId !== normalizedFilters.accountId) return false;
      if (normalizedFilters.agentId && run.agentId !== normalizedFilters.agentId) return false;
      if (normalizedFilters.workflowId && (run.workflowId || run.id) !== normalizedFilters.workflowId) return false;
      if (normalizedFilters.runId && run.id !== normalizedFilters.runId) return false;
      if (normalizedFilters.correlationId && run.correlationId !== normalizedFilters.correlationId) return false;
      return true;
    });
    const workflowJobs = workflowRunManager.getJobs().filter((job) => {
      if (normalizedFilters.accountId && job.accountId !== normalizedFilters.accountId) return false;
      if (normalizedFilters.agentId && job.agentId !== normalizedFilters.agentId) return false;
      if (normalizedFilters.workflowId && job.workflowId !== normalizedFilters.workflowId) return false;
      if (normalizedFilters.runId && job.runId !== normalizedFilters.runId) return false;
      if (
        normalizedFilters.correlationId
        && job.correlationId !== normalizedFilters.correlationId
        && job.rootCorrelationId !== normalizedFilters.correlationId
      ) return false;
      return true;
    });
    const prospects = prospectQueueStore.getAllProspects(normalizedFilters);
    const activityEvents = activityAnalyticsService.getEvents({
      accountId: normalizedFilters.accountId,
      agentId: normalizedFilters.agentId,
      workflowId: normalizedFilters.workflowId,
      activityLimit: 1000
    }).filter((event) => {
      if (normalizedFilters.runId && event.runId !== normalizedFilters.runId) return false;
      if (
        normalizedFilters.correlationId
        && event.correlationId !== normalizedFilters.correlationId
        && event.rootCorrelationId !== normalizedFilters.correlationId
        && event.metadata?.correlationId !== normalizedFilters.correlationId
        && event.metadata?.rootCorrelationId !== normalizedFilters.correlationId
      ) return false;
      return true;
    });
    const runtimeLogs = runtimeLogStore.getEntries({
      accountId: normalizedFilters.accountId,
      workflowId: normalizedFilters.workflowId,
      runId: normalizedFilters.runId,
      correlationAnyId: normalizedFilters.correlationId,
      limit: 1000
    });
    const allAccountHealth = linkedInAccountHealthStore.getAllAccountHealth();
	    const accountHealth = normalizedFilters.accountId
	      ? (allAccountHealth[normalizedFilters.accountId]
	        ? { [normalizedFilters.accountId]: allAccountHealth[normalizedFilters.accountId] }
	        : {})
	      : allAccountHealth;
	    const replyMonitorState = filterReplyMonitorState(replyMonitor.getState(), normalizedFilters.accountId);
	    const stepOutcomeBreakdown = activityAnalyticsService.getStepOutcomeBreakdown(normalizedFilters);

	    const result = diagnosticsExportService.createBundle({
	      outputDir: selection.filePaths[0],
	      filters: normalizedFilters,
	      workflowRuns,
      workflowJobs,
      prospects,
	      activityEvents,
	      runtimeLogs,
	      accountHealth,
	      replyMonitorState,
	      stepOutcomeBreakdown
	    });

    return {
      success: true,
      cancelled: false,
      path: result.bundleDir,
      fileCount: result.fileCount,
      summary: result.summary
    };
  } catch (error) {
    console.error('Failed to export diagnostics report:', error);
    return {
      success: false,
      cancelled: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('get-reply-monitor-state', async () => {
  try {
    return replyMonitor.getState();
  } catch (error) {
    console.error('Failed to load reply monitor state:', error);
    return {
      version: 2,
      lastPolledAt: null,
      accounts: {},
      notifications: {},
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('get-inbox', async (_event, filters = {}) => {
  try {
    return inboxStore.getAll(filters || {});
  } catch (error) {
    console.error('Failed to load inbox conversations:', error);
    return [];
  }
});

ipcMain.handle('get-inbox-conversation', async (_event, conversationUrn, options = {}) => {
  try {
    const conversation = await getInboxConversationThread(conversationUrn, options || {});
    return {
      success: true,
      conversation
    };
  } catch (error) {
    console.error('Failed to load inbox conversation thread:', error);
    return {
      success: false,
      error: error.message || String(error),
      conversation: null
    };
  }
});

ipcMain.handle('send-inbox-reply', async (_event, payload = {}) => {
  try {
    const result = await sendInboxConversationReply(payload || {});
    return {
      success: true,
      conversation: result.conversation || null,
      message: result.message || null,
      response: result.response || null
    };
  } catch (error) {
    console.error('Failed to send inbox reply:', error);
    return {
      success: false,
      error: error.message || String(error),
      conversation: null,
      message: null
    };
  }
});

ipcMain.handle('get-reply-notifications', async (_event, filters = {}) => {
  try {
    return replyMonitor.getNotifications(filters || {});
  } catch (error) {
    console.error('Failed to load reply notifications:', error);
    return {
      items: [],
      unreadCount: 0,
      total: 0,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('mark-reply-notification-read', async (_event, notificationId) => {
  try {
    return replyMonitor.markNotificationRead(notificationId);
  } catch (error) {
    console.error('Failed to mark reply notification read:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('mark-all-reply-notifications-read', async (_event, filters = {}) => {
  try {
    return replyMonitor.markAllNotificationsRead(filters || {});
  } catch (error) {
    console.error('Failed to mark reply notifications read:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

ipcMain.handle('archive-inbox-conversation', async (_event, conversationUrn) => {
  try {
    const conversation = inboxStore.archive(conversationUrn);
    if (!conversation) {
      return { success: false, error: 'Conversation not found' };
    }
    broadcastInboxUpdated(conversation);
    return {
      success: true,
      conversation
    };
  } catch (error) {
    console.error('Failed to archive inbox conversation:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

// Handle saving credentials securely
ipcMain.handle('save-credentials', async (event, credentials) => {
  try {
    await ensureLinkedInAccountsStoreReady();
    const result = await upsertLinkedInAccount({
      id: credentials?.id || getActiveLinkedInAccountRecord(ensureLinkedInAccountsStore())?.id || null,
      name: credentials?.name || credentials?.label || null,
      email: credentials?.email,
      password: credentials?.password,
      makeActive: true
    });

    notifyCredentialsSaved(result.success);
    if (result.success) {
      notifyActiveCredentialsLoaded(getActiveLinkedInAccountRecord({
        accounts: result.accounts,
        activeAccountId: result.activeAccountId
      }));
    }

    return result.success;
  } catch (error) {
    console.error('Failed to save credentials:', error);
    notifyCredentialsSaved(false);
    return false;
  }
});

// Handle loading credentials
ipcMain.handle('load-credentials', async (event) => {
  try {
    await ensureLinkedInAccountsStoreReady();
    const credentials = getActiveLinkedInAccountRecord(ensureLinkedInAccountsStore());
    notifyActiveCredentialsLoaded(credentials);
    return credentials;
  } catch (error) {
    console.error('Failed to load credentials:', error);
    return null;
  }
});

// Handle clearing credentials
ipcMain.handle('clear-credentials', async (event) => {
  try {
    await ensureLinkedInAccountsStoreReady();
    const activeAccount = getActiveLinkedInAccountRecord(ensureLinkedInAccountsStore());
    if (activeAccount?.id) {
      await removeLinkedInAccount(activeAccount.id);
    } else {
      syncLegacyCredentials(null);
    }
    notifyActiveCredentialsLoaded(getActiveLinkedInAccountRecord(ensureLinkedInAccountsStore()));
    return true;
  } catch (error) {
    console.error('Failed to clear credentials:', error);
    return false;
  }
});

// LinkedIn login status management
ipcMain.handle('login-linkedin', async (event, credentials) => {
  try {
    // Store login state
    global.linkedInLoggedIn = true;
    return true;
  } catch (error) {
    console.error('Login failed:', error);
    return false;
  }
});

ipcMain.handle('logout-linkedin', async (event) => {
  try {
    global.linkedInLoggedIn = false;
    return true;
  } catch (error) {
    console.error('Logout failed:', error);
    return false;
  }
});

ipcMain.handle('get-login-status', async (event) => {
  return global.linkedInLoggedIn || false;
});

async function loadLinkedInCredentialsForPosting(accountId = null) {
  return loadLinkedInAccountCredentials(accountId);
}

/**
 * Dispatch a post-publish request to the account worker and forward LOG messages
 * back to the caller's emitLog while waiting for PUBLISH_POST_RESULT.
 */
async function dispatchPostPublishToWorker(credentials, postConfig, emitLog, postId) {
  const account = {
    accountId: credentials.id || null,
    accountName: credentials.name || credentials.email,
    id: credentials.id || null,
    name: credentials.name || credentials.email,
    email: credentials.email,
    password: credentials.password,
    // Required by the worker startup config — without these the worker throws
    // "Account timezoneId is required" before opening a browser.
    timezoneId: credentials.timezoneId || 'America/Chicago',
    workingHours: credentials.workingHours || null,
    warmUpStartedAt: credentials.warmUpStartedAt || null,
    fingerprintProfileSeed: credentials.fingerprintProfileSeed || null,
    delayProfileSeed: credentials.delayProfileSeed || null,
    strictStealth: credentials.strictStealth === true,
    proxy: credentials.proxy || null,
    headless: false,
    launchSource: (postConfig && postConfig.launchSource) || null,
    slowMo: 50
  };

  const requestId = `post-publish-${postId}-${Date.now()}`;
  const worker = accountWorkerProcessManager.getOrCreate(account);

  const LOG_LEVEL_TO_TYPE = { error: 'error', warn: 'warning', warning: 'warning', success: 'success' };
  const handleWorkerLog = (payload) => {
    if (payload?.type !== ACCOUNT_WORKER_MESSAGE_TYPES.LOG || payload?.jobId !== requestId) {
      return;
    }
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) return;
    const level = String(payload.level || 'info').trim().toLowerCase();
    emitLog({ message, type: LOG_LEVEL_TO_TYPE[level] || 'info' });
  };

  worker.on('message', handleWorkerLog);
  try {
    const response = await accountWorkerProcessManager.dispatchAndAwaitMessage(
      account,
      {
        type: ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST,
        requestId,
        postConfig
      },
      {
        matchMessage: (msg) => (
          msg?.type === ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT
          && msg?.requestId === requestId
        ),
        timeoutMs: 10 * 60 * 1000,
        timeoutLabel: `post publish result for ${requestId}`,
        closedLabel: `post publish result for ${requestId}`
      }
    );

    if (response.error) {
      // Preserve the structured error metadata (httpStatus, retryAfterMs,
      // retryAfterHeader, responseBodyPreview) the worker stamped on the
      // IPC payload. Without this, the publish-post path drops them and
      // the error-shape contract is dead on arrival for upstream
      // Retry-After-aware decisions. Post-publish retry doesn't read these
      // YET, but the contract has to be honest now so it can later.
      const err = new Error(response.error);
      if (response.errorMeta && typeof response.errorMeta === 'object') {
        Object.assign(err, response.errorMeta);
      }
      throw err;
    }

    return response.publishResult;
  } finally {
    worker.off('message', handleWorkerLog);
  }
}

ipcMain.handle('publish-linkedin-post', async (event, payload) => {
  let sanitizedPayload;
  try {
    sanitizedPayload = sanitizePublishPostPayload(payload);
  } catch (error) {
    return {
      accepted: false,
      reason: 'invalid-payload',
      error: error.message || String(error)
    };
  }
  const postId = sanitizedPayload.postId || `post-${Date.now()}`;

  if (activePostPublishes.has(postId)) {
    return { accepted: false, reason: 'already-running' };
  }

  const emitLog = (entry) => {
    const message = typeof entry === 'string' ? entry : entry?.message;
    const type = typeof entry === 'object' && entry?.type ? entry.type : 'info';
    if (message) {
      event.sender.send('automation-log', { message, type });
    }
  };

  // Idempotency: if a prior attempt already captured a LinkedIn resource key
  // for this postId, skip the dispatch entirely. The resourceKey is the
  // ground truth that LinkedIn already accepted a scheduled post — running
  // a new publish would create a duplicate. Honored regardless of the
  // post's local status field: status can drift due to renderer/sync bugs,
  // but a resourceKey is a remote acknowledgement we should not contradict.
  //
  // Auto-generated postIds (post-${Date.now()}) won't match any stored row
  // by construction, so this check is a no-op for new posts.
  try {
    const existingPost = sanitizedPayload.postId
      ? scheduledPostStore.getAllPosts().find((p) => p.id === postId)
      : null;
    if (existingPost && existingPost.linkedInResourceKey) {
      emitLog({
        message: `Post ${postId} already published (LinkedIn resourceKey present); skipping dispatch.`,
        type: 'info'
      });
      // Synthesize the same publishResult shape callers already understand.
      // deliveryStrategy falls back to 'already_scheduled' when not stored
      // (legacy rows that captured a resourceKey before the field was
      // tracked) so the field is never undefined on the IPC response.
      const synthesized = {
        outcome: 'scheduled',
        deliveryStrategy: existingPost.deliveryStrategy || 'already_scheduled',
        linkedInResourceKey: existingPost.linkedInResourceKey,
        linkedInScheduledAt: existingPost.linkedInScheduledAt || null
      };
      event.sender.send('post-published', {
        postId,
        success: true,
        outcome: synthesized.outcome,
        deliveryStrategy: synthesized.deliveryStrategy,
        linkedInResourceKey: synthesized.linkedInResourceKey,
        linkedInScheduledAt: synthesized.linkedInScheduledAt
      });
      return { accepted: true, postId, alreadyPublished: true };
    }
  } catch (idempotencyLookupErr) {
    // Lookup failures shouldn't block a publish — fall through to the
    // normal path. The race we'd then expose is only the original (no
    // worse than pre-idempotency behavior), and a store outage isn't a
    // reason to refuse all publishing.
    console.warn(
      `[publish-linkedin-post] Idempotency pre-check failed; proceeding with dispatch: ${idempotencyLookupErr.message}`
    );
  }

  activePostPublishes.add(postId);

  (async () => {
    try {
      const credentials = await loadLinkedInCredentialsForPosting(sanitizedPayload.accountId || null);
      if (!credentials) {
        throw new Error('No LinkedIn credentials found. Save credentials in Settings first.');
      }

      const runtimeJobId = registerLinkedInRuntimeJob({
        jobId: `post-publish-${postId}`,
        type: 'post-publish',
        accountId: credentials.id || sanitizedPayload.accountId || null,
        accountName: credentials.name || credentials.email,
        process: null,
        meta: {
          postId
        }
      });

      let finalPublishError = null;
      let publishResult = null;
      for (let attempt = 1; attempt <= LINKEDIN_POST_PUBLISH_MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          emitLog({
            message: `Retrying LinkedIn publish attempt ${attempt}/${LINKEDIN_POST_PUBLISH_MAX_ATTEMPTS}...`,
            type: 'warning'
          });
        }

        try {
          publishResult = await dispatchPostPublishToWorker(credentials, sanitizedPayload, emitLog, postId);
          finalPublishError = null;
          break;
        } catch (error) {
          finalPublishError = error;
          const shouldRetry = attempt < LINKEDIN_POST_PUBLISH_MAX_ATTEMPTS
            && isRetriableLinkedInPostPublishError(error);
          if (!shouldRetry) {
            throw error;
          }

          const delayMs = getLinkedInPostPublishRetryDelayMs(attempt);
          emitLog({
            message: `LinkedIn publish attempt ${attempt}/${LINKEDIN_POST_PUBLISH_MAX_ATTEMPTS} failed: ${error.message || String(error)}. Retrying in ${Math.round(delayMs / 1000)}s...`,
            type: 'warning'
          });
          await waitMs(delayMs);
        }
      }

      if (finalPublishError) {
        throw finalPublishError;
      }

      // Server-side persistence of the LinkedIn resource key.
      //
      // Today the renderer's post-scheduler.js persists this on receipt of
      // the post-published IPC. That's fine for the happy path, but if the
      // renderer is unresponsive or the IPC is dropped (window closed
      // mid-publish, etc.) the resourceKey is lost and the idempotency
      // pre-check above can't fire on a subsequent attempt. Writing the key
      // here, before the IPC dispatch, makes the idempotency story robust
      // to renderer failures.
      //
      // Only updates an existing record — auto-generated postIds (no
      // sanitizedPayload.postId) have no stored row to update. The renderer
      // creates rows when scheduling; immediate-publish flows often don't
      // have a row at all, and they don't get a resourceKey anyway (the
      // resourceKey only comes back from LinkedIn for 'scheduled' outcomes).
      if (sanitizedPayload.postId && publishResult?.linkedInResourceKey) {
        try {
          scheduledPostStore.updatePostFields(sanitizedPayload.postId, {
            linkedInResourceKey: publishResult.linkedInResourceKey,
            linkedInScheduledAt: publishResult.linkedInScheduledAt || null,
            deliveryStrategy: publishResult.deliveryStrategy || null,
            status: publishResult.outcome === 'published' ? 'published' : 'scheduled',
            linkedInLastSyncedAt: new Date().toISOString(),
            linkedInSyncError: null,
            error: null
          });
        } catch (persistErr) {
          // updatePostFields throws when the postId doesn't exist in the
          // store. That's a real consistency problem — LinkedIn already
          // accepted the schedule, but we have nowhere to record it. Log
          // loudly and continue (the renderer-side persistence is still
          // attempted via the IPC below as a fallback path).
          console.warn(
            `[publish-linkedin-post] Could not persist resourceKey for postId=${sanitizedPayload.postId}: ${persistErr.message}`
          );
        }
      }

      if (publishResult?.outcome === 'published' || sanitizedPayload.immediate) {
        recordActivityEventSafe({
          type: 'post_published',
          accountId: credentials.id || sanitizedPayload.accountId || null,
          accountName: credentials.name || credentials.email,
          workflowId: sanitizedPayload.workflowId || null,
          workflowName: sanitizedPayload.workflowName || null,
          postId,
          targetValue: truncateNotificationText(sanitizedPayload.content || 'LinkedIn post', 180),
          status: 'ok',
          metadata: {
            scheduledFor: sanitizedPayload.scheduledDate || sanitizedPayload.scheduledFor || null,
            contentPreview: truncateNotificationText(sanitizedPayload.content || '', 280)
          }
        });
      }
      event.sender.send('post-published', {
        postId,
        success: true,
        outcome: publishResult?.outcome || (sanitizedPayload.immediate ? 'published' : 'scheduled'),
        deliveryStrategy: publishResult?.deliveryStrategy || null,
        linkedInResourceKey: publishResult?.linkedInResourceKey || null,
        linkedInScheduledAt: publishResult?.linkedInScheduledAt || null
      });
      unregisterLinkedInRuntimeJob(runtimeJobId);
    } catch (error) {
      event.sender.send('post-published', {
        postId,
        success: false,
        error: error.message || String(error)
      });
      emitLog({
        message: `Post publishing failed: ${error.message || String(error)}`,
        type: 'error'
      });
    } finally {
      activePostPublishes.delete(postId);
      unregisterLinkedInRuntimeJob(`post-publish-${postId}`);
    }
  })();

  return { accepted: true, postId };
});

ipcMain.handle('get-scheduled-posts', async (_event, filters = {}) => {
  try {
    return {
      ok: true,
      posts: getVisibleScheduledPosts(filters?.accountId || null)
    };
  } catch (error) {
    console.error('Failed to load scheduled posts:', error);
    return {
      ok: false,
      error: error.message || String(error),
      posts: []
    };
  }
});

ipcMain.handle('save-scheduled-posts', async (_event, posts, filters = {}) => {
  try {
    const accountId = filters?.accountId || null;
    if (filters?.syncRemote) {
      const emitLog = (entry) => {
        const message = typeof entry === 'string' ? entry : entry?.message;
        const type = typeof entry === 'object' && entry?.type ? entry.type : 'info';
        if (message && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('automation-log', { message, type });
        }
      };

      const syncResult = await syncScheduledPostsForAccount({
        existingPosts: getVisibleScheduledPosts(accountId),
        desiredPosts: Array.isArray(posts) ? posts : [],
        createLinkedInSession: async () => createScheduledPostSyncSession(accountId, emitLog),
        emitLog
      });

      return {
        ok: true,
        posts: replaceVisibleScheduledPosts(syncResult.posts, accountId),
        syncSummary: syncResult.summary
      };
    }

    return {
      ok: true,
      posts: replaceVisibleScheduledPosts(posts, accountId)
    };
  } catch (error) {
    console.error('Failed to save scheduled posts:', error);
    return {
      ok: false,
      error: error.message || String(error),
      posts: []
    };
  }
});

// ----- Profile Management Handlers -----

// NEW: Load profiles from JSON file
ipcMain.handle('load-profiles-from-json', async (_event, filters = {}) => {
  try {
    if (!fs.existsSync(getProfilesStorePath())) {
      console.log('No profiles file found');
      return [];
    }

    const profiles = getVisibleStoredProfiles(filters?.accountId || null);
    console.log(`Loaded ${profiles.length} profiles from JSON file`);
    return profiles;
  } catch (error) {
    console.error('Error loading profiles from JSON:', error);
    return [];
  }
});

// NEW: Store a single profile action
ipcMain.handle('store-profile-action', async (_event, profileUrl, profileDetails, action, notes, searchQuery, filters = {}) => {
  try {
    const profilesPath = getProfilesStorePath();
    ensureProfilesStoreDirectory(profilesPath);

    const scope = getLinkedInAccountScope(filters?.accountId || null);
    let profiles = loadAllStoredProfiles();

    const normalizedUrl = normalizeProfileUrl(profileUrl);
    const existingProfileIndex = findStoredProfileIndex(profiles, normalizedUrl, scope);
    const existingProfile = existingProfileIndex === -1 ? null : profiles[existingProfileIndex];
    const safeProfileDetails = profileDetails && typeof profileDetails === 'object' ? profileDetails : {};

    const profileData = {
      ...(existingProfile || {}),
      url: normalizedUrl,
      originalUrl: profileUrl,
      linkedInProfileUrl: profileUrl,
      firstName: safeProfileDetails.firstName || existingProfile?.firstName || '',
      lastName: safeProfileDetails.lastName || existingProfile?.lastName || '',
      fullName:
        safeProfileDetails.fullName
        || `${safeProfileDetails.firstName || existingProfile?.firstName || ''} ${safeProfileDetails.lastName || existingProfile?.lastName || ''}`.trim()
        || existingProfile?.fullName
        || 'Unknown Profile',
      title: safeProfileDetails.position || safeProfileDetails.title || existingProfile?.title || '',
      company: safeProfileDetails.company || existingProfile?.company || '',
      email: safeProfileDetails.email || existingProfile?.email || 'Not Available',
      rawHeadline: safeProfileDetails.rawHeadline || existingProfile?.rawHeadline || '',
      suggestedEmails: safeProfileDetails.suggestedEmails || existingProfile?.suggestedEmails,
      companyDomain: safeProfileDetails.companyDomain || existingProfile?.companyDomain,
      accountId: scope.accountId || existingProfile?.accountId || null,
      accountName: scope.accountName || existingProfile?.accountName || null,
      firstInteraction: existingProfile?.firstInteraction || new Date().toISOString(),
      lastInteraction: new Date().toISOString(),
      actions: []
    };

    if (existingProfileIndex !== -1) {
      if (profileData.email === 'Not Available' && existingProfile.email !== 'Not Available') {
        profileData.email = existingProfile.email;
      }

      profileData.actions = existingProfile.actions || [];
      profileData.actions.push({
        type: action,
        timestamp: new Date().toISOString(),
        notes: notes || '',
        searchQuery
      });
      
      profiles[existingProfileIndex] = profileData;
    } else {
      profileData.actions.push({
        type: action,
        timestamp: new Date().toISOString(),
        notes: notes || '',
        searchQuery
      });
      
      profiles.push(profileData);
    }

    // Save the updated profiles file (atomic — see writeJsonFileAtomic)
    writeJsonFileAtomic(profilesPath, profiles);

    const activityType = mapLegacyActionToEventType(action);
    if (activityType) {
      recordActivityEventSafe({
        type: activityType,
        accountId: scope.accountId || null,
        accountName: scope.accountName || null,
        targetValue: profileData.fullName || safeProfileDetails?.fullName || normalizedUrl,
        profileUrl: profileData.originalUrl || profileUrl || normalizedUrl,
        status: 'ok',
        metadata: {
          notes: notes || '',
          searchQuery: searchQuery || null,
          legacyAction: action
        }
      });
    }
    
    return profileData;
  } catch (error) {
    console.error('Error in storeProfileAction:', error);
    return null;
  }
});

// NEW: Store a batch of profiles
ipcMain.handle('store-profile-batch', async (_event, profiles, filters = {}) => {
  try {
    const profilesPath = getProfilesStorePath();
    const profilesDir = ensureProfilesStoreDirectory(profilesPath);
    const scope = getLinkedInAccountScope(filters?.accountId || null);
    const existingProfiles = loadAllStoredProfiles();

    const profileMap = new Map();
    existingProfiles.forEach((profile) => {
      profileMap.set(getScopedProfileKey(profile.url, profile.accountId), profile);
    });

    let savedCount = 0;
    let updatedCount = 0;

    for (const profileData of profiles) {
      const normalizedUrl = normalizeProfileUrl(profileData.url);
      const scopedKey = getScopedProfileKey(normalizedUrl, scope.accountId);

      if (profileMap.has(scopedKey)) {
        const existingProfile = profileMap.get(scopedKey);
        const nextProfile = {
          ...existingProfile,
          ...profileData,
          url: normalizedUrl,
          originalUrl: profileData.originalUrl || profileData.url || existingProfile.originalUrl || existingProfile.url,
          linkedInProfileUrl:
            profileData.originalUrl
            || profileData.url
            || existingProfile.linkedInProfileUrl
            || existingProfile.originalUrl
            || existingProfile.url,
          firstName: profileData.firstName || existingProfile.firstName || '',
          lastName: profileData.lastName || existingProfile.lastName || '',
          fullName:
            profileData.fullName
            || `${profileData.firstName || existingProfile.firstName || ''} ${profileData.lastName || existingProfile.lastName || ''}`.trim()
            || existingProfile.fullName
            || 'Unknown Profile',
          title: profileData.position || profileData.title || existingProfile.title || '',
          company: profileData.company || existingProfile.company || '',
          email: profileData.email || existingProfile.email || 'Not Available',
          accountId: scope.accountId || existingProfile.accountId || null,
          accountName: scope.accountName || existingProfile.accountName || null
        };

        if (profileData.email === 'Not Available' && existingProfile.email !== 'Not Available') {
          nextProfile.email = existingProfile.email;
        }

        nextProfile.actions = existingProfile.actions || [];
        const hasProfileViewed = nextProfile.actions.some((entry) => entry.type === 'Profile Viewed');
        if (!hasProfileViewed) {
          nextProfile.actions.push({
            type: 'Profile Viewed',
            timestamp: new Date().toISOString(),
            notes: 'Added from dashboard'
          });
          recordActivityEventSafe({
            type: 'profile_viewed',
            accountId: scope.accountId || null,
            accountName: scope.accountName || null,
            targetValue: nextProfile.fullName || normalizedUrl,
            profileUrl: nextProfile.originalUrl || nextProfile.url || normalizedUrl,
            status: 'ok',
            metadata: {
              notes: 'Added from dashboard',
              source: 'store-profile-batch'
            }
          });
        }

        nextProfile.firstInteraction = existingProfile.firstInteraction;
        nextProfile.lastInteraction = new Date().toISOString();

        profileMap.set(scopedKey, normalizeStoredProfileRecord(nextProfile));
        updatedCount++;
      } else {
        const newProfile = {
          url: normalizedUrl,
          originalUrl: profileData.originalUrl || profileData.url,
          linkedInProfileUrl: profileData.originalUrl || profileData.url,
          firstName: profileData.firstName || '',
          lastName: profileData.lastName || '',
          fullName: profileData.fullName || `${profileData.firstName} ${profileData.lastName}`.trim() || 'Unknown Profile',
          title: profileData.position || profileData.title || '',
          company: profileData.company || '',
          email: profileData.email || 'Not Available',
          accountId: scope.accountId || null,
          accountName: scope.accountName || null,
          firstInteraction: new Date().toISOString(),
          lastInteraction: new Date().toISOString(),
          actions: [{
            type: 'Profile Viewed',
            timestamp: new Date().toISOString(),
            notes: 'Added from dashboard'
          }]
        };

        recordActivityEventSafe({
          type: 'profile_viewed',
          accountId: scope.accountId || null,
          accountName: scope.accountName || null,
          targetValue: newProfile.fullName || normalizedUrl,
          profileUrl: newProfile.originalUrl || newProfile.url || normalizedUrl,
          status: 'ok',
          metadata: {
            notes: 'Added from dashboard',
            source: 'store-profile-batch'
          }
        });

        profileMap.set(scopedKey, normalizeStoredProfileRecord(newProfile));
        savedCount++;
      }
    }

    const updatedProfiles = Array.from(profileMap.values());

    if (fs.existsSync(profilesPath)) {
      const backupPath = path.join(profilesDir, 'backups');
      if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(backupPath, { recursive: true });
      }
      
      const date = new Date().toISOString().replace(/:/g, '-').split('.')[0];
      const backupFilePath = path.join(backupPath, `profiles-backup-${date}.json`);
      fs.copyFileSync(profilesPath, backupFilePath);
      console.log(`Created backup at ${backupFilePath}`);
    }
    // Atomic — the backup above is a defense-in-depth restore point, but
    // the primary fix for "crash corrupts profiles.json" is this atomic write.
    writeJsonFileAtomic(profilesPath, updatedProfiles);

    return {
      saved: savedCount,
      updated: updatedCount,
      total: updatedProfiles.filter((profile) => isRecordVisibleForAccount(profile, scope)).length
    };
  } catch (error) {
    console.error('Error in storeProfileBatch:', error);
    throw error;
  }
});

// NEW: Save visible dashboard profiles
ipcMain.handle('save-visible-dashboard-profiles', async (event) => {
  try {
    // The actual profile collection happens in the renderer process
    // This just acknowledges the request and will trigger the ProfileFilters.saveVisibleDashboardProfiles()
    // function in the renderer, which will then call storeProfileBatch with the collected profiles
    
    event.reply('automation-log', { 
      message: 'Processing visible dashboard profiles...', 
      type: 'info'
    });
    
    return true;
  } catch (error) {
    console.error('Error in save-visible-dashboard-profiles handler:', error);
    throw error;
  }
});

// Handle getting profile data
// Overlay the SQLite prospect store's clean fullName/title/company onto the
// legacy profiles.json records, so the read surfaces reflect the
// source-of-truth identity data even when profiles.json drifted stale (see
// automation/profile/prospect-overlay.js).
function getEnrichedStoredProfiles(accountId = null, filters = {}) {
  const profiles = getVisibleStoredProfiles(accountId);
  try {
    const prospects = prospectQueueStore.getAllProspects(getScopedProspectFilters(filters));
    const index = buildProspectEnrichmentIndex(prospects, normalizeProfileUrl);
    return overlayProspectEnrichment(profiles, index, normalizeProfileUrl);
  } catch (error) {
    console.error('Prospect enrichment overlay failed; returning raw profiles:', error.message);
    return profiles;
  }
}

ipcMain.handle('get-profile-data', async (_event, profileId, filters = {}) => {
  try {
    const normalizedId = normalizeProfileUrl(profileId);
    const profiles = getEnrichedStoredProfiles(filters?.accountId || null, filters);
    return profiles.find((profile) => normalizeProfileUrl(profile.url) === normalizedId) || null;
  } catch (error) {
    console.error('Error getting profile data:', error);
    return null;
  }
});

// Handle getting all profiles
ipcMain.handle('get-all-profiles', async (_event, filters = {}) => {
  try {
    return getEnrichedStoredProfiles(filters?.accountId || null, filters);
  } catch (error) {
    console.error('Error getting all profiles:', error);
    return [];
  }
});

// ----- Workflow Management Handlers -----

// Function to open the workflow manager
async function openWorkflowManager(event) {
  // If there's already a running process, do nothing
  if (workflowManagerProcess && !workflowManagerProcess.killed) {
    if (event) {
      event.reply('automation-log', { 
        message: 'Workflow manager is already running', 
        type: 'info'
      });
    }
    return;
  }

  try {
    const credentials = await getStoredCredentials(null);
    if (!credentials?.email) {
      throw new Error('No LinkedIn credentials found for the active profile.');
    }

    // Log the start of workflow manager
    if (event) {
      event.reply('automation-log', { 
        message: 'Opening workflow manager...', 
        type: 'info'
      });
    }

    // Construct a config file for profile-manager mode
    const configPath = path.join(app.getPath('temp'), 'workflow-manager-config.json');
    const config = {
      mode: 'profile-manager',
      accountId: credentials.id || null,
      accountEmail: credentials.email
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    // Launch the workflow manager process
    workflowManagerProcess = spawnNodeRuntime(automationScript, [configPath], {
      env: legacyAutomationSpawnEnv()
    });

    // Handle standard output
    workflowManagerProcess.stdout.on('data', (data) => {
      if (event) {
        const logLines = data.toString().trim().split('\n');
        
        logLines.forEach(line => {
          try {
            // Try to parse JSON logs
            const logData = JSON.parse(line);
            event.reply('automation-log', {
              message: logData.message || line,
              type: logData.type || 'normal'
            });
          } catch (e) {
            // Plain text log
            event.reply('automation-log', {
              message: line,
              type: 'normal'
            });
          }
        });
      }
    });

    // Handle error output
    workflowManagerProcess.stderr.on('data', (data) => {
      if (event) {
        const errorMessage = data.toString().trim();
        event.reply('automation-log', { 
          message: errorMessage, 
          type: 'error'
        });
      }
    });

    // Handle process exit
    workflowManagerProcess.on('close', (code) => {
      if (event) {
        const message = `Workflow manager process exited with code ${code}`;
        const type = code === 0 ? 'success' : 'error';
        
        event.reply('automation-log', { message, type });
      }
      
      workflowManagerProcess = null;
      
      cleanupTempConfig(configPath, 'workflow-manager temp config');
    });

    workflowManagerProcess.on('error', () => {
      cleanupTempConfig(configPath, 'workflow-manager temp config');
    });

  } catch (error) {
    if (event) {
      event.reply('automation-log', { 
        message: `Failed to open workflow manager: ${error.message}`, 
        type: 'error'
      });
    }
  }
}

// Handle opening workflow manager from UI
ipcMain.on('open-workflow-manager', (event) => {
  openWorkflowManager(event);
});

// Handle creating a new workflow
ipcMain.on('create-workflow', (event, workflowData) => {
  try {
    const sanitizedWorkflowData = sanitizeLegacyWorkflowPayload(workflowData);
    const workflowRecord = workflowTemplateStore.saveLegacyWorkflow({
      ...sanitizedWorkflowData,
      status: 'pending',
      progress: {
        completed: 0,
        total: sanitizedWorkflowData.profileIds.length
      }
    });
    
    event.reply('automation-log', { 
      message: `Workflow "${workflowRecord.name}" created successfully`, 
      type: 'success'
    });
    
    // Return the created workflow
    event.reply('workflow-created', workflowRecord);
    
    // Auto-run if enabled in settings (would check user preferences)
    const autoRunWorkflows = false; // Replace with actual user preference
    
    if (autoRunWorkflows) {
      startWorkflow(event, workflowRecord.id);
    }
    
  } catch (error) {
    event.reply('automation-log', { 
      message: `Failed to create workflow: ${error.message}`, 
      type: 'error'
    });
  }
});

// Handle starting a workflow
ipcMain.on('start-workflow', (event, workflowId) => {
  startWorkflow(event, workflowId);
});

// Function to start a workflow
async function startWorkflow(event, workflowId) {
  try {
    event.reply('automation-log', { 
      message: `Starting workflow ${workflowId}...`, 
      type: 'info'
    });
    
    const workflow = workflowTemplateStore.getLegacyWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    const credentials = await getStoredCredentials(null);
    if (!credentials?.email) {
      throw new Error('No LinkedIn credentials found for the active profile.');
    }
    
    // Create a config for the workflow execution
    const workflowConfig = {
      mode: 'workflow',
      workflowId: workflowId,
      accountId: credentials.id || null,
      accountEmail: credentials.email,
      actions: workflow.actions,
      profileIds: workflow.profileIds
    };
    
    // Save config to tempfile
    const configPath = path.join(app.getPath('temp'), `workflow-${workflowId}.json`);
    fs.writeFileSync(configPath, JSON.stringify(workflowConfig));
    
    // Launch the workflow process
    const workflowProcess = spawnNodeRuntime(automationScript, [configPath], {
      env: legacyAutomationSpawnEnv()
    });
    
    // Handle standard output
    workflowProcess.stdout.on('data', (data) => {
      const logLines = data.toString().trim().split('\n');
      
      logLines.forEach(line => {
        try {
          // Try to parse JSON logs
          const logData = JSON.parse(line);
          event.reply('automation-log', {
            message: logData.message || line,
            type: logData.type || 'normal'
          });
          
          // If progress update, send to UI
          if (logData.type === 'progress') {
            event.reply('workflow-progress', {
              id: workflowId,
              current: logData.current,
              total: logData.total
            });
          }
        } catch (e) {
          // Plain text log
          event.reply('automation-log', {
            message: line,
            type: 'normal'
          });
        }
      });
    });
    
    // Handle error output
    workflowProcess.stderr.on('data', (data) => {
      const errorMessage = data.toString().trim();
      event.reply('automation-log', { 
        message: errorMessage, 
        type: 'error'
      });
    });
    
    // Handle process exit
    workflowProcess.on('close', (code) => {
      const message = `Workflow ${workflowId} completed with code ${code}`;
      const type = code === 0 ? 'success' : 'error';
      
      event.reply('automation-log', { message, type });
      event.reply('workflow-completed', { id: workflowId });
      
      // Update workflow status
      updateWorkflowStatus(workflowId, code === 0 ? 'completed' : 'failed');
      
      cleanupTempConfig(configPath, 'workflow temp config');
    });

    workflowProcess.on('error', () => {
      cleanupTempConfig(configPath, 'workflow temp config');
    });
    
    // Update workflow status to running
    updateWorkflowStatus(workflowId, 'running');
    
  } catch (error) {
    event.reply('automation-log', { 
      message: `Failed to start workflow: ${error.message}`, 
      type: 'error'
    });
  }
}

// Check for updates on startup
app.whenReady().then(() => {
  // Load credentials at startup for environment variables
  ensureLinkedInAccountsStoreReady().catch((error) => {
    console.error('Failed to load credentials at startup:', error);
  });

  // Example placeholder for update check logic
  setTimeout(() => {
    if (mainWindow) {
      mainWindow.webContents.send('automation-log', {
        message: 'Checking for updates...',
        type: 'info'
      });
      
      // Add actual update check logic here
    }
  }, 3000);
});

function collectWorkflowTargets(group) {
  const profileIndex = buildStoredProfileIndex();
  return Array.isArray(group?.members)
    ? group.members
        .map((member) => normalizeWorkflowGroupMember(member, profileIndex))
        .filter(Boolean)
    : [];
}

function buildStoredProfileIndex() {
  const byUrl = new Map();
  const byName = new Map();

  try {
    const profiles = getVisibleStoredProfiles();

    profiles.forEach((profile) => {
      const normalizedUrl = normalizeProfileUrl(profile.originalUrl || profile.linkedInUrl || profile.profileUrl || profile.url || '');
      const fullName = String(
        profile.fullName
        || `${profile.firstName || ''} ${profile.lastName || ''}`.trim()
        || ''
      ).trim();
      if (normalizedUrl) {
        byUrl.set(normalizedUrl, {
          fullName: fullName || normalizedUrl,
          title: profile.title || profile.position || '',
          company: profile.company || '',
          profileUrl: profile.originalUrl || profile.linkedInUrl || profile.profileUrl || profile.url || normalizedUrl
        });
      }
      const normalizedName = normalizeComparableText(fullName);
      if (normalizedName) {
        byName.set(normalizedName, {
          fullName: fullName || null,
          title: profile.title || profile.position || '',
          company: profile.company || '',
          profileUrl: profile.originalUrl || profile.linkedInUrl || profile.profileUrl || profile.url || null
        });
      }
    });
  } catch (error) {
    console.warn('Failed to build stored profile index for workflow targets:', error.message);
  }

  return { byUrl, byName };
}

function normalizeWorkflowGroupMember(member, profileIndex) {
  const rawValue = typeof member === 'string'
    ? member
    : member?.value || member?.profileUrl || member?.url || member?.name || member?.fullName || '';
  const value = String(rawValue || '').trim();
  if (!value) return null;

  const directProfileUrl = isLinkedInProfileUrl(value)
    ? value
    : (typeof member === 'object' ? member?.profileUrl || member?.url || '' : '');
  const normalizedUrl = normalizeProfileUrl(directProfileUrl);
  const byUrlMatch = normalizedUrl ? profileIndex.byUrl.get(normalizedUrl) : null;
  const explicitName = typeof member === 'object'
    ? String(member?.label || member?.fullName || member?.name || '').trim()
    : '';
  const nameCandidate = explicitName || (!normalizedUrl ? value : '');
  const byNameMatch = nameCandidate ? profileIndex.byName.get(normalizeComparableText(nameCandidate)) : null;
  const profileMatch = byUrlMatch || byNameMatch || null;

  return {
    value,
    label: profileMatch?.fullName || explicitName || value,
    fullName: profileMatch?.fullName || explicitName || (!normalizedUrl ? value : null),
    profileUrl: profileMatch?.profileUrl || directProfileUrl || null,
    title: profileMatch?.title || (typeof member === 'object' ? member?.title || '' : ''),
    company: profileMatch?.company || (typeof member === 'object' ? member?.company || '' : ''),
    // Carry search provenance through for structured (object) members so the
    // downstream prospect + activity events can trace back to the search rank.
    searchProvenance: typeof member === 'object'
      ? normalizeSearchProvenance(member.searchProvenance || member)
      : null
  };
}

function resolveWorkflowProspectTargets(params = {}) {
  const rawTargets = collectWorkflowTargets(params.group);
  if (!rawTargets.length) {
    return [];
  }

  const targets = prospectQueueStore.upsertWorkflowTargets({
    accountId: params.accountId || null,
    accountName: params.accountName || null,
    agentId: params.agentId || null,
    agentName: params.agentName || null,
    workflowId: params.workflowId || null,
    workflowName: params.workflowName || null,
    runId: params.runId || null,
    targetType: params.targetType || 'group',
    sourceId: params.sourceId || null,
    sourceLabel: params.sourceLabel || null,
    targets: rawTargets
  });
  if (targets.length) {
    broadcastProspectsUpdated(params.accountId || null);
  }
  return targets;
}

function normalizeWorkflowSteps(steps, actions, connectionMessage) {
  const normalizedSteps = Array.isArray(steps) && steps.length
    ? steps
    : [
        actions?.viewProfile ? { type: 'view_profile', minDelayMs: 8000, maxDelayMs: 16000 } : null,
        actions?.likePosts ? { type: 'like_posts', minDelayMs: 9000, maxDelayMs: 17000 } : null,
        actions?.sendConnection
          ? {
              type: 'send_connection',
              messageTemplate: connectionMessage || '',
              minDelayMs: 10000,
              maxDelayMs: 18000
            }
          : null
      ].filter(Boolean);

  if (!normalizedSteps.length) {
    throw new Error('No workflow steps provided');
  }

  if (!normalizedSteps.some((step) => step?.type && step.type !== 'delay')) {
    throw new Error('Workflow must contain at least one action step');
  }

  return normalizedSteps;
}

// emitStructuredWorkflowLog, shouldRunWorkflowStepInMainProcess,
// and shouldTrackLinkedInWorkflowHealthForStepType have moved into
// automation/runtime/durable-workflow-scheduler.js

function buildWorkflowCorrelationContext(run = {}, job = {}, extra = {}) {
  const correlationId = extra.correlationId || job?.correlationId || run?.correlationId || null;
  const rootCorrelationId = extra.rootCorrelationId || job?.rootCorrelationId || run?.correlationId || correlationId || null;
  return {
    accountId: extra.accountId || job?.accountId || run?.accountId || null,
    accountName: extra.accountName || job?.accountName || run?.accountName || null,
    workflowId: extra.workflowId || job?.workflowId || run?.workflowId || run?.id || null,
    workflowName: extra.workflowName || job?.workflowName || run?.workflowName || null,
    runId: extra.runId || job?.runId || run?.id || null,
    targetId: extra.targetId || job?.targetId || null,
    prospectId: extra.prospectId || job?.prospectId || null,
    stepIndex: Number.isFinite(Number(extra.stepIndex)) ? Number(extra.stepIndex) : job?.stepIndex,
    stepType: extra.stepType || job?.stepType || null,
    correlationId,
    rootCorrelationId,
    source: extra.source || 'workflow-runtime',
    metadata: extra.metadata && typeof extra.metadata === 'object' ? extra.metadata : {}
  };
}

// scheduleNextDurableWorkflowStep has moved into automation/runtime/durable-workflow-scheduler.js
// The function below is kept as a tombstone comment only.
// scheduleNextDurableWorkflowStep, recordWorkflowStepEvents, finalizeDurableWorkflowRun,
// handleDurableWorkflowJobClose, executeMainProcessApolloWorkflowJob,
// executeDurableWorkflowJob, and buildDurableWorkflowLeadScores have all moved into
// automation/runtime/durable-workflow-scheduler.js


/*
 * Canonical automation entry point — thin wrapper delegating to the extracted scheduler.
 * Logic lives in automation/runtime/durable-workflow-scheduler.js.
 */
async function startDueDurableWorkflowJobs() {
  return durableScheduler.startDueDurableWorkflowJobs();
}

app.whenReady().then(() => {
  setTimeout(async () => {
    try {
      await ensureLinkedInAccountsStoreReady();
    } catch (error) {
      console.error('Failed to initialize secure LinkedIn account store:', error);
    }
    try {
      const orphanedCampaignRuns = campaignController.reconcileOrphanedCampaignRuns({
        orphanOlderThanMs: CAMPAIGN_RUN_ORPHAN_TTL_MS
      });
      if (orphanedCampaignRuns.length > 0) {
        console.warn(`Cancelled ${orphanedCampaignRuns.length} orphaned campaign run${orphanedCampaignRuns.length === 1 ? '' : 's'} on startup.`);
      }
    } catch (error) {
      console.error('Failed to reconcile orphaned campaign runs on startup:', error);
    }
    broadcastSdrAgentsUpdated();
    broadcastSdrWorkflowRunsUpdated();
    broadcastCampaignRunsUpdated();
    broadcastLinkedInAccountHealthUpdated();
    startDueDurableWorkflowJobs().catch((error) => {
      console.error('Failed to initialize durable workflow scheduler:', error);
    });
    replyMonitor.start();
  }, 1200);
});

setInterval(() => {
  startDueDurableWorkflowJobs().catch((error) => {
    console.error('Durable workflow scheduler tick failed:', error);
  });
}, 15000);

app.on('before-quit', () => {
  replyMonitor.stop();
});

ipcMain.handle('run-group-workflow', async (event, config) => {
  try {
    const sanitizedConfig = sanitizeRunGroupWorkflowConfig(config);
    const {
      groupId,
      steps,
      actions,
      connectionMessage,
      accountId,
      browserProfile,
      headless,
      slowMo,
      groupMembers,
      groupName,
      targets: targetRecords,
      targetType,
      workflowId,
      workflowName,
      agentId,
      bypassWorkingHours,
      launchSource
    } = sanitizedConfig;
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const groupsPath = path.join(userHome, 'Documents', 'Connect-Ability', 'groups.json');

    let selectedGroup = null;
    if (Array.isArray(targetRecords) && targetRecords.length) {
      // Structured targets (e.g. a People-search receipt) take precedence:
      // each member is an object carrying searchProvenance, which flows through
      // to the prospect record + activity events.
      selectedGroup = {
        id: workflowId || `search-${Date.now()}`,
        name: groupName || workflowName || 'Search Targets',
        members: targetRecords
      };
    } else if (Array.isArray(groupMembers) && groupMembers.length) {
      selectedGroup = {
        id: workflowId || `custom-${Date.now()}`,
        name: groupName || workflowName || 'Custom Workflow Target',
        members: groupMembers
      };
    } else if (fs.existsSync(groupsPath)) {
      const groups = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
      selectedGroup = groups.find((group) => group.id === groupId);
    }

    if (!selectedGroup) {
      emitWorkflowLogMessage(`Workflow target not found${groupId ? ` for group ID ${groupId}` : ''}`, 'error');
      return false;
    }

    if (!Array.isArray(selectedGroup.members) || !selectedGroup.members.length) {
      emitWorkflowLogMessage(`Selected group "${selectedGroup.name}" has no members`, 'warning');
      return false;
    }

    const normalizedSteps = normalizeWorkflowSteps(steps, actions, connectionMessage);
    console.log('[run-group-workflow] Loading credentials for accountId:', accountId || '(none)');
    const credentials = await loadLinkedInCredentialsForPosting(accountId || null);
    console.log('[run-group-workflow] Credentials result:', credentials ? { email: credentials.email, hasPassword: !!credentials.password, id: credentials.id } : null);
    if (!credentials?.email || !credentials?.password) {
      emitWorkflowLogMessage(`No LinkedIn credentials found for account "${accountId || 'default'}". Save credentials with a password first.`, 'error');
      return false;
    }

    const agent = agentId ? sdrAgentManager.getAgent(agentId) : null;
    const targets = resolveWorkflowProspectTargets({
      group: selectedGroup,
      accountId: credentials.id || accountId || null,
      accountName: credentials.name || credentials.email,
      agentId: agent?.id || null,
      agentName: agent?.name || null,
      workflowId: workflowId || null,
      workflowName: workflowName || selectedGroup.name || 'Workflow Run',
      targetType: targetType || 'group',
      sourceId: groupId || selectedGroup.id || null,
      sourceLabel: selectedGroup.name || workflowName || null
    });
    if (!targets.length) {
      emitWorkflowLogMessage(`Selected group "${selectedGroup.name}" does not contain any valid targets`, 'warning');
      return false;
    }

    const workflowRunInput = {
      workflowId: workflowId || null,
      workflowName: workflowName || selectedGroup.name || 'Workflow Run',
      accountId: credentials.id || accountId || null,
      accountName: credentials.name || credentials.email,
      agentId: agent?.id || null,
      agentName: agent?.name || null,
      targetType: targetType || 'group',
      headless: !!headless,
      browserProfile: browserProfile || 'random',
      slowMo: slowMo || 50,
      steps: normalizedSteps,
      targets,
      bypassWorkingHours: !!bypassWorkingHours,
      launchSource: launchSource || null
    };

    const usesCampaignController = shouldRouteWorkflowToCampaignController({ steps: normalizedSteps });
    const created = usesCampaignController
      ? await campaignController.createCoordinatedWorkflowRuns({
          campaignRunInput: {
            campaignTemplateId: workflowId || null,
            campaignTemplateName: workflowName || selectedGroup.name || 'Workflow Run',
            accountId: credentials.id || accountId || null,
            accountName: credentials.name || credentials.email,
            agentId: agent?.id || null,
            agentName: agent?.name || null,
            channelType: 'multi',
            metadata: {
              targetType: targetType || 'group',
              sourceId: groupId || selectedGroup.id || null,
              sourceLabel: selectedGroup.name || workflowName || null
            }
          },
          workflowRunInput
        })
      : workflowRunManager.createRun(workflowRunInput);
    const primaryRun = usesCampaignController
      ? created.workflowRuns[0] || null
      : created.run;
    const totalTargetsQueued = usesCampaignController
      ? created.workflowRuns.length
      : created.run.targets.length;

    recordActivityEventSafe({
      type: 'workflow_started',
      accountId: credentials.id || accountId || null,
      accountName: credentials.name || credentials.email,
      agentId: agent?.id || null,
      agentName: agent?.name || null,
      workflowId: workflowId || primaryRun?.id || null,
      workflowName: primaryRun?.workflowName || workflowName || selectedGroup.name || 'Workflow Run',
      runId: primaryRun?.id || null,
      correlationId: primaryRun?.correlationId || null,
      rootCorrelationId: primaryRun?.correlationId || null,
      status: 'ok',
      metadata: {
        correlationId: primaryRun?.correlationId || null,
        rootCorrelationId: primaryRun?.correlationId || null,
        workflowName: primaryRun?.workflowName || workflowName || selectedGroup.name || 'Workflow Run',
        targetCount: totalTargetsQueued,
        targetType: targetType || 'group',
        campaignManaged: usesCampaignController
      }
    });

    emitWorkflowLogMessage(
      `Queued "${primaryRun?.workflowName || workflowName || selectedGroup.name || 'Workflow Run'}" for ${totalTargetsQueued} target${totalTargetsQueued === 1 ? '' : 's'}${agent ? ` using agent "${agent.name}"` : ''}.`,
      'success',
      buildWorkflowCorrelationContext(primaryRun, null, {
        metadata: {
          campaignManaged: usesCampaignController
        }
      })
    );

    broadcastSdrWorkflowRunsUpdated();
    if (usesCampaignController) {
      broadcastCampaignRunsUpdated();
    }
    await startDueDurableWorkflowJobs();
    return true;
  } catch (error) {
    console.error('Error starting durable workflow:', error);
    emitWorkflowLogMessage(`Failed to start workflow: ${error.message}`, 'error');
    return false;
  }
});

ipcMain.on('stop-group-workflow', (event, payload = {}) => {
  const activeRuns = workflowRunManager.getAllRuns().filter((run) => {
    if (!['queued', 'running', 'waiting'].includes(run.status)) return false;
    if (payload?.runId && run.id !== payload.runId) return false;
    if (payload?.accountId && run.accountId !== payload.accountId) return false;
    return true;
  });

  activeRuns.forEach((run) => {
    workflowRunManager.cancelRun(run.id, 'Cancelled by user');
  });

  const markedCancelledSteps = durableScheduler.markJobsCancelled({
    runId:     payload?.runId     || undefined,
    accountId: payload?.accountId || undefined
  });

  broadcastSdrWorkflowRunsUpdated();

  if (activeRuns.length || markedCancelledSteps) {
    event.reply('workflow-log', {
      message: `Stopped ${activeRuns.length} workflow run${activeRuns.length === 1 ? '' : 's'} and marked ${markedCancelledSteps} active durable step${markedCancelledSteps === 1 ? '' : 's'} as cancelled.`,
      type: 'warning'
    });
    event.reply('workflow-done', { code: 1, runId: payload?.runId || null });
  } else {
    event.reply('workflow-log', {
      message: 'No durable workflow run is currently active.',
      type: 'warning'
    });
  }
});

// Add handler to get groups data
ipcMain.handle('get-groups-data', async (event) => {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;

    // Phase C C2b-2 read flip. Decide the groups SPINE — SQLite reconstruction
    // vs the legacy 3-path JSON merge — from the rollback flag + the groups
    // import_state row. The decision is a pure helper (groups-read-source.js);
    // this boundary reads env + DB and logs. Member enrichment + profile reads
    // below are UNCHANGED (still JSON spine until C3).
    const importStateRow = _workflowDb
      ? _workflowDb.prepare("SELECT * FROM import_state WHERE importer_name = 'groups'").get()
      : null;
    const decision = resolveGroupsReadSource({
      rollbackFlag: process.env.CONNECT_USE_LEGACY_JSON_STORES,
      importStateRow
    });
    if (decision.unknownTokens.length) {
      // Loud, explicit: a typo'd emergency rollback that did NOT apply must be
      // visible, with the resolved source shown.
      console.warn(
        `[groups] CONNECT_USE_LEGACY_JSON_STORES has unrecognized token(s) ` +
        `[${decision.unknownTokens.join(', ')}] — ignored (no rollback applied); ` +
        `resolved read source: ${decision.source}`
      );
    }

    let groups;
    if (_workflowDb && decision.source === 'sqlite') {
      // SQLite spine. reconstructGroups returns the pre-enrichment group shape
      // proven field-for-field equivalent to the JSON merge (C2a).
      groups = reconstructGroups(_workflowDb);
    } else {
      // Legacy 3-path JSON merge (unchanged fallback / rollback path).
      const possiblePaths = [
        path.join(userHome, 'Documents', 'Connect-Ability', 'groups.json'),
        path.join(userHome, 'Documents', 'Connect-Ability', 'standalone-groups.json'),
        path.join(app.getPath('userData'), 'groups.json')
      ];
      const mergedGroups = new Map();
      for (const groupsPath of possiblePaths) {
        if (fs.existsSync(groupsPath)) {
          const parsed = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
          if (Array.isArray(parsed)) {
            parsed.forEach((group) => {
              if (!group || typeof group !== 'object') return;
              const groupId = String(group.id || group.name || `group-${mergedGroups.size + 1}`);
              mergedGroups.set(groupId, {
                ...group,
                id: groupId,
                members: Array.isArray(group.members) ? group.members.filter(Boolean) : []
              });
            });
          }
        }
      }
      groups = Array.from(mergedGroups.values());
    }
    console.log(`[groups] read source: ${decision.source} (${decision.reason}), ${groups.length} groups`);

    // Enrich members on read: join the URL-string members against the
    // source-of-truth enriched profiles so the UI gets name/title/company via a
    // parallel memberProfiles array. `members` (URLs) is left unchanged, so
    // storage stays backward-compatible (no migration; saveGroupsData ignores
    // memberProfiles). See automation/profile/group-member-enrichment.js.
    // NOTE: getEnrichedStoredProfiles is the PROFILE read — still JSON spine,
    // flipped separately in C3. Untouched here.
    try {
      const profiles = getEnrichedStoredProfiles(null, {});
      const lookup = buildProfileLookupIndex(profiles, normalizeProfileUrl);
      return enrichGroupMembers(groups, lookup, normalizeProfileUrl);
    } catch (enrichError) {
      console.error('Group member enrichment failed; returning raw groups:', enrichError.message);
      return groups;
    }
  } catch (error) {
    console.error('Error loading groups data:', error);
    return [];
  }
});

// Add handler to save groups data
ipcMain.handle('save-groups-data', async (event, groups) => {
  try {
    const sanitizedGroups = sanitizeGroupsPayload(groups);
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
    const userDataDir = app.getPath('userData');
    
    // Ensure directory exists
    if (!fs.existsSync(documentsDir)) {
      fs.mkdirSync(documentsDir, { recursive: true });
    }

    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    const targetPaths = [
      path.join(documentsDir, 'groups.json'),
      path.join(documentsDir, 'standalone-groups.json'),
      path.join(userDataDir, 'groups.json')
    ];

    // Atomic per-path write (tmp + fsync + rename). The 3-path write remains
    // non-transactional across paths — a crash between two paths can still
    // leave the three copies inconsistent — but each individual file is now
    // guaranteed to be parseable or absent, never half-written. Full
    // cross-path atomicity would require a SQLite migration for groups,
    // tracked separately.
    targetPaths.forEach((groupsPath) => {
      writeJsonFileAtomic(groupsPath, sanitizedGroups);
    });

    // Phase C C2b-1 dual-write. JSON above is the authoritative store and read
    // spine; mirror the same sanitized payload into SQLite best-effort so the
    // C2b-2 read flip has fresh data. A failure here is logged but never fails
    // the user's save — JSON already succeeded, and a dropped sync re-heals on
    // the next save or the startup legacy importer. No read-path change.
    if (_sqliteGroupRepo) {
      try {
        const prospectIdByUrl = new Map();
        for (const p of prospectQueueStore.getAllProspects()) {
          if (p && p.normalizedProfileUrl && p.id) {
            prospectIdByUrl.set(p.normalizedProfileUrl, p.id);
          }
        }
        const synced = _sqliteGroupRepo.saveGroups(sanitizedGroups, { prospectIdByUrl });
        console.log(`[sqlite] groups dual-write: ${synced.groups} groups, ${synced.members} members synced`);
      } catch (groupSyncError) {
        console.warn(
          '[groups] SQLite dual-write failed (JSON save succeeded, continuing):',
          groupSyncError.message
        );
      }
    }

    return true;
  } catch (error) {
    console.error('Error saving groups data:', error);
    return false;
  }
});

ipcMain.on('start-automation', async (event, config) => {
  const account = await loadLinkedInCredentialsForPosting(config?.accountId);
  if (!account?.email || !account?.password) {
    event.reply('automation-log', {
      message: 'No LinkedIn credentials found for the selected profile.',
      type: 'error'
    });
    event.reply('automation-completed');
    return;
  }

  // Log the start of automation
  event.reply('automation-log', { 
    message: `Starting LinkedIn automation using ${account.name || account.email}...`, 
    type: 'info'
  });

  try {
      assertLegacyDirectLoginAllowed('main.start-automation', {
        onAllowed: ({ entryPoint }) => recordLegacyDirectLoginUsage({
          entryPoint,
          accountId: config?.accountId || null,
          accountName: null,
          source: 'main.start-automation'
        }, {
          recordEvent: (eventInput) => recordActivityEventSafe(eventInput)
        })
      });
      const jobId = createLinkedInRuntimeJobId('search-engage', account.id);
      const runtimeConfig = {
        ...config,
        jobId,
        accountId: account.id,
        accountName: account.name,
        accountEmail: account.email
      };

      // Save config to tempfile (prevents command line too long errors)
      const configPath = path.join(app.getPath('temp'), `linkedin-config-${jobId}.json`);
      fs.writeFileSync(configPath, JSON.stringify(runtimeConfig));

      // Launch the automation script using global process
      const childProcess = spawnNodeRuntime(
        path.join(__dirname, 'automation.js'),
        [configPath],
        { env: legacyAutomationSpawnEnv() }
      );
      globalAutomationProcess = childProcess;
      automationProcess = childProcess; // Compatibility
      registerLinkedInRuntimeJob({
        jobId,
        type: 'search-engage',
        accountId: account.id,
        accountName: account.name || account.email,
        process: childProcess,
        meta: {
          searchType: config.searchType || 'query',
          searchQuery: config.searchQuery || null
        }
      });

      // Handle standard output
      childProcess.stdout.on('data', (data) => {
        const logLines = data.toString().trim().split('\n');
        
        logLines.forEach(line => {
          try {
            // Try to parse JSON logs (structured)
            const logData = JSON.parse(line);
            
            if (logData.type === 'progress') {
              // Progress updates
              event.reply('automation-progress', {
                current: logData.current,
                total: logData.total
              });
            } else {
              // Regular log messages
              event.reply('automation-log', {
                message: logData.message || line,
                type: logData.type || 'normal'
              });
            }
          } catch (e) {
            // If not JSON, treat as plain text log
            event.reply('automation-log', {
              message: line,
              type: 'normal'
            });
          }
        });
      });

      // Handle error output
      childProcess.stderr.on('data', (data) => {
        const errorMessage = data.toString().trim();
        event.reply('automation-log', { 
          message: errorMessage, 
          type: 'error'
        });
      });

      // Handle process exit
      childProcess.on('close', (code) => {
        const message = `Automation process exited with code ${code}`;
        const type = code === 0 ? 'success' : 'error';
        
        event.reply('automation-log', { message, type });
        event.reply('automation-completed');
        unregisterLinkedInRuntimeJob(jobId);
        
        cleanupTempConfig(configPath, 'search-engage temp config');
        
        // If config has showWorkflowManager flag, open workflow manager
        if (config.showWorkflowManager) {
          openWorkflowManager(event);
        }
        
        // Reset process variables
        globalAutomationProcess = null;
        automationProcess = null;
      });

      childProcess.on('error', (error) => {
        console.error('Failed to start automation process:', error);
        event.reply('automation-log', { 
          message: `Failed to start automation: ${error.message}`, 
          type: 'error'
        });
        event.reply('automation-completed');
        cleanupTempConfig(configPath, 'search-engage temp config');
        unregisterLinkedInRuntimeJob(jobId);
        globalAutomationProcess = null;
        automationProcess = null;
      });

    } catch (error) {
      event.reply('automation-log', { 
        message: `Failed to start automation: ${error.message}`, 
        type: 'error'
      });
      event.reply('automation-completed');
    }
});

// Update the navigation handling to hide the workflows tab
app.whenReady().then(() => {
  const windowRef = createWindow();
  
  // Hide the workflows navigation item after window is created
  setTimeout(() => {
    if (windowRef && !windowRef.isDestroyed()) {
      windowRef.webContents.executeJavaScript(`
        // Hide the workflows navigation item
        const workflowsNavItem = document.querySelector('[data-section="workflows"]');
        if (workflowsNavItem && workflowsNavItem.parentElement) {
          workflowsNavItem.parentElement.style.display = 'none';
        }
        
        // Also hide the workflows section itself
        const workflowsSection = document.getElementById('workflows-section');
        if (workflowsSection) {
          workflowsSection.style.display = 'none';
        }
      `);
    }
  }, 1000);
});

// Add cleanup for workflow processes on app quit
app.on('before-quit', () => {
  stopExternalApiServer();
  // Clean up any running processes
  if (global.currentWorkflowProcess && !global.currentWorkflowProcess.killed) {
    global.currentWorkflowProcess.kill();
  }
  
  if (automationProcess && !automationProcess.killed) {
    automationProcess.kill();
  }
  
  if (workflowManagerProcess && !workflowManagerProcess.killed) {
    workflowManagerProcess.kill();
  }
});

// Helper function to sync groups data between localStorage and file system
function syncGroupsData() {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
    const groupsPath = path.join(documentsDir, 'groups.json');
    
    // Ensure directory exists
    if (!fs.existsSync(documentsDir)) {
      fs.mkdirSync(documentsDir, { recursive: true });
    }
    
    // If groups file doesn't exist, create empty array
    if (!fs.existsSync(groupsPath)) {
      writeJsonFileAtomic(groupsPath, []);
    }
    
    return true;
  } catch (error) {
    console.error('Error syncing groups data:', error);
    return false;
  }
}

// Call sync on startup
app.whenReady().then(() => {
  syncGroupsData();
});

// Module export (optional)
module.exports = {
  repairProfilesData,
  normalizeProfileUrl
};

/* === Scheduled Messaging Integration - BEGIN === */

// Remove existing listeners to avoid duplicates if already defined
try { ipcMain.removeAllListeners('trigger-scheduled-message'); } catch {}
try { ipcMain.removeAllListeners('schedule-message'); } catch {}
try { ipcMain.removeAllListeners('get-scheduled-messages'); } catch {}
try { ipcMain.removeAllListeners('cancel-scheduled-message'); } catch {}


ipcMain.on('clear-scheduled-logs', (event, options = {}) => {
  try {
    const { keepPending = true, statusTypes = null } = options;
    const accountId = sanitizeOptionalId(options?.accountId, 120) || null;

    let cleared = 0;
    if (statusTypes) {
      cleared = messageScheduler.clearByStatus(statusTypes, accountId ? { accountId } : {});
    } else {
      cleared = messageScheduler.clearScheduledLogs(keepPending, accountId ? { accountId } : {});
    }

    event.reply('automation-log', {
      message: `Cleared ${cleared} scheduled message logs`,
      type: 'success'
    });

    // Reload the updated list
    const messages = getVisibleScheduledMessages(accountId);
    event.reply('scheduled-messages-loaded', messages);
  } catch (error) {
    event.reply('automation-log', {
      message: `Failed to clear logs: ${error.message}`,
      type: 'error'
    });
  }
});

// Function to start messaging automation for a scheduled message
async function startMessagingAutomationForScheduledMessage(config) {
  try {
    assertLegacyDirectLoginAllowed('main.start-scheduled-message', {
      onAllowed: ({ entryPoint }) => recordLegacyDirectLoginUsage({
        entryPoint,
        accountId: config?.accountId || null,
        accountName: null,
        source: 'main.start-scheduled-message',
        metadata: {
          scheduleId: config?.scheduleId || null
        }
      }, {
        recordEvent: (eventInput) => recordActivityEventSafe(eventInput)
      })
    });
    // Import your browser automation setup
    const { chromium } = require('playwright');

    // Launch browser (visible so user can see the automation)
    const browser = await chromium.launch({ 
      headless: false,
      slowMo: config.automation?.slowMotionFactor || 50
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
      // Get stored credentials for login
      const credentials = await getStoredCredentials(); // You'll need to implement this

      if (!credentials?.email || !credentials?.password) {
        throw new Error('No stored LinkedIn credentials found');
      }

	      // Login to LinkedIn
	      logAction('Logging into LinkedIn...');
	      await loginToLinkedIn(page, credentials.email, credentials.password);

      // Process the message sending
      logAction('Starting message sending process...');
      const result = await processMessageSending(page, config);

      if (result.success) {
        await updateScheduledMessageStatus(config.scheduleId, 'sent');
        logAction(`Successfully sent ${result.sent} messages`);
      } else {
        await updateScheduledMessageStatus(config.scheduleId, 'failed');
        logError(`Failed to send messages: ${result.error || 'Unknown error'}`);
      }

      // Keep browser open for a moment so user can see completion
      await new Promise(resolve => setTimeout(resolve, 5000));

    } finally {
      await browser.close();
    }

  } catch (error) {
    logError('Error in messaging automation:', error);
    if (config.scheduleId) {
      await updateScheduledMessageStatus(config.scheduleId, 'failed');
    }
    throw error;
  }
}

// Helper function to get scheduled message from storage
async function getScheduledMessage(scheduleId) {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
    const scheduledPath = path.join(documentsDir, 'scheduled-messages.json');

    if (!fs.existsSync(scheduledPath)) {
      return null;
    }

    const messages = JSON.parse(fs.readFileSync(scheduledPath, 'utf8'));
    return messages.find(m => m.id === scheduleId);

  } catch (error) {
    logError('Error getting scheduled message:', error);
    return null;
  }
}

// Helper function to update scheduled message status
async function updateScheduledMessageStatus(scheduleId, status) {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
    const scheduledPath = path.join(documentsDir, 'scheduled-messages.json');

    if (!fs.existsSync(documentsDir)) {
      fs.mkdirSync(documentsDir, { recursive: true });
    }

    let messages = [];
    if (fs.existsSync(scheduledPath)) {
      messages = JSON.parse(fs.readFileSync(scheduledPath, 'utf8'));
    }

    const messageIndex = messages.findIndex(m => m.id === scheduleId);
    if (messageIndex >= 0) {
      messages[messageIndex].status = status;
      messages[messageIndex].lastUpdated = new Date().toISOString();

      writeJsonFileAtomic(scheduledPath, messages);
      logAction(`Updated scheduled message ${scheduleId} status to ${status}`);
    }

  } catch (error) {
    logError('Error updating scheduled message status:', error);
  }
}

// Helper function to get all scheduled messages
async function getAllScheduledMessages() {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
    const scheduledPath = path.join(documentsDir, 'scheduled-messages.json');

    if (!fs.existsSync(scheduledPath)) {
      return [];
    }

    return JSON.parse(fs.readFileSync(scheduledPath, 'utf8'));

  } catch (error) {
    logError('Error getting all scheduled messages:', error);
    return [];
  }
}

// Helper function to get stored credentials (implement based on your storage method)
async function getStoredCredentials(accountId = null) {
  try {
    return await loadLinkedInAccountCredentials(accountId);
  } catch (error) {
    logError('Error getting stored credentials:', error);
    return null;
  }
}

// Final active handlers for scheduler UI actions
ipcMain.on('schedule-message', async (event, messageData) => {
  try {
    const sanitizedMessageData = sanitizeScheduleMessageInput(messageData);
    if (!messageScheduler._initialized) {
      await messageScheduler.init();
    }

	    const profileIds = sanitizedMessageData.profileIds;
	    const message = sanitizedMessageData.message;
	    const scheduledTime = sanitizedMessageData.scheduledTime;
	    const optionOverrides = sanitizedMessageData.options;
      const scope = getLinkedInAccountScope(sanitizedMessageData.accountId || optionOverrides.accountId || null);
      const account = resolveLinkedInAccountRecord(scope.accountId || null);

    if (profileIds.length === 0) {
      event.reply('automation-log', {
        message: 'No recipients selected for scheduling',
        type: 'error'
      });
      return;
    }
    if (!message) {
      event.reply('automation-log', {
        message: 'Message text is required for scheduling',
        type: 'error'
      });
      return;
    }

    const sendNow = new Date(scheduledTime).getTime() <= Date.now() + 1500;
	    const scheduleResult = messageScheduler.scheduleMessage(
	      {
	        profileIds,
	        message,
	        scheduledTime,
          accountId: scope.accountId || null,
          accountName: account?.name || account?.email || scope.accountName || null,
	        options: {
            accountId: scope.accountId || null,
            accountName: account?.name || account?.email || scope.accountName || null,
	          recurring: !!optionOverrides.recurring,
	          recurringPattern: optionOverrides.recurringPattern ?? null,
	          maxRecurrences: Number(optionOverrides.maxRecurrences ?? 1)
	        }
	      },
	      sendNow
    );

    const scheduleId = typeof scheduleResult === 'string' ? scheduleResult : scheduleResult.id;
    event.reply('automation-log', {
      message: sendNow
        ? `Queued immediate message send for ${profileIds.length} recipients`
        : `Scheduled message ${scheduleId} for ${new Date(scheduledTime).toLocaleString()}`,
      type: 'success'
    });
    event.reply('scheduled-messages-loaded', getVisibleScheduledMessages(scope.accountId));
  } catch (error) {
    logError('Error scheduling message:', error);
    event.reply('automation-log', {
      message: `Failed to schedule messages: ${error.message}`,
      type: 'error'
    });
  }
});

ipcMain.on('get-scheduled-messages', async (event, filters = {}) => {
  try {
    if (!messageScheduler._initialized) {
      await messageScheduler.init();
    }
    event.reply('scheduled-messages-loaded', getVisibleScheduledMessages(filters?.accountId || null));
  } catch (error) {
    logError('Error getting scheduled messages:', error);
    event.reply('scheduled-messages-loaded', []);
  }
});

ipcMain.on('cancel-scheduled-message', async (event, scheduleIdOrPayload) => {
  try {
    if (!messageScheduler._initialized) {
      await messageScheduler.init();
    }
    const { scheduleId, accountId, schedule } = resolveScheduledMessageRequest(scheduleIdOrPayload);
    const cancelled = schedule
      ? messageScheduler.cancelSchedule(scheduleId, schedule.accountId ? { accountId: schedule.accountId } : {})
      : false;
    event.reply('automation-log', {
      message: cancelled
        ? `Cancelled scheduled message: ${scheduleId}`
        : `Could not cancel scheduled message: ${scheduleId}`,
      type: cancelled ? 'success' : 'warning'
    });
    event.reply('scheduled-messages-loaded', getVisibleScheduledMessages(accountId));
  } catch (error) {
    logError('Error canceling scheduled message:', error);
    event.reply('automation-log', {
      message: `Failed to cancel scheduled message: ${error.message}`,
      type: 'error'
    });
  }
});

// Invoke-based scheduler APIs for external agents (request/response style).
ipcMain.handle('schedule-message-invoke', async (_event, messageData) => {
  try {
    const sanitizedMessageData = sanitizeScheduleMessageInput(messageData);
    if (!messageScheduler._initialized) {
      await messageScheduler.init();
    }

	    const profileIds = sanitizedMessageData.profileIds;
	    const message = sanitizedMessageData.message;
	    const scheduledTime = sanitizedMessageData.scheduledTime;
	    const optionOverrides = sanitizedMessageData.options;
      const scope = getLinkedInAccountScope(sanitizedMessageData.accountId || optionOverrides.accountId || null);
      const account = resolveLinkedInAccountRecord(scope.accountId || null);

    if (profileIds.length === 0) {
      return { ok: false, error: 'No recipients selected for scheduling' };
    }
    if (!message) {
      return { ok: false, error: 'Message text is required for scheduling' };
    }

    const sendNow = new Date(scheduledTime).getTime() <= Date.now() + 1500;
	    const scheduleResult = messageScheduler.scheduleMessage(
	      {
	        profileIds,
	        message,
	        scheduledTime,
          accountId: scope.accountId || null,
          accountName: account?.name || account?.email || scope.accountName || null,
	        options: {
            accountId: scope.accountId || null,
            accountName: account?.name || account?.email || scope.accountName || null,
	          recurring: !!optionOverrides.recurring,
	          recurringPattern: optionOverrides.recurringPattern ?? null,
	          maxRecurrences: Number(optionOverrides.maxRecurrences ?? 1)
	        }
	      },
	      sendNow
    );

    const scheduleId = typeof scheduleResult === 'string' ? scheduleResult : scheduleResult.id;
    return {
      ok: true,
      scheduleId,
      sendNow,
      scheduledTime,
      messages: getVisibleScheduledMessages(scope.accountId)
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('get-scheduled-messages-invoke', async (_event, filters = {}) => {
  try {
    if (!messageScheduler._initialized) {
      await messageScheduler.init();
    }
    return { ok: true, messages: getVisibleScheduledMessages(filters?.accountId || null) };
  } catch (error) {
    return { ok: false, error: error.message, messages: [] };
  }
});

ipcMain.handle('get-scheduled-message-invoke', async (_event, scheduleIdOrPayload, filters = {}) => {
  try {
    if (!messageScheduler._initialized) {
      await messageScheduler.init();
    }
    const { scheduleId, schedule: message } = resolveScheduledMessageRequest(scheduleIdOrPayload, filters);
    if (!message) {
      return { ok: false, error: `Scheduled message ${scheduleId} not found` };
    }
    return { ok: true, message };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('cancel-scheduled-message-invoke', async (_event, scheduleIdOrPayload, filters = {}) => {
  try {
    if (!messageScheduler._initialized) {
      await messageScheduler.init();
    }
    const { scheduleId, accountId, schedule } = resolveScheduledMessageRequest(scheduleIdOrPayload, filters);
    const cancelled = schedule
      ? messageScheduler.cancelSchedule(scheduleId, schedule.accountId ? { accountId: schedule.accountId } : {})
      : false;
    return {
      ok: cancelled,
      cancelled,
      scheduleId,
      messages: getVisibleScheduledMessages(accountId)
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('update-scheduled-message-invoke', async (_event, scheduleIdOrPayload, updates, filters = {}) => {
  try {
    if (!messageScheduler._initialized) {
      await messageScheduler.init();
    }
    const { scheduleId, accountId, schedule } = resolveScheduledMessageRequest(scheduleIdOrPayload, filters);
    const updated = schedule
      ? messageScheduler.updateSchedule(scheduleId, updates || {}, schedule.accountId ? { accountId: schedule.accountId } : {})
      : false;
    return {
      ok: !!updated,
      updated: !!updated,
      scheduleId,
      messages: getVisibleScheduledMessages(accountId)
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('send-scheduled-now-invoke', async (_event, scheduleIdOrPayload, filters = {}) => {
  try {
    if (!messageScheduler._initialized) {
      await messageScheduler.init();
    }
    const { scheduleId, accountId, schedule } = resolveScheduledMessageRequest(scheduleIdOrPayload, filters);
    const ok = schedule
      ? messageScheduler.triggerNow(scheduleId, schedule.accountId ? { accountId: schedule.accountId } : {})
      : false;
    return { ok, scheduleId, messages: getVisibleScheduledMessages(accountId) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/* === Scheduled Messaging Integration - END === */
