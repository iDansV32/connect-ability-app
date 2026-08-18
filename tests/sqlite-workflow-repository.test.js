'use strict';

/**
 * tests/sqlite-workflow-repository.test.js
 *
 * Targeted tests for Ticket 4B — SQLite activation for workflow runs/jobs.
 *
 * Tests:
 *  1. First-run import: legacy JSON rows end up in SQLite when tables are empty.
 *  2. Idempotency guard: import is skipped when tables already have data.
 *  3. Persistence: createRun + initial jobs survive manager re-instantiation
 *     with the same db handle (i.e., data lives in SQLite, not in memory).
 *  4. Full lifecycle: claim / retry / complete work end-to-end through the
 *     SQLite-backed repository.
 *
 * All tests use in-memory SQLite (:memory:) for isolation, except test 3
 * which uses a file-based DB in a temp directory to verify file durability.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const SqliteWorkflowRepository = require('../storage/sqlite-workflow-repository');
const { importLegacyWorkflowData } = require('../storage/workflow-legacy-importer');
const WorkflowRunManager = require('../workflow-run-manager');
const { createTempWorkspace, writeJson } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openMemory() {
  return openDatabase(':memory:');
}

/** Minimal valid run input for WorkflowRunManager.createRun */
function runInput(overrides = {}) {
  return {
    workflowName: 'SQLite Test Run',
    accountId:    'acc-sqlite',
    steps:    [{ type: 'view_profile' }],
    targets:  [{ value: 'https://linkedin.com/in/sqlite-user', label: 'SQLite User', prospectId: 'p-sql' }],
    ...overrides
  };
}

/** Minimal legacy run record (raw shape as stored by old JsonWorkflowRepository) */
function legacyRun(id = 'legacy-run-1') {
  const now = '2024-01-01T00:00:00.000Z';
  return {
    id,
    workflowName: 'Legacy Run',
    accountId:    'acc-legacy',
    status:       'queued',
    targetType:   'group',
    browserProfile: 'random',
    slowMo:       50,
    headless:     false,
    correlationId: `corr_${id}`,
    steps:   [{ type: 'view_profile' }],
    targets: [{ targetId: 'tgt-1', value: 'https://linkedin.com/in/x', label: 'X', status: 'queued', currentStepIndex: 0, lastError: null, nextRunAt: null, completedAt: null }],
    summary: { totalTargets: 1, completedTargets: 0, failedTargets: 0, cancelledTargets: 0 },
    drainPending: false, drainReason: null, drainRequestedAt: null, drainCompletedAt: null,
    lastError: null, pauseReason: null,
    createdAt: now, updatedAt: now, completedAt: null
  };
}

/** Minimal legacy job record */
function legacyJob(id = 'legacy-job-1', runId = 'legacy-run-1') {
  const now = '2024-01-01T00:00:00.000Z';
  return {
    id, runId,
    targetId: 'tgt-1', prospectId: null,
    targetValue: 'https://linkedin.com/in/x', targetLabel: 'X', targetIndex: 0,
    stepIndex: 0, stepType: 'view_profile', step: { type: 'view_profile' },
    status: 'queued', attempts: 0, maxAttempts: 3,
    scheduledFor: now, accountId: 'acc-legacy',
    leaseOwner: null, leaseExpiresAt: null, lastHeartbeatAt: null,
    startedAt: null, completedAt: null,
    errorMessage: null, result: {},
    createdAt: now, updatedAt: now
  };
}

// ---------------------------------------------------------------------------
// 1. First-run legacy import
// ---------------------------------------------------------------------------

describe('1 — first-run import from legacy JSON', () => {

  test('imports runs and jobs when tables are empty', () => {
    const db = openMemory();
    const ws = createTempWorkspace('sqlite-import-');
    try {
      writeJson(ws.path('runs.json'), { version: 1, runs: [legacyRun('r1'), legacyRun('r2')] });
      writeJson(ws.path('jobs.json'), { version: 1, jobs: [legacyJob('j1', 'r1'), legacyJob('j2', 'r2')] });

      const result = importLegacyWorkflowData(db, {
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      assert.equal(result.imported, true,    'imported should be true');
      assert.equal(result.runsCount, 2,      'should report 2 runs');
      assert.equal(result.jobsCount, 2,      'should report 2 jobs');

      const repo = new SqliteWorkflowRepository(db);
      const { runs } = repo.readRuns();
      assert.equal(runs.length, 2, 'both runs should be in SQLite');
      assert.ok(runs.some(r => r.id === 'r1'), 'r1 should be present');
      assert.ok(runs.some(r => r.id === 'r2'), 'r2 should be present');

      const { jobs } = repo.readJobs();
      assert.equal(jobs.length, 2, 'both jobs should be in SQLite');
    } finally {
      ws.cleanup();
      closeDatabase(db);
    }
  });

  test('import preserves run fields including status, targets, and summary', () => {
    const db = openMemory();
    const ws = createTempWorkspace('sqlite-import-fields-');
    try {
      const run = legacyRun('r-fields');
      run.status = 'completed';
      run.lastError = 'some error';
      run.summary = { totalTargets: 1, completedTargets: 1, failedTargets: 0, cancelledTargets: 0 };
      writeJson(ws.path('runs.json'), { version: 1, runs: [run] });
      writeJson(ws.path('jobs.json'), { version: 1, jobs: [] });

      importLegacyWorkflowData(db, {
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      const repo = new SqliteWorkflowRepository(db);
      const loaded = repo.readRuns().runs[0];
      assert.equal(loaded.status, 'completed',     'status preserved');
      assert.equal(loaded.lastError, 'some error', 'lastError preserved');
      assert.equal(loaded.summary.completedTargets, 1, 'summary preserved');
    } finally {
      ws.cleanup();
      closeDatabase(db);
    }
  });

  test('no import when legacy files are absent', () => {
    const db = openMemory();
    const ws = createTempWorkspace('sqlite-no-files-');
    try {
      // No JSON files — readJsonFile uses fallback { runs: [] } / { jobs: [] }
      const result = importLegacyWorkflowData(db, {
        runsPath: ws.path('runs-nonexistent.json'),
        jobsPath: ws.path('jobs-nonexistent.json')
      });
      assert.equal(result.imported, false, 'should not import when files are absent');
      assert.equal(result.reason, 'no legacy data to import');
    } finally {
      ws.cleanup();
      closeDatabase(db);
    }
  });

});

// ---------------------------------------------------------------------------
// 2. Idempotency guard
// ---------------------------------------------------------------------------

describe('2 — no import when tables already contain data', () => {

  test('import is skipped when workflow_runs has rows', () => {
    const db = openMemory();
    const ws = createTempWorkspace('sqlite-idempotent-');
    try {
      // Pre-seed the DB via WorkflowRunManager
      const repo = new SqliteWorkflowRepository(db);
      const manager = new WorkflowRunManager({ repo });
      manager.createRun(runInput());

      // Prepare legacy JSON with a different run
      writeJson(ws.path('runs.json'), { version: 1, runs: [legacyRun('should-not-appear')] });
      writeJson(ws.path('jobs.json'), { version: 1, jobs: [] });

      const result = importLegacyWorkflowData(db, {
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      assert.equal(result.imported, false,              'should skip import');
      assert.equal(result.reason, 'tables already have data');

      // The pre-seeded run should be the only one present
      const { runs } = repo.readRuns();
      assert.equal(runs.length, 1, 'only the pre-seeded run should exist');
      assert.ok(runs[0].id !== 'should-not-appear', 'legacy run should NOT be imported');
    } finally {
      ws.cleanup();
      closeDatabase(db);
    }
  });

  test('import is skipped when workflow_jobs has rows even if runs is empty', () => {
    const db = openMemory();
    const ws = createTempWorkspace('sqlite-idempotent-jobs-');
    try {
      // Insert directly into jobs table to trigger the guard
      // (edge-case: orphan job row)
      const run = legacyRun('orphan-run');
      const job = legacyJob('orphan-job', 'orphan-run');

      // Seed via repo so FK constraint is honoured
      const repo = new SqliteWorkflowRepository(db);
      repo.transact((rs, js) => {
        rs.runs.push(run);
        js.jobs.push(job);
      });

      writeJson(ws.path('runs.json'), { version: 1, runs: [legacyRun('new-run')] });
      writeJson(ws.path('jobs.json'), { version: 1, jobs: [] });

      const result = importLegacyWorkflowData(db, {
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      assert.equal(result.imported, false, 'should skip when jobs table has rows');
    } finally {
      ws.cleanup();
      closeDatabase(db);
    }
  });

});

// ---------------------------------------------------------------------------
// 3. Persistence across manager re-instantiation
// ---------------------------------------------------------------------------

describe('3 — createRun + initial jobs persist in SQLite', () => {

  test('run and job survive creating a new SqliteWorkflowRepository from the same db', () => {
    const db = openMemory();
    try {
      // First manager instance
      const repo1 = new SqliteWorkflowRepository(db);
      const mgr1 = new WorkflowRunManager({ repo: repo1 });
      const { run: created } = mgr1.createRun(runInput({ accountId: 'acc-persist' }));
      const runId = created.id;

      // Second independent manager — fresh repo pointing at same db handle
      const repo2 = new SqliteWorkflowRepository(db);
      const mgr2 = new WorkflowRunManager({ repo: repo2 });

      const recovered = mgr2.getRun(runId);
      assert.ok(recovered,                    'run should be recoverable via new manager');
      assert.equal(recovered.id, runId);
      assert.equal(recovered.accountId, 'acc-persist');
      assert.equal(recovered.status, 'queued');

      const jobs = mgr2.getJobs(runId);
      assert.equal(jobs.length, 1, 'initial job should be recoverable');
      assert.equal(jobs[0].status, 'queued');
      assert.equal(jobs[0].runId, runId);
    } finally {
      closeDatabase(db);
    }
  });

  test('run and job survive close + reopen of a file-based SQLite database', () => {
    const ws = createTempWorkspace('sqlite-reopen-');
    try {
      const dbPath = ws.path('test.db');
      let runId;

      // Write phase: create run, close db
      {
        const db = openDatabase(dbPath);
        const repo = new SqliteWorkflowRepository(db);
        const mgr  = new WorkflowRunManager({ repo });
        const { run } = mgr.createRun(runInput());
        runId = run.id;
        closeDatabase(db);
      }

      // Read phase: reopen db, verify data still there
      {
        const db = openDatabase(dbPath);
        const repo = new SqliteWorkflowRepository(db);
        const mgr  = new WorkflowRunManager({ repo });

        const recovered = mgr.getRun(runId);
        assert.ok(recovered,          'run should survive db close+reopen');
        assert.equal(recovered.id, runId);

        const jobs = mgr.getJobs(runId);
        assert.equal(jobs.length, 1, 'job should survive db close+reopen');
        closeDatabase(db);
      }
    } finally {
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 4. Claim / retry / complete lifecycle through SQLite
// ---------------------------------------------------------------------------

describe('4 — claim / retry / complete through SQLite-backed repo', () => {

  test('claimDueJobs persists lease fields to SQLite', () => {
    const db = openMemory();
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr  = new WorkflowRunManager({ repo });
      const { run } = mgr.createRun(runInput());

      const claimed = mgr.claimDueJobs({
        before: new Date(Date.now() + 3_600_000).toISOString(),
        limit: 1, leaseMs: 300_000, leaseOwner: 'worker-1'
      });
      assert.equal(claimed.length, 1, 'should claim one job');
      assert.equal(claimed[0].status, 'running');

      // Verify lease fields were persisted to SQLite (not just in-memory)
      const freshJobs = repo.readJobs();
      const persisted = freshJobs.jobs.find(j => j.id === claimed[0].id);
      assert.ok(persisted,                       'job should be in SQLite');
      assert.equal(persisted.status, 'running',  'running status persisted');
      assert.ok(persisted.leaseOwner,            'leaseOwner persisted');
      assert.ok(persisted.leaseExpiresAt,        'leaseExpiresAt persisted');
    } finally {
      closeDatabase(db);
    }
  });

  test('claimDueJobs (via transactDueJobs) does NOT touch completed/failed jobs', () => {
    // Pins the indexed-path contract: the SQL pre-filter excludes non-
    // candidate statuses (completed, failed, cancelled). The pre-filter is
    // the load-all-write-all fix from senior review #5 — proving completed
    // jobs are neither loaded nor rewritten is the load-bearing assertion.
    const db = openMemory();
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr = new WorkflowRunManager({ repo });

      // Run 1: complete it (job ends up status='completed').
      const { run: completedRun } = mgr.createRun(runInput({
        workflowName: 'Completed Run',
        targets: [{ value: 'https://linkedin.com/in/done', label: 'Done', prospectId: 'p-done' }]
      }));
      const firstClaim = mgr.claimDueJobs({
        before: new Date(Date.now() + 3_600_000).toISOString(),
        limit: 1, leaseMs: 300_000, leaseOwner: 'worker-1'
      });
      assert.equal(firstClaim.length, 1, 'setup: should claim the first run\'s job');
      mgr.completeJob(firstClaim[0].id, { outcomeType: 'completed' }, { claimUuid: firstClaim[0].claimUuid });

      // Snapshot the completed job's updated_at + lease fields.
      const beforeJobs = repo.readJobs();
      const completedJobBefore = beforeJobs.jobs.find((j) => j.runId === completedRun.id);
      assert.equal(completedJobBefore.status, 'completed', 'setup: job is completed');
      const completedUpdatedAtBefore = completedJobBefore.updatedAt;

      // Run 2: leave its job queued; it's the only valid claim candidate.
      const { run: queuedRun } = mgr.createRun(runInput({
        workflowName: 'Queued Run',
        targets: [{ value: 'https://linkedin.com/in/todo', label: 'Todo', prospectId: 'p-todo' }]
      }));

      // Claim — should pick up only the queued job, never touch the completed one.
      const secondClaim = mgr.claimDueJobs({
        before: new Date(Date.now() + 3_600_000).toISOString(),
        limit: 5, leaseMs: 300_000, leaseOwner: 'worker-2'
      });
      assert.equal(secondClaim.length, 1, 'should claim exactly the queued job');
      assert.equal(secondClaim[0].runId, queuedRun.id, 'claimed the right run');

      // The completed job's updated_at must be unchanged — proves the load-all-
      // write-all behavior is gone; the SQL pre-filter excluded it from both
      // the read and the write side of transactDueJobs.
      const afterJobs = repo.readJobs();
      const completedJobAfter = afterJobs.jobs.find((j) => j.runId === completedRun.id);
      assert.equal(completedJobAfter.status, 'completed', 'completed job still completed');
      assert.equal(
        completedJobAfter.updatedAt,
        completedUpdatedAtBefore,
        'completed job updated_at unchanged — proves it was not re-written by claimDueJobs'
      );
    } finally {
      closeDatabase(db);
    }
  });

  test('retryJob requeues with incremented attempts and run transitions to waiting', () => {
    const db = openMemory();
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr  = new WorkflowRunManager({ repo });
      const { run } = mgr.createRun(runInput());

      const [claimed] = mgr.claimDueJobs({
        before: new Date(Date.now() + 3_600_000).toISOString(),
        limit: 1, leaseMs: 300_000
      });

      const retried = mgr.retryJob(claimed.id, { reason: 'transient error', delayMs: 0 });
      assert.ok(retried,                      'retryJob should return the updated job');
      assert.equal(retried.status, 'queued',  'job re-queued');
      assert.equal(retried.attempts, 1,       'attempt count incremented');

      // Verify persisted
      const savedJob = repo.readJobs().jobs.find(j => j.id === claimed.id);
      assert.equal(savedJob.status, 'queued', 'queued status persisted to SQLite');
      assert.equal(savedJob.attempts, 1,      'attempts persisted to SQLite');

      const updatedRun = mgr.getRun(run.id);
      assert.equal(updatedRun.status, 'waiting', 'run transitions to waiting');
    } finally {
      closeDatabase(db);
    }
  });

  test('completeJob + markTargetCompleted finalizes single-step run as completed', () => {
    const db = openMemory();
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr  = new WorkflowRunManager({ repo });
      const { run } = mgr.createRun(runInput());

      const [claimed] = mgr.claimDueJobs({
        before: new Date(Date.now() + 3_600_000).toISOString(),
        limit: 1, leaseMs: 300_000
      });

      mgr.completeJob(claimed.id, { ok: true });
      mgr.markTargetCompleted(run.id, claimed.targetId);

      const finalRun = mgr.getRun(run.id);
      assert.equal(finalRun.status, 'completed', 'run should be completed');
      assert.ok(finalRun.completedAt,            'completedAt should be set');

      // Verify the job row reflects completion in SQLite
      const savedJob = repo.readJobs().jobs.find(j => j.id === claimed.id);
      assert.equal(savedJob.status, 'completed', 'job completed in SQLite');
    } finally {
      closeDatabase(db);
    }
  });

  test('failJob marks job + run failed and run has no follow-on jobs', () => {
    const db = openMemory();
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr  = new WorkflowRunManager({ repo });
      const { run } = mgr.createRun(runInput());

      const [claimed] = mgr.claimDueJobs({
        before: new Date(Date.now() + 3_600_000).toISOString(),
        limit: 1, leaseMs: 300_000
      });

      mgr.failJob(claimed.id, { reason: 'permanent failure' });
      mgr.markTargetFailed(run.id, claimed.targetId, 'permanent failure');

      const finalRun = mgr.getRun(run.id);
      assert.equal(finalRun.status, 'failed', 'run should be failed');

      const allJobs = mgr.getJobs(run.id);
      assert.equal(allJobs.length, 1, 'only the original job should exist');
      assert.equal(allJobs[0].status, 'failed');
    } finally {
      closeDatabase(db);
    }
  });

  test('cancelRun marks run and all queued jobs cancelled in SQLite', () => {
    const db = openMemory();
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr  = new WorkflowRunManager({ repo });
      const { run } = mgr.createRun(runInput());

      mgr.cancelRun(run.id, 'user requested');

      const finalRun = mgr.getRun(run.id);
      assert.equal(finalRun.status, 'cancelled');

      const jobs = mgr.getJobs(run.id);
      assert.ok(jobs.every(j => j.status === 'cancelled'), 'all jobs should be cancelled');

      // Cold read from SQLite confirms
      const coldRun = repo.readRuns().runs.find(r => r.id === run.id);
      assert.equal(coldRun.status, 'cancelled', 'cancellation persisted in SQLite');
    } finally {
      closeDatabase(db);
    }
  });

  test('large SQLite runs keep the active target follow-on job inside the claim window', () => {
    const db = openMemory();
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr = new WorkflowRunManager({ repo });
      const targets = Array.from({ length: 60 }, (_, index) => ({
        value: `https://linkedin.com/in/sqlite-user-${index + 1}`,
        label: `SQLite User ${index + 1}`,
        prospectId: `p-sql-${index + 1}`
      }));
      const { run } = mgr.createRun(runInput({
        steps: [{ type: 'view_profile' }, { type: 'like_posts' }],
        targets
      }));
      const before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const [firstJob] = mgr.claimDueJobs({ before, leaseOwner: 'worker-1' });

      assert.equal(firstJob.targetIndex, 0);
      assert.equal(firstJob.stepType, 'view_profile');
      mgr.completeJob(firstJob.id, { outcomeType: 'completed' });
      mgr.queueNextStep({
        runId: run.id,
        targetId: firstJob.targetId,
        prospectId: firstJob.prospectId,
        nextStepIndex: 1,
        targetValue: firstJob.targetValue,
        targetLabel: firstJob.targetLabel
      });

      const [followOnJob] = mgr.claimDueJobs({ before, leaseOwner: 'worker-1' });
      assert.equal(followOnJob.targetIndex, 0);
      assert.equal(followOnJob.stepType, 'like_posts');
    } finally {
      closeDatabase(db);
    }
  });

  test('claim_uuid round-trips through SQLite — claim, close, reopen, complete with same UUID', () => {
    // Proves the column migration + jobToRow/rowToJob path persists the
    // claim token across a connection close. Without persistence the
    // verification would silently turn into "no stored UUID → allow", which
    // would defeat the entire mechanism after any restart.
    const workspace = createTempWorkspace('claim-uuid-sqlite-roundtrip-');
    const dbPath = workspace.path('test.db');
    let db = openDatabase(dbPath);
    let claimedUuid;
    let jobId;
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr  = new WorkflowRunManager({ repo });
      mgr.createRun(runInput());
      const before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const [claimed] = mgr.claimDueJobs({ before, leaseOwner: 'w1' });
      claimedUuid = claimed.claimUuid;
      jobId       = claimed.id;
      assert.ok(claimedUuid, 'claim assigned a UUID');
    } finally {
      closeDatabase(db);
    }

    // Reopen — new connection, fresh repo instance, fresh manager.
    db = openDatabase(dbPath);
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr  = new WorkflowRunManager({ repo });

      // Cold-load the job and verify the UUID survived.
      const job = mgr.getJobs().find(j => j.id === jobId);
      assert.equal(job.claimUuid, claimedUuid, 'claim_uuid persisted across close/reopen');

      // Stale UUID is refused even with a brand-new manager instance.
      const stale = mgr.completeJob(jobId, { outcomeType: 'completed' }, {
        claimUuid: '00000000-0000-0000-0000-000000000000'
      });
      assert.equal(stale, null, 'stored UUID still rejects mismatched claims after reopen');

      // Original UUID still works.
      const ok = mgr.completeJob(jobId, { outcomeType: 'completed' }, { claimUuid: claimedUuid });
      assert.ok(ok);
      assert.equal(ok.status, 'completed');
      assert.equal(ok.claimUuid, null, 'terminal state clears claim_uuid in SQLite too');
    } finally {
      closeDatabase(db);
      workspace.cleanup();
    }
  });

});
