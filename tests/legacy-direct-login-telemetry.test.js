'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { recordLegacyDirectLoginUsage } = require('../automation/runtime/legacy-direct-login-telemetry');

test('recordLegacyDirectLoginUsage forwards a normalized warning event to the provided recorder', () => {
  const recorded = [];

  const event = recordLegacyDirectLoginUsage({
    entryPoint: 'main.start-automation',
    accountId: 'account-1',
    accountName: 'Alice SDR',
    accountEmail: 'alice@example.com',
    source: 'main.start-automation',
    metadata: {
      reason: 'emergency-override'
    }
  }, {
    recordEvent: (eventInput) => {
      recorded.push(eventInput);
      return eventInput;
    }
  });

  assert.equal(recorded.length, 1);
  assert.equal(event, recorded[0]);
  assert.equal(event.type, 'legacy_direct_login_used');
  assert.equal(event.status, 'warning');
  assert.equal(event.accountId, 'account-1');
  assert.equal(event.accountName, 'Alice SDR');
  assert.equal(event.targetValue, 'main.start-automation');
  assert.equal(event.metadata.entryPoint, 'main.start-automation');
  assert.equal(event.metadata.accountEmail, 'alice@example.com');
  assert.equal(event.metadata.source, 'main.start-automation');
  assert.equal(event.metadata.reason, 'emergency-override');
});
