'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTION_QUOTA_WINDOWS,
  DAILY_RANDOM_MIN_FACTOR,
  DAILY_RANDOM_MAX_FACTOR,
  applyDailyWindowOptions,
  canConsumeActionQuota,
  consumeActionQuota,
  getActionQuota,
  randomBetween
} = require('../linkedin-action-quota-store');
const { createTempWorkspace } = require('./test-helpers');

// Deterministic RNG helpers for tests that need predictable limits.
// rngMin always picks the lower bound; rngMax always picks the upper bound.
const rngMin = () => 0;
const rngMax = () => 0.9999;

function dailyLo(configLimit) {
  const ceiling = configLimit; // No warm-up in these tests (multiplier = 1).
  return Math.max(1, Math.floor(ceiling * DAILY_RANDOM_MIN_FACTOR));
}

function dailyHi(configLimit) {
  const lo = dailyLo(configLimit);
  return Math.max(lo, Math.floor(configLimit * DAILY_RANDOM_MAX_FACTOR));
}

// ---------------------------------------------------------------------------
// Existing behaviour — updated for daily randomisation
// ---------------------------------------------------------------------------

test('linkedin action quota store initializes default windows for each account independently', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    // Use rngMin so the daily limit is deterministic (always picks the lo bound).
    const accountOne = getActionQuota('profile_viewed', {
      quotaPath, now, accountId: 'account-1', accountEmail: 'one@example.com', rng: rngMin
    });
    const accountTwo = getActionQuota('profile_viewed', {
      quotaPath, now, accountId: 'account-2', accountEmail: 'two@example.com', rng: rngMin
    });

    // Daily limit is now randomised; verify it's within the allowed range.
    const expectedLo = dailyLo(ACTION_QUOTA_WINDOWS.profile_viewed.daily.limit); // 48
    const expectedHi = dailyHi(ACTION_QUOTA_WINDOWS.profile_viewed.daily.limit); // 76
    assert.ok(
      accountOne.daily.limit >= expectedLo && accountOne.daily.limit <= expectedHi,
      `daily.limit ${accountOne.daily.limit} should be in [${expectedLo}, ${expectedHi}]`
    );
    // Weekly is never randomised — must stay at the configured value.
    assert.equal(accountOne.weekly.limit, ACTION_QUOTA_WINDOWS.profile_viewed.weekly.limit);
    assert.equal(accountTwo.daily.used, 0);
    assert.equal(accountTwo.weekly.used, 0);
  } finally {
    workspace.cleanup();
  }
});

test('linkedin action quota store blocks one account without affecting another', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-block-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    // Use rngMin so the daily limit for connection_requested is exactly the lower bound.
    const loLimit = dailyLo(ACTION_QUOTA_WINDOWS.connection_requested.daily.limit);

    const consumed = consumeActionQuota('connection_requested', loLimit, {
      quotaPath, now, accountId: 'account-1', accountEmail: 'one@example.com', rng: rngMin
    });
    assert.equal(consumed.allowed, true);
    assert.equal(consumed.quota.daily.used, loLimit);

    const blocked = canConsumeActionQuota('connection_requested', 1, {
      quotaPath, now, accountId: 'account-1', accountEmail: 'one@example.com', rng: rngMin
    });
    assert.equal(blocked.allowed, false);
    assert.deepEqual(blocked.exceeded, ['daily']);

    const otherAccount = canConsumeActionQuota('connection_requested', 1, {
      quotaPath, now, accountId: 'account-2', accountEmail: 'two@example.com'
    });
    assert.equal(otherAccount.allowed, true);
    assert.equal(otherAccount.quota.daily.used, 0);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Daily randomisation
// ---------------------------------------------------------------------------

test('daily window limit is randomised on first access within configured range', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-rand-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const configLimit = ACTION_QUOTA_WINDOWS.connection_requested.daily.limit;

    const quota = getActionQuota('connection_requested', { quotaPath, now });

    const lo = dailyLo(configLimit);
    const hi = dailyHi(configLimit);
    assert.ok(
      quota.daily.limit >= lo && quota.daily.limit <= hi,
      `daily.limit ${quota.daily.limit} must be in [${lo}, ${hi}]`
    );
    assert.equal(quota.daily.used, 0);
  } finally {
    workspace.cleanup();
  }
});

test('daily randomisation uses rngMin to consistently pick the lower bound', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-rng-lo-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const configLimit = ACTION_QUOTA_WINDOWS.post_liked.daily.limit; // 35
    const expectedLo = dailyLo(configLimit); // floor(35 * 0.60) = 21

    const quota = getActionQuota('post_liked', { quotaPath, now, rng: rngMin });
    assert.equal(quota.daily.limit, expectedLo);
  } finally {
    workspace.cleanup();
  }
});

test('daily randomisation uses rngMax to consistently pick the upper bound', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-rng-hi-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const configLimit = ACTION_QUOTA_WINDOWS.post_liked.daily.limit; // 35
    const expectedHi = dailyHi(configLimit); // floor(35 * 0.95) = 33

    const quota = getActionQuota('post_liked', { quotaPath, now, rng: rngMax });
    assert.equal(quota.daily.limit, expectedHi);
  } finally {
    workspace.cleanup();
  }
});

test('weekly window limit is never randomised', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-weekly-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    for (const actionType of Object.keys(ACTION_QUOTA_WINDOWS)) {
      const quota = getActionQuota(actionType, { quotaPath, now });
      assert.equal(
        quota.weekly.limit,
        ACTION_QUOTA_WINDOWS[actionType].weekly.limit,
        `weekly.limit for ${actionType} must equal the configured value`
      );
    }
  } finally {
    workspace.cleanup();
  }
});

test('_randomized flag prevents re-randomising within the same window cycle', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-flag-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    // First call with rngMin → limit = lo.
    const firstQuota = getActionQuota('profile_viewed', { quotaPath, now, rng: rngMin });
    const lockedLimit = firstQuota.daily.limit;

    // Second call with rngMax — the _randomized flag should prevent changes.
    const secondQuota = getActionQuota('profile_viewed', { quotaPath, now, rng: rngMax });
    assert.equal(
      secondQuota.daily.limit,
      lockedLimit,
      'limit must not change within the same window cycle'
    );
  } finally {
    workspace.cleanup();
  }
});

test('window reset picks a fresh randomised limit for the new daily cycle', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-reset-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    // Seed the first cycle with rngMin → lo.
    const firstQuota = getActionQuota('connection_requested', { quotaPath, now, rng: rngMin });
    const loLimit = dailyLo(ACTION_QUOTA_WINDOWS.connection_requested.daily.limit);
    assert.equal(firstQuota.daily.limit, loLimit);

    // Advance past the reset window (25 hours later).
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    // New cycle with rngMax → should pick hi instead of lo.
    const secondQuota = getActionQuota('connection_requested', { quotaPath, now: later, rng: rngMax });
    const hiLimit = dailyHi(ACTION_QUOTA_WINDOWS.connection_requested.daily.limit);
    assert.equal(secondQuota.daily.limit, hiLimit);
    assert.equal(secondQuota.daily.used, 0);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Warm-up multiplier integration
// ---------------------------------------------------------------------------

test('warm-up multiplier reduces the effective daily ceiling', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-warmup-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const configLimit = ACTION_QUOTA_WINDOWS.connection_requested.daily.limit;
    const multiplier = 0.25;

    // With rngMin and warm-up=0.25, the lower-bound daily limit is computed from the reduced ceiling.
    const quota = getActionQuota('connection_requested', {
      quotaPath, now, warmUpMultiplier: multiplier, rng: rngMin
    });
    const effectiveCeiling = Math.max(1, Math.floor(configLimit * multiplier)); // 7
    const expectedLo = Math.max(1, Math.floor(effectiveCeiling * DAILY_RANDOM_MIN_FACTOR)); // 4
    assert.equal(quota.daily.limit, expectedLo);
    // Warm-up must not touch the weekly limit.
    assert.equal(quota.weekly.limit, ACTION_QUOTA_WINDOWS.connection_requested.weekly.limit);
  } finally {
    workspace.cleanup();
  }
});

test('warm-up multiplier of 1.0 produces the same range as no warm-up', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-warmup-full-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const configLimit = ACTION_QUOTA_WINDOWS.profile_viewed.daily.limit; // 80

    const quotaFull = getActionQuota('profile_viewed', {
      quotaPath, now, warmUpMultiplier: 1.0, rng: rngMin
    });
    assert.equal(quotaFull.daily.limit, dailyLo(configLimit));
  } finally {
    workspace.cleanup();
  }
});

test('warm-up multiplier clamps the daily limit to at least 1', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-warmup-min-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    // post_published daily limit is 2 — even tiny warm-up should give ≥ 1.
    const quota = getActionQuota('post_published', {
      quotaPath, now, warmUpMultiplier: 0.01, rng: rngMin
    });
    assert.ok(quota.daily.limit >= 1, `daily.limit must be at least 1, got ${quota.daily.limit}`);
  } finally {
    workspace.cleanup();
  }
});

test('consuming quota respects warm-up ceiling and blocks at the effective limit', () => {
  const workspace = createTempWorkspace('linkedin-action-quota-warmup-block-');
  try {
    const quotaPath = workspace.path('linkedin-action-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const multiplier = 0.40;
    const configuredLimit = ACTION_QUOTA_WINDOWS.connection_requested.daily.limit;
    const effectiveCeiling = Math.max(1, Math.floor(configuredLimit * multiplier));
    const lo = Math.max(1, Math.floor(effectiveCeiling * DAILY_RANDOM_MIN_FACTOR));

    const opts = { quotaPath, now, warmUpMultiplier: multiplier, rng: rngMin };

    const filled = consumeActionQuota('connection_requested', lo, opts);
    assert.equal(filled.allowed, true);
    assert.equal(filled.quota.daily.limit, lo);

    const blocked = canConsumeActionQuota('connection_requested', 1, opts);
    assert.equal(blocked.allowed, false);
    assert.deepEqual(blocked.exceeded, ['daily']);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// randomBetween helper
// ---------------------------------------------------------------------------

test('randomBetween always returns lo when min === max', () => {
  assert.equal(randomBetween(5, 5), 5);
  assert.equal(randomBetween(5, 5, () => 0), 5);
  assert.equal(randomBetween(5, 5, () => 1), 5);
});

test('randomBetween returns lo when rng returns 0', () => {
  assert.equal(randomBetween(10, 20, () => 0), 10);
});

test('randomBetween stays within [lo, hi] for representative rng values', () => {
  // Math.random returns values in [0, 1) so we test 0, 0.1 … 0.9.
  for (let i = 0; i <= 9; i++) {
    const rng = () => i / 10;
    const result = randomBetween(18, 28, rng);
    assert.ok(result >= 18 && result <= 28, `Expected [18,28] got ${result} for rng=${i / 10}`);
  }
  // Verify the clamp holds for an rng that returns exactly 1.0 (outside the
  // normal [0,1) range — Math.random never produces it, but our shim might).
  assert.equal(randomBetween(18, 28, () => 1.0), 28);
});

// ---------------------------------------------------------------------------
// applyDailyWindowOptions (unit)
// ---------------------------------------------------------------------------

test('applyDailyWindowOptions sets _randomized flag and reduces limit below config', () => {
  const config = { limit: 30, windowMs: 24 * 60 * 60 * 1000 };
  const window = { limit: 30, used: 0, resetTime: new Date(Date.now() + 1e9).toISOString() };
  const result = applyDailyWindowOptions(window, config, { rng: rngMin });

  assert.equal(result._randomized, true);
  assert.ok(result.limit < 30, `Expected limit < 30, got ${result.limit}`);
  assert.equal(result.used, 0);
});

test('applyDailyWindowOptions is a no-op when _randomized is already true', () => {
  const config = { limit: 30, windowMs: 24 * 60 * 60 * 1000 };
  const window = { limit: 10, used: 5, _randomized: true, resetTime: new Date(Date.now() + 1e9).toISOString() };
  const result = applyDailyWindowOptions(window, config, { rng: rngMax });

  assert.equal(result.limit, 10); // unchanged
  assert.equal(result.used, 5);   // unchanged
  assert.equal(result._randomized, true);
});
