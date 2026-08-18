const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createWorkflowStepResult,
  didWorkflowStepPerformAction,
  getWorkflowStepEventStatus,
  isWorkflowStepFailure,
  isWorkflowStepSkipped,
  shouldStopWorkflowAfterStepResult,
  shouldRetryWorkflowStepResult
} = require('../workflow-step-result');

test('workflow step contract normalizes completed outcomes', () => {
  const result = createWorkflowStepResult({
    stepType: 'send_dm',
    outcomeType: 'completed',
    profileUrl: ' https://www.linkedin.com/in/jane-doe/ ',
    recipientName: 'Jane Doe',
    metadata: {
      transport: 'dom'
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.outcomeType, 'completed');
  assert.equal(result.stepType, 'send_dm');
  assert.equal(result.profileUrl, 'https://www.linkedin.com/in/jane-doe/');
  assert.equal(result.recipientName, 'Jane Doe');
  assert.equal(getWorkflowStepEventStatus(result), 'ok');
  assert.equal(didWorkflowStepPerformAction(result), true);
});

test('workflow step contract suppresses performed-action inference when verification is explicitly false', () => {
  const result = createWorkflowStepResult({
    stepType: 'send_connection',
    outcomeType: 'completed',
    profileUrl: 'https://www.linkedin.com/in/jane-doe/',
    verificationResult: {
      verified: false,
      method: 'dom',
      reason: 'connection_state_unconfirmed'
    }
  });

  assert.equal(result.verificationResult?.verified, false);
  assert.equal(didWorkflowStepPerformAction(result), false);
});

test('workflow step contract treats skipped outcomes as non-fatal', () => {
  const result = createWorkflowStepResult({
    stepType: 'send_connection',
    outcomeType: 'skipped_quota_exceeded',
    reason: 'connection_requested blocked by daily safety limit'
  });

  assert.equal(result.success, true);
  assert.equal(isWorkflowStepSkipped(result), true);
  assert.equal(isWorkflowStepFailure(result), false);
  assert.equal(getWorkflowStepEventStatus(result), 'skipped');
  assert.equal(didWorkflowStepPerformAction(result), false);
  assert.equal(shouldRetryWorkflowStepResult(result), false);
});

test('workflow step contract marks managed-elsewhere skips as terminal target stops', () => {
  const result = createWorkflowStepResult({
    stepType: 'send_connection',
    outcomeType: 'skipped_managed_elsewhere',
    reason: 'Prospect already has an accepted connection with Agent One'
  });

  assert.equal(result.success, true);
  assert.equal(isWorkflowStepSkipped(result), true);
  assert.equal(shouldStopWorkflowAfterStepResult(result), true);
  assert.equal(didWorkflowStepPerformAction(result), false);
});

test('workflow step contract marks do-not-contact skips as terminal target stops', () => {
  const result = createWorkflowStepResult({
    stepType: 'send_dm',
    outcomeType: 'skipped_do_not_contact',
    reason: 'Prospect is archived and marked do not contact'
  });

  assert.equal(result.success, true);
  assert.equal(isWorkflowStepSkipped(result), true);
  assert.equal(shouldStopWorkflowAfterStepResult(result), true);
  assert.equal(didWorkflowStepPerformAction(result), false);
});

test('workflow step contract treats skipped transport-unhealthy outcomes as terminal non-actions', () => {
  const result = createWorkflowStepResult({
    stepType: 'send_connection',
    outcomeType: 'skipped_transport_unhealthy',
    reason: 'Action skipped: dom transport is temporarily unhealthy for send_connection'
  });

  assert.equal(result.success, true);
  assert.equal(isWorkflowStepSkipped(result), true);
  assert.equal(isWorkflowStepFailure(result), false);
  assert.equal(getWorkflowStepEventStatus(result), 'skipped');
  assert.equal(shouldStopWorkflowAfterStepResult(result), true);
  assert.equal(didWorkflowStepPerformAction(result), false);
});

test('workflow step contract marks transient failures as retriable', () => {
  const result = createWorkflowStepResult({
    stepType: 'like_posts',
    outcomeType: 'failed_transient',
    reason: 'Reaction appeared to succeed but could not be verified'
  });

  assert.equal(result.success, false);
  assert.equal(isWorkflowStepFailure(result), true);
  assert.equal(isWorkflowStepSkipped(result), false);
  assert.equal(getWorkflowStepEventStatus(result), 'failed');
  assert.equal(shouldRetryWorkflowStepResult(result), true);
});

test('workflow step contract defaults invalid outcomes to permanent failure when success is false', () => {
  const result = createWorkflowStepResult({
    stepType: 'send_dm',
    success: false,
    outcomeType: 'not_real',
    reason: 'Unsupported state'
  });

  assert.equal(result.outcomeType, 'failed_permanent');
  assert.equal(result.success, false);
  assert.equal(shouldRetryWorkflowStepResult(result), false);
});
