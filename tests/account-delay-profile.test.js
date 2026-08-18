'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDelayProfileSeed } = require('../automation/safety/account-delay-profile');

test('normalizeDelayProfileSeed preserves an explicit seed', () => {
  assert.equal(normalizeDelayProfileSeed('seed-abc', 'alice@example.com'), 'seed-abc');
});

test('normalizeDelayProfileSeed derives a deterministic seed from account identity when absent', () => {
  const first = normalizeDelayProfileSeed(null, ' Alice@example.com ');
  const second = normalizeDelayProfileSeed('', 'alice@example.com');

  assert.equal(first, second);
  assert.match(first, /^li-delay-[a-f0-9]{20}$/);
});

test('normalizeDelayProfileSeed returns different seeds for different accounts', () => {
  const alice = normalizeDelayProfileSeed(null, 'alice@example.com');
  const bob = normalizeDelayProfileSeed(null, 'bob@example.com');

  assert.notEqual(alice, bob);
});
