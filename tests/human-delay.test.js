'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { randomDelay, getTypingDelay } = require('../automation/human/delay');

test('randomDelay honors an injected rng for deterministic delays', async () => {
  const delay = await randomDelay(10, 20, { rng: () => 0 });
  assert.equal(delay, 10);
});

test('randomDelay clamps an injected rng at the upper bound', async () => {
  const delay = await randomDelay(10, 20, { rng: () => 1 });
  assert.equal(delay, 20);
});

test('getTypingDelay honors an injected rng for deterministic typing cadence', () => {
  assert.equal(getTypingDelay({ rng: () => 0 }), 45);
  assert.equal(getTypingDelay({ rng: () => 0.5 }), 72.5);
});
