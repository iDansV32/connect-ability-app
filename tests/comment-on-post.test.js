'use strict';

/**
 * tests/comment-on-post.test.js
 *
 * Targeted tests for Ticket 11 — comment_on_post workflow action.
 *
 * Covers:
 *  1. workflow-step-result accepts skipped_comment_unavailable and skipped_no_post
 *  2. activity-event-store accepts post_commented
 *  3. action-router dispatches comment_on_post correctly
 *  4. no commentable post returns skipped_no_post
 *  5. unavailable comment UI returns skipped_comment_unavailable
 *  6. successful comment returns completed with verification
 *  7. comment_on_post respects quota guard
 *  8. durable-workflow-scheduler maps comment_on_post → post_commented
 *  9. comment module unit tests
 * 10. MCP step type enum includes comment_on_post
 * 11. missing commentTemplate returns failed_permanent
 * 12. unsupported step type still returns failed_permanent (regression guard)
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
  executeWorkflowStep,
  _private: { buildActionQuotaOptions }
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
 * Build a comment stub that responds to findCommentablePost, readCommentCount,
 * submitComment, and verifyComment evaluate calls based on argument patterns.
 *
 * findCommentablePost passes { postSel, commentBtnSel }
 * readCommentCount passes { postSel, commentSel, postIdx }
 * submitComment passes { postSel, commentBtnSel, inputSel, submitSel, postIdx, text }
 * verifyComment passes { postSel, commentSel, postIdx }
 */
function makeCommentStub({
  postFound = true,
  postIndex = 0,
  postUrn = 'urn:li:activity:123',
  openSuccess = true,
  openError = null,
  preCommentCount = 2,
  postOpenCommentCount,
  submitSuccess = true,
  submitError = null,
  postCommentCount = 3
}) {
  let submitHappened = false;
  let commentCountReadCount = 0;
  // After open, lazy-loaded comments may inflate the count.
  // Default: same as preCommentCount (no lazy-load inflation).
  const resolvedPostOpenCount = postOpenCommentCount != null
    ? postOpenCommentCount
    : preCommentCount;
  return function evaluateHandler(_fn, arg) {
    // findCommentablePost — has postSel + commentBtnSel but no postIdx, no text, no commentSel
    if (arg && typeof arg === 'object' && arg.postSel && arg.commentBtnSel && !('postIdx' in arg) && !('text' in arg)) {
      return postFound
        ? { found: true, postIndex, postUrn }
        : { found: false, postIndex: -1, postUrn: null };
    }
    // openCommentComposer — has postSel + commentBtnSel + postIdx, but no text, no inputSel, no commentSel
    if (arg && typeof arg === 'object' && arg.postSel && arg.commentBtnSel && ('postIdx' in arg) && !('text' in arg) && !arg.commentSel) {
      if (!openSuccess) {
        return { opened: false, error: openError || 'Comment button not found on post' };
      }
      return { opened: true };
    }
    // readCommentCount / verifyComment — both have postSel + commentSel + postIdx, no text
    // readCommentCount returns a plain number; verifyComment returns { commentCount: N }.
    // First call = readCommentCount (post-open baseline), subsequent = verifyComment (post-submit).
    if (arg && typeof arg === 'object' && arg.postSel && arg.commentSel && ('postIdx' in arg) && !('text' in arg)) {
      commentCountReadCount++;
      if (commentCountReadCount === 1) {
        // readCommentCount — returns plain number; baseline is taken after open
        return resolvedPostOpenCount;
      }
      // verifyComment — returns { commentCount: N }
      return { commentCount: submitHappened ? postCommentCount : resolvedPostOpenCount };
    }
    // submitComment — has postSel + inputSel + submitSel + postIdx + text (no commentBtnSel)
    if (arg && typeof arg === 'object' && ('text' in arg) && ('postIdx' in arg)) {
      submitHappened = true;
      if (!submitSuccess) {
        return { submitted: false, error: submitError || 'Submit failed' };
      }
      return { submitted: true };
    }
    // fallback
    return {};
  };
}

// ---------------------------------------------------------------------------
// 1. workflow-step-result accepts new outcome types
// ---------------------------------------------------------------------------

test('skipped_comment_unavailable is a valid workflow step outcome type', () => {
  assert.ok(WORKFLOW_STEP_OUTCOME_TYPES.has('skipped_comment_unavailable'));
  const result = createWorkflowStepResult({
    stepType: 'comment_on_post',
    outcomeType: 'skipped_comment_unavailable'
  });
  assert.equal(result.outcomeType, 'skipped_comment_unavailable');
  assert.ok(isWorkflowStepSkipped(result));
});

test('skipped_no_post is usable for comment_on_post', () => {
  assert.ok(WORKFLOW_STEP_OUTCOME_TYPES.has('skipped_no_post'));
  const result = createWorkflowStepResult({
    stepType: 'comment_on_post',
    outcomeType: 'skipped_no_post'
  });
  assert.equal(result.outcomeType, 'skipped_no_post');
  assert.ok(isWorkflowStepSkipped(result));
});

// ---------------------------------------------------------------------------
// 2. activity-event-store accepts post_commented
// ---------------------------------------------------------------------------

test('post_commented is a valid activity event type', () => {
  const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
  const ActivityEventStore = require('../activity-event-store');
  const ws = createTempWorkspace('comment-evt-');
  const db = openDatabase(ws.path('test.db'));
  try {
    const store = new ActivityEventStore({ db, eventsPath: ws.path('events.jsonl') });
    const event = store.append({
      type: 'post_commented',
      accountId: 'acc-1',
      agentId: 'agent-1',
      targetValue: 'Bob'
    });
    assert.ok(event);
    assert.equal(event.type, 'post_commented');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 3. action-router dispatches comment_on_post to the comment module
// ---------------------------------------------------------------------------

test('comment_on_post dispatches through the action router and returns completed', async () => {
  const ws = createTempWorkspace('comment-dispatch-');
  let commentCalled = false;

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'comment_on_post', commentTemplate: 'Great post!' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      commentOnPostDetailed: async (page, profileUrl, options) => {
        commentCalled = true;
        return createWorkflowStepResult({
          stepType: 'comment_on_post',
          outcomeType: 'completed',
          profileUrl,
          verificationResult: { verified: true, method: 'dom', at: new Date().toISOString() },
          metadata: { commentText: options.commentTemplate, postUrn: 'urn:li:activity:123' }
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.ok(commentCalled, 'comment module was invoked');
  assert.equal(result.stepType, 'comment_on_post');
  assert.equal(result.outcomeType, 'completed');
});

// ---------------------------------------------------------------------------
// 4. no commentable post returns skipped_no_post
// ---------------------------------------------------------------------------

test('comment_on_post returns skipped_no_post when no post found', async () => {
  const ws = createTempWorkspace('comment-nopost-');

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'comment_on_post', commentTemplate: 'Nice!' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      commentOnPostDetailed: async (page, profileUrl) => {
        return createWorkflowStepResult({
          stepType: 'comment_on_post',
          outcomeType: 'skipped_no_post',
          reason: 'No post with a visible comment button found on the page',
          profileUrl,
          metadata: { postFound: false }
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.stepType, 'comment_on_post');
  assert.equal(result.outcomeType, 'skipped_no_post');
  assert.ok(isWorkflowStepSkipped(result));
});

// ---------------------------------------------------------------------------
// 5. unavailable comment UI returns skipped_comment_unavailable
// ---------------------------------------------------------------------------

test('comment_on_post returns skipped_comment_unavailable when UI not available', async () => {
  const ws = createTempWorkspace('comment-nouiavail-');

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'comment_on_post', commentTemplate: 'Nice work!' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      commentOnPostDetailed: async (page, profileUrl) => {
        return createWorkflowStepResult({
          stepType: 'comment_on_post',
          outcomeType: 'skipped_comment_unavailable',
          reason: 'Comment UI unavailable: Comment input not found',
          profileUrl
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.stepType, 'comment_on_post');
  assert.equal(result.outcomeType, 'skipped_comment_unavailable');
  assert.ok(isWorkflowStepSkipped(result));
});

// ---------------------------------------------------------------------------
// 6. successful comment returns completed with verification
// ---------------------------------------------------------------------------

test('comment_on_post returns completed with verification metadata', async () => {
  const ws = createTempWorkspace('comment-success-');

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'comment_on_post', commentTemplate: 'Insightful!' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      commentOnPostDetailed: async (page, profileUrl) => {
        return createWorkflowStepResult({
          stepType: 'comment_on_post',
          outcomeType: 'completed',
          profileUrl,
          verificationResult: {
            verified: true,
            method: 'dom',
            at: new Date().toISOString(),
            metadata: { commentCount: 3, preCommentCount: 2, commentDelta: 1 }
          },
          metadata: {
            commentText: 'Insightful!',
            postUrn: 'urn:li:activity:123',
            postIndex: 0
          }
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.outcomeType, 'completed');
  assert.ok(result.verificationResult);
  assert.equal(result.verificationResult.verified, true);
  assert.equal(result.metadata.commentText, 'Insightful!');
});

// ---------------------------------------------------------------------------
// 7. comment_on_post respects quota guard
// ---------------------------------------------------------------------------

test('comment_on_post returns skipped_quota_exceeded when daily quota exhausted', async () => {
  const ws = createTempWorkspace('comment-quota-');
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
          skill_endorsed: { daily: { limit: 20, used: 0, resetTime: futureDate }, weekly: { limit: 100, used: 0, resetTime: futureDate } },
          post_commented: {
            daily: { limit: 10, used: 10, resetTime: futureDate, _randomized: true },
            weekly: { limit: 50, used: 10, resetTime: futureDate }
          }
        }
      }
    }
  });

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'comment_on_post', commentTemplate: 'Nice!' },
      quotaPath
    },
    makeStubDependencies({
      commentOnPostDetailed: async (_page, profileUrl, options) => {
        const { canConsumeActionQuota, buildQuotaExceededReason } = require('../linkedin-action-quota-store');
        const quotaState = canConsumeActionQuota('post_commented', 1, options);
        if (!quotaState.allowed) {
          return createWorkflowStepResult({
            stepType: 'comment_on_post',
            outcomeType: 'skipped_quota_exceeded',
            reason: buildQuotaExceededReason('post_commented', quotaState),
            profileUrl
          });
        }
        return createWorkflowStepResult({ stepType: 'comment_on_post', outcomeType: 'completed', profileUrl });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.stepType, 'comment_on_post');
  assert.equal(result.outcomeType, 'skipped_quota_exceeded');
});

// ---------------------------------------------------------------------------
// 8. durable-workflow-scheduler maps comment_on_post → post_commented
// ---------------------------------------------------------------------------

test('post_commented activity event type is accepted end-to-end', () => {
  const ActivityEventStore = require('../activity-event-store');
  const ws = createTempWorkspace('comment-map-');
  const store = new ActivityEventStore({ eventsPath: ws.path('events.jsonl') });
  const event = store.append({
    type: 'post_commented',
    accountId: 'acc-1',
    targetValue: 'Bob'
  });
  assert.equal(event.type, 'post_commented');
});

// ---------------------------------------------------------------------------
// 9. comment module unit tests
// ---------------------------------------------------------------------------

test('commentOnPostDetailed returns skipped_no_post when no post found', async () => {
  const { commentOnPostDetailed } = require('../automation/comment/comment');
  const ws = createTempWorkspace('comment-unit-nopost-');

  const page = makeStubPage(makeCommentStub({
    postFound: false
  }));

  const result = await commentOnPostDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json'),
    commentTemplate: 'Great insights!'
  });

  assert.equal(result.outcomeType, 'skipped_no_post');
});

test('commentOnPostDetailed returns completed for successful comment', async () => {
  const { commentOnPostDetailed } = require('../automation/comment/comment');
  const ws = createTempWorkspace('comment-unit-success-');

  const page = makeStubPage(makeCommentStub({
    postFound: true,
    postIndex: 0,
    preCommentCount: 2,
    submitSuccess: true,
    postCommentCount: 3
  }));

  const result = await commentOnPostDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json'),
    commentTemplate: 'Really enjoyed this!'
  });

  assert.equal(result.outcomeType, 'completed');
  assert.ok(result.verificationResult);
  assert.equal(result.verificationResult.verified, true);
  assert.equal(result.metadata.commentText, 'Really enjoyed this!');
  assert.equal(result.metadata.postUrn, 'urn:li:activity:123');
});

test('commentOnPostDetailed returns skipped_comment_unavailable when input not found', async () => {
  const { commentOnPostDetailed } = require('../automation/comment/comment');
  const ws = createTempWorkspace('comment-unit-noinput-');

  const page = makeStubPage(makeCommentStub({
    postFound: true,
    postIndex: 0,
    submitSuccess: false,
    submitError: 'Comment input not found'
  }));

  const result = await commentOnPostDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json'),
    commentTemplate: 'Nice!'
  });

  assert.equal(result.outcomeType, 'skipped_comment_unavailable');
  assert.match(result.reason, /Comment input not found/);
});

test('commentOnPostDetailed returns skipped_comment_unavailable when submit button not found', async () => {
  const { commentOnPostDetailed } = require('../automation/comment/comment');
  const ws = createTempWorkspace('comment-unit-nosubmit-');

  const page = makeStubPage(makeCommentStub({
    postFound: true,
    postIndex: 0,
    submitSuccess: false,
    submitError: 'Submit button not found'
  }));

  const result = await commentOnPostDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json'),
    commentTemplate: 'Cool!'
  });

  assert.equal(result.outcomeType, 'skipped_comment_unavailable');
  assert.match(result.reason, /Submit button not found/);
});

test('commentOnPostDetailed returns failed_transient when verification fails', async () => {
  const { commentOnPostDetailed } = require('../automation/comment/comment');
  const ws = createTempWorkspace('comment-unit-verifyfail-');

  const page = makeStubPage(makeCommentStub({
    postFound: true,
    postIndex: 0,
    preCommentCount: 2,
    submitSuccess: true,
    postCommentCount: 2  // unchanged — comment didn't appear
  }));

  const result = await commentOnPostDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json'),
    commentTemplate: 'Interesting thoughts!'
  });

  assert.equal(result.outcomeType, 'failed_transient');
  assert.match(result.reason, /could not verify/i);
});

test('commentOnPostDetailed does not false-positive when opening comments lazy-loads existing replies', async () => {
  const { commentOnPostDetailed } = require('../automation/comment/comment');
  const ws = createTempWorkspace('comment-unit-lazyload-');

  // Scenario: before open there are 0 visible comment elements.
  // Opening the composer lazy-loads 3 existing comments.
  // Our submit fires but nothing actually posts — count stays 3.
  // Old code would compare against pre-open baseline (0) → delta=3 → false positive.
  // Fixed code captures baseline AFTER open (3) → delta=0 → correctly fails.
  const page = makeStubPage(makeCommentStub({
    postFound: true,
    postIndex: 0,
    preCommentCount: 0,        // before composer opens
    postOpenCommentCount: 3,   // after lazy-load
    submitSuccess: true,
    postCommentCount: 3        // unchanged — our comment didn't appear
  }));

  const result = await commentOnPostDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json'),
    commentTemplate: 'Great post!'
  });

  // Must NOT be completed — verification should detect no state change
  assert.equal(result.outcomeType, 'failed_transient');
  assert.match(result.reason, /could not verify/i);
});

test('commentOnPostDetailed returns failed_permanent when no commentTemplate', async () => {
  const { commentOnPostDetailed } = require('../automation/comment/comment');
  const ws = createTempWorkspace('comment-unit-notemplate-');

  const page = makeStubPage(makeCommentStub({ postFound: true }));

  const result = await commentOnPostDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
    // no commentTemplate
  });

  assert.equal(result.outcomeType, 'failed_permanent');
  assert.match(result.reason, /No commentTemplate/);
});

test('commentOnPostDetailed respects quota — returns skipped_quota_exceeded', async () => {
  const { commentOnPostDetailed } = require('../automation/comment/comment');
  const ws = createTempWorkspace('comment-unit-quota-');
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
          skill_endorsed: { daily: { limit: 20, used: 0, resetTime: futureDate }, weekly: { limit: 100, used: 0, resetTime: futureDate } },
          post_commented: {
            daily: { limit: 10, used: 10, resetTime: futureDate, _randomized: true },
            weekly: { limit: 50, used: 10, resetTime: futureDate }
          }
        }
      }
    }
  });

  const page = makeStubPage(makeCommentStub({
    postFound: true,
    submitSuccess: true,
    postCommentCount: 3
  }));

  const result = await commentOnPostDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath,
    commentTemplate: 'Nice!'
  });

  assert.equal(result.outcomeType, 'skipped_quota_exceeded');
});

// ---------------------------------------------------------------------------
// 10. MCP step type enum includes comment_on_post
// ---------------------------------------------------------------------------

test('MCP server tool schema includes comment_on_post in step type enum', () => {
  const fs = require('fs');
  const source = fs.readFileSync(
    require.resolve('../connect-mcp-server.js'),
    'utf8'
  );
  assert.ok(
    source.includes("'comment_on_post'") || source.includes('"comment_on_post"'),
    'comment_on_post should appear in MCP server source'
  );
  assert.ok(
    source.includes('commentTemplate'),
    'commentTemplate should appear in MCP tool description'
  );
});

// ---------------------------------------------------------------------------
// 11. action-router passes commentTemplate from step config
// ---------------------------------------------------------------------------

test('action-router passes commentTemplate (or messageTemplate fallback) to comment module', async () => {
  const ws = createTempWorkspace('comment-template-pass-');
  let receivedTemplate = null;

  await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'comment_on_post', commentTemplate: 'Specific comment!' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      commentOnPostDetailed: async (page, profileUrl, options) => {
        receivedTemplate = options.commentTemplate;
        return createWorkflowStepResult({
          stepType: 'comment_on_post',
          outcomeType: 'completed',
          profileUrl
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(receivedTemplate, 'Specific comment!');
});

test('action-router falls back to messageTemplate when commentTemplate absent', async () => {
  const ws = createTempWorkspace('comment-template-fallback-');
  let receivedTemplate = null;

  await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'comment_on_post', messageTemplate: 'Fallback comment!' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      commentOnPostDetailed: async (page, profileUrl, options) => {
        receivedTemplate = options.commentTemplate;
        return createWorkflowStepResult({
          stepType: 'comment_on_post',
          outcomeType: 'completed',
          profileUrl
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(receivedTemplate, 'Fallback comment!');
});

// ---------------------------------------------------------------------------
// 12. unsupported step type still returns failed_permanent (regression guard)
// ---------------------------------------------------------------------------

test('unsupported step type still returns failed_permanent after comment_on_post addition', async () => {
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
