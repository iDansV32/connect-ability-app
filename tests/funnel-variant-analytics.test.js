'use strict';

/**
 * tests/funnel-variant-analytics.test.js
 *
 * Targeted tests for Ticket 13 — conversion funnel analytics and variant attribution.
 *
 * Covers:
 *  1. Funnel counts are computed correctly from activity events
 *  2. Drop-off is correct when later-stage events are missing
 *  3. Variant key is computed deterministically by computeVariantKey
 *  4. Variant key is recorded on sent DM activity events via action-router
 *  5. Variant performance groups replies/acceptances by variant key
 *  6. get_analytics response stays backward compatible while adding new fields
 *  7. Funnel supports filter by agentId
 *  8. Empty event set returns zero-count funnel and empty variant list
 *  9. computeVariantKey produces same key for same structural text
 * 10. Funnel includes optional stages (follow, endorse, comment)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTempWorkspace, writeJson } = require('./test-helpers');
const ActivityAnalyticsService = require('../activity-analytics');
const { computeVariantKey } = require('../automation/messaging/variant-engine');
const { createWorkflowStepResult } = require('../workflow-step-result');
const { executeWorkflowStep } = require('../automation/runtime/action-router');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnalyticsService(events) {
  const ws = createTempWorkspace('funnel-analytics-');
  const eventsPath = ws.path('events.jsonl');
  const fs = require('fs');
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(eventsPath, lines, 'utf8');
  return new ActivityAnalyticsService({
    eventsPath,
    profilesPath: ws.path('profiles.json'),
    accountHealthPath: ws.path('health.json'),
    transportHealthPath: ws.path('transport.json'),
    runtimeLogsPath: ws.path('logs.jsonl'),
    sessionRegistryPath: ws.path('sessions.json'),
    linkedInAccountsPath: ws.path('accounts.json')
  });
}

function makeEvent(type, profileUrl, extra = {}) {
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    timestamp: extra.timestamp || '2026-03-22T10:00:00.000Z',
    accountId: extra.accountId || 'acc-1',
    agentId: extra.agentId || 'agent-1',
    workflowId: extra.workflowId || 'wf-1',
    profileUrl,
    targetValue: extra.targetValue || profileUrl,
    status: extra.status || 'ok',
    metadata: extra.metadata || {}
  };
}

const RESOLVED_BOB = { profileUrl: 'https://www.linkedin.com/in/bob', recipientName: 'Bob' };

function makeStubPage() {
  return {
    async waitForSelector() { throw new Error('stub: no DOM'); },
    async evaluate() { return {}; },
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

// ---------------------------------------------------------------------------
// 1. Funnel counts computed correctly from activity events
// ---------------------------------------------------------------------------

test('getFunnelAnalytics computes correct stage counts from activity events', () => {
  const events = [
    makeEvent('profile_viewed', 'https://linkedin.com/in/alice'),
    makeEvent('profile_viewed', 'https://linkedin.com/in/bob'),
    makeEvent('profile_viewed', 'https://linkedin.com/in/carol'),
    makeEvent('connection_requested', 'https://linkedin.com/in/alice'),
    makeEvent('connection_requested', 'https://linkedin.com/in/bob'),
    makeEvent('connection_accepted', 'https://linkedin.com/in/alice'),
    makeEvent('dm_sent', 'https://linkedin.com/in/alice'),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/alice')
  ];

  const service = makeAnalyticsService(events);
  const result = service.getFunnelAnalytics();

  const stageMap = new Map(result.stages.map((s) => [s.stage, s.count]));
  assert.equal(stageMap.get('profile_viewed'), 3);
  assert.equal(stageMap.get('connection_requested'), 2);
  assert.equal(stageMap.get('connection_accepted'), 1);
  assert.equal(stageMap.get('dm_sent'), 1);
  assert.equal(stageMap.get('dm_reply_received'), 1);
});

// ---------------------------------------------------------------------------
// 2. Drop-off is correct when later-stage events are missing
// ---------------------------------------------------------------------------

test('getFunnelAnalytics computes correct drop-off rates', () => {
  const events = [
    makeEvent('profile_viewed', 'https://linkedin.com/in/alice'),
    makeEvent('profile_viewed', 'https://linkedin.com/in/bob'),
    makeEvent('profile_viewed', 'https://linkedin.com/in/carol'),
    makeEvent('profile_viewed', 'https://linkedin.com/in/dave'),
    makeEvent('connection_requested', 'https://linkedin.com/in/alice'),
    makeEvent('connection_requested', 'https://linkedin.com/in/bob'),
    makeEvent('connection_accepted', 'https://linkedin.com/in/alice'),
    makeEvent('dm_sent', 'https://linkedin.com/in/alice')
    // no replies — 100% drop-off at dm_sent → dm_reply_received
  ];

  const service = makeAnalyticsService(events);
  const result = service.getFunnelAnalytics();

  const dropOffMap = new Map(result.dropOff.map((d) => [`${d.from}→${d.to}`, d]));

  // view → connection: 4 viewed, 2 connected → 50% drop-off
  const viewToConn = dropOffMap.get('profile_viewed→connection_requested');
  assert.equal(viewToConn.fromCount, 4);
  assert.equal(viewToConn.toCount, 2);
  assert.equal(viewToConn.dropOffRate, 50);
  assert.equal(viewToConn.conversionRate, 50);

  // connection → accepted: 2 requested, 1 accepted → 50% drop-off
  const connToAccept = dropOffMap.get('connection_requested→connection_accepted');
  assert.equal(connToAccept.fromCount, 2);
  assert.equal(connToAccept.toCount, 1);
  assert.equal(connToAccept.conversionRate, 50);

  // dm_sent → dm_reply_received: 1 sent, 0 replies → 100% drop-off
  const dmToReply = dropOffMap.get('dm_sent→dm_reply_received');
  assert.equal(dmToReply.fromCount, 1);
  assert.equal(dmToReply.toCount, 0);
  assert.equal(dmToReply.dropOffRate, 100);
  assert.equal(dmToReply.conversionRate, 0);
});

// ---------------------------------------------------------------------------
// 3. Variant key is computed deterministically
// ---------------------------------------------------------------------------

test('computeVariantKey produces stable hash for same text', () => {
  const key1 = computeVariantKey('Hi there, hope you are doing great!');
  const key2 = computeVariantKey('Hi there, hope you are doing great!');
  assert.equal(key1, key2);
  assert.equal(key1.length, 8);
  assert.match(key1, /^[0-9a-f]{8}$/);
});

test('computeVariantKey produces different keys for different texts', () => {
  const key1 = computeVariantKey('Hi there, hope you are doing great!');
  const key2 = computeVariantKey('Hi friend, hope this finds you well!');
  assert.notEqual(key1, key2);
});

test('computeVariantKey returns "empty" for empty strings', () => {
  assert.equal(computeVariantKey(''), 'empty');
  assert.equal(computeVariantKey('  '), 'empty');
});

// ---------------------------------------------------------------------------
// 4. Variant key recorded on sent DM activity events via action-router
// ---------------------------------------------------------------------------

test('action-router attaches variantKey to DM success metadata', async () => {
  const ws = createTempWorkspace('variant-dm-attr-');
  let receivedMetadata = null;

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'send_dm', messageTemplate: 'Hi {there|friend}!' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      sendLinkedInMessage: async (page, profileUrl, message, profileDetails, options) => {
        return {
          success: true,
          profileUrl,
          message: 'Hi friend!',
          transport: 'dom',
          verificationResult: { verified: true, method: 'dom', at: new Date().toISOString() }
        };
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.outcomeType, 'completed');
  assert.ok(result.metadata.variantKey, 'variantKey should be present on DM success metadata');
  assert.match(result.metadata.variantKey, /^[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// 5. Variant performance groups replies/acceptances by variant key
// ---------------------------------------------------------------------------

test('getVariantPerformance groups outreach by variantKey and attributes replies', () => {
  const variantA = computeVariantKey('Hi there, hope you are doing great!');
  const variantB = computeVariantKey('Hi friend, hope this finds you well!');

  const events = [
    // Variant A: 3 sends on day 1, 1 reply on day 2
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', { timestamp: '2026-03-22T10:00:00.000Z', metadata: { variantKey: variantA } }),
    makeEvent('dm_sent', 'https://linkedin.com/in/bob', { timestamp: '2026-03-22T10:00:00.000Z', metadata: { variantKey: variantA } }),
    makeEvent('dm_sent', 'https://linkedin.com/in/carol', { timestamp: '2026-03-22T10:00:00.000Z', metadata: { variantKey: variantA } }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/alice', { timestamp: '2026-03-23T10:00:00.000Z' }),

    // Variant B: 2 sends on day 1, 2 replies on day 2
    makeEvent('dm_sent', 'https://linkedin.com/in/dave', { timestamp: '2026-03-22T10:00:00.000Z', metadata: { variantKey: variantB } }),
    makeEvent('dm_sent', 'https://linkedin.com/in/eve', { timestamp: '2026-03-22T10:00:00.000Z', metadata: { variantKey: variantB } }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/dave', { timestamp: '2026-03-23T10:00:00.000Z' }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/eve', { timestamp: '2026-03-23T10:00:00.000Z' })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getVariantPerformance();

  assert.equal(result.variants.length, 2);

  const vA = result.variants.find((v) => v.variantKey === variantA);
  const vB = result.variants.find((v) => v.variantKey === variantB);

  assert.ok(vA);
  assert.equal(vA.sends, 3);
  assert.equal(vA.replies, 1);
  assert.equal(vA.replyRate, 33);

  assert.ok(vB);
  assert.equal(vB.sends, 2);
  assert.equal(vB.replies, 2);
  assert.equal(vB.replyRate, 100);
});

// ---------------------------------------------------------------------------
// 6. get_analytics response backward compatible + new fields present
// ---------------------------------------------------------------------------

test('get_analytics output includes funnel and variantPerformance alongside existing fields', () => {
  const events = [
    makeEvent('profile_viewed', 'https://linkedin.com/in/alice'),
    makeEvent('dm_sent', 'https://linkedin.com/in/alice')
  ];

  const service = makeAnalyticsService(events);

  // Simulate the MCP get_analytics response shape
  const filters = {};
  const response = {
    ...service.getOverview(filters),
    accountHealth: service.getAccountHealthBreakdown(filters),
    stepOutcomeBreakdown: service.getStepOutcomeBreakdown(filters),
    funnel: service.getFunnelAnalytics(filters),
    variantPerformance: service.getVariantPerformance(filters)
  };

  // Existing fields preserved
  assert.ok(response.totals);
  assert.ok(response.rates);
  assert.ok(response.byAgent);
  assert.ok(response.byWorkflow);
  assert.ok(response.accountHealth);
  assert.ok(response.stepOutcomeBreakdown);

  // New fields present
  assert.ok(response.funnel);
  assert.ok(response.funnel.stages);
  assert.ok(response.funnel.dropOff);
  assert.ok(response.variantPerformance);
  assert.ok(Array.isArray(response.variantPerformance.variants));
});

// ---------------------------------------------------------------------------
// 7. Funnel supports filter by agentId
// ---------------------------------------------------------------------------

test('getFunnelAnalytics filters by agentId correctly', () => {
  const events = [
    makeEvent('profile_viewed', 'https://linkedin.com/in/alice', { agentId: 'agent-1' }),
    makeEvent('profile_viewed', 'https://linkedin.com/in/bob', { agentId: 'agent-2' }),
    makeEvent('connection_requested', 'https://linkedin.com/in/alice', { agentId: 'agent-1' }),
    makeEvent('connection_requested', 'https://linkedin.com/in/bob', { agentId: 'agent-2' })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getFunnelAnalytics({ agentId: 'agent-1' });

  const stageMap = new Map(result.stages.map((s) => [s.stage, s.count]));
  assert.equal(stageMap.get('profile_viewed'), 1);
  assert.equal(stageMap.get('connection_requested'), 1);
});

// ---------------------------------------------------------------------------
// 8. Empty event set returns zero counts
// ---------------------------------------------------------------------------

test('getFunnelAnalytics returns zero counts with no events', () => {
  const service = makeAnalyticsService([]);
  const result = service.getFunnelAnalytics();

  for (const stage of result.stages) {
    assert.equal(stage.count, 0);
  }
  for (const drop of result.dropOff) {
    assert.equal(drop.fromCount, 0);
    assert.equal(drop.toCount, 0);
    assert.equal(drop.dropOffRate, 0);
  }
});

test('getVariantPerformance returns empty variants with no events', () => {
  const service = makeAnalyticsService([]);
  const result = service.getVariantPerformance();
  assert.equal(result.variants.length, 0);
});

// ---------------------------------------------------------------------------
// 9. computeVariantKey normalises recipient-specific tokens for stability
// ---------------------------------------------------------------------------

test('computeVariantKey normalises emails and URLs but not copy words', () => {
  // Emails and URLs are replaced with tokens
  const withEmail = computeVariantKey('Hi, reach me at alice@example.com ok?');
  const withDifferentEmail = computeVariantKey('Hi, reach me at bob@example.com ok?');
  assert.equal(withEmail, withDifferentEmail, 'different emails should normalise to same key');

  const withUrl = computeVariantKey('Check out https://linkedin.com/in/alice please');
  const withDifferentUrl = computeVariantKey('Check out https://linkedin.com/in/bob please');
  assert.equal(withUrl, withDifferentUrl, 'different URLs should normalise to same key');
});

test('computeVariantKey normalises {{placeholder}} and {placeholder} template tokens', () => {
  const pre = computeVariantKey('Hi {firstName}, welcome to {company}!');
  const post = computeVariantKey('Hi Alice, welcome to Acme!');
  // These will NOT be the same because {firstName} → _tok_ but "Alice" is kept.
  // However, two pre-personalisation templates with different placeholder names should match:
  const templateA = computeVariantKey('Hi {firstName}, how are you?');
  const templateB = computeVariantKey('Hi {fullName}, how are you?');
  assert.equal(templateA, templateB, 'different placeholder names should normalise to same key');
});

// ---------------------------------------------------------------------------
// 10. Funnel includes optional stages
// ---------------------------------------------------------------------------

test('getFunnelAnalytics includes follow, endorse, and comment stages', () => {
  const events = [
    makeEvent('profile_viewed', 'https://linkedin.com/in/alice'),
    makeEvent('profile_followed', 'https://linkedin.com/in/alice'),
    makeEvent('skill_endorsed', 'https://linkedin.com/in/alice'),
    makeEvent('post_commented', 'https://linkedin.com/in/alice'),
    makeEvent('connection_requested', 'https://linkedin.com/in/alice')
  ];

  const service = makeAnalyticsService(events);
  const result = service.getFunnelAnalytics();

  const stageMap = new Map(result.stages.map((s) => [s.stage, s.count]));
  assert.equal(stageMap.get('profile_followed'), 1);
  assert.equal(stageMap.get('skill_endorsed'), 1);
  assert.equal(stageMap.get('post_commented'), 1);
});

// ---------------------------------------------------------------------------
// 11. Variant performance attributes connection_accepted by variant key
// ---------------------------------------------------------------------------

test('getVariantPerformance attributes connection acceptances to the sending variant', () => {
  const variantA = computeVariantKey('Would love to connect!');

  const events = [
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', { timestamp: '2026-03-22T10:00:00.000Z', metadata: { variantKey: variantA } }),
    makeEvent('connection_accepted', 'https://linkedin.com/in/alice', { timestamp: '2026-03-23T10:00:00.000Z' })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getVariantPerformance();

  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].acceptances, 1);
  assert.equal(result.variants[0].acceptanceRate, 100);
});

// ---------------------------------------------------------------------------
// 12. Reply attributed to the most recent variant when same profile has
//     multiple outreach events (P1 regression guard)
// ---------------------------------------------------------------------------

test('getVariantPerformance attributes reply to the newest outreach variant for the same profile', () => {
  const variantOld = computeVariantKey('Old template text here');
  const variantNew = computeVariantKey('New template text here');

  // Events are stored newest-first by getEvents() — Jan 3 reply, Jan 2 DM (new), Jan 1 DM (old)
  const events = [
    makeEvent('dm_reply_received', 'https://linkedin.com/in/alice', {
      timestamp: '2026-01-03T10:00:00.000Z'
    }),
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', {
      timestamp: '2026-01-02T10:00:00.000Z',
      metadata: { variantKey: variantNew }
    }),
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', {
      timestamp: '2026-01-01T10:00:00.000Z',
      metadata: { variantKey: variantOld }
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getVariantPerformance();

  // Reply should be attributed to the newer variant, not the older one
  const vNew = result.variants.find((v) => v.variantKey === variantNew);
  const vOld = result.variants.find((v) => v.variantKey === variantOld);

  assert.ok(vNew);
  assert.equal(vNew.replies, 1, 'reply should be attributed to the newer variant');
  assert.ok(vOld);
  assert.equal(vOld.replies, 0, 'older variant should not get the reply');
});

// ---------------------------------------------------------------------------
// 13. computeVariantKey differentiates genuinely different templates (P2 regression guard)
// ---------------------------------------------------------------------------

test('computeVariantKey produces different keys for "Loved your post" vs "Saw your post"', () => {
  const key1 = computeVariantKey('Loved your post about AI');
  const key2 = computeVariantKey('Saw your post about AI');
  assert.notEqual(key1, key2, 'different template wording should produce different variant keys');
});

// ---------------------------------------------------------------------------
// 14. action-router attaches variantKey to comment success metadata
// ---------------------------------------------------------------------------

test('action-router attaches variantKey to comment_on_post success metadata', async () => {
  const ws = createTempWorkspace('variant-comment-attr-');

  const result = await executeWorkflowStep(
    makeStubPage(),
    {
      resolvedTarget: RESOLVED_BOB,
      step: { type: 'comment_on_post', commentTemplate: 'Great {post|article}!' },
      quotaPath: ws.path('quota.json')
    },
    makeStubDependencies({
      commentOnPostDetailed: async (page, profileUrl, options) => {
        return createWorkflowStepResult({
          stepType: 'comment_on_post',
          outcomeType: 'completed',
          profileUrl,
          verificationResult: { verified: true, method: 'dom', at: new Date().toISOString() },
          metadata: { commentText: 'Great post!', postUrn: 'urn:li:activity:123' }
        });
      },
      thinkingPause: async () => {},
      readingDelay: async () => {}
    })
  );

  assert.equal(result.outcomeType, 'completed');
  assert.ok(result.metadata.variantKey, 'variantKey should be present on comment success metadata');
  assert.match(result.metadata.variantKey, /^[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// 15. Comment variant and DM variant do not cross-attribute for dm_reply
// ---------------------------------------------------------------------------

test('dm_reply_received is attributed only to dm_sent, not to post_commented variant', () => {
  const dmVariant = computeVariantKey('Hi, love to connect!');
  const commentVariant = computeVariantKey('Great article on leadership!');

  const events = [
    // Comment on Jan 1, DM on Jan 2, reply on Jan 3
    makeEvent('dm_reply_received', 'https://linkedin.com/in/alice', {
      timestamp: '2026-01-03T10:00:00.000Z'
    }),
    makeEvent('dm_sent', 'https://linkedin.com/in/alice', {
      timestamp: '2026-01-02T10:00:00.000Z',
      metadata: { variantKey: dmVariant }
    }),
    makeEvent('post_commented', 'https://linkedin.com/in/alice', {
      timestamp: '2026-01-01T10:00:00.000Z',
      metadata: { variantKey: commentVariant }
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getVariantPerformance();

  const vDm = result.variants.find((v) => v.variantKey === dmVariant);
  const vComment = result.variants.find((v) => v.variantKey === commentVariant);

  assert.ok(vDm);
  assert.equal(vDm.replies, 1, 'reply should be attributed to the DM variant');
  assert.ok(vComment);
  assert.equal(vComment.replies, 0, 'comment variant should NOT receive the DM reply');
});

// ---------------------------------------------------------------------------
// 16. Comment-only profile: dm_reply with no prior DM is unattributed
// ---------------------------------------------------------------------------

test('dm_reply_received with only post_commented outreach is unattributed', () => {
  const commentVariant = computeVariantKey('Nice post!');

  const events = [
    makeEvent('dm_reply_received', 'https://linkedin.com/in/bob', {
      timestamp: '2026-01-02T10:00:00.000Z'
    }),
    makeEvent('post_commented', 'https://linkedin.com/in/bob', {
      timestamp: '2026-01-01T10:00:00.000Z',
      metadata: { variantKey: commentVariant }
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getVariantPerformance();

  const vComment = result.variants.find((v) => v.variantKey === commentVariant);
  assert.ok(vComment);
  assert.equal(vComment.replies, 0, 'comment variant should not receive DM reply attribution');
  assert.equal(vComment.sends, 1);
});

// ---------------------------------------------------------------------------
// 17. connection_accepted can be attributed to either channel
// ---------------------------------------------------------------------------

test('connection_accepted is attributed to comment outreach when no DM exists', () => {
  const commentVariant = computeVariantKey('Insightful analysis!');

  const events = [
    makeEvent('connection_accepted', 'https://linkedin.com/in/carol', {
      timestamp: '2026-01-02T10:00:00.000Z'
    }),
    makeEvent('post_commented', 'https://linkedin.com/in/carol', {
      timestamp: '2026-01-01T10:00:00.000Z',
      metadata: { variantKey: commentVariant }
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getVariantPerformance();

  const vComment = result.variants.find((v) => v.variantKey === commentVariant);
  assert.ok(vComment);
  assert.equal(vComment.acceptances, 1, 'connection_accepted should attribute to comment when no DM exists');
});

// ---------------------------------------------------------------------------
// 18. Outcome before any outreach is unattributed
// ---------------------------------------------------------------------------

test('outcome event before any outreach is not falsely attributed', () => {
  const variantA = computeVariantKey('Some template');

  const events = [
    // Outreach on Jan 2, but reply on Jan 1 (before outreach)
    makeEvent('dm_sent', 'https://linkedin.com/in/dave', {
      timestamp: '2026-01-02T10:00:00.000Z',
      metadata: { variantKey: variantA }
    }),
    makeEvent('dm_reply_received', 'https://linkedin.com/in/dave', {
      timestamp: '2026-01-01T10:00:00.000Z'
    })
  ];

  const service = makeAnalyticsService(events);
  const result = service.getVariantPerformance();

  const vA = result.variants.find((v) => v.variantKey === variantA);
  assert.ok(vA);
  assert.equal(vA.sends, 1);
  assert.equal(vA.replies, 0, 'reply before outreach should not be attributed');
});
