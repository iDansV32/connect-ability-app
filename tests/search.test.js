'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { humanLikeSearch } = require('../automation/search/search');

function makeVisibleHandle(text = '', href = 'https://www.linkedin.com/search/results/people/?keywords=software%20developer') {
  return {
    async isVisible() {
      return true;
    },
    async textContent() {
      return text;
    },
    async getAttribute(name) {
      return name === 'href' ? href : null;
    },
    async scrollIntoViewIfNeeded() {},
    async boundingBox() {
      return { x: 10, y: 20, width: 140, height: 40 };
    },
    async click() {
      throw new Error('raw click should not be used in strict mode');
    }
  };
}

test('humanLikeSearch uses stealth clicks for input focus and People filter in strict mode', async () => {
  let rawPageClickUsed = false;
  let selectorValue = null;
  const searchInput = makeVisibleHandle('');
  const peopleButton = makeVisibleHandle('People');
  const page = {
    mouse: {
      async click() {},
      async move() {}
    },
    keyboard: {
      async press() {}
    },
    async goto() {},
    async click() {
      rawPageClickUsed = true;
    },
    async $eval(_selector, fn) {
      return fn({ value: '' });
    },
    async $(selector) {
      selectorValue = selector;
      return searchInput;
    },
    async $$(selector) {
      if (selector === 'button' || selector === 'button, a' || selector.startsWith('a[') || selector.startsWith('a:')) {
        return [peopleButton];
      }
      return [];
    },
    async fill() {},
    async type() {},
    async evaluate() {
      return true;
    },
    async url() {
      return 'https://www.linkedin.com/search/results/all/?keywords=software%20developer';
    },
    async waitForTimeout() {}
  };

  let moveCount = 0;
  const ok = await humanLikeSearch(page, 'software developer', {
    strictStealth: true,
    rng: () => 0.6,
    moveMouseNaturally: async () => {
      moveCount += 1;
    },
    pauseReaction: async () => {}
  });

  assert.equal(ok, true);
  assert.equal(rawPageClickUsed, false);
  assert.ok(selectorValue);
  assert.ok(moveCount >= 4);
});
