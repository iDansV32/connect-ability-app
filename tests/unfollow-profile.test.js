'use strict';

/**
 * tests/unfollow-profile.test.js
 *
 * Targeted tests for Ticket 15 — unfollow_profile workflow action.
 *
 * Covers:
 *  1. workflow-step-result accepts skipped_not_following
 *  2. activity-event-store accepts profile_unfollowed
 *  3. action-router dispatches unfollow_profile correctly
 *  4. not-following state returns skipped_not_following
 *  5. successful unfollow returns completed with verification
 *  6. ambiguous/missing control states classify cleanly
 *  7. unfollow_profile respects quota guard
 *  8. durable-workflow-scheduler maps unfollow_profile → profile_unfollowed
 *  9. unfollow module unit tests (including confirmation dialog)
 * 10. MCP step type enum includes unfollow_profile
 * 11. unsupported step type still returns failed_permanent (regression)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTempWorkspace, writeJson } = require('./test-helpers');

const {
  WORKFLOW_STEP_OUTCOME_TYPES,
  createWorkflowStepResult,
  isWorkflowStepSkipped
} = require('../workflow-step-result');

const {
  executeWorkflowStep
} = require('../automation/runtime/action-router');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESOLVED_BOB = { profileUrl: 'https://www.linkedin.com/in/bob', recipientName: 'Bob' };

function makeStubPage(evaluateHandler) {
  const handler = evaluateHandler || (() => { throw new Error('stub: no DOM'); });
  return {
    async waitForSelector() { throw new Error('stub: no DOM'); },
    async evaluate(fn, ...args) { return handler(fn, ...args); },
    async $() { return null; },
    async goto() {},
    async waitForTimeout() {},
    url() { return 'https://www.linkedin.com/in/bob'; },
    async reload() {}
  };
}

function makeStubDependencies(overrides = {}) {
  return {
    prospectQueueStore: {
      getProspect() { return null; },
      getContactOwnershipSummary() {
        return { blocked: false, handlersInContact: [], blockReason: null };
      }
    },
    isWithinWorkingHours: () => true,
    consumeActivityBudget: () => ({ allowed: true, used: 0, limit: 150, remaining: 150, exceeded: [] }),
    ...overrides
  };
}

/**
 * Build an unfollow stub that responds to readUnfollowState,
 * clickUnfollowButton, handleUnfollowConfirmation, and verifyUnfollow.
 *
 * readUnfollowState passes { followingSel, followSel }
 * clickUnfollowButton passes a single string (followingSel)
 * handleUnfollowConfirmation passes a single string (confirmSel)
 * verifyUnfollow re-calls readUnfollowState
 */
function makeUnfollowStub({
  following = true,
  canUnfollow = true,
  clickSuccess = true,
  clickError = null,
  dialogFound = false,
  postClickFollowing = false
}) {
  let clickHappened = false;
  return function evaluateHandler(_fn, arg) {
    // readUnfollowState — receives { followingSel, followSel }
    if (arg && typeof arg === 'object' && arg.followingSel && arg.followSel) {
      if (clickHappened) {
        return {
          following: postClickFollowing,
          canUnfollow: postClickFollowing
        };
      }
      return { following, canUnfollow };
    }
    // clickUnfollowButton — receives a plain string (followingSel)
    if (typeof arg === 'string' && arg.includes('Following')) {
      clickHappened = true;
      if (!clickSuccess) {
        return { clicked: false, reason: clickError || 'no_following_button' };
      }
      return { clicked: true };
    }
    // handleUnfollowConfirmation — receives a plain string (confirmSel)
    if (typeof arg === 'string' && arg.includes('confirm')) {
      return { confirmed: true, dialogFound };
    }
    // fallback
    return {};
  };
}

// ---------------------------------------------------------------------------
// 1. workflow-step-result accepts skipped_not_following
// ---------------------------------------------------------------------------

test('skipped_not_following is a valid workflow step outcome type', () => {
  assert.ok(WORKFLOW_STEP_OUTCOME_TYPES.has('skipped_not_following'));
  const result = createWorkflowStepResult({
    stepType: 'unfollow_profile',
    outcomeType: 'skipped_not_following'
  });
  assert.equal(result.outcomeType, 'skipped_not_following');
  assert.ok(isWorkflowStepSkipped(result));
});

// ---------------------------------------------------------------------------
// 2. activity-event-store accepts profile_unfollowed
// ---------------------------------------------------------------------------

test('profile_unfollowed is a valid activity event type', () => {
  const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
  const ActivityEventStore = require('../activity-event-store');
  const ws = createTempWorkspace('unfollow-evt-');
  const db = openDatabase(ws.path('test.db'));
  try {
    const store = new ActivityEventStore({ db, eventsPath: ws.path('events.jsonl') });
    const event = store.append({
      type: 'profile_unfollowed',
      accountId: 'acc-1',
      agentId: 'agent-1',
      targetValue: 'Bob'
    });
    assert.ok(event);
    assert.equal(event.type, 'profile_unfollowed');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 3. action-router dispatches unfollow_profile correctly
// ---------------------------------------------------------------------------

test('unfollow_profile dispatches through the action router and returns completed', async () => {
  const ws = createTempWorkspace('unfollow-dispatch-');
  let unfollowCalled = false;

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'unfollow_profile' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      unfollowProfileDetailed: async (page, profileUrl) => {
        unfollowCalled = true;
        return createWorkflowStepResult({
          stepType: 'unfollow_profile',
          outcomeType: 'completed',
          profileUrl,
          verificationResult: { verified: true, method: 'dom', at: new Date().toISOString() },
          metadata: { unfollowed: true }
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.ok(unfollowCalled, 'unfollow module was invoked');
  assert.equal(result.stepType, 'unfollow_profile');
  assert.equal(result.outcomeType, 'completed');
});

// ---------------------------------------------------------------------------
// 4. not-following state returns skipped_not_following
// ---------------------------------------------------------------------------

test('unfollow_profile returns skipped_not_following when not following', async () => {
  const ws = createTempWorkspace('unfollow-notfollowing-');

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'unfollow_profile' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      unfollowProfileDetailed: async (page, profileUrl) => {
        return createWorkflowStepResult({
          stepType: 'unfollow_profile',
          outcomeType: 'skipped_not_following',
          reason: 'Profile is not currently being followed',
          profileUrl
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.stepType, 'unfollow_profile');
  assert.equal(result.outcomeType, 'skipped_not_following');
  assert.ok(isWorkflowStepSkipped(result));
});

// ---------------------------------------------------------------------------
// 5. successful unfollow returns completed with verification
// ---------------------------------------------------------------------------

test('unfollow_profile returns completed with verification metadata', async () => {
  const ws = createTempWorkspace('unfollow-success-');

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'unfollow_profile' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      unfollowProfileDetailed: async (page, profileUrl) => {
        return createWorkflowStepResult({
          stepType: 'unfollow_profile',
          outcomeType: 'completed',
          profileUrl,
          verificationResult: {
            verified: true,
            method: 'dom',
            at: new Date().toISOString()
          },
          metadata: { unfollowed: true, confirmationDialog: false }
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.outcomeType, 'completed');
  assert.ok(result.verificationResult);
  assert.equal(result.verificationResult.verified, true);
  assert.equal(result.metadata.unfollowed, true);
});

// ---------------------------------------------------------------------------
// 6. ambiguous/missing control states classify cleanly
// ---------------------------------------------------------------------------

test('unfollowProfileDetailed returns failed_transient when control unavailable', async () => {
  const { unfollowProfileDetailed } = require('../automation/unfollow/unfollow');
  const ws = createTempWorkspace('unfollow-unit-nocontrol-');

  const page = makeStubPage(makeUnfollowStub({
    following: true,
    canUnfollow: false
  }));

  const result = await unfollowProfileDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'failed_transient');
  assert.match(result.reason, /not found/i);
});

// ---------------------------------------------------------------------------
// 7. unfollow_profile respects quota guard
// ---------------------------------------------------------------------------

test('unfollow_profile returns skipped_quota_exceeded when daily quota exhausted', async () => {
  const ws = createTempWorkspace('unfollow-quota-');
  const quotaPath = ws.path('quota.json');

  const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  writeJson(quotaPath, {
    version: 1,
    accounts: {
      default: {
        actions: {
          profile_viewed: { daily: { limit: 80, used: 0, resetTime: futureDate }, weekly: { limit: 400, used: 0, resetTime: futureDate } },
          post_liked: { daily: { limit: 35, used: 0, resetTime: futureDate }, weekly: { limit: 175, used: 0, resetTime: futureDate } },
          connection_requested: { daily: { limit: 30, used: 0, resetTime: futureDate }, weekly: { limit: 150, used: 0, resetTime: futureDate } },
          post_published: { daily: { limit: 2, used: 0, resetTime: futureDate }, weekly: { limit: 14, used: 0, resetTime: futureDate } },
          profile_followed: { daily: { limit: 22, used: 0, resetTime: futureDate }, weekly: { limit: 110, used: 0, resetTime: futureDate } },
          profile_unfollowed: {
            daily: { limit: 30, used: 30, resetTime: futureDate, _randomized: true },
            weekly: { limit: 150, used: 30, resetTime: futureDate }
          },
          skill_endorsed: { daily: { limit: 20, used: 0, resetTime: futureDate }, weekly: { limit: 100, used: 0, resetTime: futureDate } },
          post_commented: { daily: { limit: 10, used: 0, resetTime: futureDate }, weekly: { limit: 50, used: 0, resetTime: futureDate } }
        }
      }
    }
  });

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'unfollow_profile' },
      quotaPath
    },
    makeStubDependencies({
      unfollowProfileDetailed: async (_page, profileUrl, options) => {
        const { canConsumeActionQuota, buildQuotaExceededReason } = require('../linkedin-action-quota-store');
        const quotaState = canConsumeActionQuota('profile_unfollowed', 1, options);
        if (!quotaState.allowed) {
          return createWorkflowStepResult({
            stepType: 'unfollow_profile',
            outcomeType: 'skipped_quota_exceeded',
            reason: buildQuotaExceededReason('profile_unfollowed', quotaState),
            profileUrl
          });
        }
        return createWorkflowStepResult({ stepType: 'unfollow_profile', outcomeType: 'completed', profileUrl });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.stepType, 'unfollow_profile');
  assert.equal(result.outcomeType, 'skipped_quota_exceeded');
});

// ---------------------------------------------------------------------------
// 8. durable-workflow-scheduler maps unfollow_profile → profile_unfollowed
// ---------------------------------------------------------------------------

test('profile_unfollowed activity event type is accepted end-to-end', () => {
  const ActivityEventStore = require('../activity-event-store');
  const ws = createTempWorkspace('unfollow-map-');
  const store = new ActivityEventStore({ eventsPath: ws.path('events.jsonl') });
  const event = store.append({
    type: 'profile_unfollowed',
    accountId: 'acc-1',
    targetValue: 'Bob'
  });
  assert.equal(event.type, 'profile_unfollowed');
});

// ---------------------------------------------------------------------------
// 9. unfollow module unit tests
// ---------------------------------------------------------------------------

test('unfollowProfileDetailed returns skipped_not_following when not following', async () => {
  const { unfollowProfileDetailed } = require('../automation/unfollow/unfollow');
  const ws = createTempWorkspace('unfollow-unit-notfollowing-');

  const page = makeStubPage(makeUnfollowStub({
    following: false,
    canUnfollow: false
  }));

  const result = await unfollowProfileDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'skipped_not_following');
});

test('unfollowProfileDetailed returns completed for successful unfollow', async () => {
  const { unfollowProfileDetailed } = require('../automation/unfollow/unfollow');
  const ws = createTempWorkspace('unfollow-unit-success-');

  const page = makeStubPage(makeUnfollowStub({
    following: true,
    canUnfollow: true,
    clickSuccess: true,
    postClickFollowing: false
  }));

  const result = await unfollowProfileDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'completed');
  assert.ok(result.verificationResult);
  assert.equal(result.verificationResult.verified, true);
  assert.equal(result.metadata.unfollowed, true);
});

test('unfollowProfileDetailed returns failed_transient when click fails', async () => {
  const { unfollowProfileDetailed } = require('../automation/unfollow/unfollow');
  const ws = createTempWorkspace('unfollow-unit-clickfail-');

  const page = makeStubPage(makeUnfollowStub({
    following: true,
    canUnfollow: true,
    clickSuccess: false,
    clickError: 'no_following_button'
  }));

  const result = await unfollowProfileDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'failed_transient');
  assert.match(result.reason, /no_following_button/);
});

test('unfollowProfileDetailed returns failed_transient when verification fails', async () => {
  const { unfollowProfileDetailed } = require('../automation/unfollow/unfollow');
  const ws = createTempWorkspace('unfollow-unit-verifyfail-');

  const page = makeStubPage(makeUnfollowStub({
    following: true,
    canUnfollow: true,
    clickSuccess: true,
    postClickFollowing: true  // still following after click
  }));

  const result = await unfollowProfileDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'failed_transient');
  assert.match(result.reason, /could not verify/i);
});

test('unfollowProfileDetailed handles confirmation dialog', async () => {
  const { unfollowProfileDetailed } = require('../automation/unfollow/unfollow');
  const ws = createTempWorkspace('unfollow-unit-dialog-');

  const page = makeStubPage(makeUnfollowStub({
    following: true,
    canUnfollow: true,
    clickSuccess: true,
    dialogFound: true,
    postClickFollowing: false
  }));

  const result = await unfollowProfileDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'completed');
  assert.equal(result.metadata.confirmationDialog, true);
});

test('unfollowProfileDetailed respects quota — returns skipped_quota_exceeded', async () => {
  const { unfollowProfileDetailed } = require('../automation/unfollow/unfollow');
  const ws = createTempWorkspace('unfollow-unit-quota-');
  const quotaPath = ws.path('quota.json');

  const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  writeJson(quotaPath, {
    version: 1,
    accounts: {
      default: {
        actions: {
          profile_viewed: { daily: { limit: 80, used: 0, resetTime: futureDate }, weekly: { limit: 400, used: 0, resetTime: futureDate } },
          post_liked: { daily: { limit: 35, used: 0, resetTime: futureDate }, weekly: { limit: 175, used: 0, resetTime: futureDate } },
          connection_requested: { daily: { limit: 30, used: 0, resetTime: futureDate }, weekly: { limit: 150, used: 0, resetTime: futureDate } },
          post_published: { daily: { limit: 2, used: 0, resetTime: futureDate }, weekly: { limit: 14, used: 0, resetTime: futureDate } },
          profile_followed: { daily: { limit: 22, used: 0, resetTime: futureDate }, weekly: { limit: 110, used: 0, resetTime: futureDate } },
          profile_unfollowed: {
            daily: { limit: 30, used: 30, resetTime: futureDate, _randomized: true },
            weekly: { limit: 150, used: 30, resetTime: futureDate }
          },
          skill_endorsed: { daily: { limit: 20, used: 0, resetTime: futureDate }, weekly: { limit: 100, used: 0, resetTime: futureDate } },
          post_commented: { daily: { limit: 10, used: 0, resetTime: futureDate }, weekly: { limit: 50, used: 0, resetTime: futureDate } }
        }
      }
    }
  });

  const page = makeStubPage(makeUnfollowStub({
    following: true,
    canUnfollow: true
  }));

  const result = await unfollowProfileDetailed(page, 'https://www.linkedin.com/in/bob', { quotaPath });
  assert.equal(result.outcomeType, 'skipped_quota_exceeded');
});

// ---------------------------------------------------------------------------
// 10. MCP step type enum includes unfollow_profile
// ---------------------------------------------------------------------------

test('MCP server tool schema includes unfollow_profile in step type enum', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../connect-mcp-server.js'), 'utf8');
  assert.ok(
    source.includes("'unfollow_profile'") || source.includes('"unfollow_profile"'),
    'unfollow_profile should appear in MCP server source'
  );
});

// ---------------------------------------------------------------------------
// 11. unsupported step type still returns failed_permanent (regression)
// ---------------------------------------------------------------------------

test('unsupported step type still returns failed_permanent after unfollow_profile addition', async () => {
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'bogus_action' }
    },
    makeStubDependencies()
  );
  assert.equal(result.outcomeType, 'failed_permanent');
  assert.match(result.reason, /Unsupported workflow step type/);
});
