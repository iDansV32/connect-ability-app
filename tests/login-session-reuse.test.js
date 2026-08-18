'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  verifyLoggedInSession,
  _private: { isUsableAuthenticatedLinkedInUrl }
} = require('../automation/core/login');

test('authenticated restored LinkedIn page is verified without navigating again', async () => {
  let gotoCalls = 0;
  const page = {
    url: () => 'https://www.linkedin.com/search/results/people/?keywords=people',
    goto: async () => { gotoCalls += 1; }
  };

  const indicator = await verifyLoggedInSession(page, 12000, {
    waitForAnySelector: async () => 'a[href*="/messaging/"]'
  });

  assert.equal(indicator, 'a[href*="/messaging/"]');
  assert.equal(gotoCalls, 0);
});

test('login and challenge pages are never treated as reusable authenticated pages', () => {
  assert.equal(isUsableAuthenticatedLinkedInUrl('https://www.linkedin.com/feed/'), true);
  assert.equal(isUsableAuthenticatedLinkedInUrl('https://www.linkedin.com/login'), false);
  assert.equal(isUsableAuthenticatedLinkedInUrl('https://www.linkedin.com/checkpoint/challenge/'), false);
  assert.equal(isUsableAuthenticatedLinkedInUrl('https://example.com/feed/'), false);
});
