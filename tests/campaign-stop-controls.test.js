const test = require('node:test');
const assert = require('node:assert/strict');

const CampaignController = require('../campaign-controller');
const CampaignRunManager = require('../campaign-run-manager');
const ApolloPollStore = require('../apollo-poll-store');
const WorkflowRunManager = require('../workflow-run-manager');
const { createTempWorkspace } = require('./test-helpers');

test('CampaignController drains a campaign immediately, completes polling, and leaves running child work to drain', () => {
  const workspace = createTempWorkspace('campaign-stop-controls-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const apolloPolls = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({
      campaignRuns,
      apolloPolls,
      workflowRuns
    });

    const runningChild = workflowRuns.createRun({
      workflowName: 'Running Child',
      accountId: 'account-1',
      steps: [{ type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }],
      targets: [{ prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }]
    });
    workflowRuns.claimDueJobs({
      before: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      leaseOwner: 'worker-1',
      limit: 1
    });

    const queuedChild = workflowRuns.createRun({
      workflowName: 'Queued Child',
      accountId: 'account-1',
      steps: [{ type: 'send_connection', minDelayMs: 0, maxDelayMs: 0 }],
      targets: [{ prospectId: 'prospect-2', value: 'https://www.linkedin.com/in/john-doe/', label: 'John Doe' }]
    });

    const campaignRun = campaignRuns.createRun({
      campaignTemplateName: 'Kill Switch Campaign',
      accountId: 'account-1',
      childRunIds: [runningChild.run.id, queuedChild.run.id],
      apolloContactId: 'contact-1',
      apolloSequenceId: 'sequence-1',
      apolloSequenceContactId: 'seq-contact-1'
    });

    apolloPolls.createPollRecord(campaignRun.id, {
      apolloSequenceContactId: 'seq-contact-1'
    });

    const drained = controller.drainCampaignRun(campaignRun.id, 'operator_emergency_stop');
    const refreshedCampaignRun = campaignRuns.getRun(campaignRun.id);
    const refreshedPollRecord = apolloPolls.getPollRecord(campaignRun.id);
    const refreshedRunningChild = workflowRuns.getRun(runningChild.run.id);
    const refreshedQueuedChild = workflowRuns.getRun(queuedChild.run.id);

    assert.equal(drained.campaignRun.status, 'cancelled');
    assert.equal(drained.campaignRun.terminalReason, 'operator_emergency_stop');
    assert.deepEqual(drained.drainedChildRunIds.sort(), [queuedChild.run.id, runningChild.run.id].sort());

    assert.equal(refreshedCampaignRun.status, 'cancelled');
    assert.equal(refreshedCampaignRun.terminalReason, 'operator_emergency_stop');

    assert.equal(refreshedPollRecord.status, 'completed');
    assert.equal(refreshedPollRecord.lastPollResult.outcome, 'operator_cancelled');
    assert.equal(refreshedPollRecord.lastPollResult.transition, 'cancelled');
    assert.equal(refreshedPollRecord.lastPollResult.cancelReason, 'operator_emergency_stop');

    assert.equal(refreshedRunningChild.drainPending, true);
    assert.equal(refreshedRunningChild.status, 'running');
    assert.equal(refreshedQueuedChild.status, 'cancelled');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController drains all active campaigns and leaves terminal campaigns untouched', () => {
  const workspace = createTempWorkspace('campaign-stop-controls-all-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const apolloPolls = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({
      campaignRuns,
      apolloPolls,
      workflowRuns
    });

    const activeChild = workflowRuns.createRun({
      workflowName: 'Active Child',
      accountId: 'account-1',
      steps: [{ type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }],
      targets: [{ prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }]
    });
    const activeCampaign = campaignRuns.createRun({
      campaignTemplateName: 'Active Campaign',
      accountId: 'account-1',
      childRunIds: [activeChild.run.id],
      apolloSequenceContactId: 'seq-contact-active'
    });
    apolloPolls.createPollRecord(activeCampaign.id, {
      apolloSequenceContactId: 'seq-contact-active'
    });

    const pausedChild = workflowRuns.createRun({
      workflowName: 'Paused Child',
      accountId: 'account-2',
      steps: [{ type: 'send_connection', minDelayMs: 0, maxDelayMs: 0 }],
      targets: [{ prospectId: 'prospect-2', value: 'https://www.linkedin.com/in/john-doe/', label: 'John Doe' }]
    });
    workflowRuns.pauseRun(pausedChild.run.id, { reason: 'reply_received' });
    const pausedCampaign = campaignRuns.createRun({
      campaignTemplateName: 'Paused Campaign',
      accountId: 'account-2',
      status: 'paused',
      childRunIds: [pausedChild.run.id]
    });

    const terminalCampaign = campaignRuns.createRun({
      campaignTemplateName: 'Completed Campaign',
      accountId: 'account-3',
      status: 'completed',
      completedAt: '2026-03-27T00:00:00.000Z'
    });

    const drained = controller.drainAllCampaignRuns('operator_stop_all');

    assert.equal(drained.length, 2);
    assert.deepEqual(
      drained.map((entry) => entry.campaignRun.id).sort(),
      [activeCampaign.id, pausedCampaign.id].sort()
    );
    assert.equal(campaignRuns.getRun(activeCampaign.id).status, 'cancelled');
    assert.equal(campaignRuns.getRun(pausedCampaign.id).status, 'cancelled');
    assert.equal(campaignRuns.getRun(terminalCampaign.id).status, 'completed');
    assert.equal(apolloPolls.getPollRecord(activeCampaign.id).status, 'completed');
  } finally {
    workspace.cleanup();
  }
});
