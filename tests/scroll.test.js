'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  humanScroll,
  smoothScroll,
  _private: {
    buildWheelSteps
  }
} = require('../automation/human/scroll');

function createStrictPage() {
  return {
    __connectStrictStealth: true,
    wheelCalls: [],
    evaluateCalls: 0,
    mouse: {
      async wheel(_x, y) {
        this._calls.push(y);
      },
      _calls: []
    },
    async evaluate() {
      this.evaluateCalls += 1;
    }
  };
}

test('buildWheelSteps preserves total distance across generated wheel deltas', () => {
  const steps = buildWheelSteps(420);
  assert.equal(steps.reduce((sum, value) => sum + value, 0), 420);
});

test('smoothScroll uses wheel input instead of DOM scroll in strict mode', async () => {
  const page = createStrictPage();
  page.mouse._calls = page.wheelCalls;

  await smoothScroll(page, 'down', 300, { strictStealth: true, pause: async () => {} });

  assert.ok(page.wheelCalls.length >= 3);
  assert.equal(page.evaluateCalls, 0);
});

test('humanScroll uses repeated wheel input instead of DOM evaluate in strict mode', async () => {
  const page = createStrictPage();
  page.mouse._calls = page.wheelCalls;

  await humanScroll(page, { strictStealth: true, pause: async () => {} });

  assert.ok(page.wheelCalls.length > 0);
  assert.equal(page.evaluateCalls, 0);
});
