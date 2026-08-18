const DEFAULT_CONNECTION_ACCEPTED_INFERENCE = 'successful_dm_after_connection_request';
const DEFAULT_CONNECTION_ACCEPTED_DETECTION = 'connected_profile_state_after_connection_request';

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeCount(value) {
  return Math.max(0, Number(value) || 0);
}

function hasConnectionRequestEvidence(prospect = {}) {
  return normalizeCount(prospect?.metrics?.connectionRequests) > 0;
}

function normalizeConnectionState(connectionState = {}) {
  return {
    pending: connectionState?.pending === true,
    connected: connectionState?.connected === true,
    following: connectionState?.following === true,
    canConnect: connectionState?.canConnect === true
  };
}

function hasRecordedConnectionAcceptance(prospect = {}) {
  const metadata = prospect?.metadata && typeof prospect.metadata === 'object'
    ? prospect.metadata
    : {};

  return (
    normalizeCount(prospect?.metrics?.connectionAcceptances) > 0
    || cleanString(metadata.connectionAcceptedAt, 80).length > 0
    || cleanString(metadata.lastEventType, 80) === 'connection_accepted'
  );
}

function shouldInferConnectionAcceptedFromProspect(prospect = {}) {
  return Boolean(prospect) && hasConnectionRequestEvidence(prospect) && !hasRecordedConnectionAcceptance(prospect);
}

function shouldDetectConnectionAcceptedFromState(prospect = {}, connectionState = {}) {
  const normalizedState = normalizeConnectionState(connectionState);
  return Boolean(prospect) && normalizedState.connected === true
    && hasConnectionRequestEvidence(prospect)
    && !hasRecordedConnectionAcceptance(prospect);
}

function buildConnectionAcceptedInferenceMetadata(prospect = {}, options = {}) {
  if (!shouldInferConnectionAcceptedFromProspect(prospect)) {
    return {};
  }

  return {
    connectionAcceptedInferred: true,
    connectionAcceptedInferredAt: cleanString(options.timestamp, 80) || new Date().toISOString(),
    connectionAcceptedInference:
      cleanString(options.reason, 160) || DEFAULT_CONNECTION_ACCEPTED_INFERENCE,
    connectionRequestCount: normalizeCount(prospect?.metrics?.connectionRequests)
  };
}

function buildConnectionAcceptedDetectionMetadata(prospect = {}, connectionState = {}, options = {}) {
  if (!shouldDetectConnectionAcceptedFromState(prospect, connectionState)) {
    return {};
  }

  return {
    connectionAcceptedDetected: true,
    connectionAcceptedDetectedAt: cleanString(options.timestamp, 80) || new Date().toISOString(),
    connectionAcceptedDetection:
      cleanString(options.reason, 160) || DEFAULT_CONNECTION_ACCEPTED_DETECTION,
    connectionRequestCount: normalizeCount(prospect?.metrics?.connectionRequests)
  };
}

module.exports = {
  DEFAULT_CONNECTION_ACCEPTED_DETECTION,
  DEFAULT_CONNECTION_ACCEPTED_INFERENCE,
  buildConnectionAcceptedDetectionMetadata,
  buildConnectionAcceptedInferenceMetadata,
  hasConnectionRequestEvidence,
  hasRecordedConnectionAcceptance,
  shouldDetectConnectionAcceptedFromState,
  shouldInferConnectionAcceptedFromProspect
};
