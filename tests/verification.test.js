'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  verifyConnectionSent,
  verifyDmSent,
  verifyPostScheduled
} = require('../automation/runtime/verification');

test('verifyConnectionSent confirms pending connection state', async () => {
  const result = await verifyConnectionSent({}, {
    state: {
      pending: true,
      connected: false,
      canConnect: false
    }
  });

  assert.equal(result.verified, true);
  assert.equal(result.method, 'dom');
  assert.equal(result.metadata.pending, true);
});

test('verifyConnectionSent marks connection attempt unconfirmed when no pending or connected state exists', async () => {
  const result = await verifyConnectionSent({}, {
    state: {
      pending: false,
      connected: false,
      canConnect: true
    }
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, 'connection_state_unconfirmed');
});

test('verifyDmSent uses DOM verification when transport is dom', async () => {
  const result = await verifyDmSent({}, {
    transport: 'dom',
    verifyDomMessageSent: async () => true
  });

  assert.equal(result.verified, true);
  assert.equal(result.method, 'dom');
});

test('verifyPostScheduled confirms resource-key-backed scheduled posts', () => {
  const result = verifyPostScheduled({
    resourceKey: 'urn:li:share:123'
  });

  assert.equal(result.verified, true);
  assert.equal(result.method, 'dom');
  assert.equal(result.metadata.resourceKey, 'urn:li:share:123');
});

