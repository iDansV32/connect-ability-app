'use strict';

const RESUMABLE_LINKEDIN_PAUSE_REASONS = new Set(['reply_received']);

function pauseWorkflowRunFromLinkedIn(input = {}) {
  const workflowRuns = input.workflowRuns;
  const campaignController = input.campaignController;
  const runId = input.runId;
  const options = input.options && typeof input.options === 'object'
    ? input.options
    : {};

  const previousRun = workflowRuns && typeof workflowRuns.getRun === 'function'
    ? workflowRuns.getRun(runId)
    : null;
  const workflowRun = workflowRuns && typeof workflowRuns.pauseRun === 'function'
    ? workflowRuns.pauseRun(runId, options)
    : null;
  const campaignTransition = workflowRun
    && previousRun?.campaignRunId
    && campaignController
    && typeof campaignController.pauseCampaignFromLinkedIn === 'function'
    ? campaignController.pauseCampaignFromLinkedIn(previousRun.campaignRunId, options.reason || 'reply_received')
    : null;

  return {
    previousRun,
    workflowRun,
    campaignTransition
  };
}

function cancelWorkflowRunFromLinkedIn(input = {}) {
  const workflowRuns = input.workflowRuns;
  const campaignController = input.campaignController;
  const runId = input.runId;
  const reason = cleanString(input.reason, 160) || 'unsubscribe_received';

  const previousRun = workflowRuns && typeof workflowRuns.getRun === 'function'
    ? workflowRuns.getRun(runId)
    : null;
  const workflowResult = workflowRuns && typeof workflowRuns.cancelRun === 'function'
    ? workflowRuns.cancelRun(runId, reason)
    : null;
  const campaignTransition = workflowResult?.cancelled
    && previousRun?.campaignRunId
    && campaignController
    && typeof campaignController.suppressCampaignFromLinkedIn === 'function'
    ? campaignController.suppressCampaignFromLinkedIn(previousRun.campaignRunId, reason)
    : null;

  return {
    previousRun,
    workflowResult,
    campaignTransition
  };
}

function resumeWorkflowRunFromLinkedIn(input = {}) {
  const workflowRuns = input.workflowRuns;
  const campaignController = input.campaignController;
  const runId = input.runId;

  const previousRun = workflowRuns && typeof workflowRuns.getRun === 'function'
    ? workflowRuns.getRun(runId)
    : null;
  const workflowRun = workflowRuns && typeof workflowRuns.resumeRun === 'function'
    ? workflowRuns.resumeRun(runId)
    : null;
  const campaignTransition = workflowRun
    && previousRun?.campaignRunId
    && shouldResumeCampaignFromWorkflowRun(previousRun)
    && campaignController
    && typeof campaignController.resumeCampaignFromLinkedIn === 'function'
    ? campaignController.resumeCampaignFromLinkedIn(previousRun.campaignRunId)
    : null;

  return {
    previousRun,
    workflowRun,
    campaignTransition
  };
}

function shouldResumeCampaignFromWorkflowRun(run = {}) {
  const pauseReason = cleanString(run.pauseReason, 160);
  return RESUMABLE_LINKEDIN_PAUSE_REASONS.has(pauseReason);
}

function cleanString(value, maxLength = 200) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  pauseWorkflowRunFromLinkedIn,
  cancelWorkflowRunFromLinkedIn,
  resumeWorkflowRunFromLinkedIn,
  shouldResumeCampaignFromWorkflowRun
};
