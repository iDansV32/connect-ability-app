'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PendingInviteSweepStore,
  DEFAULT_SWEEP_INTERVAL_MS
} = require('../automation/safety/pending-invite-sweep-store');
const {
  LINKEDIN_SENT_INVITES_URL,
  maybeSweepPendingInvites,
  _private
} = require('../automation/safety/pending-invite-manager');
const { createTempWorkspace, readJson } = require('./test-helpers');

const TARGET_URL = 'https://www.linkedin.com/in/testuser/';
const ACCOUNT_EMAIL = 'seller@example.com';

test('PendingInviteSweepStore enforces cadence per account and persists sweep metadata', () => {
  const workspace = createTempWorkspace('pending-invite-store-');
  try {
    const storePath = workspace.path('pending-invite-sweeps.json');
    const store = new PendingInviteSweepStore({ storePath });
    const startedAt = new Date('2026-03-22T12:00:00.000Z');

    assert.equal(store.shouldRunSweep(ACCOUNT_EMAIL, { now: startedAt }), true);

    store.recordSweep(ACCOUNT_EMAIL, {
      now: startedAt,
      timestamp: startedAt.toISOString(),
      withdrewCount: 3,
      candidateCount: 9,
      status: 'completed'
    });

    assert.equal(
      store.shouldRunSweep(ACCOUNT_EMAIL, {
        now: new Date(startedAt.getTime() + 60 * 60 * 1000)
      }),
      false
    );
    assert.equal(
      store.shouldRunSweep(ACCOUNT_EMAIL, {
        now: new Date(startedAt.getTime() + DEFAULT_SWEEP_INTERVAL_MS + 1000)
      }),
      true
    );

    const onDisk = readJson(storePath);
    assert.equal(onDisk.accounts[ACCOUNT_EMAIL].lastWithdrawCount, 3);
    assert.equal(onDisk.accounts[ACCOUNT_EMAIL].lastCandidateCount, 9);
  } finally {
    workspace.cleanup();
  }
});

test('parseInviteAgeToDays handles common LinkedIn relative-age strings', () => {
  assert.equal(_private.parseInviteAgeToDays('Sent 3 days ago'), 3);
  assert.equal(_private.parseInviteAgeToDays('Invited 2 weeks ago'), 14);
  assert.equal(_private.parseInviteAgeToDays('Pending for 4 months'), 120);
  assert.equal(_private.parseInviteAgeToDays('Sent 1 yr ago'), 365);
  assert.equal(_private.parseInviteAgeToDays('today'), 0);
  assert.equal(_private.parseInviteAgeToDays('yesterday'), 1);
  assert.equal(_private.parseInviteAgeToDays('No relative age here'), null);
});

test('maybeSweepPendingInvites skips when account email is missing', async () => {
  const result = await maybeSweepPendingInvites({ url: () => TARGET_URL }, {});
  assert.deepEqual(result, {
    attempted: false,
    skipped: true,
    reason: 'missing_account_email',
    status: null,
    withdrewCount: 0,
    candidateCount: 0,
    error: null
  });
});

test('maybeSweepPendingInvites withdraws only old invites and returns to the profile page', async () => {
  const workspace = createTempWorkspace('pending-invite-manager-');
  try {
    const store = new PendingInviteSweepStore({
      storePath: workspace.path('pending-invite-sweeps.json')
    });
    const page = {
      url() {
        return TARGET_URL;
      }
    };

    const navigations = [];
    const withdrawnKeys = [];
    let passIndex = 0;
    const result = await maybeSweepPendingInvites(page, {
      accountEmail: ACCOUNT_EMAIL,
      pendingInviteMinAgeDays: 21
    }, {
      sweepStore: store,
      navigate: async (_page, url) => navigations.push(url),
      waitForPageReady: async () => {},
      listVisibleCandidates: async () => {
        if (passIndex > 0) {
          return [];
        }
        passIndex += 1;
        return [
          { key: 'recent', ageDays: 7, profileLink: null },
          { key: 'old-1', ageDays: 45, profileLink: 'https://www.linkedin.com/in/old-1/' },
          { key: 'old-2', ageDays: 90, profileLink: 'https://www.linkedin.com/in/old-2/' }
        ];
      },
      withdrawCandidate: async (_page, candidate) => {
        withdrawnKeys.push(candidate.key);
        return true;
      },
      scrollPage: async () => false,
      returnToUrl: async (_page, url) => navigations.push(url),
      randomDelayFn: async () => {},
      logAction: () => {},
      logError: () => {}
    });

    assert.equal(result.attempted, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.withdrewCount, 2);
    assert.equal(result.candidateCount, 3);
    assert.deepEqual(withdrawnKeys, ['old-1', 'old-2']);
    assert.deepEqual(navigations, [LINKEDIN_SENT_INVITES_URL, TARGET_URL]);

    const state = store.getAccountState(ACCOUNT_EMAIL);
    assert.equal(state.lastWithdrawCount, 2);
    assert.equal(state.lastCandidateCount, 3);
    assert.equal(state.lastStatus, 'completed');
  } finally {
    workspace.cleanup();
  }
});

test('maybeSweepPendingInvites respects cadence and avoids navigating when the last sweep is recent', async () => {
  const workspace = createTempWorkspace('pending-invite-cadence-');
  try {
    const store = new PendingInviteSweepStore({
      storePath: workspace.path('pending-invite-sweeps.json')
    });
    const now = new Date('2026-03-22T12:00:00.000Z');
    store.recordSweep(ACCOUNT_EMAIL, {
      now,
      timestamp: now.toISOString(),
      withdrewCount: 1,
      candidateCount: 2,
      status: 'completed'
    });

    let navigated = false;
    const result = await maybeSweepPendingInvites({
      url() {
        return TARGET_URL;
      }
    }, {
      accountEmail: ACCOUNT_EMAIL,
      now: new Date(now.getTime() + 60 * 60 * 1000)
    }, {
      sweepStore: store,
      navigate: async () => {
        navigated = true;
      }
    });

    assert.equal(result.attempted, false);
    assert.equal(result.reason, 'sweep_not_due');
    assert.equal(navigated, false);
  } finally {
    workspace.cleanup();
  }
});

test('maybeSweepPendingInvites records failure and still returns to the target profile', async () => {
  const workspace = createTempWorkspace('pending-invite-failure-');
  try {
    const store = new PendingInviteSweepStore({
      storePath: workspace.path('pending-invite-sweeps.json')
    });
    const navigations = [];

    const result = await maybeSweepPendingInvites({
      url() {
        return TARGET_URL;
      }
    }, {
      accountEmail: ACCOUNT_EMAIL
    }, {
      sweepStore: store,
      navigate: async (_page, url) => navigations.push(url),
      waitForPageReady: async () => {},
      listVisibleCandidates: async () => {
        throw new Error('sent invites page unavailable');
      },
      returnToUrl: async (_page, url) => navigations.push(url),
      logAction: () => {},
      logError: () => {}
    });

    assert.equal(result.attempted, true);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /sent invites page unavailable/i);
    assert.deepEqual(navigations, [LINKEDIN_SENT_INVITES_URL, TARGET_URL]);

    const state = store.getAccountState(ACCOUNT_EMAIL);
    assert.equal(state.lastStatus, 'failed');
    assert.match(state.lastError, /sent invites page unavailable/i);
  } finally {
    workspace.cleanup();
  }
});
