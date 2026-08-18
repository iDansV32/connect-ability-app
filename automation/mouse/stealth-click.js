const { moveMouseNaturally } = require('./move-naturally');

async function stealthClick(page, handle, options = {}) {
  if (!page || !handle) {
    return false;
  }

  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const moveMouse = typeof options.moveMouseNaturally === 'function'
    ? options.moveMouseNaturally
    : moveMouseNaturally;
  const react = typeof options.pauseReaction === 'function'
    ? options.pauseReaction
    : async (ms) => defaultPause(page, ms);
  const click = typeof options.mouseClick === 'function'
    ? options.mouseClick
    : async (x, y, clickOptions) => page.mouse.click(x, y, clickOptions);

  await handle.scrollIntoViewIfNeeded().catch(() => {});
  const box = await handle.boundingBox().catch(() => null);
  if (!box) {
    return false;
  }

  const hoverPoint = buildHoverPoint(box, rng);
  const clickPoint = buildClickPoint(box, hoverPoint, rng);
  const allowOvershoot = box.width >= 30 && box.height >= 30;

  await moveMouse(page, hoverPoint, {
    ...options,
    rng,
    allowOvershoot
  });
  await react(randomInt(150, 350, rng));

  if (rng() < 0.4) {
    const jitterTarget = buildMicroJitterPoint(box, clickPoint, rng);
    await moveMouse(page, jitterTarget, {
      ...options,
      rng,
      allowOvershoot: false
    });
  }

  await moveMouse(page, clickPoint, {
    ...options,
    rng,
    allowOvershoot: false
  });
  await click(clickPoint.x, clickPoint.y, {
    delay: randomInt(35, 110, rng)
  });
  return true;
}

function buildHoverPoint(box, rng) {
  return {
    x: roundCoordinate(box.x + (box.width * (0.3 + (rng() * 0.4)))),
    y: roundCoordinate(box.y + (box.height * (0.2 + (rng() * 0.3)))),
    box
  };
}

function buildClickPoint(box, hoverPoint, rng) {
  const deltaX = randomSignedInt(5, 15, rng);
  const deltaY = randomSignedInt(5, 15, rng);
  return {
    x: clamp(roundCoordinate(hoverPoint.x + deltaX), box.x + 2, box.x + box.width - 2),
    y: clamp(roundCoordinate(hoverPoint.y + deltaY), box.y + 2, box.y + box.height - 2),
    box
  };
}

function buildMicroJitterPoint(box, basePoint, rng) {
  return {
    x: clamp(roundCoordinate(basePoint.x + randomSignedInt(1, 3, rng)), box.x + 2, box.x + box.width - 2),
    y: clamp(roundCoordinate(basePoint.y + randomSignedInt(1, 3, rng)), box.y + 2, box.y + box.height - 2),
    box
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundCoordinate(value) {
  return Number(value.toFixed(2));
}

function randomInt(min, max, rng) {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.floor(rng() * ((upper - lower) + 1)) + lower;
}

function randomSignedInt(min, max, rng) {
  const sign = rng() < 0.5 ? -1 : 1;
  return sign * randomInt(min, max, rng);
}

async function defaultPause(page, ms) {
  if (page && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  stealthClick,
  _private: {
    buildClickPoint,
    buildHoverPoint,
    buildMicroJitterPoint,
    clamp,
    randomInt,
    randomSignedInt
  }
};
