'use strict';

/**
 * tests/profile-storage-fixes.test.js
 *
 * Tests for profile storage corruption fixes:
 *  1. cleanLinkedInSlugName strips pure-digit and mixed-alphanumeric suffixes
 *  2. cleanLinkedInSlugName preserves normal name parts
 *  3. profileMatchesAccount returns false for null-to-null matching
 *  4. profileMatchesAccount returns true for matching accountIds
 *  5. deriveRecipientNameFromProfileUrl uses shared cleaner
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempWorkspace, readJson } = require('./test-helpers');

// ---------------------------------------------------------------------------
// 1–2. cleanLinkedInSlugName
// ---------------------------------------------------------------------------

const { cleanLinkedInSlugName } = require('../automation/profile/url-utils');

test('cleanLinkedInSlugName strips pure-digit suffix', () => {
  assert.equal(cleanLinkedInSlugName('ivan-dans-517204886'), 'Ivan Dans');
});

test('cleanLinkedInSlugName strips mixed-alphanumeric suffix', () => {
  assert.equal(cleanLinkedInSlugName('madison-crane-4c7a91e02'), 'Madison Crane');
});

test('cleanLinkedInSlugName strips multiple trailing tokens', () => {
  assert.equal(cleanLinkedInSlugName('sara-jones-7qmzkt'), 'Sara Jones');
  assert.equal(cleanLinkedInSlugName('liam-walder-8kd3rp'), 'Liam Walder');
});

test('cleanLinkedInSlugName preserves simple name slugs', () => {
  assert.equal(cleanLinkedInSlugName('john-smith'), 'John Smith');
  assert.equal(cleanLinkedInSlugName('alice'), 'Alice');
});

test('cleanLinkedInSlugName preserves hyphenated names without digits', () => {
  assert.equal(cleanLinkedInSlugName('jean-paul-martin'), 'Jean Paul Martin');
});

test('cleanLinkedInSlugName handles empty input', () => {
  assert.equal(cleanLinkedInSlugName(''), '');
  assert.equal(cleanLinkedInSlugName(null), '');
  assert.equal(cleanLinkedInSlugName(undefined), '');
});

test('cleanLinkedInSlugName strips pure-digit-only slug', () => {
  assert.equal(cleanLinkedInSlugName('12345'), '');
});

// ---------------------------------------------------------------------------
// 3–5. profileMatchesAccount + storage behavior
// ---------------------------------------------------------------------------

const {
  storeProfileAction,
  _private: { profileMatchesAccount }
} = require('../automation/profile/storage');

test('profileMatchesAccount returns false when both accountIds are null', () => {
  assert.equal(profileMatchesAccount({ accountId: null }, { accountId: null }), false);
  assert.equal(profileMatchesAccount({ accountId: '' }, { accountId: '' }), false);
});

test('profileMatchesAccount returns true when accountIds match', () => {
  assert.equal(profileMatchesAccount({ accountId: 'acc-1' }, { accountId: 'acc-1' }), true);
  assert.equal(profileMatchesAccount({ accountId: 'acc-1' }, { accountId: 'acc-2' }), false);
});

test('storeProfileAction does not merge into null-account profile when account context is unset', () => {
  const workspace = createTempWorkspace('profile-storage-null-account-');
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousContext = global.currentLinkedInAccountContext;

  try {
    process.env.HOME = workspace.root;
    process.env.USERPROFILE = workspace.root;
    global.currentLinkedInAccountContext = {};

    const profilesDir = path.join(workspace.root, 'Documents', 'Connect-Ability');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(
      path.join(profilesDir, 'profiles.json'),
      JSON.stringify([
        {
          url: 'https://www.linkedin.com/in/madison-crane-4c7a91e02',
          accountId: null,
          firstName: 'Madison',
          lastName: 'Crane',
          fullName: 'Madison Crane',
          actions: [{ type: 'Profile Viewed', timestamp: '2026-04-01T00:00:00.000Z', notes: 'existing' }]
        }
      ], null, 2)
    );

    storeProfileAction(
      'https://www.linkedin.com/in/madison-crane-4c7a91e02/',
      { firstName: '', lastName: '', fullName: '', position: '', company: '', email: '' },
      'Connection Request Sent',
      'new action'
    );

    const profiles = readJson(path.join(profilesDir, 'profiles.json'));
    assert.equal(profiles.length, 2, 'should create a new record rather than corrupt the existing null-account record');
    assert.equal(profiles[0].actions.length, 1, 'existing record must remain untouched');
    assert.equal(profiles[1].fullName, 'Madison Crane');
    assert.equal(profiles[1].actions.at(-1).type, 'Connection Request Sent');
  } finally {
    global.currentLinkedInAccountContext = previousContext;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    workspace.cleanup();
  }
});

test('storeProfileAction updates the matching account-scoped profile when accountIds match', () => {
  const workspace = createTempWorkspace('profile-storage-account-match-');
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousContext = global.currentLinkedInAccountContext;

  try {
    process.env.HOME = workspace.root;
    process.env.USERPROFILE = workspace.root;
    global.currentLinkedInAccountContext = { accountId: 'acc-1', accountName: 'Account One' };

    const profilesDir = path.join(workspace.root, 'Documents', 'Connect-Ability');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(
      path.join(profilesDir, 'profiles.json'),
      JSON.stringify([
        {
          url: 'https://www.linkedin.com/in/nora-vidal-santos',
          accountId: 'acc-1',
          accountName: 'Account One',
          firstName: 'Nora',
          lastName: 'Vidal Santos',
          fullName: 'Nora Vidal Santos',
          actions: [{ type: 'Profile Viewed', timestamp: '2026-04-01T00:00:00.000Z', notes: 'existing' }]
        }
      ], null, 2)
    );

    storeProfileAction(
      'https://www.linkedin.com/in/nora-vidal-santos/',
      { firstName: 'Nora', lastName: 'Vidal Santos', fullName: 'Nora Vidal Santos', position: '', company: '', email: '' },
      'Connection Request Sent',
      'new action'
    );

    const profiles = readJson(path.join(profilesDir, 'profiles.json'));
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].actions.length, 2);
    assert.equal(profiles[0].actions.at(-1).type, 'Connection Request Sent');
  } finally {
    global.currentLinkedInAccountContext = previousContext;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. deriveRecipientNameFromProfileUrl uses shared cleaner
// ---------------------------------------------------------------------------

const { _private } = require('../automation/runtime/action-router');
const { deriveRecipientNameFromProfileUrl } = _private;

test('deriveRecipientNameFromProfileUrl strips mixed-alphanumeric suffixes', () => {
  assert.equal(
    deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/madison-crane-4c7a91e02'),
    'Madison Crane'
  );
});

test('deriveRecipientNameFromProfileUrl strips pure-digit suffixes', () => {
  assert.equal(
    deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/ivan-dans-517204886'),
    'Ivan Dans'
  );
});

test('deriveRecipientNameFromProfileUrl handles clean slug', () => {
  assert.equal(
    deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/john-smith'),
    'John Smith'
  );
});

test('deriveRecipientNameFromProfileUrl handles trailing slash', () => {
  assert.equal(
    deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/madison-crane-4c7a91e02/'),
    'Madison Crane'
  );
});

test('deriveRecipientNameFromProfileUrl returns empty for invalid URL', () => {
  assert.equal(deriveRecipientNameFromProfileUrl(''), '');
  assert.equal(deriveRecipientNameFromProfileUrl('https://example.com'), '');
});

// ---------------------------------------------------------------------------
// 7. extract.js URL fallback uses shared cleaner (integration)
// ---------------------------------------------------------------------------

test('extractProfileDetails URL fallback strips slug suffixes', async () => {
  // We test the URL fallback path by providing a stub page that returns
  // empty profile data from all DOM selectors, forcing the URL fallback.
  const { extractProfileDetails } = require('../automation/profile/extract');

  const stubPage = {
    async evaluate() {
      // Return empty profile — forces URL fallback
      return {
        firstName: '',
        lastName: '',
        fullName: '',
        title: 'Not Available',
        position: 'Not Available',
        company: 'Not Available',
        profileUrl: '',
        debug: []
      };
    },
    async waitForSelector() { return null; },
    async $() { return null; },
    url() { return 'https://www.linkedin.com/in/madison-crane-4c7a91e02/'; }
  };

  const details = await extractProfileDetails(stubPage, 'https://www.linkedin.com/in/madison-crane-4c7a91e02/');
  assert.equal(details.firstName, 'Madison');
  assert.equal(details.fullName, 'Madison Crane');
  // Should NOT contain the hash suffix
  assert.ok(!details.fullName.includes('1883'), 'fullName should not contain hash suffix');
});

test('storeProfileAction URL fallback preserves multi-part surnames while stripping slug suffixes', () => {
  const workspace = createTempWorkspace('profile-storage-url-fallback-');
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousContext = global.currentLinkedInAccountContext;

  try {
    process.env.HOME = workspace.root;
    process.env.USERPROFILE = workspace.root;
    global.currentLinkedInAccountContext = { accountId: 'acc-2', accountName: 'Account Two' };

    storeProfileAction(
      'https://www.linkedin.com/in/nora-vidal-santos-4c7a91e02/',
      { firstName: '', lastName: '', fullName: '', position: '', company: '', email: '' },
      'Profile Viewed',
      'fallback name extraction'
    );

    const profiles = readJson(path.join(workspace.root, 'Documents', 'Connect-Ability', 'profiles.json'));
    assert.equal(profiles[0].firstName, 'Nora');
    assert.equal(profiles[0].lastName, 'Vidal Santos');
    assert.equal(profiles[0].fullName, 'Nora Vidal Santos');
  } finally {
    global.currentLinkedInAccountContext = previousContext;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    workspace.cleanup();
  }
});
