'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WARMUP_DURATION_DAYS,
  WARMUP_STAGES,
  applyWarmUpToLimit,
  getWarmUpMultiplier,
  isInWarmUp
} = require('../automation/safety/warmup-schedule');

const DAY_MS = 24 * 60 * 60 * 1000;

// Reference "start" date for all warm-up calculations.
const BASE = new Date('2026-03-01T00:00:00.000Z');

function daysAfter(n) {
  return new Date(BASE.getTime() + n * DAY_MS);
}

// ---------------------------------------------------------------------------
// WARMUP_STAGES constant
// ---------------------------------------------------------------------------

test('WARMUP_STAGES covers day 0 through Infinity without gaps', () => {
  // Sort by minDay and verify contiguous coverage.
  const sorted = [...WARMUP_STAGES].sort((a, b) => a.minDay - b.minDay);

  assert.equal(sorted[0].minDay, 0);
  for (let i = 0; i < sorted.length - 1; i++) {
    assert.equal(sorted[i].maxDay, sorted[i + 1].minDay,
      `Gap between stage ${i} (maxDay ${sorted[i].maxDay}) and stage ${i + 1} (minDay ${sorted[i + 1].minDay})`);
  }
  assert.equal(sorted[sorted.length - 1].maxDay, Infinity);
});

test('WARMUP_STAGES final stage has multiplier 1.0', () => {
  const finalStage = WARMUP_STAGES.find((s) => s.maxDay === Infinity);
  assert.ok(finalStage, 'Expected a stage with maxDay === Infinity');
  assert.equal(finalStage.multiplier, 1.0);
});

test('WARMUP_STAGES multipliers are monotonically increasing', () => {
  const sorted = [...WARMUP_STAGES].sort((a, b) => a.minDay - b.minDay);
  for (let i = 0; i < sorted.length - 1; i++) {
    assert.ok(
      sorted[i].multiplier <= sorted[i + 1].multiplier,
      `Stage ${i} multiplier (${sorted[i].multiplier}) must not exceed stage ${i + 1} (${sorted[i + 1].multiplier})`
    );
  }
});

// ---------------------------------------------------------------------------
// getWarmUpMultiplier
// ---------------------------------------------------------------------------

test('getWarmUpMultiplier returns 1.0 when warmUpStartedAt is absent', () => {
  assert.equal(getWarmUpMultiplier({}, new Date()), 1.0);
  assert.equal(getWarmUpMultiplier({ warmUpStartedAt: null }, new Date()), 1.0);
  assert.equal(getWarmUpMultiplier({ warmUpStartedAt: '' }, new Date()), 1.0);
});

test('getWarmUpMultiplier returns 1.0 for unparseable warmUpStartedAt', () => {
  assert.equal(getWarmUpMultiplier({ warmUpStartedAt: 'not-a-date' }, new Date()), 1.0);
  assert.equal(getWarmUpMultiplier({ warmUpStartedAt: 'NaN' }, new Date()), 1.0);
});

test('getWarmUpMultiplier returns stage 1 multiplier on day 0', () => {
  const account = { warmUpStartedAt: BASE.toISOString() };
  const multiplier = getWarmUpMultiplier(account, BASE);
  const stage = WARMUP_STAGES.find((s) => s.minDay === 0);
  assert.equal(multiplier, stage.multiplier);
});

test('getWarmUpMultiplier returns stage 1 multiplier on day 6 (last day of stage)', () => {
  const account = { warmUpStartedAt: BASE.toISOString() };
  const multiplier = getWarmUpMultiplier(account, daysAfter(6));
  const stage = WARMUP_STAGES.find((s) => s.minDay === 0);
  assert.equal(multiplier, stage.multiplier);
});

test('getWarmUpMultiplier advances to next stage on day 7', () => {
  const account = { warmUpStartedAt: BASE.toISOString() };
  const multiplier = getWarmUpMultiplier(account, daysAfter(7));
  const stage = WARMUP_STAGES.find((s) => s.minDay === 7);
  assert.ok(stage, 'Expected stage starting at day 7');
  assert.equal(multiplier, stage.multiplier);
});

test('getWarmUpMultiplier returns 1.0 on day 28 (graduated)', () => {
  const account = { warmUpStartedAt: BASE.toISOString() };
  assert.equal(getWarmUpMultiplier(account, daysAfter(WARMUP_DURATION_DAYS)), 1.0);
});

test('getWarmUpMultiplier returns 1.0 far beyond warm-up period', () => {
  const account = { warmUpStartedAt: BASE.toISOString() };
  assert.equal(getWarmUpMultiplier(account, daysAfter(365)), 1.0);
});

test('getWarmUpMultiplier treats future warmUpStartedAt as day 0 (clock skew)', () => {
  const future = new Date(BASE.getTime() + 10 * DAY_MS);
  const account = { warmUpStartedAt: future.toISOString() };
  // now = BASE, which is 10 days BEFORE warmUpStartedAt → elapsed = -10 days → clamp to 0
  const multiplier = getWarmUpMultiplier(account, BASE);
  const stage0 = WARMUP_STAGES.find((s) => s.minDay === 0);
  assert.equal(multiplier, stage0.multiplier);
});

// Verify every stage boundary individually.
for (const stage of WARMUP_STAGES) {
  if (stage.maxDay === Infinity) continue;
  test(`getWarmUpMultiplier at day boundary ${stage.minDay}–${stage.maxDay} stays in correct stage`, () => {
    const account = { warmUpStartedAt: BASE.toISOString() };
    const atStart = getWarmUpMultiplier(account, daysAfter(stage.minDay));
    assert.equal(atStart, stage.multiplier, `Day ${stage.minDay} should be multiplier ${stage.multiplier}`);
    const atEnd = getWarmUpMultiplier(account, daysAfter(stage.maxDay - 1));
    assert.equal(atEnd, stage.multiplier, `Day ${stage.maxDay - 1} should be multiplier ${stage.multiplier}`);
  });
}

// ---------------------------------------------------------------------------
// applyWarmUpToLimit
// ---------------------------------------------------------------------------

test('applyWarmUpToLimit returns full limit when multiplier is 1.0', () => {
  assert.equal(applyWarmUpToLimit(30, 1.0), 30);
  assert.equal(applyWarmUpToLimit(80, 1.0), 80);
});

test('applyWarmUpToLimit returns 25% of limit at start of warm-up', () => {
  const stage0 = WARMUP_STAGES.find((s) => s.minDay === 0);
  // connection_requested daily: 30 × 0.25 = 7.5 → floor = 7
  assert.equal(applyWarmUpToLimit(30, stage0.multiplier), Math.floor(30 * stage0.multiplier));
});

test('applyWarmUpToLimit always returns at least 1', () => {
  assert.equal(applyWarmUpToLimit(1, 0.01), 1);
  assert.equal(applyWarmUpToLimit(0, 1.0), 1);
});

test('applyWarmUpToLimit floors the result to an integer', () => {
  // 80 × 0.40 = 32 (exact), 80 × 0.25 = 20 (exact)
  assert.equal(applyWarmUpToLimit(80, 0.40), 32);
  assert.equal(applyWarmUpToLimit(80, 0.25), 20);
  // 30 × 0.60 = 18 (exact)
  assert.equal(applyWarmUpToLimit(30, 0.60), 18);
});

// ---------------------------------------------------------------------------
// isInWarmUp
// ---------------------------------------------------------------------------

test('isInWarmUp returns true for a brand-new account (day 0)', () => {
  const account = { warmUpStartedAt: BASE.toISOString() };
  assert.equal(isInWarmUp(account, BASE), true);
});

test('isInWarmUp returns true on the last day of warm-up (day 27)', () => {
  const account = { warmUpStartedAt: BASE.toISOString() };
  assert.equal(isInWarmUp(account, daysAfter(WARMUP_DURATION_DAYS - 1)), true);
});

test('isInWarmUp returns false once fully graduated (day 28+)', () => {
  const account = { warmUpStartedAt: BASE.toISOString() };
  assert.equal(isInWarmUp(account, daysAfter(WARMUP_DURATION_DAYS)), false);
  assert.equal(isInWarmUp(account, daysAfter(100)), false);
});

test('isInWarmUp returns false when warmUpStartedAt is absent', () => {
  assert.equal(isInWarmUp({}, new Date()), false);
  assert.equal(isInWarmUp({ warmUpStartedAt: null }, new Date()), false);
});
