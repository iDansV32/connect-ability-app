'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDelayProfileFromSeed,
  setProcessDelayProfile,
  getProcessDelayProfile,
  resetProcessDelayProfile,
  applyDelayProfileRange,
  getTypingDelay
} = require('../automation/human/delay');

test.afterEach(() => {
  resetProcessDelayProfile();
});

test('buildDelayProfileFromSeed is deterministic for the same seed', () => {
  const first = buildDelayProfileFromSeed('seed-alice');
  const second = buildDelayProfileFromSeed('seed-alice');

  assert.deepEqual(first, second);
});

test('buildDelayProfileFromSeed produces different profiles for different seeds', () => {
  const first = buildDelayProfileFromSeed('seed-alice');
  const second = buildDelayProfileFromSeed('seed-bob');

  assert.notDeepEqual(first, second);
});

test('applyDelayProfileRange scales delay bounds using the configured process profile', () => {
  const profile = buildDelayProfileFromSeed('seed-alice');
  setProcessDelayProfile(profile);

  const scaled = applyDelayProfileRange(100, 200);

  assert.equal(scaled.seed, profile.seed);
  assert.equal(scaled.multiplier, profile.baseMultiplier);
  assert.equal(scaled.minDelay, Math.round(100 * profile.baseMultiplier));
  assert.equal(scaled.maxDelay, Math.round(200 * profile.baseMultiplier));
});

test('applyDelayProfileRange can use an explicit delay profile without mutating process state', () => {
  const profile = buildDelayProfileFromSeed('seed-bob');
  const scaled = applyDelayProfileRange(80, 160, profile);

  assert.equal(scaled.seed, profile.seed);
  assert.equal(getProcessDelayProfile().seed, null);
});

test('getTypingDelay respects the active process typing multiplier', () => {
  const profile = buildDelayProfileFromSeed('seed-alice');
  setProcessDelayProfile(profile);

  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(getTypingDelay(), 45 * profile.typingMultiplier);
  } finally {
    Math.random = originalRandom;
  }
});

test('resetProcessDelayProfile restores the default unscaled profile', () => {
  setProcessDelayProfile('seed-alice');
  const reset = resetProcessDelayProfile();

  assert.equal(reset.seed, null);
  assert.equal(reset.baseMultiplier, 1);
  assert.equal(reset.typingMultiplier, 1);
});
