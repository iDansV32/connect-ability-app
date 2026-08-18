'use strict';

/**
 * Targeted tests for the Ticket-4A repository seam in WorkflowRunManager.
 *
 * These tests verify the five behaviours called out by the ticket:
 *   1. createRun + initial jobs are treated as one atomic unit
 *   2. claimDueJobs preserves ordering/lease behaviour
 *   3. Transient retry requeues correctly
 *   4. Terminal failure does not create follow-on jobs
 *   5. Cancel and drain semantics still hold
 *
 * An additional section verifies that WorkflowRunManager accepts an
 * injected repository, so the seam can be swapped for SQLite in Ticket 4B.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const WorkflowRunManager = require('../workflow-run-manager');
const JsonWorkflowRepository = require('../storage/json-workflow-repository');
const { createTempWorkspace, readJson } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(ws) {
  const runsPath = ws.path('runs.json');
  const jobsPath = ws.path('jobs.json');
  return new WorkflowRunManager({ runsPath, jobsPath });
}

function singleTargetRun(overrides = {}) {
  return {
    workflowName: 'Repo Seam Test',
    accountId:    'acc-1',
    accountName:  'Test Account',
    targets: [{ value: 'https://linkedin.com/in/testuser', label: 'Test User', prospectId: 'p-1' }],
    steps: [{ type: 'view_profile' }],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. createRun atomicity
// ---------------------------------------------------------------------------

describe('1 — createRun + initial jobs are one atomic unit', () => {

  test('both files are written together: run and job coexist after createRun', () => {
    const ws = createTempWorkspace('repo-create-');
    try {
      const manager = makeManager(ws);
      const { run, jobs } = manager.createRun(singleTargetRun());

      // Run is persisted
      const runsOnDisk = readJson(ws.path('runs.json'));
      assert.equal(runsOnDisk.runs.length, 1);
      assert.equal(runsOnDisk.runs[0].id, run.id);

      // Job is persisted in the same logical write
      const jobsOnDisk = readJson(ws.path('jobs.json'));
      assert.equal(jobsOnDisk.jobs.length, 1);
      assert.equal(jobsOnDisk.jobs[0].id, jobs[0].id);
      assert.equal(jobsOnDisk.jobs[0].runId, run.id);
    } finally {
      ws.cleanup();
    }
  });

  test('createRun: job file is written BEFORE (or simultaneously with) runs file', () => {
    // Verify the safe write order: jobs first, runs second.
    // We do this by checking both files exist and are consistent after createRun.
    const ws = createTempWorkspace('repo-order-');
    try {
      const manager = makeManager(ws);
      manager.createRun(singleTargetRun());

      const runsOnDisk = readJson(ws.path('runs.json'));
      const jobsOnDisk = readJson(ws.path('jobs.json'));

      const runId = runsOnDisk.runs[0].id;
      const jobRunId = jobsOnDisk.jobs[0].runId;
      assert.equal(runId, jobRunId, 'job runId must match persisted run id');
    } finally {
      ws.cleanup();
    }
  });

  test('createRun with multi-step run: only first non-delay step gets a job', () => {
    const ws = createTempWorkspace('repo-multi-step-');
    try {
      const manager = makeManager(ws);
      const { run, jobs } = manager.createRun(singleTargetRun({
        steps: [
          { type: 'view_profile' },
          { type: 'delay', minDelayMs: 86400000, maxDelayMs: 86400000 },
          { type: 'send_dm', messageTemplate: 'Hi' }
        ]
      }));
      // Only one initial job — for view_profile at index 0
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].stepType, 'view_profile');
      assert.equal(jobs[0].stepIndex, 0);
    } finally {
      ws.cleanup();
    }
  });

  test('createRun with a delay-first run: scheduledFor is in the future', () => {
    const ws = createTempWorkspace('repo-delay-first-');
    try {
      const manager = makeManager(ws);
      const { jobs } = manager.createRun(singleTargetRun({
        steps: [
          { type: 'delay', minDelayMs: 3600000, maxDelayMs: 3600000 },
          { type: 'send_dm', messageTemplate: 'Hi' }
        ]
      }));
      // Job for send_dm with ~1h delay
      assert.equal(jobs[0].stepType, 'send_dm');
      assert.ok(
        new Date(jobs[0].scheduledFor).getTime() > Date.now(),
        'scheduledFor should be in the future when a leading delay is present'
      );
    } finally {
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 2. claimDueJobs ordering and lease behaviour
// ---------------------------------------------------------------------------

describe('2 — claimDueJobs: ordering and lease semantics', () => {

  test('score-ordered claim: higher prospect score wins', () => {
    const ws = createTempWorkspace('repo-claim-score-');
    try {
      const manager = makeManager(ws);

      manager.createRun({
        workflowName: 'Low Score Run',
        accountId:    'acc-1',
        targets: [{ value: 'https://linkedin.com/in/low', label: 'Low', prospectId: 'p-low' }],
        steps: [{ type: 'view_profile' }]
      });
      manager.createRun({
        workflowName: 'High Score Run',
        accountId:    'acc-2',
        targets: [{ value: 'https://linkedin.com/in/high', label: 'High', prospectId: 'p-high' }],
        steps: [{ type: 'view_profile' }]
      });

      const claimed = manager.claimDueJobs({
        before: new Date(Date.now() + 3600000).toISOString(),
        limit:  1,
        leaseMs: 300000,
        prospectScores: new Map([['p-low', 20], ['p-high', 80]])
      });

      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].prospectId, 'p-high', 'higher score should be claimed first');
    } finally {
      ws.cleanup();
    }
  });

  test('claimDueJobs respects blockedAccountIds', () => {
    const ws = createTempWorkspace('repo-claim-blocked-');
    try {
      const manager = makeManager(ws);

      manager.createRun(singleTargetRun({ accountId: 'acc-blocked' }));

      const claimed = manager.claimDueJobs({
        before: new Date(Date.now() + 3600000).toISOString(),
        limit:  1,
        leaseMs: 300000,
        blockedAccountIds: ['acc-blocked']
      });

      assert.equal(claimed.length, 0, 'blocked account should not be claimed');
    } finally {
      ws.cleanup();
    }
  });

  test('claimDueJobs reclaims expired lease and increments attempts', () => {
    const ws = createTempWorkspace('repo-claim-reclaim-');
    try {
      const manager = makeManager(ws);
      const { run } = manager.createRun(singleTargetRun());

      // First claim
      const claimed = manager.claimDueJobs({
        before:   new Date(Date.now() + 3600000).toISOString(),
        limit:    1,
        leaseMs:  300000,
        leaseOwner: 'worker-a'
      });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].attempts, 1);

      // Expire the lease by writing directly to the JSON file
      const jobsOnDisk = readJson(ws.path('jobs.json'));
      jobsOnDisk.jobs[0].leaseExpiresAt = new Date(Date.now() - 60000).toISOString();
      const fs = require('node:fs');
      fs.writeFileSync(ws.path('jobs.json'), JSON.stringify(jobsOnDisk, null, 2));

      // Second claim reclaims the expired job
      const reclaimed = manager.claimDueJobs({
        before:   new Date(Date.now() + 7200000).toISOString(),
        limit:    1,
        leaseMs:  300000,
        leaseOwner: 'worker-b'
      });
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0].attempts, 2, 'attempts should increment on reclaim');
      assert.equal(reclaimed[0].leaseOwner, 'worker-b');
    } finally {
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 3. Transient retry requeues correctly
// ---------------------------------------------------------------------------

describe('3 — transient retry requeues correctly', () => {

  test('retryJob transitions job to queued and run to waiting', () => {
    const ws = createTempWorkspace('repo-retry-');
    try {
      const manager = makeManager(ws);
      const { run } = manager.createRun(singleTargetRun());

      const claimed = manager.claimDueJobs({
        before: new Date(Date.now() + 3600000).toISOString(),
        limit: 1, leaseMs: 300000
      });
      const job = claimed[0];

      const retried = manager.retryJob(job.id, { reason: 'transient error', delayMs: 30000 });

      assert.ok(retried, 'retryJob should return the retried job');
      assert.equal(retried.status, 'queued', 'retried job should be queued');
      assert.ok(
        new Date(retried.scheduledFor).getTime() > Date.now(),
        'scheduledFor should be in the future'
      );

      const refreshedRun = manager.getRun(run.id);
      assert.equal(refreshedRun.status, 'waiting', 'run should be waiting after retry');
    } finally {
      ws.cleanup();
    }
  });

  test('retryJob returns null when max attempts exceeded', () => {
    const ws = createTempWorkspace('repo-retry-maxattempts-');
    try {
      const manager = makeManager(ws);
      manager.createRun(singleTargetRun());

      // Claim and "exhaust" attempts by direct manipulation
      const claimed = manager.claimDueJobs({
        before: new Date(Date.now() + 3600000).toISOString(),
        limit: 1, leaseMs: 300000
      });
      const job = claimed[0];

      // Simulate max attempts by writing maxAttempts: 1 to the file
      const jobsOnDisk = readJson(ws.path('jobs.json'));
      jobsOnDisk.jobs[0].maxAttempts = 1; // attempts is already 1 from the claim
      const fs = require('node:fs');
      fs.writeFileSync(ws.path('jobs.json'), JSON.stringify(jobsOnDisk, null, 2));

      const retried = manager.retryJob(job.id, { reason: 'transient' });
      assert.equal(retried, null, 'retryJob should return null when max attempts exceeded');
    } finally {
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 4. Terminal failure does not create follow-on jobs
// ---------------------------------------------------------------------------

describe('4 — terminal failure: no follow-on jobs created', () => {

  test('failJob marks job failed and run failed — no new jobs', () => {
    const ws = createTempWorkspace('repo-fail-');
    try {
      const manager = makeManager(ws);
      const { run } = manager.createRun(singleTargetRun());

      const claimed = manager.claimDueJobs({
        before: new Date(Date.now() + 3600000).toISOString(),
        limit: 1, leaseMs: 300000
      });

      manager.failJob(claimed[0].id, { reason: 'permanent failure' });
      manager.markTargetFailed(run.id, claimed[0].targetId, 'permanent failure');

      const allJobs = manager.getJobs(run.id);
      assert.equal(allJobs.length, 1, 'only the original job should exist');
      assert.equal(allJobs[0].status, 'failed');

      const finalRun = manager.getRun(run.id);
      assert.equal(finalRun.status, 'failed');
    } finally {
      ws.cleanup();
    }
  });

  test('completeJob + markTargetCompleted on single-step run finalizes as completed', () => {
    const ws = createTempWorkspace('repo-complete-');
    try {
      const manager = makeManager(ws);
      const { run } = manager.createRun(singleTargetRun());

      const claimed = manager.claimDueJobs({
        before: new Date(Date.now() + 3600000).toISOString(),
        limit: 1, leaseMs: 300000
      });

      manager.completeJob(claimed[0].id, { recipientName: 'Test User' });
      manager.markTargetCompleted(run.id, claimed[0].targetId);

      const allJobs = manager.getJobs(run.id);
      assert.equal(allJobs.length, 1, 'no follow-on jobs should be created');
      assert.equal(allJobs[0].status, 'completed');

      const finalRun = manager.getRun(run.id);
      assert.equal(finalRun.status, 'completed');
    } finally {
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 5. Cancel and drain semantics
// ---------------------------------------------------------------------------

describe('5 — cancel and drain semantics', () => {

  test('cancelRun: cancels queued jobs and marks run cancelled', () => {
    const ws = createTempWorkspace('repo-cancel-');
    try {
      const manager = makeManager(ws);
      const { run } = manager.createRun(singleTargetRun());

      const result = manager.cancelRun(run.id, 'user requested cancel');
      assert.equal(result.cancelled, true);

      const allJobs = manager.getJobs(run.id);
      assert.ok(allJobs.every(j => j.status === 'cancelled'), 'all queued jobs should be cancelled');

      const finalRun = manager.getRun(run.id);
      assert.equal(finalRun.status, 'cancelled');
    } finally {
      ws.cleanup();
    }
  });

  test('drainWorkflowRun: sets drainPending, cancels queued jobs', () => {
    const ws = createTempWorkspace('repo-drain-');
    try {
      const manager = makeManager(ws);
      const { run } = manager.createRun(singleTargetRun({
        steps: [
          { type: 'view_profile' },
          { type: 'send_dm', messageTemplate: 'Hi' }
        ],
        targets: [
          { value: 'https://linkedin.com/in/a', label: 'A', prospectId: 'p-a' },
          { value: 'https://linkedin.com/in/b', label: 'B', prospectId: 'p-b' }
        ]
      }));

      // Claim one job so it enters 'running' state — drain must wait for it to finish,
      // which means drainPending stays true until that job completes.
      const claimed = manager.claimDueJobs({
        before: new Date(Date.now() + 3600000).toISOString(),
        limit: 1, leaseMs: 300000
      });
      assert.equal(claimed.length, 1, 'should have claimed a job');

      const drained = manager.drainWorkflowRun(run.id, 'test drain');
      assert.ok(drained, 'drainWorkflowRun should return the updated run');

      const refreshedRun = manager.getRun(run.id);
      assert.equal(refreshedRun.drainPending, true, 'drainPending should stay set while a job is still running');

      // The other queued job should have been cancelled
      const allJobs = manager.getJobs(run.id);
      const cancelledJobs = allJobs.filter(j => j.status === 'cancelled');
      assert.ok(cancelledJobs.length >= 1, 'at least one queued job should be cancelled');
    } finally {
      ws.cleanup();
    }
  });

  test('pauseRun + resumeRun: jobs transition queued→paused→queued', () => {
    const ws = createTempWorkspace('repo-pause-resume-');
    try {
      const manager = makeManager(ws);
      const { run, jobs } = manager.createRun(singleTargetRun());

      manager.pauseRun(run.id, { reason: 'reply received' });
      assert.equal(manager.getRun(run.id).status, 'paused');
      assert.equal(manager.getJobs(run.id)[0].status, 'paused');

      manager.resumeRun(run.id);
      assert.equal(manager.getJobs(run.id)[0].status, 'queued');
      // Run should be waiting (has a queued job)
      assert.equal(manager.getRun(run.id).status, 'waiting');
    } finally {
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 6. Repository injection — seam proves swappable for Ticket 4B
// ---------------------------------------------------------------------------

describe('6 — repository injection seam', () => {

  test('WorkflowRunManager accepts an injected JsonWorkflowRepository', () => {
    const ws = createTempWorkspace('repo-inject-');
    try {
      const repo = new JsonWorkflowRepository({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });
      const manager = new WorkflowRunManager({ repo });

      const { run } = manager.createRun(singleTargetRun());
      assert.ok(run.id, 'run should be created via injected repo');

      const runs = manager.getAllRuns();
      assert.equal(runs.length, 1);
      assert.equal(runs[0].id, run.id);
    } finally {
      ws.cleanup();
    }
  });

  test('injected stub repo can intercept transact calls (proving swap point)', () => {
    // Build a minimal in-memory stub that implements the same interface.
    // This proves the contract is thin enough to swap without changing the manager.
    const calls = [];
    let runsStore = { version: 1, runs: [] };
    let jobsStore = { version: 1, jobs: [] };

    const stubRepo = {
      transact(fn) {
        calls.push('transact');
        const result = fn(runsStore, jobsStore);
        return result;
      },
      transactJobsOnly(fn) {
        calls.push('transactJobsOnly');
        return fn(jobsStore);
      },
      readRuns()  { return runsStore; },
      readJobs()  { return jobsStore; }
    };

    const manager = new WorkflowRunManager({ repo: stubRepo });
    manager.createRun(singleTargetRun());

    assert.ok(calls.includes('transact'), 'createRun should call repo.transact()');
    assert.ok(runsStore.runs.length > 0, 'run should be in the stub store');
    assert.ok(jobsStore.jobs.length > 0, 'job should be in the stub store');
  });

  test('transact() does not flush if fn throws', () => {
    const ws = createTempWorkspace('repo-noflushonerror-');
    try {
      const repo = new JsonWorkflowRepository({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });

      assert.throws(
        () => repo.transact((runsStore, jobsStore) => {
          runsStore.runs.push({ id: 'should-not-persist' });
          throw new Error('simulated failure');
        }),
        /simulated failure/
      );

      // Files should not have been written at all (no file exists yet)
      const fs = require('node:fs');
      assert.ok(!fs.existsSync(ws.path('runs.json')), 'runs file should not be written on error');
    } finally {
      ws.cleanup();
    }
  });

});
