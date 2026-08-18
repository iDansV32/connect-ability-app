const WORKFLOW_STEP_OUTCOME_TYPES = new Set([
  'completed',
  'skipped_already_connected',
  'skipped_invite_pending',
  'skipped_managed_elsewhere',
  'skipped_do_not_contact',
  'skipped_no_post',
  'skipped_thread_exists',
  'skipped_quota_exceeded',
  'skipped_not_connected',
  'skipped_outside_working_hours',
  'skipped_budget_exceeded',
  'skipped_transport_unhealthy',
  'skipped_already_following',
  'skipped_no_endorseable_skills',
  'skipped_already_endorsed',
  'skipped_comment_unavailable',
  'skipped_not_following',
  'failed_transient',
  'failed_permanent'
]);

const SKIPPED_WORKFLOW_STEP_OUTCOME_TYPES = new Set([
  'skipped_already_connected',
  'skipped_invite_pending',
  'skipped_managed_elsewhere',
  'skipped_do_not_contact',
  'skipped_no_post',
  'skipped_thread_exists',
  'skipped_quota_exceeded',
  'skipped_not_connected',
  'skipped_outside_working_hours',
  'skipped_budget_exceeded',
  'skipped_transport_unhealthy',
  'skipped_already_following',
  'skipped_no_endorseable_skills',
  'skipped_already_endorsed',
  'skipped_comment_unavailable',
  'skipped_not_following'
]);

const FAILED_WORKFLOW_STEP_OUTCOME_TYPES = new Set([
  'failed_transient',
  'failed_permanent'
]);

const TERMINAL_WORKFLOW_STEP_OUTCOME_TYPES = new Set([
  'skipped_managed_elsewhere',
  'skipped_do_not_contact',
  'skipped_transport_unhealthy'
]);

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeVerificationResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const method = cleanString(value.method, 40).toLowerCase();
  const result = {
    verified: value.verified === true,
    method: method || null,
    at: cleanString(value.at, 80) || new Date().toISOString()
  };

  const reason = cleanString(value.reason, 200);
  if (reason) {
    result.reason = reason;
  }

  if (value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)) {
    result.metadata = { ...value.metadata };
  }

  return result;
}

function normalizeWorkflowStepOutcomeType(input = {}) {
  const explicit = cleanString(input.outcomeType, 80);
  if (WORKFLOW_STEP_OUTCOME_TYPES.has(explicit)) {
    return explicit;
  }

  if (input.success === false) {
    return 'failed_permanent';
  }

  return 'completed';
}

function createWorkflowStepResult(input = {}) {
  const outcomeType = normalizeWorkflowStepOutcomeType(input);

  return {
    success: !FAILED_WORKFLOW_STEP_OUTCOME_TYPES.has(outcomeType),
    outcomeType,
    stepType: cleanString(input.stepType, 80) || null,
    reason: cleanString(input.reason || input.error, 400) || null,
    profileUrl: cleanString(input.profileUrl, 400) || null,
    recipientName: cleanString(input.recipientName || input.targetLabel, 200) || null,
    timestamp: cleanString(input.timestamp, 80) || new Date().toISOString(),
    metadata: normalizeMetadata(input.metadata),
    verificationResult: normalizeVerificationResult(input.verificationResult)
  };
}

function isWorkflowStepSkipped(result = {}) {
  const normalized = createWorkflowStepResult(result);
  return SKIPPED_WORKFLOW_STEP_OUTCOME_TYPES.has(normalized.outcomeType);
}

function isWorkflowStepFailure(result = {}) {
  const normalized = createWorkflowStepResult(result);
  return FAILED_WORKFLOW_STEP_OUTCOME_TYPES.has(normalized.outcomeType);
}

function shouldRetryWorkflowStepResult(result = {}) {
  const normalized = createWorkflowStepResult(result);
  return normalized.outcomeType === 'failed_transient';
}

function didWorkflowStepPerformAction(result = {}) {
  const normalized = createWorkflowStepResult(result);
  if (normalized.outcomeType !== 'completed') {
    return false;
  }
  if (normalized.verificationResult && normalized.verificationResult.verified === false) {
    return false;
  }
  return true;
}

function shouldStopWorkflowAfterStepResult(result = {}) {
  const normalized = createWorkflowStepResult(result);
  return TERMINAL_WORKFLOW_STEP_OUTCOME_TYPES.has(normalized.outcomeType);
}

function getWorkflowStepEventStatus(result = {}) {
  if (isWorkflowStepFailure(result)) {
    return 'failed';
  }
  if (isWorkflowStepSkipped(result)) {
    return 'skipped';
  }
  return 'ok';
}

module.exports = {
  WORKFLOW_STEP_OUTCOME_TYPES,
  createWorkflowStepResult,
  didWorkflowStepPerformAction,
  getWorkflowStepEventStatus,
  isWorkflowStepFailure,
  isWorkflowStepSkipped,
  shouldStopWorkflowAfterStepResult,
  shouldRetryWorkflowStepResult
};
