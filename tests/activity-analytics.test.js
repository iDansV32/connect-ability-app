const test = require('node:test');
const assert = require('node:assert/strict');

const ActivityAnalyticsService = require('../activity-analytics');
const { createTempWorkspace, writeJson, writeJsonLines } = require('./test-helpers');

test('ActivityAnalyticsService merges ledger and legacy events without double-counting', () => {
  const workspace = createTempWorkspace('activity-analytics-');
  try {
    const now = new Date('2026-03-21T12:00:00.000Z').toISOString();
    const eventsPath = workspace.path('activity-events.jsonl');
    const profilesPath = workspace.path('profiles.json');

    writeJsonLines(eventsPath, [
      {
        id: 'evt-1',
        type: 'profile_viewed',
        timestamp: now,
        profileUrl: 'https://www.linkedin.com/in/jane-doe/',
        targetValue: 'Jane Doe',
        accountId: 'account-1'
      },
      {
        id: 'evt-2',
        type: 'dm_sent',
        timestamp: now,
        targetValue: 'Jane Doe',
        accountId: 'account-1',
        workflowId: 'workflow-1',
        agentId: 'agent-1'
      },
      {
        id: 'evt-3',
        type: 'connection_accepted',
        timestamp: '2026-03-21T12:03:00.000Z',
        targetValue: 'Jane Doe',
        accountId: 'account-1',
        workflowId: 'workflow-1',
        agentId: 'agent-1'
      },
      {
        id: 'evt-4',
        type: 'dm_reply_received',
        timestamp: '2026-03-21T12:05:00.000Z',
        targetValue: 'Jane Doe',
        accountId: 'account-1',
        workflowId: 'workflow-1',
        agentId: 'agent-1',
        metadata: { senderName: 'Jane Doe' }
      }
    ]);

    writeJson(profilesPath, [
      {
        originalUrl: 'https://www.linkedin.com/in/jane-doe/',
        fullName: 'Jane Doe',
        actions: [
          {
            type: 'Profile Viewed',
            timestamp: now
          },
          {
            type: 'Connection Request Sent',
            timestamp: '2026-03-21T12:02:00.000Z'
          }
        ]
      }
    ]);

    const analytics = new ActivityAnalyticsService({
      eventsPath,
      profilesPath
    });

    const overview = analytics.getOverview({ activityLimit: 10 });
    assert.equal(overview.totals.profilesViewed, 1);
    assert.equal(overview.totals.connectionRequests, 1);
    assert.equal(overview.totals.connectionAcceptances, 1);
    assert.equal(overview.totals.dmsSent, 1);
    assert.equal(overview.totals.dmReplies, 1);
    assert.equal(overview.rates.dmReplyRate, 100);
    assert.equal(overview.rates.connectionAcceptanceRate, 100);
    assert.equal(
      overview.byAgent.some((entry) => entry.id === 'agent-1' && entry.replies === 1 && entry.dmsSent === 1 && entry.acceptances === 1),
      true
    );
    assert.equal(
      overview.byWorkflow.some((entry) => entry.id === 'workflow-1' && entry.replies === 1 && entry.dmsSent === 1 && entry.acceptances === 1),
      true
    );
    assert.equal(overview.recentReplies[0].name, 'Jane Doe');
  } finally {
    workspace.cleanup();
  }
});

test('ActivityAnalyticsService recentReplies is not limited by recentActivity window', () => {
  const workspace = createTempWorkspace('activity-analytics-replies-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    const profilesPath = workspace.path('profiles.json');
    const events = [];

    for (let index = 0; index < 12; index += 1) {
      events.push({
        id: `view-${index}`,
        type: 'profile_viewed',
        timestamp: `2026-03-21T12:${String(20 + index).padStart(2, '0')}:00.000Z`,
        targetValue: `Prospect ${index}`,
        accountId: 'account-1'
      });
    }

    events.push({
      id: 'reply-older',
      type: 'dm_reply_received',
      timestamp: '2026-03-21T12:05:00.000Z',
      targetValue: 'Jane Doe',
      accountId: 'account-1',
      workflowId: 'workflow-1',
      agentId: 'agent-1',
      metadata: { senderName: 'Jane Doe' }
    });

    writeJsonLines(eventsPath, events);
    writeJson(profilesPath, []);

    const analytics = new ActivityAnalyticsService({
      eventsPath,
      profilesPath
    });

    const overview = analytics.getOverview({ activityLimit: 5 });
    assert.equal(overview.recentActivity.length, 5);
    assert.equal(overview.recentReplies.length, 1);
    assert.equal(overview.recentReplies[0].name, 'Jane Doe');
  } finally {
    workspace.cleanup();
  }
});

test('getAccountHealthBreakdown summarizes current account health and risk signals', () => {
  const workspace = createTempWorkspace('activity-analytics-account-health-');
  try {
    writeJson(workspace.path('linkedin-accounts.json'), {
      accounts: [
        { id: 'account-1', name: 'Alice SDR', email: 'alice@example.com' },
        { id: 'account-2', name: 'Bob SDR', email: 'bob@example.com' }
      ]
    });

    writeJson(workspace.path('linkedin-account-health.json'), {
      version: 2,
      accounts: {
        'account-1': {
          workflow: {
            status: 'cooldown',
            lastSuccessAt: null,
            lastErrorAt: '2026-03-21T10:00:00.000Z',
            lastError: 'selector timeout',
            consecutiveFailures: 3,
            cooldownUntil: '2099-03-21T11:00:00.000Z',
            cooldownReason: 'challenge',
            lastUpdatedAt: '2026-03-21T10:00:00.000Z'
          },
          replyMonitor: {
            status: 'healthy',
            lastSuccessAt: null,
            lastErrorAt: null,
            lastError: null,
            consecutiveFailures: 0,
            cooldownUntil: null,
            cooldownReason: null,
            lastUpdatedAt: '2026-03-21T10:00:00.000Z'
          },
          challenged: {
            at: '2026-03-21T10:05:00.000Z',
            type: 'captcha',
            source: 'verify_session'
          },
          updatedAt: '2026-03-21T10:05:00.000Z'
        },
        'account-2': {
          workflow: {
            status: 'healthy',
            lastSuccessAt: '2026-03-21T10:00:00.000Z',
            lastErrorAt: null,
            lastError: null,
            consecutiveFailures: 0,
            cooldownUntil: null,
            cooldownReason: null,
            lastUpdatedAt: '2026-03-21T10:00:00.000Z'
          },
          replyMonitor: {
            status: 'cooldown',
            lastSuccessAt: null,
            lastErrorAt: '2026-03-21T10:02:00.000Z',
            lastError: 'HTTP 429 rate limit',
            consecutiveFailures: 2,
            cooldownUntil: '2099-03-21T12:00:00.000Z',
            cooldownReason: 'rate_limit',
            lastUpdatedAt: '2026-03-21T10:02:00.000Z'
          },
          challenged: null,
          updatedAt: '2026-03-21T10:02:00.000Z'
        }
      }
    });

    writeJson(workspace.path('transport-health.json'), {
      version: 1,
      entries: {
        'private_api::send_dm::alice@example.com': {
          transport: 'private_api',
          action: 'send_dm',
          accountEmail: 'alice@example.com',
          successCount: 1,
          failureCount: 3,
          lastSuccessAt: '2026-03-21T09:55:00.000Z',
          lastFailureAt: '2026-03-21T09:59:00.000Z',
          lastFailureReason: 'messaging_canary_failed',
          lastUpdatedAt: '2026-03-21T09:59:00.000Z',
          disabled: true,
          disabledUntil: '2099-03-21T10:30:00.000Z'
        },
        'dom::send_connection::alice@example.com': {
          transport: 'dom',
          action: 'send_connection',
          accountEmail: 'alice@example.com',
          successCount: 0,
          failureCount: 1,
          lastSuccessAt: null,
          lastFailureAt: '2026-03-21T09:58:00.000Z',
          lastFailureReason: 'selector_canary_exception',
          lastUpdatedAt: '2026-03-21T09:58:00.000Z',
          disabled: false,
          disabledUntil: null
        },
        'private_api::send_connection::bob@example.com': {
          transport: 'private_api',
          action: 'send_connection',
          accountEmail: 'bob@example.com',
          successCount: 0,
          failureCount: 3,
          lastSuccessAt: null,
          lastFailureAt: '2026-03-21T09:50:00.000Z',
          lastFailureReason: 'identity_canary_failed',
          lastUpdatedAt: '2026-03-21T09:50:00.000Z',
          disabled: true,
          disabledUntil: '2099-03-21T10:20:00.000Z'
        }
      }
    });

    writeJson(workspace.path('session-registry.json'), {
      version: 1,
      accounts: {
        'alice@example.com': {
          email: 'alice@example.com',
          profilePath: workspace.path('profiles', 'alice'),
          lastVerifiedAt: '2026-03-21T09:45:00.000Z',
          lastVerifiedBy: 'action',
          lastAuthFailureAt: null,
          lastChallengeAt: null,
          updatedAt: '2026-03-21T09:56:00.000Z'
        },
        'bob@example.com': {
          email: 'bob@example.com',
          profilePath: workspace.path('profiles', 'bob'),
          lastVerifiedAt: '2026-03-21T09:30:00.000Z',
          lastVerifiedBy: 'canary',
          lastAuthFailureAt: null,
          lastChallengeAt: null,
          updatedAt: '2026-03-21T09:30:00.000Z'
        }
      }
    });

    writeJsonLines(workspace.path('runtime-logs.jsonl'), [
      {
        id: 'log-1',
        timestamp: '2026-03-21T09:56:30.000Z',
        type: 'warning',
        source: 'workflow-worker',
        message: 'Session verification failed: LinkedIn session could not be verified',
        accountId: 'account-1',
        accountName: 'Alice SDR'
      },
      {
        id: 'log-2',
        timestamp: '2026-03-21T09:57:00.000Z',
        type: 'info',
        source: 'private-api-canary',
        message: 'Identity private API canary passed using profileByVanityNamePrimary.',
        accountId: 'account-1',
        accountName: 'Alice SDR'
      },
      {
        id: 'log-3',
        timestamp: '2026-03-21T09:58:00.000Z',
        type: 'warning',
        source: 'selector-canary',
        message: 'Connection DOM selector canary failed: no matching selectors.',
        accountId: 'account-1',
        accountName: 'Alice SDR'
      },
      {
        id: 'log-4',
        timestamp: '2026-03-21T09:59:00.000Z',
        type: 'warning',
        source: 'private-api-canary',
        message: 'Messaging private API canary failed: timeout.',
        accountId: 'account-2',
        accountName: 'Bob SDR'
      }
    ]);

    const analytics = new ActivityAnalyticsService({
      eventsPath: workspace.path('activity-events.jsonl'),
      profilesPath: workspace.path('profiles.json'),
      accountHealthPath: workspace.path('linkedin-account-health.json'),
      transportHealthPath: workspace.path('transport-health.json'),
      runtimeLogsPath: workspace.path('runtime-logs.jsonl'),
      sessionRegistryPath: workspace.path('session-registry.json'),
      linkedInAccountsPath: workspace.path('linkedin-accounts.json')
    });

    const result = analytics.getAccountHealthBreakdown({ accountId: 'account-1' });

    assert.equal(result.byAccount.length, 1);
    assert.equal(result.byAccount[0].accountId, 'account-1');
    assert.equal(result.byAccount[0].accountName, 'Alice SDR');
    assert.equal(result.byAccount[0].accountEmail, 'alice@example.com');
    assert.equal(result.byAccount[0].challengeCount, 1);
    assert.equal(result.byAccount[0].cooldownCount, 1);
    assert.equal(result.byAccount[0].transportDisableCount, 1);
    assert.equal(result.byAccount[0].verificationFailureRate, 50);
    assert.equal(result.byAccount[0].canaryFailureRate, 50);
    assert.equal(result.totals.accounts, 1);
    assert.equal(result.totals.challengeCount, 1);
    assert.equal(result.totals.cooldownCount, 1);
    assert.equal(result.totals.transportDisableCount, 1);
  } finally {
    workspace.cleanup();
  }
});

// ---- getStepOutcomeBreakdown ----

test('getStepOutcomeBreakdown returns empty result when there are no step events', () => {
  const workspace = createTempWorkspace('analytics-breakdown-empty-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    writeJsonLines(eventsPath, [
      { id: 'e-1', type: 'profile_viewed', timestamp: '2026-03-21T10:00:00.000Z', accountId: 'acc-1' }
    ]);

    const analytics = new ActivityAnalyticsService({ eventsPath, profilesPath: workspace.path('profiles.json') });
    const result = analytics.getStepOutcomeBreakdown();

    assert.deepEqual(result.byStepType, []);
    assert.deepEqual(result.totals, { total: 0, completed: 0, skipped: 0, failed: 0 });
  } finally {
    workspace.cleanup();
  }
});

test('getStepOutcomeBreakdown groups by stepType and outcomeType with correct counts', () => {
  const workspace = createTempWorkspace('analytics-breakdown-basic-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    writeJsonLines(eventsPath, [
      // view_profile: 3 completed, 2 skipped_quota_exceeded, 1 skipped_outside_working_hours
      { id: 'e-1', type: 'workflow_step_completed', timestamp: '2026-03-21T10:00:00.000Z', accountId: 'acc-1', status: 'ok', metadata: { stepType: 'view_profile', outcomeType: 'completed' } },
      { id: 'e-2', type: 'workflow_step_completed', timestamp: '2026-03-21T10:01:00.000Z', accountId: 'acc-1', status: 'ok', metadata: { stepType: 'view_profile', outcomeType: 'completed' } },
      { id: 'e-3', type: 'workflow_step_completed', timestamp: '2026-03-21T10:02:00.000Z', accountId: 'acc-1', status: 'ok', metadata: { stepType: 'view_profile', outcomeType: 'completed' } },
      { id: 'e-4', type: 'workflow_step_completed', timestamp: '2026-03-21T10:03:00.000Z', accountId: 'acc-1', status: 'skipped', metadata: { stepType: 'view_profile', outcomeType: 'skipped_quota_exceeded' } },
      { id: 'e-5', type: 'workflow_step_completed', timestamp: '2026-03-21T10:04:00.000Z', accountId: 'acc-1', status: 'skipped', metadata: { stepType: 'view_profile', outcomeType: 'skipped_quota_exceeded' } },
      { id: 'e-6', type: 'workflow_step_completed', timestamp: '2026-03-21T10:05:00.000Z', accountId: 'acc-1', status: 'skipped', metadata: { stepType: 'view_profile', outcomeType: 'skipped_outside_working_hours' } },
      // send_dm: 2 completed, 1 failed_transient
      { id: 'e-7', type: 'workflow_step_completed', timestamp: '2026-03-21T10:06:00.000Z', accountId: 'acc-1', status: 'ok', metadata: { stepType: 'send_dm', outcomeType: 'completed' } },
      { id: 'e-8', type: 'workflow_step_completed', timestamp: '2026-03-21T10:07:00.000Z', accountId: 'acc-1', status: 'ok', metadata: { stepType: 'send_dm', outcomeType: 'completed' } },
      { id: 'e-9', type: 'workflow_step_failed', timestamp: '2026-03-21T10:08:00.000Z', accountId: 'acc-1', status: 'failed', metadata: { stepType: 'send_dm', outcomeType: 'failed_transient' } }
    ]);

    const analytics = new ActivityAnalyticsService({ eventsPath, profilesPath: workspace.path('profiles.json') });
    const result = analytics.getStepOutcomeBreakdown();

    // Sorted by total descending (view_profile: 6, send_dm: 3)
    assert.equal(result.byStepType.length, 2);
    const [vpEntry, dmEntry] = result.byStepType;

    assert.equal(vpEntry.stepType, 'view_profile');
    assert.equal(vpEntry.total, 6);
    // breakdown sorted by count descending: completed(3), skipped_quota_exceeded(2), skipped_outside_working_hours(1)
    assert.equal(vpEntry.breakdown[0].outcomeType, 'completed');
    assert.equal(vpEntry.breakdown[0].count, 3);
    assert.equal(vpEntry.breakdown[1].outcomeType, 'skipped_quota_exceeded');
    assert.equal(vpEntry.breakdown[1].count, 2);
    assert.equal(vpEntry.breakdown[2].outcomeType, 'skipped_outside_working_hours');
    assert.equal(vpEntry.breakdown[2].count, 1);

    assert.equal(dmEntry.stepType, 'send_dm');
    assert.equal(dmEntry.total, 3);

    // Overall totals
    assert.equal(result.totals.total, 9);
    assert.equal(result.totals.completed, 5); // 3 view_profile + 2 send_dm with status ok
    assert.equal(result.totals.skipped, 3);   // 3 view_profile with status skipped
    assert.equal(result.totals.failed, 1);    // 1 send_dm with status failed
  } finally {
    workspace.cleanup();
  }
});

test('getStepOutcomeBreakdown respects agentId filter', () => {
  const workspace = createTempWorkspace('analytics-breakdown-agent-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    writeJsonLines(eventsPath, [
      { id: 'e-1', type: 'workflow_step_completed', timestamp: '2026-03-21T10:00:00.000Z', agentId: 'agent-a', status: 'ok', metadata: { stepType: 'view_profile', outcomeType: 'completed' } },
      { id: 'e-2', type: 'workflow_step_completed', timestamp: '2026-03-21T10:01:00.000Z', agentId: 'agent-b', status: 'skipped', metadata: { stepType: 'view_profile', outcomeType: 'skipped_quota_exceeded' } },
      { id: 'e-3', type: 'workflow_step_completed', timestamp: '2026-03-21T10:02:00.000Z', agentId: 'agent-a', status: 'ok', metadata: { stepType: 'send_dm', outcomeType: 'completed' } }
    ]);

    const analytics = new ActivityAnalyticsService({ eventsPath, profilesPath: workspace.path('profiles.json') });

    const agentAResult = analytics.getStepOutcomeBreakdown({ agentId: 'agent-a' });
    assert.equal(agentAResult.totals.total, 2);
    assert.equal(agentAResult.byStepType.length, 2);

    const agentBResult = analytics.getStepOutcomeBreakdown({ agentId: 'agent-b' });
    assert.equal(agentBResult.totals.total, 1);
    assert.equal(agentBResult.byStepType[0].stepType, 'view_profile');
    assert.equal(agentBResult.byStepType[0].breakdown[0].outcomeType, 'skipped_quota_exceeded');
  } finally {
    workspace.cleanup();
  }
});

test('getStepOutcomeBreakdown respects since/until filter', () => {
  const workspace = createTempWorkspace('analytics-breakdown-time-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    writeJsonLines(eventsPath, [
      { id: 'e-old', type: 'workflow_step_completed', timestamp: '2026-03-01T10:00:00.000Z', accountId: 'acc-1', status: 'ok', metadata: { stepType: 'view_profile', outcomeType: 'completed' } },
      { id: 'e-new', type: 'workflow_step_completed', timestamp: '2026-03-21T10:00:00.000Z', accountId: 'acc-1', status: 'skipped', metadata: { stepType: 'view_profile', outcomeType: 'skipped_outside_working_hours' } }
    ]);

    const analytics = new ActivityAnalyticsService({ eventsPath, profilesPath: workspace.path('profiles.json') });

    const recentResult = analytics.getStepOutcomeBreakdown({ since: '2026-03-15T00:00:00.000Z' });
    assert.equal(recentResult.totals.total, 1);
    assert.equal(recentResult.byStepType[0].breakdown[0].outcomeType, 'skipped_outside_working_hours');
  } finally {
    workspace.cleanup();
  }
});

test('getStepOutcomeBreakdown treats missing stepType and outcomeType as unknown', () => {
  const workspace = createTempWorkspace('analytics-breakdown-unknown-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    writeJsonLines(eventsPath, [
      { id: 'e-1', type: 'workflow_step_failed', timestamp: '2026-03-21T10:00:00.000Z', accountId: 'acc-1', status: 'failed', metadata: {} }
    ]);

    const analytics = new ActivityAnalyticsService({ eventsPath, profilesPath: workspace.path('profiles.json') });
    const result = analytics.getStepOutcomeBreakdown();

    assert.equal(result.byStepType.length, 1);
    assert.equal(result.byStepType[0].stepType, 'unknown');
    assert.equal(result.byStepType[0].breakdown[0].outcomeType, 'unknown');
    assert.equal(result.byStepType[0].breakdown[0].count, 1);
  } finally {
    workspace.cleanup();
  }
});

test('getStepOutcomeBreakdown skips non-step events such as profile_viewed', () => {
  const workspace = createTempWorkspace('analytics-breakdown-skip-non-step-');
  try {
    const eventsPath = workspace.path('activity-events.jsonl');
    writeJsonLines(eventsPath, [
      { id: 'e-1', type: 'profile_viewed',          timestamp: '2026-03-21T10:00:00.000Z', accountId: 'acc-1', metadata: { stepType: 'view_profile', outcomeType: 'completed' } },
      { id: 'e-2', type: 'dm_sent',                 timestamp: '2026-03-21T10:01:00.000Z', accountId: 'acc-1', metadata: { stepType: 'send_dm',     outcomeType: 'completed' } },
      { id: 'e-3', type: 'workflow_step_completed',  timestamp: '2026-03-21T10:02:00.000Z', accountId: 'acc-1', status: 'ok', metadata: { stepType: 'like_posts',  outcomeType: 'completed' } }
    ]);

    const analytics = new ActivityAnalyticsService({ eventsPath, profilesPath: workspace.path('profiles.json') });
    const result = analytics.getStepOutcomeBreakdown();

    // Only the workflow_step_completed event should be counted
    assert.equal(result.totals.total, 1);
    assert.equal(result.byStepType[0].stepType, 'like_posts');
  } finally {
    workspace.cleanup();
  }
});

test('ActivityAnalyticsService scopes legacy profile actions by accountId', () => {
  const workspace = createTempWorkspace('activity-analytics-legacy-account-scope-');
  try {
    const profilesPath = workspace.path('profiles.json');
    writeJson(profilesPath, [
      {
        originalUrl: 'https://www.linkedin.com/in/robert-henderson/',
        fullName: 'Robert Henderson',
        accountId: 'account-robert',
        accountName: 'Robert Henderson',
        actions: [
          {
            type: 'Profile Viewed',
            timestamp: '2026-03-21T12:00:00.000Z'
          }
        ]
      },
      {
        originalUrl: 'https://www.linkedin.com/in/ivan-dans/',
        fullName: 'Ivan Dans',
        accountId: 'account-ivan',
        accountName: 'Ivan Dans',
        actions: [
          {
            type: 'Profile Viewed',
            timestamp: '2026-03-21T12:05:00.000Z'
          }
        ]
      }
    ]);

    const analytics = new ActivityAnalyticsService({
      eventsPath: workspace.path('activity-events.jsonl'),
      profilesPath
    });

    const robertOverview = analytics.getOverview({ accountId: 'account-robert', activityLimit: 10 });
    const ivanOverview = analytics.getOverview({ accountId: 'account-ivan', activityLimit: 10 });

    assert.equal(robertOverview.totals.profilesViewed, 1);
    assert.equal(robertOverview.recentActivity[0].name, 'Robert Henderson');
    assert.equal(ivanOverview.totals.profilesViewed, 1);
    assert.equal(ivanOverview.recentActivity[0].name, 'Ivan Dans');
  } finally {
    workspace.cleanup();
  }
});
