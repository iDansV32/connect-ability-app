'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TransportHealthStore = require('../automation/runtime/transport-health-store');
const {
  runConnectionSelectorCanary,
  shouldRerunConnectionSelectorCanary
} = require('../automation/dom/selector-canary');

function createTempStore() {
  const documentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selector-canary-'));
  return new TransportHealthStore({ documentsDir });
}

function createPage({ matchSelectors = [], discoveredProfileUrl = null } = {}) {
  return {
    gotoCalls: [],
    async goto(url) {
      this.gotoCalls.push(url);
    },
    async evaluate() {
      return discoveredProfileUrl;
    },
    async $$(selector) {
      if (!matchSelectors.includes(selector)) {
        return [];
      }
      return [{
        async isVisible() {
          return true;
        }
      }];
    }
  };
}

test('runConnectionSelectorCanary records success when at least one shared Connect selector matches', async () => {
  const store = createTempStore();
  const page = createPage({
    matchSelectors: ['main button:has-text("Connect")'],
    discoveredProfileUrl: 'https://www.linkedin.com/in/test-user/'
  });

  const result = await runConnectionSelectorCanary({
    accountEmail: 'alice@example.com',
    transportHealthStore: store,
    workflowPage: page
  });

  assert.equal(result.status, 'ok');
  assert.equal(page.gotoCalls[0], 'https://www.linkedin.com/in/test-user/');
  assert.equal(result.matchedSelectors.includes('main button:has-text("Connect")'), true);
  assert.equal(store.isTransportDisabled('dom', 'send_connection', 'alice@example.com'), false);
});

test('runConnectionSelectorCanary records selector drift when all shared selectors miss', async () => {
  const store = createTempStore();
  const page = createPage({
    discoveredProfileUrl: 'https://www.linkedin.com/in/test-user/'
  });

  const result = await runConnectionSelectorCanary({
    accountEmail: 'alice@example.com',
    transportHealthStore: store,
    workflowPage: page
  });

  assert.equal(result.status, 'failed');
  const state = store.getTransportState('dom', 'send_connection', 'alice@example.com');
  assert.equal(state.failureCount, 1);
  assert.equal(state.lastFailureReason, 'selector_drift_detected');
});

test('shouldRerunConnectionSelectorCanary only returns true after threshold failures until selector drift is recorded', () => {
  const store = createTempStore();
  const email = 'alice@example.com';

  assert.equal(shouldRerunConnectionSelectorCanary(store, email), false);

  store.recordFailure('dom', 'send_connection', email, { reason: 'connect_button_not_found', timestamp: '2026-03-22T10:00:00.000Z' });
  store.recordFailure('dom', 'send_connection', email, { reason: 'connect_button_not_found', timestamp: '2026-03-22T10:01:00.000Z' });
  assert.equal(shouldRerunConnectionSelectorCanary(store, email, new Date('2026-03-22T10:01:30.000Z')), false);

  store.recordFailure('dom', 'send_connection', email, { reason: 'connect_button_not_found', timestamp: '2026-03-22T10:02:00.000Z' });
  assert.equal(shouldRerunConnectionSelectorCanary(store, email, new Date('2026-03-22T10:02:30.000Z')), true);

  store.recordFailure('dom', 'send_connection', email, { reason: 'selector_drift_detected', timestamp: '2026-03-22T10:03:00.000Z' });
  assert.equal(shouldRerunConnectionSelectorCanary(store, email, new Date('2026-03-22T10:03:30.000Z')), false);
});
