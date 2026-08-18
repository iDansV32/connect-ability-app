const test = require('node:test');
const assert = require('node:assert/strict');

const WorkflowRunManager = require('../workflow-run-manager');
const { createTempWorkspace, readJson, writeJson } = require('./test-helpers');

test('WorkflowRunManager claims, heartbeats, reclaims, and completes durable jobs', () => {
  const workspace = createTempWorkspace('workflow-run-manager-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Outbound Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'view_profile', minDelayMs: 1000, maxDelayMs: 1000 },
        { type: 'delay', minDelayMs: 5000, maxDelayMs: 5000 },
        { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 1000, maxDelayMs: 1000 }
      ],
      targets: [
        {
          prospectId: 'prospect-1',
          value: 'https://www.linkedin.com/in/jane-doe/',
          label: 'Jane Doe'
        }
      ]
    });

    assert.equal(created.jobs.length, 1);
    assert.equal(created.run.targets[0].prospectId, 'prospect-1');
    assert.equal(Boolean(created.run.correlationId), true);
    assert.equal(created.jobs[0].rootCorrelationId, created.run.correlationId);
    assert.equal(Boolean(created.jobs[0].correlationId), true);

    const firstClaimBefore = new Date(Date.now() + (60 * 60 * 1000)).toISOString();
    const claimed = manager.claimDueJobs({
      before: firstClaimBefore,
      leaseOwner: 'worker-1',
      limit: 1
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, 'running');
    assert.equal(claimed[0].attempts, 1);
    assert.equal(claimed[0].prospectId, 'prospect-1');

    const heartbeated = manager.heartbeatJob(claimed[0].id, {
      leaseOwner: 'worker-1',
      leaseMs: 120000
    });
    assert.equal(heartbeated.leaseOwner, 'worker-1');

    const jobsStore = readJson(jobsPath);
    jobsStore.jobs[0].leaseExpiresAt = new Date(Date.now() - (60 * 1000)).toISOString();
    writeJson(jobsPath, jobsStore);

    const secondClaimBefore = new Date(Date.now() + (2 * 60 * 60 * 1000)).toISOString();
    const reclaimed = manager.claimDueJobs({
      before: secondClaimBefore,
      leaseOwner: 'worker-2',
      limit: 1
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].leaseOwner, 'worker-2');
    assert.equal(reclaimed[0].attempts, 2);

    manager.completeJob(reclaimed[0].id, { recipientName: 'Jane Doe' });
    const nextJob = manager.queueNextStep({
      runId: created.run.id,
      targetId: reclaimed[0].targetId,
      prospectId: reclaimed[0].prospectId,
      nextStepIndex: 2,
      targetValue: reclaimed[0].targetValue,
      targetLabel: reclaimed[0].targetLabel,
      scheduledFor: '2026-03-21T12:20:00.000Z'
    });
    assert.equal(nextJob.stepType, 'send_dm');
    assert.equal(nextJob.prospectId, 'prospect-1');
    assert.equal(nextJob.rootCorrelationId, created.run.correlationId);

    manager.completeJob(nextJob.id, { recipientName: 'Jane Doe' });
    manager.markTargetCompleted(created.run.id, reclaimed[0].targetId);
    const refreshedRun = manager.refreshRunStatus(created.run.id);

    assert.equal(refreshedRun.status, 'completed');
    assert.equal(refreshedRun.summary.completedTargets, 1);
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager preserves nullable campaignRunId without deriving it during normalization', () => {
  const workspace = createTempWorkspace('workflow-run-manager-campaign-run-id-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Coordinated Sequence',
      campaignRunId: 'campaign_run_1',
      accountId: 'account-1',
      steps: [
        { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    assert.equal(created.run.campaignRunId, 'campaign_run_1');
    assert.equal(manager.getRun(created.run.id).campaignRunId, 'campaign_run_1');

    const unlinked = manager.createRun({
      workflowName: 'Standalone Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-2', value: 'https://www.linkedin.com/in/john-doe/', label: 'John Doe' }
      ]
    });

    assert.equal(unlinked.run.campaignRunId, null);
    assert.equal(manager.getRun(unlinked.run.id).campaignRunId, null);
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager pauses queued jobs, resumes them, and keeps paused jobs unclaimable', () => {
  const workspace = createTempWorkspace('workflow-run-manager-pause-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Pause Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    const pausedRun = manager.pauseRun(created.run.id, { reason: 'reply_received' });
    const pausedJobs = manager.getJobs(created.run.id);
    assert.equal(pausedRun.status, 'paused');
    assert.equal(pausedRun.pauseReason, 'reply_received');
    assert.equal(pausedJobs[0].status, 'paused');
    assert.equal(manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-1',
      limit: 1
    }).length, 0);

    const resumedRun = manager.resumeRun(created.run.id);
    const resumedJobs = manager.getJobs(created.run.id);
    assert.equal(resumedRun.status, 'waiting');
    assert.equal(resumedRun.pauseReason, null);
    assert.equal(resumedJobs[0].status, 'queued');

    const claimed = manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-1',
      limit: 1
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, 'running');
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager pauseRun is idempotent and does not pause running jobs', () => {
  const workspace = createTempWorkspace('workflow-run-manager-pause-idempotent-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Pause Running Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'view_profile', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    const claimed = manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-1',
      limit: 1
    });
    assert.equal(claimed.length, 1);

    const firstPause = manager.pauseRun(created.run.id, { reason: 'reply_received' });
    const secondPause = manager.pauseRun(created.run.id, { reason: 'reply_received' });
    const jobs = manager.getJobs(created.run.id);

    assert.equal(firstPause.status, 'paused');
    assert.equal(secondPause.status, 'paused');
    assert.equal(jobs[0].status, 'running');
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager keeps paused jobs unclaimable even if run record is stale', () => {
  const workspace = createTempWorkspace('workflow-run-manager-pause-recovery-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Pause Recovery Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'send_connection', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    manager.pauseRun(created.run.id, { reason: 'reply_received' });

    const runsStore = readJson(runsPath);
    runsStore.runs[0].status = 'waiting';
    writeJson(runsPath, runsStore);

    const claimed = manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-1',
      limit: 1
    });

    assert.equal(claimed.length, 0);
    assert.equal(manager.getJobs(created.run.id)[0].status, 'paused');
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager cancelRun cancels queued jobs before run state is persisted', () => {
  const workspace = createTempWorkspace('workflow-run-manager-cancel-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Cancel Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    const cancelled = manager.cancelRun(created.run.id, 'unsubscribe_received');
    assert.equal(cancelled.cancelled, true);
    assert.equal(manager.getJobs(created.run.id)[0].status, 'cancelled');
    assert.equal(manager.getRun(created.run.id).status, 'cancelled');
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager drainWorkflowRun finalizes immediately when only queued work remains', () => {
  const workspace = createTempWorkspace('workflow-run-manager-drain-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Drain Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    const drained = manager.drainWorkflowRun(created.run.id, 'campaign_suppressed');
    const job = manager.getJobs(created.run.id)[0];

    assert.equal(drained.status, 'cancelled');
    assert.equal(drained.drainPending, false);
    assert.equal(drained.drainReason, 'campaign_suppressed');
    assert.equal(Boolean(drained.drainRequestedAt), true);
    assert.equal(Boolean(drained.drainCompletedAt), true);
    assert.equal(job.status, 'cancelled');
    assert.equal(drained.targets[0].status, 'cancelled');
    assert.equal(manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-1',
      limit: 1
    }).length, 0);
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager drainWorkflowRun cancels queued jobs, leaves running jobs alone, and blocks new claims', () => {
  const workspace = createTempWorkspace('workflow-run-manager-drain-running-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Drain Running Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' },
        { prospectId: 'prospect-2', value: 'https://www.linkedin.com/in/john-doe/', label: 'John Doe' }
      ]
    });

    const claimed = manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-1',
      limit: 1
    });

    assert.equal(claimed.length, 1);

    const drained = manager.drainWorkflowRun(created.run.id, 'campaign_suppressed');
    const jobs = manager.getJobs(created.run.id);

    assert.equal(drained.drainPending, true);
    assert.equal(drained.drainReason, 'campaign_suppressed');
    assert.equal(jobs.some((job) => job.status === 'running'), true);
    assert.equal(jobs.some((job) => job.status === 'cancelled'), true);
    assert.equal(jobs.some((job) => job.status === 'queued'), false);
    assert.equal(drained.targets.some((target) => target.status === 'cancelled'), true);
    assert.equal(manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-2',
      limit: 1
    }).length, 0);
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager finalizes a draining run after the last running job settles and refuses next-step queueing', () => {
  const workspace = createTempWorkspace('workflow-run-manager-drain-finalize-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Drain Finalization Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'view_profile', minDelayMs: 0, maxDelayMs: 0 },
        { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    const claimed = manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-1',
      limit: 1
    });

    manager.drainWorkflowRun(created.run.id, 'campaign_suppressed');
    manager.completeJob(claimed[0].id, { recipientName: 'Jane Doe' });

    assert.equal(manager.queueNextStep({
      runId: created.run.id,
      targetId: claimed[0].targetId,
      prospectId: claimed[0].prospectId,
      nextStepIndex: 1,
      scheduledFor: '2026-03-21T12:20:00.000Z',
      targetValue: claimed[0].targetValue,
      targetLabel: claimed[0].targetLabel
    }), null);

    manager.markTargetCancelled(created.run.id, claimed[0].targetId, 'campaign_suppressed');
    const finalized = manager.refreshRunStatus(created.run.id);

    assert.equal(finalized.status, 'cancelled');
    assert.equal(finalized.drainPending, false);
    assert.equal(Boolean(finalized.drainCompletedAt), true);
    assert.equal(finalized.targets[0].status, 'cancelled');
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager completes one target sequence before claiming the next target', () => {
  const workspace = createTempWorkspace('workflow-run-manager-score-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Scored Sequence',
      accountId: 'account-1',
      steps: [
        { type: 'view_profile', minDelayMs: 0, maxDelayMs: 0 },
        { type: 'like_posts', minDelayMs: 0, maxDelayMs: 0 },
        { type: 'send_connection', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-low', value: 'https://www.linkedin.com/in/low-score/', label: 'Low Score' },
        { prospectId: 'prospect-high', value: 'https://www.linkedin.com/in/high-score/', label: 'High Score' }
      ]
    });

    const claimed = manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-score',
      limit: 1,
      prospectScores: {
        'prospect-low': 30,
        'prospect-high': 90
      }
    });

    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].prospectId, 'prospect-low');
    assert.equal(claimed[0].stepType, 'view_profile');

    manager.completeJob(claimed[0].id, { reason: 'done' });
    manager.queueNextStep({
      runId: created.run.id,
      targetId: claimed[0].targetId,
      prospectId: claimed[0].prospectId,
      nextStepIndex: 1,
      targetValue: claimed[0].targetValue,
      targetLabel: claimed[0].targetLabel
    });

    const nextActionForFirstTarget = manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-score',
      limit: 1,
      prospectScores: {
        'prospect-low': 30,
        'prospect-high': 90
      }
    });

    assert.equal(nextActionForFirstTarget.length, 1);
    assert.equal(nextActionForFirstTarget[0].prospectId, 'prospect-low');
    assert.equal(nextActionForFirstTarget[0].stepType, 'like_posts');

    manager.completeJob(nextActionForFirstTarget[0].id, { reason: 'done' });
    manager.queueNextStep({
      runId: created.run.id,
      targetId: nextActionForFirstTarget[0].targetId,
      prospectId: nextActionForFirstTarget[0].prospectId,
      nextStepIndex: 2,
      targetValue: nextActionForFirstTarget[0].targetValue,
      targetLabel: nextActionForFirstTarget[0].targetLabel
    });

    const finalActionForFirstTarget = manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-score',
      limit: 1,
      prospectScores: {
        'prospect-low': 30,
        'prospect-high': 90
      }
    });

    assert.equal(finalActionForFirstTarget.length, 1);
    assert.equal(finalActionForFirstTarget[0].prospectId, 'prospect-low');
    assert.equal(finalActionForFirstTarget[0].stepType, 'send_connection');

    manager.completeJob(finalActionForFirstTarget[0].id, { reason: 'done' });
    manager.markTargetCompleted(created.run.id, finalActionForFirstTarget[0].targetId);

    const firstActionForSecondTarget = manager.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-score',
      limit: 1,
      prospectScores: {
        'prospect-low': 30,
        'prospect-high': 90
      }
    });

    assert.equal(firstActionForSecondTarget.length, 1);
    assert.equal(firstActionForSecondTarget[0].prospectId, 'prospect-high');
    assert.equal(firstActionForSecondTarget[0].stepType, 'view_profile');
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager preserves step metadata when creating and queueing jobs', () => {
  const workspace = createTempWorkspace('workflow-run-manager-step-metadata-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Metadata Sequence',
      accountId: 'account-1',
      steps: [
        {
          type: 'send_dm',
          messageTemplate: 'Hello',
          minDelayMs: 0,
          maxDelayMs: 0,
          metadata: {
            triggerEventType: 'connection_accepted',
            templateSlot: 'dm_primary'
          }
        }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    assert.equal(created.run.steps[0].metadata.triggerEventType, 'connection_accepted');
    assert.equal(created.jobs[0].step.metadata.templateSlot, 'dm_primary');
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowRunManager preserves Apollo enrollment step fields when creating and queueing jobs', () => {
  const workspace = createTempWorkspace('workflow-run-manager-apollo-step-');
  try {
    const runsPath = workspace.path('workflow-runs.json');
    const jobsPath = workspace.path('workflow-step-jobs.json');
    const manager = new WorkflowRunManager({ runsPath, jobsPath });

    const created = manager.createRun({
      workflowName: 'Apollo Sequence',
      campaignRunId: 'campaign-1',
      accountId: 'account-1',
      steps: [
        {
          type: 'apollo_enroll_sequence',
          sequenceId: 'seq-1',
          sequenceName: 'Outbound Apollo',
          emailAccountId: 'email-account-1',
          minDelayMs: 0,
          maxDelayMs: 0
        },
        {
          type: 'send_dm',
          messageTemplate: 'Hello',
          minDelayMs: 0,
          maxDelayMs: 0
        }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    assert.equal(created.run.steps[0].apolloSequenceId, 'seq-1');
    assert.equal(created.run.steps[0].sequenceId, 'seq-1');
    assert.equal(created.run.steps[0].sequenceName, 'Outbound Apollo');
    assert.equal(created.jobs[0].step.emailAccountId, 'email-account-1');
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// claim_uuid verification
//
// Pins the stale-completion-after-reclaim race the UUID was added to prevent:
// a worker hangs past lease expiry, the job gets reclaimed, the worker
// finally returns — completeJob/failJob/heartbeatJob must refuse the stale
// result rather than overwriting the new claim's state.
// ---------------------------------------------------------------------------

function setupRunForClaimUuidTests(workspace) {
  const manager = new WorkflowRunManager({
    runsPath: workspace.path('workflow-runs.json'),
    jobsPath: workspace.path('workflow-step-jobs.json')
  });
  const created = manager.createRun({
    workflowName: 'Claim UUID Test',
    accountId: 'acc-1',
    steps: [{ type: 'view_profile', minDelayMs: 0, maxDelayMs: 0 }],
    targets: [{ prospectId: 'p1', value: 'https://www.linkedin.com/in/x/', label: 'X' }]
  });
  return { manager, runId: created.run.id, jobId: created.jobs[0].id };
}

test('claimDueJobs assigns a fresh claim_uuid to every claimed job', () => {
  const workspace = createTempWorkspace('claim-uuid-fresh-');
  try {
    const { manager } = setupRunForClaimUuidTests(workspace);
    const before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const [claimed] = manager.claimDueJobs({ before, leaseOwner: 'w1' });
    assert.ok(claimed.claimUuid, 'claim_uuid must be assigned at claim time');
    assert.match(claimed.claimUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'should look like a UUID');
  } finally { workspace.cleanup(); }
});

test('completeJob refuses a stale claim_uuid; the real claim still completes', () => {
  const workspace = createTempWorkspace('claim-uuid-stale-complete-');
  try {
    const { manager, jobId } = setupRunForClaimUuidTests(workspace);
    const before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const [claimed] = manager.claimDueJobs({ before, leaseOwner: 'w1' });
    const realUuid = claimed.claimUuid;

    // A stale worker carries an old UUID (e.g., from a prior claim cycle).
    const staleResult = manager.completeJob(jobId, { outcomeType: 'completed' }, {
      claimUuid: '00000000-0000-0000-0000-000000000000'
    });
    assert.equal(staleResult, null, 'stale claim must be refused');

    // Job is still in 'running' state — the real worker's completion will land.
    const jobsAfterRefusal = manager.getJobs();
    assert.equal(jobsAfterRefusal[0].status, 'running');
    assert.equal(jobsAfterRefusal[0].claimUuid, realUuid,
      'claim_uuid unchanged after refused stale completion');

    // The legitimate worker completes successfully.
    const realResult = manager.completeJob(jobId, { outcomeType: 'completed' }, {
      claimUuid: realUuid
    });
    assert.ok(realResult, 'real claim must complete');
    assert.equal(realResult.status, 'completed');
    assert.equal(realResult.claimUuid, null, 'terminal state clears claim_uuid');
  } finally { workspace.cleanup(); }
});

test('failJob refuses a stale claim_uuid', () => {
  const workspace = createTempWorkspace('claim-uuid-stale-fail-');
  try {
    const { manager, jobId } = setupRunForClaimUuidTests(workspace);
    const before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    manager.claimDueJobs({ before, leaseOwner: 'w1' });

    const result = manager.failJob(jobId, { reason: 'stale' }, {
      claimUuid: '00000000-0000-0000-0000-000000000000'
    });
    assert.equal(result, null);
    const jobsAfter = manager.getJobs();
    assert.equal(jobsAfter[0].status, 'running', 'stale fail must not move the job to failed');
  } finally { workspace.cleanup(); }
});

test('failJob with { cancelled: true } bypasses claim_uuid verification (operator override)', () => {
  const workspace = createTempWorkspace('claim-uuid-cancel-bypass-');
  try {
    const { manager, jobId } = setupRunForClaimUuidTests(workspace);
    const before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    manager.claimDueJobs({ before, leaseOwner: 'w1' });

    // Even with a totally wrong claim_uuid, cancellation wins.
    const result = manager.failJob(jobId, { reason: 'user cancelled' }, {
      cancelled: true,
      claimUuid: '00000000-0000-0000-0000-000000000000'
    });
    assert.ok(result, 'cancellation must succeed despite UUID mismatch');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.claimUuid, null, 'terminal state clears claim_uuid even for cancellation');
  } finally { workspace.cleanup(); }
});

test('heartbeatJob refuses a stale claim_uuid', () => {
  const workspace = createTempWorkspace('claim-uuid-stale-heartbeat-');
  try {
    const { manager, jobId } = setupRunForClaimUuidTests(workspace);
    const before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    manager.claimDueJobs({ before, leaseOwner: 'w1' });

    const result = manager.heartbeatJob(jobId, {
      leaseOwner: 'w1',
      claimUuid: '00000000-0000-0000-0000-000000000000'
    });
    assert.equal(result, null, 'heartbeat with stale UUID must return null');
  } finally { workspace.cleanup(); }
});

test('Legacy callers (no claim_uuid passed) still complete jobs — backward compat', () => {
  // Pre-rollout callers don't carry a claim_uuid argument. The check only
  // fires when BOTH stored and provided UUIDs are present. Without an
  // expected UUID the operation flows through unchanged.
  const workspace = createTempWorkspace('claim-uuid-legacy-caller-');
  try {
    const { manager, jobId } = setupRunForClaimUuidTests(workspace);
    const before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    manager.claimDueJobs({ before, leaseOwner: 'w1' });

    // Old call shape — no third arg.
    const result = manager.completeJob(jobId, { outcomeType: 'completed' });
    assert.ok(result);
    assert.equal(result.status, 'completed');
  } finally { workspace.cleanup(); }
});

test('Pre-migration in-flight jobs (stored claim_uuid null) still complete with a new UUID', () => {
  // Forward-compat: a scheduler restarted under the new code receives results
  // from workers carrying claim_uuids, but the in-flight row was claimed
  // pre-migration and has claim_uuid=null in storage. The verification must
  // allow the operation rather than burn the job.
  const workspace = createTempWorkspace('claim-uuid-premigration-row-');
  try {
    const { manager, jobId } = setupRunForClaimUuidTests(workspace);
    const before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    manager.claimDueJobs({ before, leaseOwner: 'w1' });

    // Simulate pre-migration row: rewrite the job file with claim_uuid stripped.
    const jobsRaw = readJson(workspace.path('workflow-step-jobs.json'));
    jobsRaw.jobs[0].claimUuid = null;
    writeJson(workspace.path('workflow-step-jobs.json'), jobsRaw);

    // Caller carries a new-shape UUID; stored is null → allow.
    const result = manager.completeJob(jobId, { outcomeType: 'completed' }, {
      claimUuid: '11111111-1111-1111-1111-111111111111'
    });
    assert.ok(result, 'pre-migration null-stored row should accept any claim_uuid');
    assert.equal(result.status, 'completed');
  } finally { workspace.cleanup(); }
});

test('Reclaiming an expired job regenerates claim_uuid — old workers cannot land results', () => {
  // The exact race claim_uuid was added to prevent: original worker hangs
  // past lease expiry, scheduler reclaims (or restarts) the job, original
  // worker eventually returns and tries to complete.
  const workspace = createTempWorkspace('claim-uuid-reclaim-');
  try {
    const { manager, jobId } = setupRunForClaimUuidTests(workspace);

    // First claim with a 60s lease.
    const before1 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const [firstClaim] = manager.claimDueJobs({
      before: before1,
      leaseOwner: 'w1',
      leaseMs: 60000
    });
    const firstUuid = firstClaim.claimUuid;
    assert.ok(firstUuid);

    // Forge an expired lease on disk to trigger reclaimExpiredJob on next call.
    const jobsRaw = readJson(workspace.path('workflow-step-jobs.json'));
    jobsRaw.jobs[0].leaseExpiresAt = new Date(Date.now() - 60000).toISOString();
    writeJson(workspace.path('workflow-step-jobs.json'), jobsRaw);

    // A subsequent claim cycle reclaims the expired job. Since this is its
    // second attempt and DEFAULT_JOB_MAX_ATTEMPTS=3, it requeues rather than
    // failing permanently. The next claim assigns a fresh UUID.
    const before2 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const [secondClaim] = manager.claimDueJobs({ before: before2, leaseOwner: 'w2' });
    assert.ok(secondClaim, 'expired job should be reclaimed');
    assert.notEqual(secondClaim.claimUuid, firstUuid, 'reclaim must assign a fresh UUID');

    // The original worker eventually returns with the OLD claim_uuid → refused.
    const staleResult = manager.completeJob(jobId, { outcomeType: 'completed' }, {
      claimUuid: firstUuid
    });
    assert.equal(staleResult, null, 'first worker\'s late result must be refused');

    // The new claimant completes cleanly.
    const ok = manager.completeJob(jobId, { outcomeType: 'completed' }, {
      claimUuid: secondClaim.claimUuid
    });
    assert.ok(ok);
    assert.equal(ok.status, 'completed');
  } finally { workspace.cleanup(); }
});
