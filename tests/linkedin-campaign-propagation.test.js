const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pauseWorkflowRunFromLinkedIn,
  cancelWorkflowRunFromLinkedIn,
  resumeWorkflowRunFromLinkedIn
} = require('../linkedin-campaign-propagation');

test('pauseWorkflowRunFromLinkedIn reads the workflow run before mutating and propagates to the campaign when linked', () => {
  const callOrder = [];
  const workflowRuns = {
    getRun(runId) {
      callOrder.push(`get:${runId}`);
      return {
        id: runId,
        accountId: 'account-1',
        campaignRunId: 'campaign-1'
      };
    },
    pauseRun(runId, options) {
      callOrder.push(`pause:${runId}:${options.reason}`);
      return {
        id: runId,
        accountId: 'account-1',
        campaignRunId: 'campaign-1',
        status: 'paused',
        pauseReason: options.reason
      };
    }
  };
  const campaignController = {
    pauseCampaignFromLinkedIn(campaignRunId, reason) {
      callOrder.push(`campaign-pause:${campaignRunId}:${reason}`);
      return {
        campaignRun: {
          id: campaignRunId,
          status: 'paused'
        },
        pollRecord: null
      };
    }
  };

  const result = pauseWorkflowRunFromLinkedIn({
    runId: 'run-1',
    options: { reason: 'reply_received' },
    workflowRuns,
    campaignController
  });

  assert.deepEqual(callOrder, [
    'get:run-1',
    'pause:run-1:reply_received',
    'campaign-pause:campaign-1:reply_received'
  ]);
  assert.equal(result.workflowRun.status, 'paused');
  assert.equal(result.campaignTransition.campaignRun.status, 'paused');
});

test('pauseWorkflowRunFromLinkedIn is a campaign no-op for standalone workflow runs', () => {
  let campaignCalls = 0;
  const workflowRuns = {
    getRun() {
      return {
        id: 'run-standalone',
        accountId: 'account-1',
        campaignRunId: null
      };
    },
    pauseRun() {
      return {
        id: 'run-standalone',
        accountId: 'account-1',
        campaignRunId: null,
        status: 'paused',
        pauseReason: 'reply_received'
      };
    }
  };
  const campaignController = {
    pauseCampaignFromLinkedIn() {
      campaignCalls += 1;
      return null;
    }
  };

  const result = pauseWorkflowRunFromLinkedIn({
    runId: 'run-standalone',
    options: { reason: 'reply_received' },
    workflowRuns,
    campaignController
  });

  assert.equal(result.workflowRun.status, 'paused');
  assert.equal(result.campaignTransition, null);
  assert.equal(campaignCalls, 0);
});

test('cancelWorkflowRunFromLinkedIn suppresses the campaign only for linked workflow runs', () => {
  let suppressedCampaignRunId = null;
  const workflowRuns = {
    getRun() {
      return {
        id: 'run-1',
        campaignRunId: 'campaign-1'
      };
    },
    cancelRun() {
      return { cancelled: true };
    }
  };
  const campaignController = {
    suppressCampaignFromLinkedIn(campaignRunId, reason) {
      suppressedCampaignRunId = `${campaignRunId}:${reason}`;
      return {
        campaignRun: {
          id: campaignRunId,
          status: 'suppressed'
        },
        pollRecord: null
      };
    }
  };

  const result = cancelWorkflowRunFromLinkedIn({
    runId: 'run-1',
    reason: 'unsubscribe_received',
    workflowRuns,
    campaignController
  });

  assert.equal(result.workflowResult.cancelled, true);
  assert.equal(result.campaignTransition.campaignRun.status, 'suppressed');
  assert.equal(suppressedCampaignRunId, 'campaign-1:unsubscribe_received');
});

test('resumeWorkflowRunFromLinkedIn resumes linked campaigns only for reply-origin pauses', () => {
  let resumedCampaignRunId = null;
  const workflowRuns = {
    getRun() {
      return {
        id: 'run-1',
        campaignRunId: 'campaign-1',
        pauseReason: 'reply_received'
      };
    },
    resumeRun() {
      return {
        id: 'run-1',
        campaignRunId: 'campaign-1',
        status: 'waiting'
      };
    }
  };
  const campaignController = {
    resumeCampaignFromLinkedIn(campaignRunId) {
      resumedCampaignRunId = campaignRunId;
      return {
        campaignRun: {
          id: campaignRunId,
          status: 'queued'
        },
        pollRecord: {
          status: 'active'
        }
      };
    }
  };

  const result = resumeWorkflowRunFromLinkedIn({
    runId: 'run-1',
    workflowRuns,
    campaignController
  });

  assert.equal(result.workflowRun.status, 'waiting');
  assert.equal(result.campaignTransition.campaignRun.status, 'queued');
  assert.equal(resumedCampaignRunId, 'campaign-1');
});

test('resumeWorkflowRunFromLinkedIn is a campaign no-op for manual workflow pauses', () => {
  let campaignCalls = 0;
  const workflowRuns = {
    getRun() {
      return {
        id: 'run-1',
        campaignRunId: 'campaign-1',
        pauseReason: 'Paused by operator'
      };
    },
    resumeRun() {
      return {
        id: 'run-1',
        status: 'waiting'
      };
    }
  };
  const campaignController = {
    resumeCampaignFromLinkedIn() {
      campaignCalls += 1;
      return null;
    }
  };

  const result = resumeWorkflowRunFromLinkedIn({
    runId: 'run-1',
    workflowRuns,
    campaignController
  });

  assert.equal(result.workflowRun.status, 'waiting');
  assert.equal(result.campaignTransition, null);
  assert.equal(campaignCalls, 0);
});
