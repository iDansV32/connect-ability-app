// ============================================
// FILE: human/scroll.js - COMPLETE IMPLEMENTATION
// ============================================
// human/scroll.js
const { randomDelay } = require('./delay');

/**
 * Smooth human-like scrolling
 * @param {Page} page - Playwright page object
 * @param {string} direction - 'down' or 'up'
 * @param {number} distance - Distance to scroll
 */
async function smoothScroll(page, direction = 'down', distance = 300, options = {}) {
  const pause = typeof options.pause === 'function' ? options.pause : randomDelay;
  if (isStrictStealthScroll(page, options)) {
    const sign = direction === 'down' ? 1 : -1;
    const steps = buildWheelSteps(sign * Math.abs(distance));
    for (const delta of steps) {
      await page.mouse.wheel(0, delta);
      await pause(90, 180);
    }
    await pause(280, 520);
    return;
  }

  await page.evaluate(async ({ dir, dist }) => {
    const scrollAmount = dir === 'down' ? dist : -dist;
    window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
  }, { dir: direction, dist: distance });
  await pause(500, 1000);
}

/**
 * Scroll to a specific element
 * @param {Page} page - Playwright page object
 * @param {string} selector - CSS selector
 */
async function scrollToElement(page, selector, options = {}) {
  const pause = typeof options.pause === 'function' ? options.pause : randomDelay;
  const element = await page.$(selector);
  if (element) {
    if (isStrictStealthScroll(page, options)) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const visible = await element.isVisible().catch(() => false);
        if (visible) {
          break;
        }
        await smoothScroll(page, 'down', 220 + Math.floor(Math.random() * 120), options);
      }
    } else {
      await element.scrollIntoViewIfNeeded();
    }
    await pause(300, 600);
    return true;
  }
  return false;
}

/**
 * Random human-like scrolling behavior
 * @param {Page} page - Playwright page object
 */
async function randomScroll(page, options = {}) {
  const scrollDistance = 100 + Math.random() * 400;
  await smoothScroll(page, 'down', scrollDistance, options);
}

/**
 * Human-like scrolling with variable behavior
 * @param {Page} page - Playwright page object
 */
async function humanScroll(page, options = {}) {
  const pause = typeof options.pause === 'function' ? options.pause : randomDelay;
  if (isStrictStealthScroll(page, options)) {
    const maxScrolls = 3 + Math.floor(Math.random() * 5);
    await pause(500, 1000);
    for (let scrollCount = 0; scrollCount < maxScrolls; scrollCount += 1) {
      const distance = 100 + Math.floor(Math.random() * 300);
      const direction = Math.random() < 0.2 && scrollCount > 0 ? 'up' : 'down';
      await smoothScroll(page, direction, direction === 'up' ? Math.floor(distance * 0.3) : distance, options);
      await pause(500, 1500);
    }
    return;
  }

  await page.evaluate(() => {
    return new Promise((resolve) => {
      let scrollCount = 0;
      const maxScrolls = 3 + Math.floor(Math.random() * 5); // 3-7 scrolls

      const scroll = () => {
        if (scrollCount >= maxScrolls) {
          resolve();
          return;
        }

        // Variable scroll distance
        const distance = 100 + Math.floor(Math.random() * 300);

        // Occasionally scroll up slightly (20% chance)
        if (Math.random() < 0.2 && scrollCount > 0) {
          window.scrollBy(0, -Math.floor(distance * 0.3));
        } else {
          window.scrollBy(0, distance);
        }

        scrollCount++;

        // Variable delay between scrolls
        setTimeout(scroll, 500 + Math.random() * 1500);
      };

      // Initial delay before starting to scroll
      setTimeout(scroll, 500 + Math.random() * 1000);
    });
  });
}

function isStrictStealthScroll(page, options = {}) {
  return options.strictStealth === true || page?.__connectStrictStealth === true;
}

function buildWheelSteps(totalDistance) {
  const sign = totalDistance < 0 ? -1 : 1;
  const absoluteDistance = Math.max(1, Math.abs(totalDistance));
  const stepCount = absoluteDistance < 180 ? 3 : absoluteDistance < 420 ? 4 : 5;
  const ratios = stepCount === 3
    ? [0.45, 0.35, 0.2]
    : stepCount === 4
      ? [0.28, 0.32, 0.24, 0.16]
      : [0.18, 0.26, 0.24, 0.18, 0.14];

  let consumed = 0;
  return ratios.map((ratio, index) => {
    if (index === ratios.length - 1) {
      return sign * Math.max(1, absoluteDistance - consumed);
    }
    const step = Math.max(1, Math.round(absoluteDistance * ratio));
    consumed += step;
    return sign * step;
  });
}

module.exports = {
  _private: {
    buildWheelSteps,
    isStrictStealthScroll
  },
  smoothScroll,
  scrollToElement,
  randomScroll,
  humanScroll
};
