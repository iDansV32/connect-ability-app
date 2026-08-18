const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const LinkedInAccountHealthStore = require('../linkedin-account-health-store');
const { createTempWorkspace } = require('./test-helpers');

test('LinkedInAccountHealthStore cools down workflow accounts after repeated transient failures', () => {
  const workspace = createTempWorkspace('linkedin-account-health-');
  try {
    const store = new LinkedInAccountHealthStore({
      storePath: workspace.path('linkedin-account-health.json')
    });

    store.recordFailure('account-1', 'workflow', 'selector timeout', {
      timestamp: '2026-03-21T12:00:00.000Z'
    });
    store.recordFailure('account-1', 'workflow', 'selector timeout', {
      timestamp: '2026-03-21T12:05:00.000Z'
    });
    const third = store.recordFailure('account-1', 'workflow', 'selector timeout', {
      timestamp: '2026-03-21T12:10:00.000Z'
    });

    assert.equal(third.status, 'cooldown');
    assert.equal(store.isCoolingDown('account-1', 'workflow', new Date('2026-03-21T12:15:00.000Z')), true);
    assert.deepEqual(store.getCoolingDownAccountIds('workflow', new Date('2026-03-21T12:15:00.000Z')), ['account-1']);
  } finally {
    workspace.cleanup();
  }
});

test('LinkedInAccountHealthStore applies severe cooldowns for reply-monitor rate limits and clears on success', () => {
  const workspace = createTempWorkspace('linkedin-account-health-rate-limit-');
  try {
    const store = new LinkedInAccountHealthStore({
      storePath: workspace.path('linkedin-account-health.json')
    });

    const failure = store.recordFailure('account-2', 'replyMonitor', 'HTTP 429 rate limit');
    assert.equal(failure.status, 'cooldown');
    assert.equal(store.isCoolingDown('account-2', 'replyMonitor'), true);

    const success = store.recordSuccess('account-2', 'replyMonitor', {
      timestamp: '2026-03-21T13:00:00.000Z'
    });
    assert.equal(success.status, 'healthy');

    const accountHealth = store.getAccountHealth('account-2');
    assert.equal(accountHealth.replyMonitor.status, 'healthy');
    assert.equal(accountHealth.replyMonitor.consecutiveFailures, 0);
    assert.equal(accountHealth.replyMonitor.cooldownUntil, null);
  } finally {
    workspace.cleanup();
  }
});

test('LinkedInAccountHealthStore records and clears account-level challenges independently of subsystem health', () => {
  const workspace = createTempWorkspace('linkedin-account-health-challenge-');
  try {
    const store = new LinkedInAccountHealthStore({
      storePath: workspace.path('linkedin-account-health.json')
    });

    store.recordFailure('account-3', 'workflow', 'selector timeout', {
      timestamp: '2026-03-21T10:00:00.000Z'
    });
    const challenged = store.recordChallenge('account-3', 'captcha', 'reply_poll', {
      timestamp: '2026-03-21T10:05:00.000Z'
    });

    assert.equal(challenged.challenged.type, 'captcha');
    assert.equal(store.isChallenged('account-3'), true);
    assert.deepEqual(store.getChallengedAccountIds(), ['account-3']);

    const accountHealth = store.getAccountHealth('account-3');
    assert.equal(accountHealth.workflow.status, 'warning');
    assert.equal(accountHealth.challenged.type, 'captcha');

    const cleared = store.clearChallenge('account-3');
    assert.equal(cleared.challenged, null);
    assert.equal(store.isChallenged('account-3'), false);
    assert.deepEqual(store.getChallengedAccountIds(), []);
    assert.equal(store.getAccountHealth('account-3').workflow.status, 'warning');
  } finally {
    workspace.cleanup();
  }
});

test('LinkedInAccountHealthStore normalizes malformed challenge records to null', () => {
  const workspace = createTempWorkspace('linkedin-account-health-normalize-');
  try {
    const store = new LinkedInAccountHealthStore({
      storePath: workspace.path('linkedin-account-health.json')
    });

    store.recordFailure('account-4', 'replyMonitor', 'HTTP 429 rate limit', {
      timestamp: '2026-03-21T11:00:00.000Z'
    });

    const persisted = {
      version: 2,
      accounts: {
        'account-4': {
          workflow: null,
          replyMonitor: {
            lastError: 'HTTP 429 rate limit',
            lastErrorAt: '2026-03-21T11:00:00.000Z',
            cooldownUntil: '2099-03-21T13:00:00.000Z'
          },
          challenged: {
            type: 'captcha',
            source: 'reply_poll'
          }
        }
      }
    };
    fs.writeFileSync(
      workspace.path('linkedin-account-health.json'),
      JSON.stringify(persisted, null, 2)
    );

    const accountHealth = store.getAccountHealth('account-4');
    assert.equal(accountHealth.replyMonitor.status, 'cooldown');
    assert.equal(accountHealth.challenged, null);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// meta.cooldownMs override — the 429 / Retry-After integration point
// ---------------------------------------------------------------------------

test('recordFailure with explicit meta.cooldownMs overrides classification default', () => {
  // Default policy for workflow rate_limit classification is severeCooldownMs
  // = 6h. Passing an explicit meta.cooldownMs (e.g. derived from a
  // Retry-After header) must take precedence over the policy default.
  const workspace = createTempWorkspace('linkedin-account-health-cooldown-override-');
  try {
    const store = new LinkedInAccountHealthStore({
      storePath: workspace.path('linkedin-account-health.json')
    });

    const before = Date.now();
    const failure = store.recordFailure(
      'account-override',
      'workflow',
      'HTTP 429 rate limit',
      { cooldownMs: 90 * 1000 }
    );
    const after = Date.now();

    assert.equal(failure.status, 'cooldown');
    assert.ok(failure.cooldownUntil);

    const cooldownAt = new Date(failure.cooldownUntil).getTime();
    const elapsedSinceBefore = cooldownAt - before;
    const elapsedSinceAfter = cooldownAt - after;
    // The cooldown should be ~90s out from now, NOT 6h (which would be the
    // policy default for a rate_limit classification). Allow 1s tolerance.
    assert.ok(elapsedSinceBefore >= 90 * 1000, `cooldown should be at least 90s; got ${elapsedSinceBefore}ms`);
    assert.ok(elapsedSinceAfter <= 91 * 1000, `cooldown should be ~90s, not 6h; got ${elapsedSinceAfter}ms`);
  } finally {
    workspace.cleanup();
  }
});

test('recordFailure with meta.cooldownMs honored even for non-rate-limit classifications', () => {
  // The override is unconditional — passing an explicit cooldownMs means the
  // caller has already resolved the duration and we should respect it
  // regardless of what classifyRuntimeIssue would have picked.
  const workspace = createTempWorkspace('linkedin-account-health-cooldown-override-transient-');
  try {
    const store = new LinkedInAccountHealthStore({
      storePath: workspace.path('linkedin-account-health.json')
    });

    const before = Date.now();
    const failure = store.recordFailure(
      'account-transient',
      'workflow',
      'Some unrelated transient error',
      { cooldownMs: 120 * 1000 }
    );
    const after = Date.now();

    // A single transient error normally wouldn't trigger cooldown
    // (consecutiveFailures < threshold of 3). The explicit override forces it.
    assert.equal(failure.status, 'cooldown');
    const cooldownAt = new Date(failure.cooldownUntil).getTime();
    assert.ok(cooldownAt - before >= 120 * 1000);
    assert.ok(cooldownAt - after <= 121 * 1000);
  } finally {
    workspace.cleanup();
  }
});
