'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTempWorkspace, writeJson } = require('./test-helpers');

const {
  executeWorkflowStep,
  _private: {
    deriveRecipientNameFromProfileUrl,
    resolveKnownTargetFromConfig,
    resolveWorkflowTarget,
    buildWorkflowStepMetadata,
    buildActionQuotaOptions,
    buildBudgetOptions,
    getTransportHealthGuardResult,
    resolveTransportHealthContext,
    mapStepTypeToPrivateApiAction,
    mapDmOutcome,
    resolveDoNotContactSummary,
    buildDoNotContactResult,
    buildManagedElsewhereResult,
    formatContactOwnerLabel
  }
} = require('../automation/runtime/action-router');

// ---- pure helper tests ----

test('deriveRecipientNameFromProfileUrl derives a human-readable name from slug', () => {
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/john-doe-123/'), 'John Doe');
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/alice/'), 'Alice');
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/bob-smith/'), 'Bob Smith');
});

test('deriveRecipientNameFromProfileUrl strips mixed alphanumeric LinkedIn slug suffixes', () => {
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/ivan-dans-517204886/'), 'Ivan Dans');
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/madison-crane-4c7a91e02/'), 'Madison Crane');
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/sara-jones-7qmzkt/'), 'Sara Jones');
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/liam-walder-8kd3rp/'), 'Liam Walder');
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/bob-123-abc456/'), 'Bob');
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/in/john-smith/'), 'John Smith');
});

test('deriveRecipientNameFromProfileUrl returns empty string for non-profile URLs', () => {
  assert.equal(deriveRecipientNameFromProfileUrl('https://www.linkedin.com/feed/'), '');
  assert.equal(deriveRecipientNameFromProfileUrl(''), '');
  assert.equal(deriveRecipientNameFromProfileUrl(null), '');
});

test('buildWorkflowStepMetadata omits undefined values', () => {
  const result = buildWorkflowStepMetadata({ a: 1, b: undefined, c: 'hello', d: null });
  assert.deepEqual(result, { a: 1, c: 'hello', d: null });
});

test('buildWorkflowStepMetadata returns empty object for no arguments', () => {
  assert.deepEqual(buildWorkflowStepMetadata(), {});
  assert.deepEqual(buildWorkflowStepMetadata({}), {});
});

test('buildActionQuotaOptions extracts all account identity fields from config', () => {
  const result = buildActionQuotaOptions({
    accountId: 'acc-1',
    accountEmail: 'alice@example.com',
    accountName: 'Alice',
    quotaPath: '/tmp/quota.json'
  });
  assert.equal(result.accountId, 'acc-1');
  assert.equal(result.accountEmail, 'alice@example.com');
  assert.equal(result.accountName, 'Alice');
  assert.equal(result.quotaPath, '/tmp/quota.json');
  assert.equal(result.warmUpMultiplier, 1.0, 'no warmUpStartedAt → fully ramped multiplier');
});

test('buildActionQuotaOptions falls back to email field when accountEmail is absent', () => {
  const result = buildActionQuotaOptions({ email: 'bob@example.com' });
  assert.equal(result.accountEmail, 'bob@example.com');
  assert.equal(result.accountId, null);
  assert.equal(result.quotaPath, null);
  assert.equal(result.warmUpMultiplier, 1.0);
});

test('buildActionQuotaOptions applies warm-up multiplier when warmUpStartedAt is set', () => {
  // Day 0 account → stage 1 multiplier = 0.25
  const startedAt = new Date().toISOString();
  const result = buildActionQuotaOptions({ accountId: 'new-acc', warmUpStartedAt: startedAt });
  assert.equal(result.warmUpMultiplier, 0.25, 'brand-new account should be at 25% warm-up');
});

test('buildBudgetOptions extracts accountId, accountEmail, budgetPath, and dailyBudget', () => {
  const result = buildBudgetOptions({
    accountId: 'acc-1',
    accountEmail: 'alice@example.com',
    budgetPath: '/tmp/budget.json',
    dailyBudget: 200
  });
  assert.deepEqual(result, {
    accountId: 'acc-1',
    accountEmail: 'alice@example.com',
    budgetPath: '/tmp/budget.json',
    dailyBudget: 200
  });
});

test('mapStepTypeToPrivateApiAction preserves transport action names', () => {
  assert.equal(mapStepTypeToPrivateApiAction('send_connection'), 'send_connection');
  assert.equal(mapStepTypeToPrivateApiAction('send_dm'), 'send_dm');
  assert.equal(mapStepTypeToPrivateApiAction('schedule_post'), 'schedule_post');
});

test('getTransportHealthGuardResult returns skipped_transport_unhealthy when the selected transport is disabled', () => {
  const result = getTransportHealthGuardResult(
    'send_connection',
    { accountEmail: 'alice@example.com' },
    {
      isTransportDisabled(transport, action, accountEmail) {
        return transport === 'dom' && action === 'send_connection' && accountEmail === 'alice@example.com';
      }
    },
    {
      profileUrl: 'https://www.linkedin.com/in/alice',
      recipientName: 'Alice'
    }
  );

  assert.equal(result.outcomeType, 'skipped_transport_unhealthy');
  assert.equal(result.metadata.transport, 'dom');
  assert.equal(result.metadata.action, 'send_connection');
});

test('mapDmOutcome maps known reason codes to correct outcome types', () => {
  assert.equal(mapDmOutcome({ reason: 'recent_message_exists' }), 'skipped_thread_exists');
  assert.equal(mapDmOutcome({ reason: 'missing_template_fields' }), 'failed_permanent');
  assert.equal(mapDmOutcome({ reason: 'missing_recipient_name' }), 'failed_permanent');
  assert.equal(mapDmOutcome({ reason: 'conversation_not_found' }), 'skipped_not_connected');
  assert.equal(mapDmOutcome({ reason: 'navigation_failed' }), 'skipped_quota_exceeded');
  assert.equal(mapDmOutcome({ reason: 'send_failed' }), 'skipped_quota_exceeded');
  assert.equal(mapDmOutcome({ reason: 'quota_exceeded' }), 'skipped_quota_exceeded');
  assert.equal(mapDmOutcome({ reason: 'exception' }), 'failed_transient');
  assert.equal(mapDmOutcome({ reason: 'missing_messaging_context' }), 'failed_transient');
  assert.equal(mapDmOutcome({}), 'failed_transient');
  assert.equal(mapDmOutcome(), 'failed_transient');
});

test('formatContactOwnerLabel combines agent and account names', () => {
  assert.equal(formatContactOwnerLabel({ agentName: 'Johnny', accountName: 'ConnectCo' }), 'Johnny (ConnectCo)');
  assert.equal(formatContactOwnerLabel({ agentName: 'Johnny' }), 'Johnny');
  assert.equal(formatContactOwnerLabel({ accountName: 'ConnectCo' }), 'ConnectCo');
  assert.equal(formatContactOwnerLabel({}), 'another SDR account');
});

test('buildManagedElsewhereResult returns skipped_managed_elsewhere with correct reason', () => {
  const summary = {
    blocked: true,
    handlersInContact: [{ agentName: 'Johnny', accountName: 'ConnectCo', contactStage: 'active', prospectId: 'p-1' }],
    blockReason: 'accepted_connection_elsewhere'
  };
  const result = buildManagedElsewhereResult('send_connection', summary, {
    profileUrl: 'https://www.linkedin.com/in/alice',
    recipientName: 'Alice'
  });
  assert.equal(result.stepType, 'send_connection');
  assert.equal(result.outcomeType, 'skipped_managed_elsewhere');
  assert.match(result.reason, /Johnny \(ConnectCo\)/);
  assert.equal(result.metadata.blockingProspectId, 'p-1');
});

test('buildManagedElsewhereResult uses responded reason when contactStage is responded', () => {
  const summary = {
    blocked: true,
    handlersInContact: [{ agentName: 'Alice', accountName: 'Co', contactStage: 'responded' }]
  };
  const result = buildManagedElsewhereResult('send_dm', summary, {});
  assert.match(result.reason, /already replied to/);
});

test('resolveKnownTargetFromConfig reuses prospect identity without needing target resolution', () => {
  const result = resolveKnownTargetFromConfig({
    targetLabel: 'Fallback Label'
  }, {
    fullName: 'Jordan Lee',
    profileUrl: 'https://www.linkedin.com/in/jordan-lee/?trk=foo'
  });

  assert.deepEqual(result, {
    profileUrl: 'https://www.linkedin.com/in/jordan-lee',
    recipientName: 'Jordan Lee'
  });
});

test('resolveDoNotContactSummary blocks archived prospects and carries archive metadata', () => {
  const result = resolveDoNotContactSummary({
    id: 'prospect-1',
    state: 'archived',
    metadata: {
      doNotContact: true,
      archiveReason: 'unsubscribe_received'
    }
  });

  assert.equal(result.blocked, true);
  assert.equal(result.prospectId, 'prospect-1');
  assert.equal(result.archived, true);
  assert.equal(result.doNotContact, true);
  assert.equal(result.archiveReason, 'unsubscribe_received');
});

test('buildDoNotContactResult returns skipped_do_not_contact with prospect metadata', () => {
  const result = buildDoNotContactResult('send_dm', {
    prospectId: 'prospect-1',
    archived: true,
    doNotContact: true,
    archiveReason: 'unsubscribe_received',
    reason: 'prospect_archived'
  }, {
    profileUrl: 'https://www.linkedin.com/in/alice',
    recipientName: 'Alice'
  });

  assert.equal(result.stepType, 'send_dm');
  assert.equal(result.outcomeType, 'skipped_do_not_contact');
  assert.match(result.reason, /do not contact/i);
  assert.equal(result.metadata.prospectId, 'prospect-1');
  assert.equal(result.metadata.archiveReason, 'unsubscribe_received');
});

// ---- resolveWorkflowTarget ----

test('resolveWorkflowTarget returns profile URL and derived name for a LinkedIn URL', async () => {
  const result = await resolveWorkflowTarget({}, 'https://www.linkedin.com/in/john-doe/?trk=123');
  assert.equal(result.profileUrl, 'https://www.linkedin.com/in/john-doe/');
  assert.equal(result.recipientName, 'John Doe');
});

test('resolveWorkflowTarget strips query parameters from LinkedIn URLs', async () => {
  const result = await resolveWorkflowTarget({}, 'https://www.linkedin.com/in/alice-smith?utm=test&ref=1');
  assert.equal(result.profileUrl, 'https://www.linkedin.com/in/alice-smith');
});

test('resolveWorkflowTarget uses click-based search helper in strict stealth mode', async () => {
  let searchCalls = 0;
  let openCalls = 0;

  const result = await resolveWorkflowTarget({}, 'Alice Smith', {
    strictStealth: true,
    searchForProfiles: async () => {
      searchCalls += 1;
      return ['https://www.linkedin.com/in/should-not-run/'];
    },
    searchAndOpenFirstProfile: async () => {
      openCalls += 1;
      return {
        profileUrl: 'https://www.linkedin.com/in/alice-smith/',
        recipientName: 'Alice Smith'
      };
    }
  });

  assert.equal(searchCalls, 0);
  assert.equal(openCalls, 1);
  assert.equal(result.profileUrl, 'https://www.linkedin.com/in/alice-smith/');
  assert.equal(result.recipientName, 'Alice Smith');
  assert.equal(result.navigationMode, 'context_click_only');
});

test('resolveWorkflowTarget uses URL-based search helper outside strict stealth mode', async () => {
  let searchCalls = 0;
  let openCalls = 0;

  const result = await resolveWorkflowTarget({}, 'Alice Smith', {
    searchForProfiles: async () => {
      searchCalls += 1;
      return ['https://www.linkedin.com/in/alice-smith/'];
    },
    searchAndOpenFirstProfile: async () => {
      openCalls += 1;
      return null;
    }
  });

  assert.equal(searchCalls, 1);
  assert.equal(openCalls, 0);
  assert.equal(result.profileUrl, 'https://www.linkedin.com/in/alice-smith/');
  assert.equal(result.navigationMode, 'allow_direct_profile_navigation');
});

test('resolveWorkflowTarget throws when target is empty', async () => {
  await assert.rejects(
    resolveWorkflowTarget({}, ''),
    /Workflow target is empty/
  );
  await assert.rejects(
    resolveWorkflowTarget({}, null),
    /Workflow target is empty/
  );
});

// ---- routing tests using stub page and injected dependencies ----

function makeStubPage() {
  return {
    async waitForSelector() { throw new Error('stub: no DOM'); },
    async evaluate() { throw new Error('stub: no DOM'); },
    async $() { return null; },
    async goto() {},
    async waitForTimeout() {}
  };
}

function makeStubProspectQueueStore(overrides = {}) {
  return {
    getProspect() { return null; },
    getContactOwnershipSummary() {
      return { blocked: false, handlersInContact: [], blockReason: null };
    },
    ...overrides
  };
}

/**
 * Produces a safe dependency bundle for routing tests that do not care about
 * working-hours enforcement or activity budget gating.  Both checks are
 * stubbed to always allow, preventing time-of-day flakiness and cross-test
 * budget accumulation in the global default store.
 */
function makeStubDependencies(overrides = {}) {
  return {
    prospectQueueStore: makeStubProspectQueueStore(),
    isWithinWorkingHours: () => true,
    consumeActivityBudget: () => ({ allowed: true, used: 0, limit: 150, remaining: 150, exceeded: [] }),
    ...overrides
  };
}

const RESOLVED_ALICE = { profileUrl: 'https://www.linkedin.com/in/alice', recipientName: 'Alice' };

test('delay step always returns completed with step metadata', async () => {
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'delay', delayValue: 24, delayUnit: 'hours' }
    },
    makeStubDependencies()
  );
  assert.equal(result.stepType, 'delay');
  assert.equal(result.outcomeType, 'completed');
  assert.equal(result.metadata.delayValue, 24);
  assert.equal(result.metadata.delayUnit, 'hours');
});

test('delay step is not gated by managed-elsewhere check', async () => {
  // The managed-elsewhere check must be skipped for delay steps regardless of prospect state
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'delay', delayValue: 1, delayUnit: 'days' }
    },
    makeStubDependencies({
      prospectQueueStore: makeStubProspectQueueStore({
        getContactOwnershipSummary() {
          throw new Error('should not be called for delay steps');
        }
      })
    })
  );
  assert.equal(result.outcomeType, 'completed');
});

test('send_dm with no message template returns failed_permanent without touching DOM', async () => {
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'send_dm', messageTemplate: '' }
    },
    makeStubDependencies({
      thinkingPause: async () => {
        throw new Error('should not pause invalid DM steps');
      }
    })
  );
  assert.equal(result.stepType, 'send_dm');
  assert.equal(result.outcomeType, 'failed_permanent');
  assert.match(result.reason, /Message template is required/);
});

test('send_connection forwards strict stealth navigation context to the executor', async () => {
  let receivedOptions = null;
  const page = makeStubPage();
  page.url = () => 'https://www.linkedin.com/in/alice/';

  const result = await executeWorkflowStep(
    page,
    {
      strictStealth: true,
      resolvedTarget: {
        profileUrl: 'https://www.linkedin.com/in/alice',
        recipientName: 'Alice',
        navigationMode: 'context_click_only'
      },
      step: { type: 'send_connection', messageTemplate: '' }
    },
    makeStubDependencies({
      thinkingPause: async () => {},
      sendConnectionRequestDetailed: async (_page, _profileUrl, _messageTemplate, options) => {
        receivedOptions = options;
        return {
          stepType: 'send_connection',
          outcomeType: 'completed',
          profileUrl: 'https://www.linkedin.com/in/alice',
          metadata: { transport: 'dom' }
        };
      }
    })
  );

  assert.equal(result.outcomeType, 'completed');
  assert.equal(receivedOptions.strictStealth, true);
  assert.equal(receivedOptions.navigationMode, 'context_click_only');
});

test('send_connection derives click target name from the profile URL instead of a stale target label', async () => {
  let navigatedTo = null;
  let receivedOptions = null;
  const page = makeStubPage();
  page.goto = async (url) => {
    navigatedTo = url;
  };

  const result = await executeWorkflowStep(
    page,
    {
      resolvedTarget: {
        profileUrl: 'https://www.linkedin.com/in/sam-okonkwo',
        recipientName: 'Riley Nakamura'
      },
      targetLabel: 'Riley Nakamura',
      step: { type: 'send_connection', messageTemplate: '' }
    },
    makeStubDependencies({
      thinkingPause: async () => {},
      sendConnectionRequestDetailed: async (_page, _profileUrl, _messageTemplate, options) => {
        receivedOptions = options;
        return {
          stepType: 'send_connection',
          outcomeType: 'failed_transient',
          reason: 'mock stop before click'
        };
      }
    })
  );

  assert.equal(navigatedTo, 'https://www.linkedin.com/in/sam-okonkwo');
  assert.equal(receivedOptions.recipientName, 'Sam Okonkwo');
  assert.equal(result.recipientName, 'Sam Okonkwo');
});

test('view_profile uses readingDelay after navigation and before scroll', async () => {
  const workspace = createTempWorkspace('action-router-reading-delay-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeJson(quotaPath, { version: 1, accounts: {} });

    const events = [];
    const delayRng = () => 0.5;
    const page = makeStubPage();
    page.goto = async () => {
      events.push('goto');
    };

    const result = await executeWorkflowStep(
      page,
      {
        resolvedTarget: RESOLVED_ALICE,
        step: { type: 'view_profile' },
        quotaPath,
        delayProfileSeed: 'seed-view'
      },
      makeStubDependencies({
        delayRng,
        readingDelay: async (wordCount, options) => {
          events.push(`reading:${wordCount}`);
          assert.equal(wordCount, 10);
          assert.equal(options.delayProfile, 'seed-view');
          assert.equal(options.rng, delayRng);
        },
        humanScroll: async () => {
          events.push('scroll');
        },
        readConnectionState: async () => {
          events.push('state');
          return { pending: false, connected: false, following: false, canConnect: true };
        }
      })
    );

    assert.equal(result.outcomeType, 'completed');
    assert.deepEqual(events, ['goto', 'reading:10', 'scroll', 'state']);
  } finally {
    workspace.cleanup();
  }
});

test('view_profile in strict stealth reuses natural search context without reloading profile', async () => {
  const workspace = createTempWorkspace('action-router-strict-view-profile-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeJson(quotaPath, { version: 1, accounts: {} });

    const events = [];
    const page = makeStubPage();
    page.url = async () => 'https://www.linkedin.com/in/alice/';
    page.goto = async () => {
      events.push('goto');
    };

    const result = await executeWorkflowStep(
      page,
      {
        strictStealth: true,
        resolvedTarget: {
          profileUrl: 'https://www.linkedin.com/in/alice',
          recipientName: 'Alice',
          navigationMode: 'context_click_only'
        },
        step: { type: 'view_profile' },
        quotaPath
      },
      makeStubDependencies({
        readingDelay: async () => {
          events.push('reading');
        },
        humanScroll: async () => {
          events.push('scroll');
        },
        readConnectionState: async () => {
          events.push('state');
          return { pending: false, connected: false, following: false, canConnect: true };
        }
      })
    );

    assert.equal(result.outcomeType, 'completed');
    assert.deepEqual(events, ['reading', 'scroll', 'state']);
  } finally {
    workspace.cleanup();
  }
});

test('send_connection uses thinkingPause before dispatching the request', async () => {
  const events = [];
  const delayRng = () => 0.25;
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'send_connection', messageTemplate: 'Let us connect' },
      delayProfileSeed: 'seed-connection'
    },
    makeStubDependencies({
      delayRng,
      thinkingPause: async (options) => {
        events.push('pause');
        assert.equal(options.delayProfile, 'seed-connection');
        assert.equal(options.rng, delayRng);
      },
      sendConnectionRequestDetailed: async () => {
        events.push('send_connection');
        return { outcomeType: 'completed', metadata: { transport: 'dom' } };
      }
    })
  );

  assert.equal(result.outcomeType, 'completed');
  assert.deepEqual(events, ['pause', 'send_connection']);
});

test('send_connection skips before execution when the selected transport is unhealthy', async () => {
  let executorCalls = 0;
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      accountEmail: 'alice@example.com',
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'send_connection', messageTemplate: '' }
    },
    makeStubDependencies({
      transportHealthStore: {
        isTransportDisabled(transport, action, accountEmail) {
          return transport === 'dom' && action === 'send_connection' && accountEmail === 'alice@example.com';
        }
      },
      thinkingPause: async () => {
        throw new Error('should not pause unhealthy transport');
      },
      sendConnectionRequestDetailed: async () => {
        executorCalls += 1;
        return { outcomeType: 'completed' };
      }
    })
  );

  assert.equal(result.outcomeType, 'skipped_transport_unhealthy');
  assert.equal(result.metadata.transport, 'dom');
  assert.equal(executorCalls, 0);
});

test('send_dm uses thinkingPause before dispatching the message flow', async () => {
  const events = [];
  let sendOptions = null;
  const delayRng = () => 0.75;
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'send_dm', messageTemplate: 'Hello there' },
      delayProfileSeed: 'seed-dm'
    },
    makeStubDependencies({
      delayRng,
      thinkingPause: async (options) => {
        events.push('pause');
        assert.equal(options.delayProfile, 'seed-dm');
        assert.equal(options.rng, delayRng);
      },
      sendLinkedInMessage: async (_page, _profileUrl, _message, options) => {
        events.push('send_dm');
        sendOptions = options;
        return { success: true, transport: 'dom' };
      }
    })
  );

  assert.equal(result.outcomeType, 'completed');
  assert.equal(result.metadata.transport, 'dom');
  assert.deepEqual(events, ['pause', 'send_dm']);
  assert.equal(sendOptions.useMessagingDrawer, false);
});

test('like_posts uses reactionDelay before dispatching the activity flow', async () => {
  const events = [];
  const delayRng = () => 0;
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'like_posts' },
      delayProfileSeed: 'seed-like'
    },
    makeStubDependencies({
      delayRng,
      reactionDelay: async (options) => {
        events.push('reaction');
        assert.equal(options.delayProfile, 'seed-like');
        assert.equal(options.rng, delayRng);
      },
      processActivityPageDetailed: async () => {
        events.push('like_posts');
        return { outcomeType: 'completed', metadata: { likedCount: 1 } };
      }
    })
  );

  assert.equal(result.outcomeType, 'completed');
  assert.deepEqual(events, ['reaction', 'like_posts']);
});

test('delay step does not invoke semantic human-delay primitives', async () => {
  const calls = [];
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'delay', delayValue: 3, delayUnit: 'days' }
    },
    makeStubDependencies({
      readingDelay: async () => { calls.push('reading'); },
      thinkingPause: async () => { calls.push('thinking'); },
      reactionDelay: async () => { calls.push('reaction'); }
    })
  );

  assert.equal(result.outcomeType, 'completed');
  assert.deepEqual(calls, []);
});

test('unknown step type returns failed_permanent', async () => {
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'teleport_to_moon' }
    },
    makeStubDependencies()
  );
  assert.equal(result.stepType, 'teleport_to_moon');
  assert.equal(result.outcomeType, 'failed_permanent');
  assert.match(result.reason, /Unsupported workflow step type/);
});

test('empty step type returns failed_permanent', async () => {
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: {}
    },
    makeStubDependencies()
  );
  assert.equal(result.outcomeType, 'failed_permanent');
});

test('managed elsewhere blocks step before touching DOM', async () => {
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'send_connection' }
    },
    makeStubDependencies({
      prospectQueueStore: makeStubProspectQueueStore({
        getContactOwnershipSummary() {
          return {
            blocked: true,
            handlersInContact: [{
              agentName: 'Johnny',
              accountName: 'ConnectCo',
              contactStage: 'active',
              prospectId: 'p-999'
            }],
            blockReason: 'accepted_connection_elsewhere'
          };
        }
      })
    })
  );
  assert.equal(result.stepType, 'send_connection');
  assert.equal(result.outcomeType, 'skipped_managed_elsewhere');
  assert.match(result.reason, /Johnny \(ConnectCo\)/);
  assert.equal(result.metadata.blockingProspectId, 'p-999');
});

test('do-not-contact prospect blocks step before touching DOM', async () => {
  const page = {
    gotoCalls: 0,
    evaluateCalls: 0,
    waitForSelectorCalls: 0,
    async goto() {
      this.gotoCalls += 1;
      throw new Error('should not navigate');
    },
    async evaluate() {
      this.evaluateCalls += 1;
      throw new Error('should not evaluate');
    },
    async waitForSelector() {
      this.waitForSelectorCalls += 1;
      throw new Error('should not wait for selectors');
    },
    async $() {
      throw new Error('should not query selectors');
    },
    async waitForTimeout() {
      throw new Error('should not wait');
    }
  };

  const result = await executeWorkflowStep(
    page,
    {
      step: { type: 'send_dm', messageTemplate: 'Hello there' },
      prospectId: 'prospect-1'
    },
    makeStubDependencies({
      prospectQueueStore: makeStubProspectQueueStore({
        getProspect() {
          return {
            id: 'prospect-1',
            fullName: 'Jordan Lee',
            profileUrl: 'https://www.linkedin.com/in/jordan-lee/',
            state: 'archived',
            metadata: {
              doNotContact: true,
              archiveReason: 'unsubscribe_received'
            }
          };
        }
      })
    })
  );

  assert.equal(result.outcomeType, 'skipped_do_not_contact');
  assert.equal(result.metadata.prospectId, 'prospect-1');
  assert.equal(result.metadata.archiveReason, 'unsubscribe_received');
  assert.equal(page.gotoCalls, 0);
  assert.equal(page.evaluateCalls, 0);
  assert.equal(page.waitForSelectorCalls, 0);
});

test('view_profile returns skipped_quota_exceeded when daily quota is exhausted', async () => {
  const workspace = createTempWorkspace('action-router-quota-');
  try {
    const quotaPath = workspace.path('quota.json');
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    writeJson(quotaPath, {
      version: 1,
      accounts: {
        default: {
          actions: {
            profile_viewed: {
              daily: { limit: 100, used: 100, resetTime: futureDate },
              weekly: { limit: 500, used: 0, resetTime: futureDate }
            },
            connection_requested: {
              daily: { limit: 30, used: 0, resetTime: futureDate },
              weekly: { limit: 150, used: 0, resetTime: futureDate }
            },
            message_sent: {
              daily: { limit: 50, used: 0, resetTime: futureDate },
              weekly: { limit: 200, used: 0, resetTime: futureDate }
            },
            post_liked: {
              daily: { limit: 50, used: 0, resetTime: futureDate },
              weekly: { limit: 200, used: 0, resetTime: futureDate }
            }
          }
        }
      }
    });

    const result = await executeWorkflowStep(
      makeStubPage(),
      {
        resolvedTarget: RESOLVED_ALICE,
        step: { type: 'view_profile' },
        quotaPath
      },
      makeStubDependencies()
    );

    assert.equal(result.stepType, 'view_profile');
    assert.equal(result.outcomeType, 'skipped_quota_exceeded');
    assert.equal(result.profileUrl, RESOLVED_ALICE.profileUrl);
  } finally {
    workspace.cleanup();
  }
});

test('view_profile marks connection accepted when connected state appears after a recorded invite', async () => {
  const workspace = createTempWorkspace('action-router-view-accept-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeJson(quotaPath, { version: 1, accounts: {} });

    const page = {
      gotoCalls: 0,
      waitForSelectorCalls: 0,
      async goto() {
        this.gotoCalls += 1;
      },
      async waitForSelector() {
        this.waitForSelectorCalls += 1;
        throw new Error('profile extraction not needed in test');
      },
      async evaluate() {
        throw new Error('should not use page.evaluate when readConnectionState is injected');
      },
      async $() {
        return null;
      },
      async waitForTimeout() {}
    };

    let readConnectionStateCalls = 0;
    const result = await executeWorkflowStep(
      page,
      {
        resolvedTarget: RESOLVED_ALICE,
        step: { type: 'view_profile' },
        prospectId: 'prospect-1',
        quotaPath
      },
      makeStubDependencies({
        readingDelay: async () => {},
        humanScroll: async () => {},
        readConnectionState: async () => {
          readConnectionStateCalls += 1;
          return { pending: false, connected: true, following: false, canConnect: false };
        },
        prospectQueueStore: makeStubProspectQueueStore({
          getProspect() {
            return {
              id: 'prospect-1',
              fullName: 'Alice',
              profileUrl: RESOLVED_ALICE.profileUrl,
              metrics: {
                connectionRequests: 1,
                connectionAcceptances: 0
              },
              metadata: {}
            };
          }
        })
      })
    );

    assert.equal(result.stepType, 'view_profile');
    assert.equal(result.outcomeType, 'completed');
    assert.equal(readConnectionStateCalls, 1);
    assert.equal(page.gotoCalls, 1);
    assert.equal(result.metadata.connectionAcceptedDetected, true);
    assert.equal(result.metadata.connectionRequestCount, 1);
    assert.equal(result.metadata.connectionStateConnected, true);
    assert.equal(result.metadata.connectionStatePending, false);
  } finally {
    workspace.cleanup();
  }
});

test('view_profile does not mark connection accepted when the prospect already has an acceptance recorded', async () => {
  const workspace = createTempWorkspace('action-router-view-no-redetect-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeJson(quotaPath, { version: 1, accounts: {} });

    const result = await executeWorkflowStep(
      {
        async goto() {},
        async waitForSelector() {
          throw new Error('profile extraction not needed in test');
        },
        async evaluate() {
          throw new Error('should not use page.evaluate when readConnectionState is injected');
        },
        async $() {
          return null;
        },
        async waitForTimeout() {}
      },
      {
        resolvedTarget: RESOLVED_ALICE,
        step: { type: 'view_profile' },
        prospectId: 'prospect-1',
        quotaPath
      },
      makeStubDependencies({
        readingDelay: async () => {},
        humanScroll: async () => {},
        readConnectionState: async () => ({ pending: false, connected: true, following: false, canConnect: false }),
        prospectQueueStore: makeStubProspectQueueStore({
          getProspect() {
            return {
              id: 'prospect-1',
              fullName: 'Alice',
              profileUrl: RESOLVED_ALICE.profileUrl,
              metrics: {
                connectionRequests: 1,
                connectionAcceptances: 1
              },
              metadata: {
                connectionAcceptedAt: '2026-03-22T11:00:00.000Z'
              }
            };
          }
        })
      })
    );

    assert.equal(result.stepType, 'view_profile');
    assert.equal(result.outcomeType, 'completed');
    assert.equal(result.metadata.connectionAcceptedDetected, undefined);
    assert.equal(result.metadata.connectionRequestCount, undefined);
    assert.equal(result.metadata.connectionStateConnected, true);
    assert.equal(result.metadata.connectionStatePending, false);
  } finally {
    workspace.cleanup();
  }
});

test('non-delay step returns skipped_outside_working_hours when outside configured working hours', async () => {
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'view_profile' }
    },
    makeStubDependencies({
      isWithinWorkingHours: () => false
    })
  );
  assert.equal(result.stepType, 'view_profile');
  assert.equal(result.outcomeType, 'skipped_outside_working_hours');
  assert.match(result.reason, /working hours/i);
});

test('delay step is not gated by working-hours check', async () => {
  // delay must complete even when working-hours check says false
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'delay', delayValue: 6, delayUnit: 'hours' }
    },
    makeStubDependencies({
      isWithinWorkingHours: () => false
    })
  );
  assert.equal(result.stepType, 'delay');
  assert.equal(result.outcomeType, 'completed');
});

test('non-delay step returns skipped_budget_exceeded when daily activity budget is exhausted', async () => {
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'view_profile' }
    },
    makeStubDependencies({
      consumeActivityBudget: () => ({ allowed: false, used: 150, limit: 150, remaining: 0, exceeded: ['daily_total'] })
    })
  );
  assert.equal(result.stepType, 'view_profile');
  assert.equal(result.outcomeType, 'skipped_budget_exceeded');
  assert.match(result.reason, /budget/i);
  assert.equal(result.metadata.used, 150);
  assert.equal(result.metadata.limit, 150);
});

test('delay step is not gated by activity budget check', async () => {
  // delay must complete even when the budget is fully exhausted
  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_ALICE,
      step: { type: 'delay', delayValue: 12, delayUnit: 'hours' }
    },
    makeStubDependencies({
      consumeActivityBudget: () => { throw new Error('should not be called for delay steps'); }
    })
  );
  assert.equal(result.stepType, 'delay');
  assert.equal(result.outcomeType, 'completed');
});
