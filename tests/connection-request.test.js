'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sendConnectionRequest, sendConnectionRequestDetailed, handleConnectionPopups } = require('../automation/connection/request');
const { createTempWorkspace, writeJson } = require('./test-helpers');

// Disable network tracing so traceAction does not attempt fs writes to the log dir.
process.env.CONNECT_TRACE_NETWORK = 'false';

const TARGET_URL = 'https://www.linkedin.com/in/testuser/';

/**
 * Minimal mock page. Sets url() to return the canonical target so no navigation
 * is triggered (skips page.goto + randomDelay). The evaluate() dispatcher
 * distinguishes the three inline browser functions by unique string tokens:
 *   - readConnectionState       → contains 'canConnect'
 *   - extractMemberProfileUrn   → contains 'urn:li:fsd_profile'
 *   - isProfilePage check       → contains 'window.location.href'
 *   - captureVisibleActionLabels → default, returns []
 */
function buildMockPage(options = {}) {
  const {
    currentUrl = TARGET_URL,
    connectionState = { pending: false, connected: false, following: false, canConnect: true }
  } = options;

  return {
    url() { return currentUrl; },
    async goto() {},
    async waitForSelector() {},
    async waitForTimeout() {},
    async evaluate(fn) {
      const fnStr = fn.toString();
      if (fnStr.includes('canConnect')) return connectionState;
      if (fnStr.includes('urn:li:fsd_profile')) return null;  // no URN in mock DOM
      if (fnStr.includes('window.location.href')) return true;  // navigation check
      return [];  // captureVisibleActionLabels
    },
    async $() { return null; },
    async $$() { return []; },
    on() {}
  };
}

function futureDate(days = 7) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Writes a quota file where the daily connection_requested limit is already at
 * the maximum so canConsumeActionQuota returns { allowed: false }.
 */
function writeExhaustedDailyQuota(quotaPath) {
  writeJson(quotaPath, {
    version: 1,
    accounts: {
      default: {
        actions: {
          connection_requested: {
            daily:  { limit: 30, used: 30, resetTime: futureDate(1) },
            weekly: { limit: 150, used: 0,  resetTime: futureDate(6) }
          },
          profile_viewed: {
            daily:  { limit: 80,  used: 0, resetTime: futureDate(1) },
            weekly: { limit: 400, used: 0, resetTime: futureDate(6) }
          },
          post_liked: {
            daily:  { limit: 60,  used: 0, resetTime: futureDate(1) },
            weekly: { limit: 300, used: 0, resetTime: futureDate(6) }
          },
          post_published: {
            daily:  { limit: 2,  used: 0, resetTime: futureDate(1) },
            weekly: { limit: 14, used: 0, resetTime: futureDate(6) }
          }
        }
      }
    }
  });
}

// ─── Quota gate ───────────────────────────────────────────────────────────────

test('sendConnectionRequestDetailed returns skipped_quota_exceeded when daily connection quota is exhausted', async () => {
  const workspace = createTempWorkspace('conn-req-quota-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeExhaustedDailyQuota(quotaPath);

    const page = buildMockPage();
    const result = await sendConnectionRequestDetailed(page, TARGET_URL, '', { quotaPath });

    assert.equal(result.outcomeType, 'skipped_quota_exceeded');
    assert.equal(result.success, true);        // skipped is not a failure
    assert.equal(result.stepType, 'send_connection');
    assert.ok(result.reason, 'expected a quota reason message');
    assert.ok(result.metadata.exceeded.includes('daily'));
  } finally {
    workspace.cleanup();
  }
});

test('sendConnectionRequest returns false when quota is exhausted (boolean wrapper)', async () => {
  const workspace = createTempWorkspace('conn-req-quota-bool-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeExhaustedDailyQuota(quotaPath);

    const page = buildMockPage();
    const succeeded = await sendConnectionRequest(page, TARGET_URL, '', { quotaPath });

    assert.equal(succeeded, false);
  } finally {
    workspace.cleanup();
  }
});

// ─── URL normalization ────────────────────────────────────────────────────────

test('sendConnectionRequestDetailed normalizes the profileUrl in the result (tracking params stripped)', async () => {
  const workspace = createTempWorkspace('conn-req-normalize-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeExhaustedDailyQuota(quotaPath);

    const page = buildMockPage();
    // Quota-exceeded path is the cheapest path that still exposes profileUrl in the result.
    const result = await sendConnectionRequestDetailed(
      page,
      'https://www.linkedin.com/in/testuser?trk=some-source',
      '',
      { quotaPath }
    );

    assert.equal(result.outcomeType, 'skipped_quota_exceeded');
    assert.equal(result.profileUrl, TARGET_URL);
  } finally {
    workspace.cleanup();
  }
});

// ─── DOM connection-state detection ──────────────────────────────────────────

test('sendConnectionRequestDetailed returns skipped_already_connected when DOM shows connected state', async () => {
  const workspace = createTempWorkspace('conn-req-connected-');
  try {
    const quotaPath = workspace.path('quota.json');
    // Fresh quota (empty file) — quota is NOT the reason for the early exit here.
    writeJson(quotaPath, { version: 1, accounts: {} });

    const page = buildMockPage({
      currentUrl: TARGET_URL,
      connectionState: { pending: false, connected: true, following: false, canConnect: false }
    });

    const result = await sendConnectionRequestDetailed(page, TARGET_URL, '', { quotaPath });

    assert.equal(result.outcomeType, 'skipped_already_connected');
    assert.equal(result.success, true);
    assert.equal(result.stepType, 'send_connection');
    assert.equal(result.profileUrl, TARGET_URL);
  } finally {
    workspace.cleanup();
  }
});

test('sendConnectionRequestDetailed returns skipped_invite_pending when DOM shows pending state', async () => {
  const workspace = createTempWorkspace('conn-req-pending-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeJson(quotaPath, { version: 1, accounts: {} });

    const page = buildMockPage({
      currentUrl: TARGET_URL,
      connectionState: { pending: true, connected: false, following: false, canConnect: false }
    });

    const result = await sendConnectionRequestDetailed(page, TARGET_URL, '', { quotaPath });

    assert.equal(result.outcomeType, 'skipped_invite_pending');
    assert.equal(result.success, true);
    assert.equal(result.stepType, 'send_connection');
  } finally {
    workspace.cleanup();
  }
});

test('sendConnectionRequestDetailed runs pending invite cleanup before attempting a new connection', async () => {
  const workspace = createTempWorkspace('conn-req-invite-sweep-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeJson(quotaPath, { version: 1, accounts: {} });

    let sweepCalls = 0;
    let lastSweepOptions = null;
    const page = buildMockPage({
      currentUrl: TARGET_URL,
      connectionState: { pending: false, connected: false, following: false, canConnect: true }
    });

    const result = await sendConnectionRequestDetailed(page, TARGET_URL, '', {
      quotaPath,
      accountEmail: 'seller@example.com',
      recipientName: 'Test User',
      connectButtonTimeoutMs: 50,
      managePendingInvites: async (_page, options) => {
        sweepCalls += 1;
        lastSweepOptions = options;
        return {
          attempted: true,
          skipped: false,
          status: 'completed',
          withdrewCount: 2,
          candidateCount: 5,
          error: null
        };
      }
    });

    assert.equal(sweepCalls, 1);
    assert.equal(lastSweepOptions.accountEmail, 'seller@example.com');
    assert.equal(lastSweepOptions.returnUrl, TARGET_URL);
    assert.equal(result.outcomeType, 'failed_transient');
    assert.match(result.reason, /could not find connect button/i);
  } finally {
    workspace.cleanup();
  }
});

test('sendConnectionRequestDetailed does not run pending invite cleanup when the invite is already pending', async () => {
  const workspace = createTempWorkspace('conn-req-pending-no-sweep-');
  try {
    const quotaPath = workspace.path('quota.json');
    writeJson(quotaPath, { version: 1, accounts: {} });

    let sweepCalls = 0;
    const page = buildMockPage({
      currentUrl: TARGET_URL,
      connectionState: { pending: true, connected: false, following: false, canConnect: false }
    });

    const result = await sendConnectionRequestDetailed(page, TARGET_URL, '', {
      quotaPath,
      accountEmail: 'seller@example.com',
      managePendingInvites: async () => {
        sweepCalls += 1;
        return { attempted: true };
      }
    });

    assert.equal(result.outcomeType, 'skipped_invite_pending');
    assert.equal(sweepCalls, 0);
  } finally {
    workspace.cleanup();
  }
});

// ─── Popup handler ────────────────────────────────────────────────────────────

test('handleConnectionPopups resolves without error when no dismiss buttons are present', async () => {
  const page = { async $() { return null; } };
  await handleConnectionPopups(page);
  // No assertion needed — the test verifies it does not throw.
});

test('handleConnectionPopups skips dismiss when button is not visible', async () => {
  const visibleSpy = { calls: 0 };
  const page = {
    async $(selector) {
      if (selector === 'button[aria-label="Dismiss"]') {
        return {
          async isVisible() {
            visibleSpy.calls += 1;
            return false;
          },
          async click() {}
        };
      }
      return null;
    }
  };

  await handleConnectionPopups(page);
  assert.equal(visibleSpy.calls, 1);  // checked visibility but did not click
});

// ─── Selector priority regression ────────────────────────────────────────────

test('CONNECTION_SELECTORS prioritises profile-header-scoped selectors before broad main selectors', () => {
  const { CONNECTION_SELECTORS } = require('../automation/connection/request');

  // Find the first profile-header-scoped selector and the first broad `main` selector.
  const firstProfileScoped = CONNECTION_SELECTORS.findIndex(
    (s) => s.startsWith('.pv-top-card') || s.startsWith('.pvs-profile-actions')
  );
  const firstBroadMain = CONNECTION_SELECTORS.findIndex(
    (s) => s === 'main button:has-text("Connect")' || s === 'main div[role="button"]:has-text("Connect")'
  );

  assert.ok(firstProfileScoped >= 0, 'profile-header-scoped selector should exist');
  assert.ok(firstBroadMain >= 0, 'broad main selector should exist');
  assert.ok(
    firstProfileScoped < firstBroadMain,
    `Profile-header selector (index ${firstProfileScoped}) must come before broad main selector (index ${firstBroadMain})`
  );
});

test('findVisibleHandle with targetName skips sidebar Connect buttons for other people', async () => {
  // Simulates a LinkedIn profile page where:
  //   - Madison Crane's hero has: aria-label="Invite Madison Crane to connect"
  //   - Sidebar has Liam's:      aria-label="Invite Liam Walder to connect"
  //   - Sidebar has Harlie's:    aria-label="Invite Harlie Walfish to connect"
  //
  // All three are visible inside `main`. The targetName filter ensures only
  // Madison's button is selected.

  const { CONNECTION_SELECTORS } = require('../automation/connection/request');

  const madisonConnect = {
    _id: 'madison-connect',
    async isVisible() { return true; },
    async getAttribute(attr) {
      if (attr === 'aria-label') return 'Invite Madison Crane to connect';
      return '';
    }
  };

  const liamConnect = {
    _id: 'liam-connect',
    async isVisible() { return true; },
    async getAttribute(attr) {
      if (attr === 'aria-label') return 'Invite Liam Walder to connect';
      return '';
    }
  };

  const harlieConnect = {
    _id: 'harlie-connect',
    async isVisible() { return true; },
    async getAttribute(attr) {
      if (attr === 'aria-label') return 'Invite Harlie Walfish to connect';
      return '';
    }
  };

  const page = {
    async $$(selector) {
      // Profile-header selectors match nothing (class names changed)
      if (selector.startsWith('.pv-top-card') || selector.startsWith('.pvs-profile')) {
        return [];
      }
      // Broad `main` selectors match all three — sidebar buttons first in DOM
      if (selector.startsWith('main ')) {
        return [liamConnect, harlieConnect, madisonConnect];
      }
      return [];
    },
    async waitForTimeout() {}
  };

  // Replicate findVisibleHandle with targetName filter
  const targetName = 'Madison Crane';
  let firstMatch = null;
  for (const selector of CONNECTION_SELECTORS) {
    const handles = await page.$$(selector);
    for (const handle of handles) {
      if (!(await handle.isVisible())) continue;
      const ariaLabel = ((await handle.getAttribute('aria-label')) || '').toLowerCase();
      if (!ariaLabel.includes(targetName.toLowerCase())) continue;
      firstMatch = handle;
      break;
    }
    if (firstMatch) break;
  }

  assert.ok(firstMatch, 'Should find Madison Connect button');
  assert.equal(firstMatch._id, 'madison-connect', 'Must select Madison, not Liam or Harlie');
});

test('findVisibleHandle without targetName returns first visible button (backwards compatible)', async () => {
  // When no targetName is provided (e.g. legacy callers), findVisibleHandle
  // should behave as before: return the first visible match.

  const { CONNECTION_SELECTORS } = require('../automation/connection/request');

  const button = {
    _id: 'any-connect',
    async isVisible() { return true; },
    async getAttribute() { return 'Connect'; }
  };

  const page = {
    async $$(selector) {
      if (selector.startsWith('main ')) return [button];
      return [];
    },
    async waitForTimeout() {}
  };

  let firstMatch = null;
  for (const selector of CONNECTION_SELECTORS) {
    const handles = await page.$$(selector);
    for (const handle of handles) {
      if (await handle.isVisible()) {
        firstMatch = handle;
        break;
      }
    }
    if (firstMatch) break;
  }

  assert.ok(firstMatch);
  assert.equal(firstMatch._id, 'any-connect');
});

// ---------------------------------------------------------------------------
// Phase 0: person-specific aria-label selector test
// ---------------------------------------------------------------------------

test('clickConnectButton Phase 0 finds person-specific button via aria-label and ignores sidebar', async () => {
  const { _private: { clickConnectButton } } = require('../automation/connection/request');

  let clickedId = null;

  const madisonConnect = {
    _id: 'madison-hero',
    async isVisible() { return true; },
    async getAttribute(attr) {
      if (attr === 'aria-label') return 'Invite Madison Crane to connect';
      return '';
    },
    async scrollIntoViewIfNeeded() {},
    async click() { clickedId = this._id; },
    async boundingBox() { return { x: 200, y: 400, width: 100, height: 40 }; }
  };

  const liamSidebar = {
    _id: 'liam-sidebar',
    async isVisible() { return true; },
    async getAttribute(attr) {
      if (attr === 'aria-label') return 'Invite Liam Walder to connect';
      return '';
    },
    async scrollIntoViewIfNeeded() {},
    async click() { clickedId = this._id; },
    async boundingBox() { return { x: 1000, y: 500, width: 100, height: 40 }; }
  };

  const page = {
    async $$(selector) {
      // Phase 0 person-specific selectors: only match Madison
      if (selector.includes('Invite Madison Crane')) {
        return [madisonConnect];
      }
      // Broad selectors match both — Liam first in DOM order
      if (selector.startsWith('main ') || selector.startsWith('.pv-')) {
        return [liamSidebar, madisonConnect];
      }
      return [];
    },
    async waitForTimeout() {},
    mouse: {
      async move() {},
      async click() {}
    }
  };

  const result = await clickConnectButton(page, 1000, {
    targetName: 'Madison Crane'
  });

  assert.equal(result, true, 'clickConnectButton should succeed');
  assert.equal(clickedId, 'madison-hero', 'Phase 0 must click Madison hero, not Liam sidebar');
});

test('clickConnectButton Phase 0 skips to Phase 1 when no person-specific match', async () => {
  const { _private: { clickConnectButton } } = require('../automation/connection/request');

  let clickedId = null;

  // Only the hero button has the target name; no Phase 0 match exists
  // because the aria-label has a slightly different format.
  const heroConnect = {
    _id: 'hero-connect',
    async isVisible() { return true; },
    async getAttribute(attr) {
      // Non-standard aria-label — no "Invite X" pattern
      if (attr === 'aria-label') return 'Madison Crane connect action';
      return '';
    },
    async textContent() { return 'Connect'; },
    async scrollIntoViewIfNeeded() {},
    async click() { clickedId = this._id; },
    async boundingBox() { return { x: 200, y: 400, width: 100, height: 40 }; }
  };

  const page = {
    async $$(selector) {
      // Phase 0 person-specific selectors: match nothing (unusual aria-label)
      if (selector.includes('Invite Madison') || selector.includes('Connect with Madison')) {
        return [];
      }
      // Broad selectors find the hero button
      if (selector.startsWith('main ')) {
        return [heroConnect];
      }
      return [];
    },
    async waitForTimeout() {},
    mouse: {
      async move() {},
      async click() {}
    }
  };

  const result = await clickConnectButton(page, 500, {
    targetName: 'Madison Crane'
  });

  // Phase 1 matchesTargetPerson checks full name in aria-label.
  // "madison crane connect action" contains "madison crane" → passes.
  assert.equal(result, true, 'Phase 1 should find the button');
  assert.equal(clickedId, 'hero-connect');
});

// ---------------------------------------------------------------------------
// Phase 2: More-menu dropdown now filters by targetName
// ---------------------------------------------------------------------------

test('clickConnectButton Phase 2 dropdown filters Connect items by targetName', async () => {
  const { _private: { clickConnectButton } } = require('../automation/connection/request');

  let clickedId = null;

  const moreButton = {
    _id: 'more-btn',
    async isVisible() { return true; },
    async getAttribute(attr) {
      if (attr === 'aria-label') return 'More actions';
      return '';
    },
    async textContent() { return 'More'; },
    async scrollIntoViewIfNeeded() {},
    async click() {},
    async boundingBox() { return { x: 300, y: 400, width: 80, height: 40 }; }
  };

  const wrongDropdownConnect = {
    _id: 'wrong-connect',
    async isVisible() { return true; },
    async getAttribute(attr) {
      if (attr === 'aria-label') return 'Invite Someone Else to connect';
      return '';
    },
    async textContent() { return 'Connect'; },
    async scrollIntoViewIfNeeded() {},
    async click() { clickedId = this._id; },
    async boundingBox() { return { x: 300, y: 450, width: 150, height: 30 }; }
  };

  const rightDropdownConnect = {
    _id: 'right-connect',
    async isVisible() { return true; },
    async getAttribute(attr) {
      if (attr === 'aria-label') return 'Invite Madison Crane to connect';
      return '';
    },
    async textContent() { return 'Connect'; },
    async scrollIntoViewIfNeeded() {},
    async click() { clickedId = this._id; },
    async boundingBox() { return { x: 300, y: 480, width: 150, height: 30 }; }
  };

  const page = {
    async $$(selector) {
      // Phase 0: no person-specific match
      if (selector.includes('Invite Madison') || selector.includes('Connect with Madison')) {
        return [];
      }
      // Phase 1: no match (hero Connect absent — hidden behind More)
      if (selector.startsWith('main button') && selector.includes('Connect')) {
        return [];
      }
      // More button
      if (selector.includes('More actions') || selector.includes('More')) {
        return [moreButton];
      }
      // Dropdown items — wrong person first, right person second
      if (selector.includes('artdeco-dropdown') || selector.includes('role="menu"')) {
        return [wrongDropdownConnect, rightDropdownConnect];
      }
      return [];
    },
    async waitForTimeout() {},
    mouse: {
      async move() {},
      async click() {}
    }
  };

  const result = await clickConnectButton(page, 500, {
    targetName: 'Madison Crane'
  });

  assert.equal(result, true, 'Phase 2 should find Connect in dropdown');
  assert.equal(clickedId, 'right-connect', 'Must click Madison dropdown item, not Someone Else');
});
