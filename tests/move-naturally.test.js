const test = require('node:test');
const assert = require('node:assert/strict');

const {
  moveMouseNaturally,
  _private: {
    clearStoredMousePosition,
    generateQuadraticBezierPoints,
    getStoredMousePosition
  }
} = require('../automation/mouse/move-naturally');

function makeFakePage(viewport = { width: 800, height: 600 }) {
  const moves = [];
  const waits = [];
  return {
    moves,
    waits,
    mouse: {
      async move(x, y) {
        moves.push({ x, y });
      }
    },
    async waitForTimeout(ms) {
      waits.push(ms);
    },
    async viewportSize() {
      return viewport;
    }
  };
}

test('generateQuadraticBezierPoints produces a deterministic path for a fixed rng', () => {
  const rng = () => 0.25;
  const points = generateQuadraticBezierPoints(
    { x: 0, y: 0 },
    { x: 100, y: 50 },
    {
      rng,
      stepCount: 5,
      jitterPx: 0,
      stepPauseRangeMs: [0, 0]
    }
  );

  assert.deepEqual(points, [
    { x: 22.8, y: 4.4, pauseMs: 0 },
    { x: 44.2, y: 11.6, pauseMs: 0 },
    { x: 64.2, y: 21.6, pauseMs: 0 },
    { x: 82.8, y: 34.4, pauseMs: 0 },
    { x: 100, y: 50, pauseMs: 0 }
  ]);
});

test('moveMouseNaturally tracks mouse position per page across calls', async () => {
  const page = makeFakePage();
  const rng = () => 0.25;

  await moveMouseNaturally(page, { x: 100, y: 100 }, {
    rng,
    allowOvershoot: false,
    pauseForMs: async () => {}
  });
  assert.deepEqual(getStoredMousePosition(page), { x: 100, y: 100 });

  const firstMoveCount = page.moves.length;

  await moveMouseNaturally(page, { x: 200, y: 200 }, {
    rng,
    allowOvershoot: false,
    pauseForMs: async () => {}
  });

  assert.deepEqual(getStoredMousePosition(page), { x: 200, y: 200 });
  const firstPointOfSecondMove = page.moves[firstMoveCount];
  assert.ok(Math.abs(firstPointOfSecondMove.x - 100) < 20);
  assert.ok(Math.abs(firstPointOfSecondMove.y - 100) < 20);

  clearStoredMousePosition(page);
  assert.equal(getStoredMousePosition(page), null);
});
