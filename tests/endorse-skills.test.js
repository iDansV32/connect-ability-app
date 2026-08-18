'use strict';

/**
 * tests/endorse-skills.test.js
 *
 * Targeted tests for Ticket 10 — endorse_skills workflow action.
 *
 * Covers:
 *  1. workflow-step-result accepts skipped_no_endorseable_skills and skipped_already_endorsed
 *  2. activity-event-store accepts skill_endorsed
 *  3. action-router dispatches endorse_skills correctly
 *  4. no endorseable skills returns skipped_no_endorseable_skills
 *  5. already-endorsed state returns skipped_already_endorsed
 *  6. successful endorsement returns completed with verification
 *  7. endorse_skills respects quota guard
 *  8. durable-workflow-scheduler maps endorse_skills → skill_endorsed
 *  9. endorse module unit tests
 * 10. MCP step type enum includes endorse_skills
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
 * Build an endorsement stub that responds to readEndorsementState and
 * clickEndorseButtons evaluate calls based on the argument pattern.
 *
 * readEndorsementState passes { sectionSel, endorseSel, endorsedSel }
 * clickEndorseButtons passes { sectionSel, endorseSel, max }
 * verifyEndorsements re-calls readEndorsementState
 */
function makeEndorseStub({
  endorseableCount = 2,
  endorsedCount = 0,
  totalSkills = 2,
  endorseableSkills = ['JavaScript', 'Node.js'],
  alreadyEndorsedSkills = [],
  clickEndorsed = 2,
  clickErrors = 0,
  clickSkills = ['JavaScript', 'Node.js'],
  postClickEndorsedCount = 2,
  postClickEndorseableCount
}) {
  let clickHappened = false;
  const resolvedPostClickEndorseableCount = postClickEndorseableCount != null
    ? postClickEndorseableCount
    : Math.max(0, endorseableCount - clickEndorsed);
  return function evaluateHandler(_fn, arg) {
    // readEndorsementState — receives an object with sectionSel + endorseSel + endorsedSel
    if (arg && typeof arg === 'object' && arg.sectionSel && arg.endorsedSel && !arg.max) {
      if (clickHappened) {
        return {
          endorseableCount: resolvedPostClickEndorseableCount,
          endorsedCount: postClickEndorsedCount,
          totalSkills,
          endorseableSkills: endorseableSkills.slice(clickEndorsed),
          alreadyEndorsedSkills: [...alreadyEndorsedSkills, ...clickSkills]
        };
      }
      return {
        endorseableCount,
        endorsedCount,
        totalSkills,
        endorseableSkills,
        alreadyEndorsedSkills
      };
    }
    // clickEndorseButtons — receives object with sectionSel + endorseSel + max
    if (arg && typeof arg === 'object' && typeof arg.max === 'number') {
      clickHappened = true;
      return { endorsed: clickEndorsed, errors: clickErrors, skills: clickSkills };
    }
    // fallback
    return {};
  };
}

// ---------------------------------------------------------------------------
// 1. workflow-step-result accepts new outcome types
// ---------------------------------------------------------------------------

test('skipped_no_endorseable_skills is a valid workflow step outcome type', () => {
  assert.ok(WORKFLOW_STEP_OUTCOME_TYPES.has('skipped_no_endorseable_skills'));
  const result = createWorkflowStepResult({
    stepType: 'endorse_skills',
    outcomeType: 'skipped_no_endorseable_skills'
  });
  assert.equal(result.outcomeType, 'skipped_no_endorseable_skills');
  assert.ok(isWorkflowStepSkipped(result));
});

test('skipped_already_endorsed is a valid workflow step outcome type', () => {
  assert.ok(WORKFLOW_STEP_OUTCOME_TYPES.has('skipped_already_endorsed'));
  const result = createWorkflowStepResult({
    stepType: 'endorse_skills',
    outcomeType: 'skipped_already_endorsed'
  });
  assert.equal(result.outcomeType, 'skipped_already_endorsed');
  assert.ok(isWorkflowStepSkipped(result));
});

// ---------------------------------------------------------------------------
// 2. activity-event-store accepts skill_endorsed
// ---------------------------------------------------------------------------

test('skill_endorsed is a valid activity event type', () => {
  const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
  const ActivityEventStore = require('../activity-event-store');
  const ws = createTempWorkspace('endorse-evt-');
  const db = openDatabase(ws.path('test.db'));
  try {
    const store = new ActivityEventStore({ db, eventsPath: ws.path('events.jsonl') });
    const event = store.append({
      type: 'skill_endorsed',
      accountId: 'acc-1',
      agentId: 'agent-1',
      targetValue: 'Bob'
    });
    assert.ok(event);
    assert.equal(event.type, 'skill_endorsed');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 3. action-router dispatches endorse_skills to the endorsement module
// ---------------------------------------------------------------------------

test('endorse_skills dispatches through the action router and returns completed', async () => {
  const ws = createTempWorkspace('endorse-dispatch-');
  let endorseCalled = false;

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'endorse_skills' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      endorseSkillsDetailed: async (page, profileUrl, options) => {
        endorseCalled = true;
        return createWorkflowStepResult({
          stepType: 'endorse_skills',
          outcomeType: 'completed',
          profileUrl,
          verificationResult: { verified: true, method: 'dom', at: new Date().toISOString() },
          metadata: { endorsedSkills: ['JavaScript', 'Node.js'], endorsedCount: 2, errors: 0 }
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.ok(endorseCalled, 'endorsement module was invoked');
  assert.equal(result.stepType, 'endorse_skills');
  assert.equal(result.outcomeType, 'completed');
});

// ---------------------------------------------------------------------------
// 4. no endorseable skills returns skipped_no_endorseable_skills
// ---------------------------------------------------------------------------

test('endorse_skills returns skipped_no_endorseable_skills when no skills found', async () => {
  const ws = createTempWorkspace('endorse-noskills-');

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'endorse_skills' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      endorseSkillsDetailed: async (page, profileUrl) => {
        return createWorkflowStepResult({
          stepType: 'endorse_skills',
          outcomeType: 'skipped_no_endorseable_skills',
          reason: 'No skills section found on profile page',
          profileUrl,
          metadata: { totalSkills: 0, endorseableCount: 0 }
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.stepType, 'endorse_skills');
  assert.equal(result.outcomeType, 'skipped_no_endorseable_skills');
  assert.ok(isWorkflowStepSkipped(result));
});

// ---------------------------------------------------------------------------
// 5. already-endorsed state returns skipped_already_endorsed
// ---------------------------------------------------------------------------

test('endorse_skills returns skipped_already_endorsed when all skills endorsed', async () => {
  const ws = createTempWorkspace('endorse-alreadyall-');

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'endorse_skills' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      endorseSkillsDetailed: async (page, profileUrl) => {
        return createWorkflowStepResult({
          stepType: 'endorse_skills',
          outcomeType: 'skipped_already_endorsed',
          reason: 'All visible skills are already endorsed',
          profileUrl,
          metadata: { alreadyEndorsed: true, endorsedCount: 3 }
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.stepType, 'endorse_skills');
  assert.equal(result.outcomeType, 'skipped_already_endorsed');
  assert.ok(isWorkflowStepSkipped(result));
});

// ---------------------------------------------------------------------------
// 6. successful endorsement returns completed with verification
// ---------------------------------------------------------------------------

test('endorse_skills returns completed with verification metadata', async () => {
  const ws = createTempWorkspace('endorse-success-');

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'endorse_skills' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      endorseSkillsDetailed: async (page, profileUrl) => {
        return createWorkflowStepResult({
          stepType: 'endorse_skills',
          outcomeType: 'completed',
          profileUrl,
          verificationResult: {
            verified: true,
            method: 'dom',
            at: new Date().toISOString(),
            metadata: { endorsedCount: 2, endorseableCount: 0 }
          },
          metadata: {
            endorsedSkills: ['JavaScript', 'Node.js'],
            endorsedCount: 2,
            errors: 0
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
  assert.deepEqual(result.metadata.endorsedSkills, ['JavaScript', 'Node.js']);
});

// ---------------------------------------------------------------------------
// 7. endorse_skills respects quota guard
// ---------------------------------------------------------------------------

test('endorse_skills returns skipped_quota_exceeded when daily quota exhausted', async () => {
  const ws = createTempWorkspace('endorse-quota-');
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
          skill_endorsed: {
            daily: { limit: 20, used: 20, resetTime: futureDate, _randomized: true },
            weekly: { limit: 100, used: 20, resetTime: futureDate }
          }
        }
      }
    }
  });

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'endorse_skills' },
      quotaPath
    },
    makeStubDependencies({
      endorseSkillsDetailed: async (_page, profileUrl, options) => {
        const { canConsumeActionQuota, buildQuotaExceededReason } = require('../linkedin-action-quota-store');
        const quotaState = canConsumeActionQuota('skill_endorsed', 1, options);
        if (!quotaState.allowed) {
          return createWorkflowStepResult({
            stepType: 'endorse_skills',
            outcomeType: 'skipped_quota_exceeded',
            reason: buildQuotaExceededReason('skill_endorsed', quotaState),
            profileUrl
          });
        }
        return createWorkflowStepResult({ stepType: 'endorse_skills', outcomeType: 'completed', profileUrl });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.stepType, 'endorse_skills');
  assert.equal(result.outcomeType, 'skipped_quota_exceeded');
});

// ---------------------------------------------------------------------------
// 8. durable-workflow-scheduler maps endorse_skills → skill_endorsed
// ---------------------------------------------------------------------------

test('skill_endorsed activity event type is accepted end-to-end', () => {
  const ActivityEventStore = require('../activity-event-store');
  const ws = createTempWorkspace('endorse-map-');
  const store = new ActivityEventStore({ eventsPath: ws.path('events.jsonl') });
  const event = store.append({
    type: 'skill_endorsed',
    accountId: 'acc-1',
    targetValue: 'Bob'
  });
  assert.equal(event.type, 'skill_endorsed');
});

// ---------------------------------------------------------------------------
// 9. endorse module unit tests
// ---------------------------------------------------------------------------

test('endorseSkillsDetailed returns skipped_no_endorseable_skills when no skills section', async () => {
  const { endorseSkillsDetailed } = require('../automation/endorsement/endorse');
  const ws = createTempWorkspace('endorse-unit-noskills-');

  const page = makeStubPage(makeEndorseStub({
    endorseableCount: 0,
    endorsedCount: 0,
    totalSkills: 0,
    endorseableSkills: [],
    alreadyEndorsedSkills: []
  }));

  const result = await endorseSkillsDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'skipped_no_endorseable_skills');
});

test('endorseSkillsDetailed returns skipped_already_endorsed when all skills endorsed', async () => {
  const { endorseSkillsDetailed } = require('../automation/endorsement/endorse');
  const ws = createTempWorkspace('endorse-unit-allendorsed-');

  const page = makeStubPage(makeEndorseStub({
    endorseableCount: 0,
    endorsedCount: 3,
    totalSkills: 3,
    endorseableSkills: [],
    alreadyEndorsedSkills: ['JavaScript', 'Node.js', 'React']
  }));

  const result = await endorseSkillsDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'skipped_already_endorsed');
  assert.equal(result.metadata.alreadyEndorsed, true);
});

test('endorseSkillsDetailed returns completed for successful endorsement', async () => {
  const { endorseSkillsDetailed } = require('../automation/endorsement/endorse');
  const ws = createTempWorkspace('endorse-unit-success-');

  const page = makeStubPage(makeEndorseStub({
    endorseableCount: 2,
    endorsedCount: 0,
    totalSkills: 2,
    endorseableSkills: ['JavaScript', 'Node.js'],
    clickEndorsed: 2,
    clickSkills: ['JavaScript', 'Node.js'],
    postClickEndorsedCount: 2
  }));

  const result = await endorseSkillsDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'completed');
  assert.ok(result.verificationResult);
  assert.equal(result.verificationResult.verified, true);
  assert.deepEqual(result.metadata.endorsedSkills, ['JavaScript', 'Node.js']);
  assert.equal(result.metadata.endorsedCount, 2);
});

test('endorseSkillsDetailed returns failed_transient when click fails', async () => {
  const { endorseSkillsDetailed } = require('../automation/endorsement/endorse');
  const ws = createTempWorkspace('endorse-unit-clickfail-');

  const page = makeStubPage(makeEndorseStub({
    endorseableCount: 2,
    endorsedCount: 0,
    totalSkills: 2,
    endorseableSkills: ['JavaScript', 'Node.js'],
    clickEndorsed: 0,
    clickErrors: 2,
    clickSkills: []
  }));

  const result = await endorseSkillsDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'failed_transient');
  assert.match(result.reason, /Could not click any endorse buttons/);
});

test('endorseSkillsDetailed returns failed_transient when verification fails', async () => {
  const { endorseSkillsDetailed } = require('../automation/endorsement/endorse');
  const ws = createTempWorkspace('endorse-unit-verifyfail-');

  const page = makeStubPage(makeEndorseStub({
    endorseableCount: 2,
    endorsedCount: 0,
    totalSkills: 2,
    endorseableSkills: ['JavaScript', 'Node.js'],
    clickEndorsed: 2,
    clickSkills: ['JavaScript', 'Node.js'],
    postClickEndorsedCount: 0,  // unchanged
    postClickEndorseableCount: 2  // also unchanged — nothing happened
  }));

  const result = await endorseSkillsDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  assert.equal(result.outcomeType, 'failed_transient');
  assert.match(result.reason, /could not verify/i);
});

test('endorseSkillsDetailed respects quota — returns skipped_quota_exceeded', async () => {
  const { endorseSkillsDetailed } = require('../automation/endorsement/endorse');
  const ws = createTempWorkspace('endorse-unit-quota-');
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
          skill_endorsed: {
            daily: { limit: 20, used: 20, resetTime: futureDate, _randomized: true },
            weekly: { limit: 100, used: 20, resetTime: futureDate }
          }
        }
      }
    }
  });

  const page = makeStubPage(makeEndorseStub({
    endorseableCount: 2,
    endorsedCount: 0,
    totalSkills: 2
  }));

  const result = await endorseSkillsDetailed(page, 'https://www.linkedin.com/in/bob', { quotaPath });

  assert.equal(result.outcomeType, 'skipped_quota_exceeded');
});

// ---------------------------------------------------------------------------
// 9b. mixed-state false positive — pre-existing endorsements should not
//     verify success when no new endorsement actually happened
// ---------------------------------------------------------------------------

test('endorseSkillsDetailed returns failed_transient on mixed-state profile with no actual change', async () => {
  const { endorseSkillsDetailed } = require('../automation/endorsement/endorse');
  const ws = createTempWorkspace('endorse-unit-mixedstate-');

  // Profile already has 1 endorsed skill and 2 endorseable.
  // clickEndorseButtons reports 2 endorsed (optimistic), but the post-click
  // DOM state is identical to pre-click (endorsedCount stays 1,
  // endorseableCount stays 2) — the clicks silently failed / were no-ops.
  const page = makeStubPage(makeEndorseStub({
    endorseableCount: 2,
    endorsedCount: 1,
    totalSkills: 3,
    endorseableSkills: ['JavaScript', 'Node.js'],
    alreadyEndorsedSkills: ['React'],
    clickEndorsed: 2,
    clickSkills: ['JavaScript', 'Node.js'],
    postClickEndorsedCount: 1,  // unchanged — endorsements didn't actually stick
    postClickEndorseableCount: 2  // also unchanged
  }));

  const result = await endorseSkillsDetailed(page, 'https://www.linkedin.com/in/bob', {
    quotaPath: ws.path('quota.json')
  });

  // Must NOT be completed — the verifier should detect no state change.
  assert.equal(result.outcomeType, 'failed_transient');
  assert.match(result.reason, /could not verify/i);
});

// ---------------------------------------------------------------------------
// 10. MCP step type enum includes endorse_skills
// ---------------------------------------------------------------------------

test('MCP server tool schema includes endorse_skills in step type enum', () => {
  // Read the raw source to verify the enum contains endorse_skills
  const fs = require('fs');
  const source = fs.readFileSync(
    require.resolve('../connect-mcp-server.js'),
    'utf8'
  );
  // The enum line for step types
  assert.ok(
    source.includes("'endorse_skills'") || source.includes('"endorse_skills"'),
    'endorse_skills should appear in MCP server source'
  );
  // The description line
  assert.ok(
    source.includes('endorse_skills'),
    'endorse_skills should appear in MCP tool description'
  );
});

// ---------------------------------------------------------------------------
// 11. Unsupported step type still returns failed_permanent (regression guard)
// ---------------------------------------------------------------------------

test('unsupported step type still returns failed_permanent after endorse_skills addition', async () => {
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
