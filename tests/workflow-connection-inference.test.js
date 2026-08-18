const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CONNECTION_ACCEPTED_DETECTION,
  DEFAULT_CONNECTION_ACCEPTED_INFERENCE,
  buildConnectionAcceptedDetectionMetadata,
  buildConnectionAcceptedInferenceMetadata,
  hasRecordedConnectionAcceptance,
  shouldDetectConnectionAcceptedFromState,
  shouldInferConnectionAcceptedFromProspect
} = require('../workflow-connection-inference');

test('workflow connection inference marks successful DM after a recorded invite as accepted', () => {
  const metadata = buildConnectionAcceptedInferenceMetadata({
    metrics: {
      connectionRequests: 1,
      connectionAcceptances: 0
    },
    metadata: {
      lastEventType: 'connection_requested'
    }
  }, {
    timestamp: '2026-03-21T12:00:00.000Z'
  });

  assert.equal(metadata.connectionAcceptedInferred, true);
  assert.equal(metadata.connectionAcceptedInferredAt, '2026-03-21T12:00:00.000Z');
  assert.equal(metadata.connectionAcceptedInference, DEFAULT_CONNECTION_ACCEPTED_INFERENCE);
  assert.equal(metadata.connectionRequestCount, 1);
});

test('workflow connection inference does not duplicate already-recorded acceptances', () => {
  const prospect = {
    metrics: {
      connectionRequests: 1,
      connectionAcceptances: 1
    },
    metadata: {
      connectionAcceptedAt: '2026-03-20T12:00:00.000Z'
    }
  };

  assert.equal(hasRecordedConnectionAcceptance(prospect), true);
  assert.equal(shouldInferConnectionAcceptedFromProspect(prospect), false);
  assert.deepEqual(buildConnectionAcceptedInferenceMetadata(prospect), {});
});

test('workflow connection inference marks connected profile state after a recorded invite as accepted', () => {
  const metadata = buildConnectionAcceptedDetectionMetadata({
    metrics: {
      connectionRequests: 2,
      connectionAcceptances: 0
    }
  }, {
    pending: false,
    connected: true,
    canConnect: false
  }, {
    timestamp: '2026-03-23T09:15:00.000Z'
  });

  assert.equal(metadata.connectionAcceptedDetected, true);
  assert.equal(metadata.connectionAcceptedDetectedAt, '2026-03-23T09:15:00.000Z');
  assert.equal(metadata.connectionAcceptedDetection, DEFAULT_CONNECTION_ACCEPTED_DETECTION);
  assert.equal(metadata.connectionRequestCount, 2);
});

test('workflow connection inference does not mark accepted when state is still pending or already recorded', () => {
  const freshProspect = {
    metrics: {
      connectionRequests: 1,
      connectionAcceptances: 0
    }
  };
  assert.equal(shouldDetectConnectionAcceptedFromState(freshProspect, {
    pending: true,
    connected: false
  }), false);
  assert.deepEqual(buildConnectionAcceptedDetectionMetadata(freshProspect, {
    pending: true,
    connected: false
  }), {});

  const acceptedProspect = {
    metrics: {
      connectionRequests: 1,
      connectionAcceptances: 1
    },
    metadata: {
      connectionAcceptedAt: '2026-03-22T11:00:00.000Z'
    }
  };
  assert.equal(shouldDetectConnectionAcceptedFromState(acceptedProspect, {
    pending: false,
    connected: true
  }), false);
  assert.deepEqual(buildConnectionAcceptedDetectionMetadata(acceptedProspect, {
    pending: false,
    connected: true
  }), {});
});
