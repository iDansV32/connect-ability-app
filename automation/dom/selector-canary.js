'use strict';

const { CONNECTION_SELECTORS } = require('../connection/request');

async function runConnectionSelectorCanary(worker = {}, options = {}) {
  const page = options.page || worker.workflowPage || worker.page || null;
  const goto = typeof options.goto === 'function'
    ? options.goto
    : async (targetPage, url) => targetPage.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
  const emitLog = typeof options.emitLog === 'function' ? options.emitLog : () => {};
  const transportHealthStore = options.transportHealthStore || worker.transportHealthStore || null;
  const accountEmail = normalizeEmail(options.accountEmail || worker.accountEmail || worker.email);
  const profileUrl = cleanProfileUrl(
    options.canaryProfileUrl
      || worker.canaryProfileUrl
      || await resolveProfileUrlFromPage(page)
  );

  if (!page) {
    return {
      family: 'connection_dom',
      status: 'skipped',
      reason: 'missing_page'
    };
  }

  if (!profileUrl) {
    emitLog({
      level: 'warning',
      message: 'Connection DOM selector canary skipped because no safe profile URL was available.',
      source: 'selector-canary',
      metadata: { family: 'connection_dom' }
    });
    return {
      family: 'connection_dom',
      status: 'skipped',
      reason: 'missing_canary_profile_url'
    };
  }

  try {
    await goto(page, profileUrl);
    const matchedSelectors = [];

    for (const selector of CONNECTION_SELECTORS) {
      if (await selectorHasVisibleMatch(page, selector)) {
        matchedSelectors.push(selector);
      }
    }

    if (!matchedSelectors.length) {
      recordTransportFailure(transportHealthStore, accountEmail, 'selector_drift_detected');
      emitLog({
        level: 'warning',
        message: 'Connection DOM selector canary found no matching Connect selectors.',
        source: 'selector-canary',
        metadata: {
          family: 'connection_dom',
          profileUrl,
          selectorCount: CONNECTION_SELECTORS.length
        }
      });
      return {
        family: 'connection_dom',
        status: 'failed',
        profileUrl,
        matchedSelectors: []
      };
    }

    recordTransportSuccess(transportHealthStore, accountEmail, 'selector_canary_ok');
    emitLog({
      level: 'info',
      message: `Connection DOM selector canary matched ${matchedSelectors.length} selector(s).`,
      source: 'selector-canary',
      metadata: {
        family: 'connection_dom',
        profileUrl,
        matchedSelectors
      }
    });
    return {
      family: 'connection_dom',
      status: 'ok',
      profileUrl,
      matchedSelectors
    };
  } catch (error) {
    recordTransportFailure(transportHealthStore, accountEmail, 'selector_canary_exception');
    emitLog({
      level: 'warning',
      message: `Connection DOM selector canary failed: ${error.message}`,
      source: 'selector-canary',
      metadata: {
        family: 'connection_dom',
        profileUrl
      }
    });
    return {
      family: 'connection_dom',
      status: 'failed',
      profileUrl,
      reason: error.message
    };
  }
}

function shouldRerunConnectionSelectorCanary(store, accountEmail, now = new Date()) {
  if (!store || typeof store.getTransportState !== 'function') {
    return false;
  }

  const state = store.getTransportState('dom', 'send_connection', accountEmail, now);
  if (!state) {
    return false;
  }

  const threshold = Math.max(1, Number(store.failureThreshold) || 3);
  if (Number(state.failureCount || 0) < threshold) {
    return false;
  }

  return String(state.lastFailureReason || '').trim().toLowerCase() !== 'selector_drift_detected';
}

async function selectorHasVisibleMatch(page, selector) {
  if (!page || typeof page.$$ !== 'function') {
    return false;
  }

  const handles = await page.$$(selector).catch(() => []);
  for (const handle of handles) {
    if (!handle) continue;
    if (typeof handle.isVisible === 'function') {
      try {
        if (await handle.isVisible()) {
          return true;
        }
      } catch (_) {
        continue;
      }
    } else {
      return true;
    }
  }
  return false;
}

async function resolveProfileUrlFromPage(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return null;
  }

  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/in/"]'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href) continue;
      if (/linkedin\.com\/in\//i.test(href)) return href;
      if (/^\/in\//i.test(href)) return `https://www.linkedin.com${href}`;
    }
    return null;
  }).catch(() => null);
}

function recordTransportSuccess(store, accountEmail, reason) {
  if (!store || !accountEmail || typeof store.recordSuccess !== 'function') {
    return;
  }
  store.recordSuccess('dom', 'send_connection', accountEmail, {
    reason,
    timestamp: new Date().toISOString()
  });
}

function recordTransportFailure(store, accountEmail, reason) {
  if (!store || !accountEmail || typeof store.recordFailure !== 'function') {
    return;
  }
  store.recordFailure('dom', 'send_connection', accountEmail, {
    reason,
    timestamp: new Date().toISOString()
  });
}

function cleanProfileUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return normalized.split('?')[0];
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase() || null;
}

module.exports = {
  runConnectionSelectorCanary,
  shouldRerunConnectionSelectorCanary
};
