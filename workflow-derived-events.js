const { createWorkflowStepResult, didWorkflowStepPerformAction } = require('./workflow-step-result');
const {
  DEFAULT_CONNECTION_ACCEPTED_DETECTION,
  DEFAULT_CONNECTION_ACCEPTED_INFERENCE
} = require('./workflow-connection-inference');

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeCount(value) {
  return Math.max(0, Number(value) || 0);
}

function isTruthy(value) {
  if (value === true) return true;
  return cleanString(value, 10).toLowerCase() === 'true';
}

function buildBaseEvent(run = {}, job = {}, result = {}) {
  return {
    accountId: run.accountId || null,
    accountName: run.accountName || null,
    agentId: run.agentId || null,
    agentName: run.agentName || null,
    workflowId: run.workflowId || run.id || null,
    workflowName: run.workflowName || null,
    runId: run.id || null,
    correlationId: job.correlationId || run.correlationId || null,
    rootCorrelationId: job.rootCorrelationId || run.correlationId || null,
    targetId: job.targetId || null,
    prospectId: job.prospectId || null,
    targetValue: result.recipientName || job.targetLabel || job.targetValue || null,
    profileUrl: result.profileUrl || null
  };
}

function resolveDerivedWorkflowActivityEvents(run = {}, job = {}, stepResult = {}) {
  const normalizedStepResult = createWorkflowStepResult({
    ...stepResult,
    stepType: stepResult?.stepType || job.stepType,
    profileUrl: stepResult?.profileUrl || job.targetValue,
    recipientName: stepResult?.recipientName || job.targetLabel || job.targetValue
  });
  const metadata = normalizedStepResult.metadata && typeof normalizedStepResult.metadata === 'object'
    ? normalizedStepResult.metadata
    : {};
  const stepType = cleanString(job.stepType, 80);

  if (
    !didWorkflowStepPerformAction(normalizedStepResult)
  ) {
    return [];
  }

  const inferred = isTruthy(metadata.connectionAcceptedInferred);
  const detected = isTruthy(metadata.connectionAcceptedDetected);
  if (!inferred && !detected) {
    return [];
  }

  const connectionRequestCount = normalizeCount(metadata.connectionRequestCount);
  const eventMetadata = {
    stepIndex: job.stepIndex,
    stepType,
    targetType: run.targetType || null,
    recipientName: normalizedStepResult.recipientName || job.targetLabel || null,
    outcomeType: normalizedStepResult.outcomeType,
    connectionRequestCount: connectionRequestCount || undefined
  };

  if (inferred) {
    eventMetadata.inferred = true;
    eventMetadata.inferredFromStepType = stepType;
    eventMetadata.inferenceReason =
      cleanString(metadata.connectionAcceptedInference, 160) || DEFAULT_CONNECTION_ACCEPTED_INFERENCE;
    eventMetadata.inferredAt =
      cleanString(metadata.connectionAcceptedInferredAt, 80) || normalizedStepResult.timestamp;
  }

  if (detected) {
    eventMetadata.detected = true;
    eventMetadata.detectionReason =
      cleanString(metadata.connectionAcceptedDetection, 160) || DEFAULT_CONNECTION_ACCEPTED_DETECTION;
    eventMetadata.detectedAt =
      cleanString(metadata.connectionAcceptedDetectedAt, 80) || normalizedStepResult.timestamp;
    if (Object.prototype.hasOwnProperty.call(metadata, 'connectionStateConnected')) {
      eventMetadata.connectionStateConnected = metadata.connectionStateConnected === true;
    }
    if (Object.prototype.hasOwnProperty.call(metadata, 'connectionStatePending')) {
      eventMetadata.connectionStatePending = metadata.connectionStatePending === true;
    }
  }

  return [
    {
      ...buildBaseEvent(run, job, normalizedStepResult),
      type: 'connection_accepted',
      status: 'ok',
      metadata: eventMetadata
    }
  ];
}

module.exports = {
  resolveDerivedWorkflowActivityEvents
};
