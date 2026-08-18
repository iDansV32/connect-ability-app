'use strict';

/**
 * tests/session-auth-redirect.test.js
 *
 * Tests for LinkedIn session auth-redirect detection.
 * Verifies that isLinkedInAuthRedirect and isPageOnAuthRedirect correctly
 * identify login, checkpoint, and challenge URLs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isLinkedInAuthRedirect,
  isPageOnAuthRedirect
} = require('../automation/core/session-state');

// ---------------------------------------------------------------------------
// isLinkedInAuthRedirect — URL pattern matching
// ---------------------------------------------------------------------------

test('isLinkedInAuthRedirect detects /uas/login', () => {
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/uas/login'), true);
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/uas/login?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F'), true);
});

test('isLinkedInAuthRedirect detects /login', () => {
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/login'), true);
});

test('isLinkedInAuthRedirect detects /checkpoint', () => {
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/checkpoint/challenge/123'), true);
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/checkpoint/lg/login-submit'), true);
});

test('isLinkedInAuthRedirect detects /challenge', () => {
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/challenge'), true);
});

test('isLinkedInAuthRedirect returns false for normal pages', () => {
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/feed/'), false);
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/in/madison-crane'), false);
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/search/results/people/'), false);
  assert.equal(isLinkedInAuthRedirect('https://www.linkedin.com/messaging/'), false);
});

test('isLinkedInAuthRedirect handles empty/null input', () => {
  assert.equal(isLinkedInAuthRedirect(''), false);
  assert.equal(isLinkedInAuthRedirect(null), false);
  assert.equal(isLinkedInAuthRedirect(undefined), false);
});

// ---------------------------------------------------------------------------
// isPageOnAuthRedirect — page object integration
// ---------------------------------------------------------------------------

test('isPageOnAuthRedirect returns true for page on login URL', async () => {
  const page = { url: () => 'https://www.linkedin.com/uas/login?session_redirect=foo' };
  assert.equal(await isPageOnAuthRedirect(page), true);
});

test('isPageOnAuthRedirect returns false for page on feed URL', async () => {
  const page = { url: () => 'https://www.linkedin.com/feed/' };
  assert.equal(await isPageOnAuthRedirect(page), false);
});

test('isPageOnAuthRedirect handles async page.url()', async () => {
  const page = { url: () => Promise.resolve('https://www.linkedin.com/checkpoint/challenge/456') };
  assert.equal(await isPageOnAuthRedirect(page), true);
});

test('isPageOnAuthRedirect returns false on error', async () => {
  const page = { url: () => { throw new Error('page closed'); } };
  assert.equal(await isPageOnAuthRedirect(page), false);
});
