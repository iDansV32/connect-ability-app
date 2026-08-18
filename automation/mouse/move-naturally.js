const { randomDelay } = require('../human/delay');

const DEFAULT_VIEWPORT = Object.freeze({ width: 1366, height: 768 });
const pageMousePositions = new WeakMap();

async function moveMouseNaturally(page, target, options = {}) {
  try {
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    const targetPoint = await resolveTargetPoint(page, target, rng, options);
    if (!targetPoint) return false;

    const viewport = await resolveViewport(page, options.viewport);
    const startPoint = getStoredMousePosition(page) || buildInitialMousePosition(viewport, rng);
    const pathPoints = buildMousePath(startPoint, targetPoint, {
      rng,
      targetBox: targetPoint.box || null,
      allowOvershoot: options.allowOvershoot !== false
    });

    for (const point of pathPoints) {
      await page.mouse.move(point.x, point.y, { steps: 1 });
      if (point.pauseMs > 0) {
        await pauseForMs(page, point.pauseMs, options.pauseForMs);
      }
    }

    setStoredMousePosition(page, {
      x: targetPoint.x,
      y: targetPoint.y
    });
    return true;
  } catch (error) {
    console.error('Error moving mouse:', error);
    return false;
  }
}

async function hoverElement(page, selector, options = {}) {
  const element = await page.$(selector);
  if (element) {
    await moveMouseNaturally(page, element, options);
    await randomDelay(200, 500);
    return true;
  }
  return false;
}

function buildMousePath(startPoint, targetPoint, options = {}) {
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const basePath = [];
  const canOvershoot = shouldOvershoot(targetPoint.box, rng, options.allowOvershoot !== false);

  if (canOvershoot) {
    const overshootTarget = buildOvershootPoint(startPoint, targetPoint, rng);
    const overshootSteps = scaleStepCount(distanceBetween(startPoint, overshootTarget));
    basePath.push(
      ...generateQuadraticBezierPoints(startPoint, overshootTarget, {
        rng,
        stepCount: overshootSteps,
        stepPauseRangeMs: [4, 12],
        jitterPx: 2
      })
    );
    basePath.push({
      x: overshootTarget.x,
      y: overshootTarget.y,
      pauseMs: randomInt(60, 120, rng)
    });
    const correctionSteps = Math.max(6, Math.floor(scaleStepCount(distanceBetween(overshootTarget, targetPoint)) * 0.75));
    basePath.push(
      ...generateQuadraticBezierPoints(overshootTarget, targetPoint, {
        rng,
        stepCount: correctionSteps,
        stepPauseRangeMs: [4, 10],
        jitterPx: 1,
        controlOffsetMultiplierRange: [0.08, 0.14]
      })
    );
    return dedupeSequentialPoints(basePath);
  }

  return dedupeSequentialPoints(generateQuadraticBezierPoints(startPoint, targetPoint, {
    rng,
    stepCount: scaleStepCount(distanceBetween(startPoint, targetPoint)),
    stepPauseRangeMs: [4, 12],
    jitterPx: 2
  }));
}

function generateQuadraticBezierPoints(startPoint, targetPoint, options = {}) {
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const stepCount = Math.max(2, options.stepCount || scaleStepCount(distanceBetween(startPoint, targetPoint)));
  const jitterPx = Number.isFinite(options.jitterPx) ? options.jitterPx : 2;
  const [minPause, maxPause] = Array.isArray(options.stepPauseRangeMs)
    ? options.stepPauseRangeMs
    : [4, 12];
  const controlPoint = buildQuadraticControlPoint(startPoint, targetPoint, rng, options.controlOffsetMultiplierRange);
  const points = [];

  for (let stepIndex = 1; stepIndex <= stepCount; stepIndex += 1) {
    const t = stepIndex / stepCount;
    const point = evaluateQuadraticBezier(startPoint, controlPoint, targetPoint, t);
    const shouldJitter = stepIndex !== stepCount && stepIndex !== 1 && rng() < 0.18;
    const jitteredPoint = shouldJitter
      ? {
          x: point.x + randomInt(-jitterPx, jitterPx, rng),
          y: point.y + randomInt(-jitterPx, jitterPx, rng)
        }
      : point;

    points.push({
      x: roundCoordinate(jitteredPoint.x),
      y: roundCoordinate(jitteredPoint.y),
      pauseMs: stepIndex === stepCount ? 0 : randomInt(minPause, maxPause, rng)
    });
  }

  return points;
}

function buildQuadraticControlPoint(startPoint, targetPoint, rng, multiplierRange = [0.15, 0.25]) {
  const dx = targetPoint.x - startPoint.x;
  const dy = targetPoint.y - startPoint.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const perpendicular = {
    x: -dy / distance,
    y: dx / distance
  };
  const sign = rng() < 0.5 ? -1 : 1;
  const offsetMultiplier = multiplierRange[0] + ((multiplierRange[1] - multiplierRange[0]) * rng());
  const offset = distance * offsetMultiplier * sign;

  return {
    x: ((startPoint.x + targetPoint.x) / 2) + (perpendicular.x * offset),
    y: ((startPoint.y + targetPoint.y) / 2) + (perpendicular.y * offset)
  };
}

function evaluateQuadraticBezier(startPoint, controlPoint, targetPoint, t) {
  const oneMinusT = 1 - t;
  return {
    x: (oneMinusT * oneMinusT * startPoint.x)
      + (2 * oneMinusT * t * controlPoint.x)
      + (t * t * targetPoint.x),
    y: (oneMinusT * oneMinusT * startPoint.y)
      + (2 * oneMinusT * t * controlPoint.y)
      + (t * t * targetPoint.y)
  };
}

async function resolveTargetPoint(page, target, rng, options = {}) {
  if (!target) {
    return null;
  }

  if (typeof target.boundingBox === 'function') {
    const box = await target.boundingBox();
    if (!box) return null;
    const pointRatio = options.pointRatio || { x: 0.3 + (rng() * 0.4), y: 0.3 + (rng() * 0.4) };
    return {
      x: roundCoordinate(box.x + (box.width * pointRatio.x)),
      y: roundCoordinate(box.y + (box.height * pointRatio.y)),
      box
    };
  }

  if (Number.isFinite(target?.x) && Number.isFinite(target?.y)) {
    return {
      x: roundCoordinate(target.x),
      y: roundCoordinate(target.y),
      box: target.box || null
    };
  }

  return null;
}

async function resolveViewport(page, providedViewport = null) {
  if (providedViewport && Number.isFinite(providedViewport.width) && Number.isFinite(providedViewport.height)) {
    return {
      width: providedViewport.width,
      height: providedViewport.height
    };
  }

  try {
    if (page && typeof page.viewportSize === 'function') {
      const viewport = await page.viewportSize();
      if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)) {
        return viewport;
      }
    }
  } catch (_) {}

  try {
    if (page && typeof page.evaluate === 'function') {
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight
      }));
      if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)) {
        return viewport;
      }
    }
  } catch (_) {}

  return { ...DEFAULT_VIEWPORT };
}

function buildInitialMousePosition(viewport, rng) {
  return {
    x: roundCoordinate((viewport.width * 0.5) + randomInt(-40, 40, rng)),
    y: roundCoordinate((viewport.height * 0.5) + randomInt(-30, 30, rng))
  };
}

function shouldOvershoot(box, rng, allowOvershoot) {
  if (!allowOvershoot) return false;
  if (!box) return rng() < 0.35;
  if (box.width < 30 || box.height < 30) {
    return false;
  }
  return rng() < 0.35;
}

function buildOvershootPoint(startPoint, targetPoint, rng) {
  const dx = targetPoint.x - startPoint.x;
  const dy = targetPoint.y - startPoint.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const unitVector = {
    x: dx / distance,
    y: dy / distance
  };
  const overshootPx = randomInt(4, 10, rng);
  return {
    x: roundCoordinate(targetPoint.x + (unitVector.x * overshootPx)),
    y: roundCoordinate(targetPoint.y + (unitVector.y * overshootPx))
  };
}

function distanceBetween(a, b) {
  return Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0));
}

function scaleStepCount(distance) {
  if (distance < 80) {
    return 8 + Math.floor(distance / 20);
  }
  if (distance < 300) {
    return 15 + Math.floor((distance - 80) / 14);
  }
  return Math.min(50, 30 + Math.floor((distance - 300) / 22));
}

function randomInt(min, max, rng) {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.floor(rng() * ((upper - lower) + 1)) + lower;
}

function roundCoordinate(value) {
  return Number(value.toFixed(2));
}

function dedupeSequentialPoints(points = []) {
  const deduped = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) {
      previous.pauseMs = Math.max(previous.pauseMs || 0, point.pauseMs || 0);
      continue;
    }
    deduped.push(point);
  }
  return deduped;
}

async function pauseForMs(page, ms, customPause) {
  if (typeof customPause === 'function') {
    await customPause(ms);
    return;
  }

  if (page && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getStoredMousePosition(page) {
  return pageMousePositions.get(page) || null;
}

function setStoredMousePosition(page, position) {
  if (!page || !position) return;
  pageMousePositions.set(page, {
    x: roundCoordinate(position.x),
    y: roundCoordinate(position.y)
  });
}

function clearStoredMousePosition(page) {
  pageMousePositions.delete(page);
}

module.exports = {
  moveMouseNaturally,
  hoverElement,
  _private: {
    buildMousePath,
    buildQuadraticControlPoint,
    buildInitialMousePosition,
    clearStoredMousePosition,
    distanceBetween,
    evaluateQuadraticBezier,
    generateQuadraticBezierPoints,
    getStoredMousePosition,
    randomInt,
    resolveViewport,
    scaleStepCount,
    setStoredMousePosition
  }
};
