'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _private: {
    applyCanvasNoise,
    buildCanvasNoisePlan
  }
} = require('../automation/core/fingerprinting');

function buildImageData(width = 12, height = 12) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = index % 251;
  }
  return { width, height, data };
}

test('buildCanvasNoisePlan is deterministic for the same seed and dimensions', () => {
  const first = buildCanvasNoisePlan('seed-a', 100, 50);
  const second = buildCanvasNoisePlan('seed-a', 100, 50);

  assert.deepEqual(first, second);
});

test('applyCanvasNoise produces identical output for the same seed and different output for different seeds', () => {
  const first = buildImageData();
  const second = buildImageData();
  const third = buildImageData();

  applyCanvasNoise(first, 'seed-a');
  applyCanvasNoise(second, 'seed-a');
  applyCanvasNoise(third, 'seed-b');

  assert.deepEqual(Array.from(first.data), Array.from(second.data));
  assert.notDeepEqual(Array.from(first.data), Array.from(third.data));
});
