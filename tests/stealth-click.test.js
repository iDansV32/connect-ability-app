const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stealthClick
} = require('../automation/mouse/stealth-click');

function makeHandle(box = { x: 10, y: 20, width: 140, height: 50 }) {
  return {
    async scrollIntoViewIfNeeded() {},
    async boundingBox() {
      return box;
    }
  };
}

test('stealthClick moves twice, pauses, then clicks', async () => {
  const events = [];
  const page = {
    mouse: {
      async click(x, y, options) {
        events.push({ type: 'click', x, y, options });
      }
    },
    async waitForTimeout(ms) {
      events.push({ type: 'wait', ms });
    }
  };

  await stealthClick(page, makeHandle(), {
    rng: () => 0.6,
    moveMouseNaturally: async (_page, target) => {
      events.push({ type: 'move', target });
      return true;
    },
    pauseReaction: async (ms) => {
      events.push({ type: 'pause', ms });
    }
  });

  assert.equal(events.length, 4);
  assert.equal(events[0].type, 'move');
  assert.equal(events[1].type, 'pause');
  assert.equal(events[2].type, 'move');
  assert.equal(events[3].type, 'click');
});
