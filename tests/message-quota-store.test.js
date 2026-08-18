'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QUOTA_WINDOWS,
  DAILY_RANDOM_MIN_FACTOR,
  DAILY_RANDOM_MAX_FACTOR,
  canConsumeMessageQuota,
  consumeMessageQuota,
  getMessageQuota,
  resetMessageQuotaWindow,
  _private: { randomBetween, applyDailyOptions, resolveAccountKey }
} = require('../message-quota-store');
const { createTempWorkspace, writeJson, readJson } = require('./test-helpers');

const rngMin = () => 0;
const rngMax = () => 0.9999;

function futureDate(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Per-account keying
// ---------------------------------------------------------------------------

test('getMessageQuota uses different quota buckets for different accounts', () => {
  const workspace = createTempWorkspace('msg-quota-accounts-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    // Consume some quota for account-1 only.
    consumeMessageQuota(5, { quotaPath, now, accountId: 'account-1', rng: rngMin });

    const q1 = getMessageQuota({ quotaPath, now, accountId: 'account-1', rng: rngMin });
    const q2 = getMessageQuota({ quotaPath, now, accountId: 'account-2', rng: rngMin });

    assert.equal(q1.daily.used, 5);
    assert.equal(q2.daily.used, 0, 'account-2 must have a separate bucket');
  } finally {
    workspace.cleanup();
  }
});

test('resolveAccountKey falls back to email then to default', () => {
  assert.equal(resolveAccountKey({ accountId: 'id-1' }), 'id-1');
  assert.equal(resolveAccountKey({ accountEmail: 'A@EXAMPLE.COM' }), 'a@example.com');
  assert.equal(resolveAccountKey({}), 'default');
});

// ---------------------------------------------------------------------------
// Daily randomisation
// ---------------------------------------------------------------------------

test('daily limit is randomised on first access within the configured range', () => {
  const workspace = createTempWorkspace('msg-quota-rand-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const quota = getMessageQuota({ quotaPath, now });
    const lo = Math.max(1, Math.floor(QUOTA_WINDOWS.daily.limit * DAILY_RANDOM_MIN_FACTOR));
    const hi = Math.max(lo, Math.floor(QUOTA_WINDOWS.daily.limit * DAILY_RANDOM_MAX_FACTOR));

    assert.ok(
      quota.daily.limit >= lo && quota.daily.limit <= hi,
      `daily.limit ${quota.daily.limit} must be in [${lo}, ${hi}]`
    );
  } finally {
    workspace.cleanup();
  }
});

test('rngMin picks the lower bound of the daily range', () => {
  const workspace = createTempWorkspace('msg-quota-lo-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const expectedLo = Math.max(1, Math.floor(QUOTA_WINDOWS.daily.limit * DAILY_RANDOM_MIN_FACTOR));

    const quota = getMessageQuota({ quotaPath, now, rng: rngMin });
    assert.equal(quota.daily.limit, expectedLo);
  } finally {
    workspace.cleanup();
  }
});

test('rngMax picks the upper bound of the daily range', () => {
  const workspace = createTempWorkspace('msg-quota-hi-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const lo = Math.max(1, Math.floor(QUOTA_WINDOWS.daily.limit * DAILY_RANDOM_MIN_FACTOR));
    const expectedHi = Math.max(lo, Math.floor(QUOTA_WINDOWS.daily.limit * DAILY_RANDOM_MAX_FACTOR));

    const quota = getMessageQuota({ quotaPath, now, rng: rngMax });
    assert.equal(quota.daily.limit, expectedHi);
  } finally {
    workspace.cleanup();
  }
});

test('weekly limit is never randomised', () => {
  const workspace = createTempWorkspace('msg-quota-weekly-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const quota = getMessageQuota({ quotaPath, now, rng: rngMax });
    assert.equal(quota.weekly.limit, QUOTA_WINDOWS.weekly.limit);
  } finally {
    workspace.cleanup();
  }
});

test('_randomized flag prevents re-randomising within the same window cycle', () => {
  const workspace = createTempWorkspace('msg-quota-flag-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const first = getMessageQuota({ quotaPath, now, rng: rngMin });
    const locked = first.daily.limit;

    const second = getMessageQuota({ quotaPath, now, rng: rngMax });
    assert.equal(second.daily.limit, locked, 'limit must not change within the same window cycle');
  } finally {
    workspace.cleanup();
  }
});

test('window reset picks a fresh randomised limit for the new daily cycle', () => {
  const workspace = createTempWorkspace('msg-quota-cycle-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const first = getMessageQuota({ quotaPath, now, rng: rngMin });
    const loLimit = Math.max(1, Math.floor(QUOTA_WINDOWS.daily.limit * DAILY_RANDOM_MIN_FACTOR));
    assert.equal(first.daily.limit, loLimit);

    // Advance 25 hours — past the 24-hour window reset.
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const second = getMessageQuota({ quotaPath, now: later, rng: rngMax });
    const hiLimit = Math.max(loLimit, Math.floor(QUOTA_WINDOWS.daily.limit * DAILY_RANDOM_MAX_FACTOR));
    assert.equal(second.daily.limit, hiLimit);
    assert.equal(second.daily.used, 0);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Warm-up multiplier
// ---------------------------------------------------------------------------

test('warmUpMultiplier reduces the effective daily ceiling before randomisation', () => {
  const workspace = createTempWorkspace('msg-quota-warmup-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const multiplier = 0.40;

    // ceiling = floor(50 * 0.40) = 20 → lo = floor(20 * 0.60) = 12
    const effectiveCeiling = Math.max(1, Math.floor(QUOTA_WINDOWS.daily.limit * multiplier));
    const expectedLo = Math.max(1, Math.floor(effectiveCeiling * DAILY_RANDOM_MIN_FACTOR));

    const quota = getMessageQuota({ quotaPath, now, warmUpMultiplier: multiplier, rng: rngMin });
    assert.equal(quota.daily.limit, expectedLo);
    // Weekly must stay at configured value.
    assert.equal(quota.weekly.limit, QUOTA_WINDOWS.weekly.limit);
  } finally {
    workspace.cleanup();
  }
});

test('warmUpMultiplier clamps the daily limit to at least 1', () => {
  const workspace = createTempWorkspace('msg-quota-warmup-min-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const quota = getMessageQuota({ quotaPath, now, warmUpMultiplier: 0.01, rng: rngMin });
    assert.ok(quota.daily.limit >= 1, `daily.limit must be >= 1, got ${quota.daily.limit}`);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// canConsumeMessageQuota / consumeMessageQuota
// ---------------------------------------------------------------------------

test('canConsumeMessageQuota returns allowed when quota is fresh', () => {
  const workspace = createTempWorkspace('msg-quota-can-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const result = canConsumeMessageQuota(1, { quotaPath, now });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.exceeded, []);
  } finally {
    workspace.cleanup();
  }
});

test('consumeMessageQuota blocks when daily limit is exhausted', () => {
  const workspace = createTempWorkspace('msg-quota-block-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    // Use rngMin so daily limit = lo; consume exactly that many.
    const lo = Math.max(1, Math.floor(QUOTA_WINDOWS.daily.limit * DAILY_RANDOM_MIN_FACTOR));
    consumeMessageQuota(lo, { quotaPath, now, rng: rngMin });

    const blocked = canConsumeMessageQuota(1, { quotaPath, now, rng: rngMin });
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.exceeded.includes('daily'));
  } finally {
    workspace.cleanup();
  }
});

test('consumeMessageQuota for one account does not affect another', () => {
  const workspace = createTempWorkspace('msg-quota-isolation-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const lo = Math.max(1, Math.floor(QUOTA_WINDOWS.daily.limit * DAILY_RANDOM_MIN_FACTOR));

    consumeMessageQuota(lo, { quotaPath, now, accountId: 'acc-A', rng: rngMin });

    const blocked = canConsumeMessageQuota(1, { quotaPath, now, accountId: 'acc-A', rng: rngMin });
    assert.equal(blocked.allowed, false);

    const other = canConsumeMessageQuota(1, { quotaPath, now, accountId: 'acc-B' });
    assert.equal(other.allowed, true);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Window reset
// ---------------------------------------------------------------------------

test('expired daily window resets to used=0 on next read', () => {
  const workspace = createTempWorkspace('msg-quota-expire-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    consumeMessageQuota(3, { quotaPath, now });

    // Advance past the daily window.
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const refreshed = getMessageQuota({ quotaPath, now: later });
    assert.equal(refreshed.daily.used, 0);
  } finally {
    workspace.cleanup();
  }
});

test('resetMessageQuotaWindow resets the specified window only', () => {
  const workspace = createTempWorkspace('msg-quota-manual-reset-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    consumeMessageQuota(5, { quotaPath, now, rng: rngMin });

    const result = resetMessageQuotaWindow('daily', { quotaPath, now });
    assert.equal(result.daily.used, 0);
    assert.equal(result.weekly.used, 5, 'weekly counter must be preserved');
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// V1 migration
// ---------------------------------------------------------------------------

test('v1 flat format is migrated to default account bucket', () => {
  const workspace = createTempWorkspace('msg-quota-migrate-');
  try {
    const quotaPath = workspace.path('msg-quota.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    // Write old-style flat format (no accounts key).
    writeJson(quotaPath, {
      daily:  { limit: 40, used: 10, resetTime: futureDate(12), _randomized: true },
      weekly: { limit: 250, used: 10, resetTime: futureDate(100) }
    });

    // Calling with no accountId resolves to 'default' — should read the migrated state.
    const quota = getMessageQuota({ quotaPath, now });
    assert.equal(quota.daily.used, 10, 'usage from old format should be preserved via migration');
    assert.equal(quota.weekly.used, 10);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// applyDailyOptions unit
// ---------------------------------------------------------------------------

test('applyDailyOptions sets _randomized flag and reduces limit below config', () => {
  const window = { limit: 50, used: 0, resetTime: futureDate(12) };
  const quota = { daily: window, weekly: { limit: 250, used: 0, resetTime: futureDate(100) } };
  const result = applyDailyOptions(quota, { rng: rngMin });

  assert.equal(result.daily._randomized, true);
  assert.ok(result.daily.limit < 50, `Expected limit < 50, got ${result.daily.limit}`);
});

test('applyDailyOptions is a no-op when _randomized is already true', () => {
  const window = { limit: 15, used: 3, resetTime: futureDate(12), _randomized: true };
  const quota = { daily: window, weekly: { limit: 250, used: 0, resetTime: futureDate(100) } };
  const result = applyDailyOptions(quota, { rng: rngMax });

  assert.equal(result.daily.limit, 15);  // unchanged
  assert.equal(result.daily.used, 3);    // unchanged
});

// ---------------------------------------------------------------------------
// randomBetween helper
// ---------------------------------------------------------------------------

test('randomBetween returns lo when rng returns 0', () => {
  assert.equal(randomBetween(10, 20, () => 0), 10);
});

test('randomBetween returns hi when rng returns exactly 1.0 (clamp)', () => {
  assert.equal(randomBetween(10, 20, () => 1.0), 20);
});

test('randomBetween stays within [lo, hi] across representative rng values', () => {
  for (let i = 0; i <= 9; i++) {
    const result = randomBetween(10, 20, () => i / 10);
    assert.ok(result >= 10 && result <= 20, `Expected [10,20] got ${result} for rng=${i / 10}`);
  }
});

test('randomBetween returns lo when lo === hi', () => {
  assert.equal(randomBetween(7, 7), 7);
  assert.equal(randomBetween(7, 7, () => 0.9999), 7);
});
