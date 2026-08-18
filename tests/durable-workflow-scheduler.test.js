'use strict';

/**
 * Integration smoke tests for the durable workflow scheduler.
 *
 * These tests use a real WorkflowRunManager backed by a temp-workspace on disk,
 * a fake accountWorkerProcessManager whose dispatchAndAwaitResult is configurable
 * per scenario, and stubs for every Electron / Apollo side-effect.
 *
 * The four required scenarios:
 *   1. Success — job executed, completed, run finalized as 'completed'
 *   2. Worker error / timeout — null step result, job retried
 *   3. Transient failure — failed_transient, job retried
 *   4. Terminal failure — failed_permanent, job failed, run finalized as 'failed'
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createDurableWorkflowScheduler } = require('../automation/runtime/durable-workflow-scheduler');
const WorkflowRunManager = require('../workflow-run-manager');
const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal run input — a single target, a single view_profile step.
 * No delays, so the job is due immediately upon creation.
 */
function makeRunInput(overrides = {}) {
  return {
    workflowName: 'Smoke Test Workflow',
    accountId:    'acc-smoke',
    accountName:  'Smoke Account',
    targets: [{
      value:      'https://linkedin.com/in/smoketest',
      label:      'Smoke User',
      prospectId: 'p-smoke-1'
    }],
    steps: [{ type: 'view_profile' }],
    ...overrides
  };
}

/**
 * Build a minimal scheduler deps object.
 * `dispatchFn` controls what accountWorkerProcessManager.dispatchAndAwaitResult returns.
 * `onRunStatusChange` is optionally overridden to capture status transitions.
 */
function makeSchedulerDeps(workflowRunManager, dispatchFn, extras = {}) {
  const worker = new EventEmitter();

  return {
    workflowRunManager,

    accountWorkerProcessManager: {
      getOrCreate: () => worker,
      dispatchAndAwaitResult: dispatchFn
    },

    linkedInAccountHealthStore: {
      getCoolingDownAccountIds: () => [],
      getChallengedAccountIds:  () => []
    },

    prospectQueueStore: {
      getProspect:     () => null,
      applyLeadScores: () => []
    },

    sdrAgentManager: {
      getAgent: () => null
    },

    campaignController: {
      notifyChildRunFinalized:    () => {},
      executeApolloEnrollmentStep: async () => ({ stepResult: null })
    },

    isWithinWorkingHours:  () => true,
    scoreProspect:         () => ({ score: 50, scoreBreakdown: {} }),
    loadLinkedInCredentials: async () => ({
      id:       'acc-smoke',
      email:    'smoke@example.com',
      password: 'pw-smoke'
    }),
    ensureLinkedInAccountsStore: () => ({ accounts: [] }),

    recordActivityEvent:          () => {},
    updateProspectWorkflowProgress: () => null,
    emitWorkflowLog:              () => {},

    onRunStatusChange: extras.onRunStatusChange || (() => {}),

    broadcastWorkflowRunsUpdated:  () => {},
    broadcastCampaignRunsUpdated:  () => {},
    broadcastProspectsUpdated:     () => {},

    retryApolloHeldRuns:       async () => {},
    processApolloCampaignPolls: async () => {},

    registerRuntimeJob:   () => {},
    unregisterRuntimeJob: () => {},
    createRuntimeJobId:   (type, accountId) => `${type}-${accountId}-${Date.now()}`,

    recordWorkflowHealthSuccess: () => {},
    recordWorkflowHealthFailure: () => {},

    isAppReady: () => true
  };
}

/**
 * Claim the first due job from the manager (test helper — not through the scheduler).
 */
function claimFirstJob(manager) {
  const claimed = manager.claimDueJobs({
    before:   new Date().toISOString(),
    limit:    1,
    leaseMs:  300_000
  });
  return claimed[0] || null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('durable workflow scheduler — smoke tests', () => {

  // ─── Scenario 1: success path ───────────────────────────────────────────

  test('1 — success: job is completed and run finalizes as completed', async () => {
    const ws = createTempWorkspace('sched-test-success-');

    try {
      const manager = new WorkflowRunManager({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      // Capture run-status transitions
      const statusChanges = [];
      const dispatchFn = async () => ({
        stepResult: {
          outcomeType: 'completed',
          success:     true,
          stepType:    'view_profile',
          profileUrl:  'https://linkedin.com/in/smoketest',
          recipientName: 'Smoke User'
        }
      });

      const scheduler = createDurableWorkflowScheduler(
        makeSchedulerDeps(manager, dispatchFn, {
          onRunStatusChange: (status, runId) => statusChanges.push({ status, runId })
        })
      );

      const { run } = manager.createRun(makeRunInput());
      const job = claimFirstJob(manager);
      assert.ok(job, 'a job should be claimable immediately');
      assert.equal(job.runId, run.id);
      assert.equal(job.stepType, 'view_profile');

      await scheduler.executeDurableWorkflowJob(job);

      const finalJob = manager.getJobs(run.id)[0];
      assert.equal(finalJob.status, 'completed', 'job should be completed');

      const finalRun = manager.getRun(run.id);
      assert.equal(finalRun.status, 'completed', 'run should be completed');

      assert.equal(statusChanges.length, 1);
      assert.equal(statusChanges[0].status, 'completed');
      assert.equal(statusChanges[0].runId,  run.id);
    } finally {
      ws.cleanup();
    }
  });

  // ─── Scenario 2: worker error / timeout ────────────────────────────────

  test('2 — worker error: null step result is treated as retryable failure', async () => {
    const ws = createTempWorkspace('sched-test-worker-err-');

    try {
      const manager = new WorkflowRunManager({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      const dispatchFn = async () => {
        throw new Error('worker timed out');
      };

      const scheduler = createDurableWorkflowScheduler(
        makeSchedulerDeps(manager, dispatchFn)
      );

      const { run } = manager.createRun(makeRunInput());
      const job = claimFirstJob(manager);
      assert.ok(job, 'a job should be claimable immediately');

      await scheduler.executeDurableWorkflowJob(job);

      // Job should be back in 'queued' (retried with a 30-second delay)
      const finalJob = manager.getJobs(run.id)[0];
      assert.equal(finalJob.status, 'queued', 'job should be requeued after worker error');

      // Run should be 'waiting' (queued job exists but not yet runnable)
      const finalRun = manager.getRun(run.id);
      assert.equal(finalRun.status, 'waiting', 'run should be waiting for retry');

      // The retried job must be scheduled in the future (30 s window)
      const scheduledMs = new Date(finalJob.scheduledFor).getTime();
      assert.ok(scheduledMs > Date.now(), 'retried job should be scheduled in the future');
    } finally {
      ws.cleanup();
    }
  });

  // ─── Scenario 3: transient failure ─────────────────────────────────────

  test('3 — transient failure: failed_transient schedules a retry', async () => {
    const ws = createTempWorkspace('sched-test-transient-');

    try {
      const manager = new WorkflowRunManager({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      const dispatchFn = async () => ({
        stepResult: {
          outcomeType:  'failed_transient',
          success:      false,
          stepType:     'view_profile',
          reason:       'rate limit hit'
        }
      });

      const scheduler = createDurableWorkflowScheduler(
        makeSchedulerDeps(manager, dispatchFn)
      );

      const { run } = manager.createRun(makeRunInput());
      const job = claimFirstJob(manager);
      assert.ok(job, 'a job should be claimable immediately');

      await scheduler.executeDurableWorkflowJob(job);

      const finalJob = manager.getJobs(run.id)[0];
      assert.equal(finalJob.status, 'queued', 'job should be requeued after transient failure');

      const finalRun = manager.getRun(run.id);
      assert.equal(finalRun.status, 'waiting', 'run should be waiting for retry');

      // Sanity: same target, same step index
      assert.equal(finalJob.stepIndex, 0, 'retry should be at same step index');
    } finally {
      ws.cleanup();
    }
  });

  // ─── Scenario 4: terminal (permanent) failure ───────────────────────────

  test('4 — terminal failure: failed_permanent fails the job without retrying', async () => {
    const ws = createTempWorkspace('sched-test-permanent-');

    try {
      const manager = new WorkflowRunManager({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      const statusChanges = [];
      const dispatchFn = async () => ({
        stepResult: {
          outcomeType: 'failed_permanent',
          success:     false,
          stepType:    'view_profile',
          reason:      'profile not accessible'
        }
      });

      const scheduler = createDurableWorkflowScheduler(
        makeSchedulerDeps(manager, dispatchFn, {
          onRunStatusChange: (status, runId) => statusChanges.push({ status, runId })
        })
      );

      const { run } = manager.createRun(makeRunInput());
      const job = claimFirstJob(manager);
      assert.ok(job, 'a job should be claimable immediately');

      await scheduler.executeDurableWorkflowJob(job);

      const finalJob = manager.getJobs(run.id)[0];
      assert.equal(finalJob.status, 'failed', 'job should be failed');

      const finalRun = manager.getRun(run.id);
      assert.equal(finalRun.status, 'failed', 'run should be failed');

      assert.equal(statusChanges.length, 1);
      assert.equal(statusChanges[0].status, 'failed');
      assert.equal(statusChanges[0].runId,  run.id);

      // No retry: there should be only one job record (the failed one, not a new queued one)
      const allJobs = manager.getJobs(run.id);
      assert.equal(allJobs.length, 1, 'no additional job should be created for a permanent failure');
    } finally {
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// Pacing: single-job claims + tail-recursive drain
//
// startDueDurableWorkflowJobs claims one job per tick (limit:1) and, after a
// productive tick, re-triggers itself via setImmediate until the due queue
// drains. These tests pin: (1) all due jobs drain across ticks, (2) the loop
// halts when nothing is due, (3) the schedulerBusy guard blocks concurrent
// entry so a setInterval tick can't overlap a tail-recursion tick.
// ---------------------------------------------------------------------------

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // Each setTimeout turn lets the setImmediate tail-recursion chain advance.
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe('durable workflow scheduler — pacing (limit:1 + tail-recursion)', () => {

  test('drains all due jobs across tail-recursion ticks', async () => {
    const ws = createTempWorkspace('sched-pacing-drain-');
    try {
      const manager = new WorkflowRunManager({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      let dispatchCount = 0;
      const dispatchFn = async () => {
        dispatchCount += 1;
        return {
          stepResult: {
            outcomeType: 'completed',
            success:     true,
            stepType:    'view_profile',
            profileUrl:  'https://linkedin.com/in/smoketest',
            recipientName: 'Smoke User'
          }
        };
      };

      const scheduler = createDurableWorkflowScheduler(makeSchedulerDeps(manager, dispatchFn));

      // Two runs on two distinct accounts, both due immediately. limit:1
      // claims one per tick; the tail-recursion must pick up the second.
      const { run: run1 } = manager.createRun(makeRunInput({ accountId: 'acc-1', accountName: 'Acct 1' }));
      const { run: run2 } = manager.createRun(makeRunInput({
        accountId: 'acc-2',
        accountName: 'Acct 2',
        targets: [{ value: 'https://linkedin.com/in/two', label: 'Two', prospectId: 'p-two' }]
      }));

      await scheduler.startDueDurableWorkflowJobs();
      // Let the setImmediate chain drain.
      await waitFor(() => dispatchCount >= 2);

      assert.equal(dispatchCount, 2, 'both due jobs executed across tail-recursion ticks');
      assert.equal(manager.getRun(run1.id).status, 'completed');
      assert.equal(manager.getRun(run2.id).status, 'completed');
    } finally {
      ws.cleanup();
    }
  });

  test('halts when no due jobs remain (no runaway loop)', async () => {
    const ws = createTempWorkspace('sched-pacing-halt-');
    try {
      const manager = new WorkflowRunManager({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      let dispatchCount = 0;
      const dispatchFn = async () => {
        dispatchCount += 1;
        return {
          stepResult: { outcomeType: 'completed', success: true, stepType: 'view_profile' }
        };
      };

      const scheduler = createDurableWorkflowScheduler(makeSchedulerDeps(manager, dispatchFn));

      // Single one-step run. After it completes there is nothing due — the
      // tail-recursion must stop, not spin.
      manager.createRun(makeRunInput({ accountId: 'acc-solo', accountName: 'Solo' }));

      await scheduler.startDueDurableWorkflowJobs();
      await waitFor(() => dispatchCount >= 1);
      assert.equal(dispatchCount, 1, 'the single due job ran once');

      // Give the loop ample time to misbehave; the count must stay put.
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(dispatchCount, 1, 'tail-recursion halted once the queue drained');
    } finally {
      ws.cleanup();
    }
  });

  test('schedulerBusy guard blocks concurrent entry', async () => {
    const ws = createTempWorkspace('sched-pacing-busy-');
    try {
      const manager = new WorkflowRunManager({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      // A manually-gated dispatch keeps tick 1 in-flight so we can attempt a
      // concurrent entry deterministically (no timing races).
      let dispatchCount = 0;
      let releaseGate;
      const gate = new Promise((resolve) => { releaseGate = resolve; });
      const dispatchFn = async () => {
        dispatchCount += 1;
        await gate;
        return {
          stepResult: { outcomeType: 'completed', success: true, stepType: 'view_profile' }
        };
      };

      let retryApolloCalls = 0;
      const deps = makeSchedulerDeps(manager, dispatchFn);
      deps.retryApolloHeldRuns = async () => { retryApolloCalls += 1; };

      const scheduler = createDurableWorkflowScheduler(deps);
      manager.createRun(makeRunInput({ accountId: 'acc-busy', accountName: 'Busy' }));

      // Kick off tick 1 without awaiting — it claims the job, calls dispatchFn,
      // and blocks on the gate. schedulerBusy is now true.
      const tick1 = scheduler.startDueDurableWorkflowJobs();
      // Let tick 1 reach the gated dispatch.
      await waitFor(() => dispatchCount >= 1);
      assert.equal(retryApolloCalls, 1, 'tick 1 entered the body');

      // Concurrent entry while tick 1 is in-flight must no-op via schedulerBusy.
      await scheduler.startDueDurableWorkflowJobs();
      assert.equal(retryApolloCalls, 1, 'concurrent entry was blocked by schedulerBusy');
      assert.equal(dispatchCount, 1, 'no second dispatch from the blocked entry');

      // Release the gate and let tick 1 finish cleanly.
      releaseGate();
      await tick1;
      await waitFor(() => manager.getRun(manager.getAllRuns()[0].id).status === 'completed');
    } finally {
      ws.cleanup();
    }
  });

});
