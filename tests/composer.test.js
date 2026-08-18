'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pressKeyChord, typeMessage } = require('../automation/messaging/composer');

test('pressKeyChord spaces modifier keydown, keypress, and keyup', async () => {
  const events = [];
  const page = {
    keyboard: {
      async down(key) {
        events.push(`down:${key}`);
      },
      async press(key) {
        events.push(`press:${key}`);
      },
      async up(key) {
        events.push(`up:${key}`);
      }
    }
  };

  await pressKeyChord(page, 'Control', 'a');

  assert.deepEqual(events, [
    'down:Control',
    'press:a',
    'up:Control'
  ]);
});

test('typeMessage uses stealth click to focus the composer in strict mode', async () => {
  let rawClickUsed = false;
  const events = [];
  const page = {
    keyboard: {
      async down(key) {
        events.push(`down:${key}`);
      },
      async press(key) {
        events.push(`press:${key}`);
      },
      async up(key) {
        events.push(`up:${key}`);
      },
      async type(char) {
        events.push(`type:${char}`);
      }
    },
    async waitForTimeout(ms) {
      events.push(`wait:${ms}`);
    },
    mouse: {
      async click(x, y) {
        events.push(`mouse:${x},${y}`);
      }
    }
  };
  const input = {
    async click() {
      rawClickUsed = true;
    },
    async scrollIntoViewIfNeeded() {},
    async boundingBox() {
      return { x: 10, y: 20, width: 160, height: 60 };
    }
  };

  const typed = await typeMessage(page, input, 'Hi', {
    strictStealth: true,
    rng: () => 0.6,
    moveMouseNaturally: async () => {
      events.push('move');
    },
    pauseReaction: async () => {
      events.push('pause');
    }
  });

  assert.equal(typed, true);
  assert.equal(rawClickUsed, false);
  assert.ok(events.includes('move'));
  assert.ok(events.includes('pause'));
  assert.ok(events.some((event) => event.startsWith('mouse:')));
});
