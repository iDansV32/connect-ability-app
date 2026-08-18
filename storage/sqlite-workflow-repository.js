'use strict';

/**
 * storage/sqlite-workflow-repository.js
 *
 * SQLite-backed implementation of the workflow repository seam.
 * Satisfies the same interface as storage/json-workflow-repository.js:
 *
 *   transact(fn)        — load both stores, call fn(runsStore, jobsStore),
 *                         upsert changed rows back; rolls back on throw
 *   transactJobsOnly(fn)— same but jobs-only (used by heartbeatJob)
 *   readRuns()          — read-only snapshot of runsStore
 *   readJobs()          — read-only snapshot of jobsStore
 *
 * Design: the fn(runsStore, jobsStore) pattern is preserved verbatim.
 * Before each transact, all rows are loaded into in-memory { version, runs/jobs: [] }
 * objects that WorkflowRunManager mutates in place.  After fn returns, every
 * record in the store is upserted via INSERT OR REPLACE inside a single
 * SQLite transaction.  Since WRM never deletes rows (only status transitions),
 * upsert-all is both correct and complete.
 *
 * Crash safety: one SQLite transaction wraps the entire load + fn + sync,
 * so a crash mid-way leaves the database unchanged — stronger than the
 * jobs-first / runs-second file ordering in JsonWorkflowRepository.
 */

const STORE_VERSION = 1;

// ---------------------------------------------------------------------------
// Row ↔ JS object conversions
// ---------------------------------------------------------------------------

function safeParseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function runToRow(run) {
  return {
    id:                  run.id,
    workflow_id:         run.workflowId       || null,
    workflow_name:       run.workflowName     || null,
    account_id:          run.accountId        || null,
    account_name:        run.accountName      || null,
    agent_id:            run.agentId          || null,
    agent_name:          run.agentName        || null,
    campaign_run_id:     run.campaignRunId    || null,
    run_status:          run.status           || 'queued',
    target_type:         run.targetType       || null,
    browser_profile:     run.browserProfile   || null,
    slow_mo:             Number(run.slowMo)   || 0,
    headless:            run.headless ? 1 : 0,
    steps_json:          JSON.stringify(Array.isArray(run.steps)   ? run.steps   : []),
    targets_json:        JSON.stringify(Array.isArray(run.targets) ? run.targets : []),
    summary_json:        JSON.stringify(run.summary && typeof run.summary === 'object' ? run.summary : {}),
    correlation_id:      run.correlationId    || null,
    drain_pending:       run.drainPending ? 1 : 0,
    drain_reason:        run.drainReason      || null,
    drain_requested_at:  run.drainRequestedAt || null,
    drain_completed_at:  run.drainCompletedAt || null,
    last_error:          run.lastError        || null,
    pause_reason:        run.pauseReason      || null,
    launch_source:       run.launchSource     || null,
    bypass_working_hours: run.bypassWorkingHours ? 1 : 0,
    created_at:          run.createdAt        || new Date().toISOString(),
    updated_at:          run.updatedAt        || new Date().toISOString(),
    completed_at:        run.completedAt      || null
  };
}

function rowToRun(row) {
  return {
    id:               row.id,
    workflowId:       row.workflow_id        || null,
    workflowName:     row.workflow_name      || null,
    accountId:        row.account_id         || null,
    accountName:      row.account_name       || null,
    agentId:          row.agent_id           || null,
    agentName:        row.agent_name         || null,
    campaignRunId:    row.campaign_run_id    || null,
    status:           row.run_status         || 'queued',
    targetType:       row.target_type        || null,
    browserProfile:   row.browser_profile    || 'random',
    slowMo:           Number(row.slow_mo)    || 50,
    headless:         row.headless === 1,
    steps:            safeParseJson(row.steps_json,   []),
    targets:          safeParseJson(row.targets_json, []),
    summary:          safeParseJson(row.summary_json, {}),
    correlationId:    row.correlation_id     || null,
    drainPending:     row.drain_pending === 1,
    drainReason:      row.drain_reason       || null,
    drainRequestedAt: row.drain_requested_at || null,
    drainCompletedAt: row.drain_completed_at || null,
    lastError:        row.last_error         || null,
    pauseReason:      row.pause_reason       || null,
    launchSource:     row.launch_source      || null,
    bypassWorkingHours: row.bypass_working_hours === 1,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
    completedAt:      row.completed_at       || null
  };
}

function jobToRow(job) {
  return {
    id:                  job.id,
    run_id:              job.runId,
    target_id:           job.targetId,
    prospect_id:         job.prospectId         || null,
    target_value:        job.targetValue        || null,
    target_label:        job.targetLabel        || null,
    target_index:        Number(job.targetIndex) || 0,
    step_index:          Number(job.stepIndex)   || 0,
    step_type:           job.stepType,
    step_json:           JSON.stringify(job.step && typeof job.step === 'object' ? job.step : {}),
    job_status:          job.status             || 'queued',
    attempts:            Number(job.attempts)   || 0,
    max_attempts:        Number(job.maxAttempts) || 3,
    scheduled_for:       job.scheduledFor,
    started_at:          job.startedAt          || null,
    completed_at:        job.completedAt        || null,
    created_at:          job.createdAt          || new Date().toISOString(),
    updated_at:          job.updatedAt          || new Date().toISOString(),
    lease_owner:         job.leaseOwner         || null,
    lease_expires_at:    job.leaseExpiresAt     || null,
    last_heartbeat_at:   job.lastHeartbeatAt    || null,
    error_message:       job.errorMessage       || null,
    result_json:         JSON.stringify(job.result && typeof job.result === 'object' ? job.result : {}),
    account_id:          job.accountId          || null,
    account_name:        job.accountName        || null,
    agent_id:            job.agentId            || null,
    agent_name:          job.agentName          || null,
    workflow_id:         job.workflowId         || null,
    workflow_name:       job.workflowName       || null,
    correlation_id:      job.correlationId      || null,
    root_correlation_id: job.rootCorrelationId  || null,
    claim_uuid:          job.claimUuid          || null
  };
}

function rowToJob(row) {
  return {
    id:               row.id,
    runId:            row.run_id,
    targetId:         row.target_id,
    prospectId:       row.prospect_id          || null,
    targetValue:      row.target_value         || null,
    targetLabel:      row.target_label         || null,
    targetIndex:      Number(row.target_index)  || 0,
    stepIndex:        Number(row.step_index)    || 0,
    stepType:         row.step_type,
    step:             safeParseJson(row.step_json, {}),
    status:           row.job_status           || 'queued',
    attempts:         Number(row.attempts)     || 0,
    maxAttempts:      Number(row.max_attempts) || 3,
    scheduledFor:     row.scheduled_for,
    startedAt:        row.started_at           || null,
    completedAt:      row.completed_at         || null,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
    leaseOwner:       row.lease_owner          || null,
    leaseExpiresAt:   row.lease_expires_at     || null,
    lastHeartbeatAt:  row.last_heartbeat_at    || null,
    errorMessage:     row.error_message        || null,
    result:           safeParseJson(row.result_json, {}),
    accountId:        row.account_id           || null,
    accountName:      row.account_name         || null,
    agentId:          row.agent_id             || null,
    agentName:        row.agent_name           || null,
    workflowId:       row.workflow_id          || null,
    workflowName:     row.workflow_name        || null,
    correlationId:    row.correlation_id       || null,
    rootCorrelationId: row.root_correlation_id || null,
    claimUuid:        row.claim_uuid           || null
  };
}

// ---------------------------------------------------------------------------
// SqliteWorkflowRepository
// ---------------------------------------------------------------------------

class SqliteWorkflowRepository {
  constructor(db) {
    if (!db) throw new Error('SqliteWorkflowRepository requires a db instance');
    this.db = db;
    this._prep();
  }

  _prep() {
    this._stmtLoadRuns = this.db.prepare(
      'SELECT * FROM workflow_runs ORDER BY created_at ASC'
    );
    this._stmtLoadJobs = this.db.prepare(
      'SELECT * FROM workflow_jobs ORDER BY created_at ASC'
    );
    this._stmtUpsertRun = this.db.prepare(`
      INSERT OR REPLACE INTO workflow_runs (
        id, workflow_id, workflow_name, account_id, account_name,
        agent_id, agent_name, campaign_run_id, run_status, target_type,
        browser_profile, slow_mo, headless, launch_source, bypass_working_hours,
        steps_json, targets_json, summary_json, correlation_id,
        drain_pending, drain_reason, drain_requested_at, drain_completed_at,
        last_error, pause_reason, created_at, updated_at, completed_at
      ) VALUES (
        @id, @workflow_id, @workflow_name, @account_id, @account_name,
        @agent_id, @agent_name, @campaign_run_id, @run_status, @target_type,
        @browser_profile, @slow_mo, @headless, @launch_source, @bypass_working_hours,
        @steps_json, @targets_json, @summary_json, @correlation_id,
        @drain_pending, @drain_reason, @drain_requested_at, @drain_completed_at,
        @last_error, @pause_reason, @created_at, @updated_at, @completed_at
      )
    `);
    this._stmtUpsertJob = this.db.prepare(`
      INSERT OR REPLACE INTO workflow_jobs (
        id, run_id, target_id, prospect_id, target_value, target_label, target_index,
        step_index, step_type, step_json, job_status, attempts, max_attempts,
        scheduled_for, started_at, completed_at, created_at, updated_at,
        lease_owner, lease_expires_at, last_heartbeat_at,
        error_message, result_json,
        account_id, account_name, agent_id, agent_name,
        workflow_id, workflow_name, correlation_id, root_correlation_id,
        claim_uuid
      ) VALUES (
        @id, @run_id, @target_id, @prospect_id, @target_value, @target_label, @target_index,
        @step_index, @step_type, @step_json, @job_status, @attempts, @max_attempts,
        @scheduled_for, @started_at, @completed_at, @created_at, @updated_at,
        @lease_owner, @lease_expires_at, @last_heartbeat_at,
        @error_message, @result_json,
        @account_id, @account_name, @agent_id, @agent_name,
        @workflow_id, @workflow_name, @correlation_id, @root_correlation_id,
        @claim_uuid
      )
    `);

    // Targeted claim path — uses idx_workflow_jobs_claim (job_status, scheduled_for, account_id).
    // Two queries combined: candidate queued jobs whose scheduledFor has elapsed,
    // and running jobs whose lease has expired (for reclamation). Together these
    // are the only rows claimDueJobs needs to examine, vs. the full table.
    this._stmtSelectQueuedDueJobIds = this.db.prepare(`
      SELECT id FROM workflow_jobs
      WHERE job_status = 'queued' AND scheduled_for <= ?
      -- Target-first ordering guarantees that a due follow-on action for the
      -- active prospect is included even when a large run has many older,
      -- still-queued first-step jobs for later prospects.
      ORDER BY target_index ASC, scheduled_for ASC, created_at ASC
      LIMIT ?
    `);
    this._stmtSelectExpiredRunningJobIds = this.db.prepare(`
      SELECT id FROM workflow_jobs
      WHERE job_status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `);
    this._stmtLoadJobById = this.db.prepare('SELECT * FROM workflow_jobs WHERE id = ?');
    this._stmtLoadRunById = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?');
  }

  _readRunsStore() {
    return { version: STORE_VERSION, runs: this._stmtLoadRuns.all().map(rowToRun) };
  }

  _readJobsStore() {
    return { version: STORE_VERSION, jobs: this._stmtLoadJobs.all().map(rowToJob) };
  }

  _syncRuns(runs) {
    for (const run of runs) { this._stmtUpsertRun.run(runToRow(run)); }
  }

  _syncJobs(jobs) {
    for (const job of jobs) { this._stmtUpsertJob.run(jobToRow(job)); }
  }

  /**
   * Load both stores, call fn(runsStore, jobsStore), upsert all records back.
   * If fn throws the SQLite transaction is rolled back — no partial writes.
   */
  transact(fn) {
    return this.db.transaction(() => {
      const runsStore = this._readRunsStore();
      const jobsStore = this._readJobsStore();
      const result = fn(runsStore, jobsStore);
      // Runs before jobs — honours FK constraint workflow_jobs.run_id → workflow_runs.id
      this._syncRuns(runsStore.runs);
      this._syncJobs(jobsStore.jobs);
      return result;
    })();
  }

  /**
   * Load only jobsStore, call fn(jobsStore), upsert jobs back.
   * Used by heartbeatJob (touches only the jobs table).
   */
  transactJobsOnly(fn) {
    return this.db.transaction(() => {
      const jobsStore = this._readJobsStore();
      const result = fn(jobsStore);
      this._syncJobs(jobsStore.jobs);
      return result;
    })();
  }

  /** Read-only snapshot of runsStore (no flush). */
  readRuns() { return this._readRunsStore(); }

  /** Read-only snapshot of jobsStore (no flush). */
  readJobs() { return this._readJobsStore(); }

  /**
   * Targeted variant of transact() for claimDueJobs. Instead of loading the
   * entire workflow_jobs + workflow_runs tables, uses idx_workflow_jobs_claim
   * to fetch only candidate job IDs (queued + due, OR running + lease-expired),
   * loads those jobs and their referenced runs, calls fn(runsStore, jobsStore),
   * and writes back only the loaded subset. The caller's mutation logic stays
   * unchanged because the stores it receives have the same shape — just
   * smaller. Atomic within a single SQL transaction.
   *
   * @param {object} options
   * @param {string} [options.before]                 ISO timestamp upper bound (default: now)
   * @param {number} [options.candidateFetchLimit]    cap on candidates fetched (default: 100)
   * @param {function(runsStore, jobsStore): T} fn
   * @returns {T}
   */
  transactDueJobs(options, fn) {
    const before = (options && options.before) || new Date().toISOString();
    const fetchLimit = Math.max(50, Number(options && options.candidateFetchLimit) || 100);

    return this.db.transaction(() => {
      const queuedDueIds = this._stmtSelectQueuedDueJobIds.all(before, fetchLimit).map((r) => r.id);
      const expiredRunningIds = this._stmtSelectExpiredRunningJobIds.all(before).map((r) => r.id);
      const allJobIds = [...new Set([...queuedDueIds, ...expiredRunningIds])];

      const jobs = allJobIds
        .map((id) => this._stmtLoadJobById.get(id))
        .filter(Boolean)
        .map(rowToJob);
      const jobsStore = { version: STORE_VERSION, jobs };

      const runIds = [...new Set(jobs.map((j) => j.runId).filter(Boolean))];
      const runs = runIds
        .map((id) => this._stmtLoadRunById.get(id))
        .filter(Boolean)
        .map(rowToRun);
      const runsStore = { version: STORE_VERSION, runs };

      const result = fn(runsStore, jobsStore);
      // Runs before jobs — honours FK constraint workflow_jobs.run_id → workflow_runs.id
      this._syncRuns(runsStore.runs);
      this._syncJobs(jobsStore.jobs);
      return result;
    })();
  }
}

module.exports = SqliteWorkflowRepository;
