'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ACCOUNT_WORKER_MESSAGE_TYPES } = require('../automation/runtime/account-worker-protocol');
const {
  buildScheduledPostResult,
  _private: {
    isLinkedInLoginInterstitialUrl,
    buildAccountChooserTokens,
    toLinkedInDateFormat,
    toLinkedInTimeFormat,
    toScheduledTimestamp,
    mapVisibilityType,
    focusFieldForTyping
  }
} = require('../automation/posting/post-publisher');

// ─── Protocol catalog ─────────────────────────────────────────────────────────

test('ACCOUNT_WORKER_MESSAGE_TYPES includes PUBLISH_POST and PUBLISH_POST_RESULT', () => {
  assert.equal(ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST, 'publish_post');
  assert.equal(ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT, 'publish_post_result');
});

test('PUBLISH_POST and PUBLISH_POST_RESULT are distinct values', () => {
  assert.notEqual(
    ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST,
    ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT
  );
});

test('ACCOUNT_WORKER_MESSAGE_TYPES still contains all original message types', () => {
  const required = [
    'EXECUTE_STEP', 'STEP_RESULT', 'POLL_REPLIES', 'POLL_REPLIES_RESULT',
    'PUBLISH_POST', 'PUBLISH_POST_RESULT', 'HEARTBEAT', 'LOG', 'WORKER_READY', 'SHUTDOWN'
  ];
  for (const key of required) {
    assert.ok(
      typeof ACCOUNT_WORKER_MESSAGE_TYPES[key] === 'string' && ACCOUNT_WORKER_MESSAGE_TYPES[key].length > 0,
      `expected ACCOUNT_WORKER_MESSAGE_TYPES.${key} to be a non-empty string`
    );
  }
});

// ─── buildScheduledPostResult ─────────────────────────────────────────────────

test('buildScheduledPostResult returns scheduled outcome with resourceKey from result', () => {
  const postConfig = { scheduledDate: '2026-04-01', scheduledTime: '09:00' };
  const result = { resourceKey: 'urn:li:share:12345', scheduledAt: '1743498000000' };

  const output = buildScheduledPostResult(postConfig, result);

  assert.equal(output.outcome, 'scheduled');
  assert.equal(output.deliveryStrategy, 'linkedin_scheduled');
  assert.equal(output.linkedInResourceKey, 'urn:li:share:12345');
  assert.equal(output.linkedInScheduledAt, '1743498000000');
});

test('buildScheduledPostResult derives linkedInScheduledAt from postConfig when result has none', () => {
  const postConfig = { scheduledDate: '2026-06-15', scheduledTime: '14:30' };
  const result = { resourceKey: 'urn:li:share:99' };

  const output = buildScheduledPostResult(postConfig, result);

  assert.equal(output.linkedInResourceKey, 'urn:li:share:99');
  // Should be a numeric timestamp string for 2026-06-15T14:30.
  const ts = Number(output.linkedInScheduledAt);
  assert.ok(Number.isFinite(ts) && ts > 0, 'expected a positive numeric timestamp');
  const date = new Date(ts);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 5); // 0-indexed June
  assert.equal(date.getDate(), 15);
});

test('buildScheduledPostResult sets linkedInResourceKey to null when result has none', () => {
  const output = buildScheduledPostResult({ scheduledDate: '2026-04-01', scheduledTime: '10:00' }, {});
  assert.equal(output.linkedInResourceKey, null);
});

test('buildScheduledPostResult with no arguments returns safe defaults', () => {
  const output = buildScheduledPostResult();
  assert.equal(output.outcome, 'scheduled');
  assert.equal(output.deliveryStrategy, 'linkedin_scheduled');
  assert.equal(output.linkedInResourceKey, null);
  assert.equal(output.linkedInScheduledAt, null);
});

test('buildScheduledPostResult is no-throw on an unparseable date; resourceKey survives, timestamp is null', () => {
  // Regression guard for the worker-internal resourceKey-then-throw race.
  // toScheduledTimestamp throws on a malformed date. Before the fix, that
  // throw bubbled out of the private fast path and fell through to a
  // duplicate composer publish. Now the builder swallows it: the captured
  // resourceKey (proof LinkedIn accepted the schedule) must survive, and
  // the local timestamp degrades to null rather than throwing.
  // Structurally date-shaped but out-of-range so `new Date(...)` yields NaN
  // and toScheduledTimestamp throws. (Freeform garbage like 'not-a-date'
  // gets coerced to a year-2000 date by V8 and would not exercise the throw
  // path — the value has to look like a date but be impossible.)
  const postConfig = { scheduledDate: '2026-13-99', scheduledTime: '99:99' };
  const result = { resourceKey: 'urn:li:share:already-scheduled' };

  let output;
  assert.doesNotThrow(() => {
    output = buildScheduledPostResult(postConfig, result);
  }, 'builder must not throw on an unparseable date when a resourceKey is present');

  assert.equal(output.outcome, 'scheduled');
  assert.equal(output.linkedInResourceKey, 'urn:li:share:already-scheduled',
    'resourceKey (control field) must survive a timestamp-reconstruction failure');
  assert.equal(output.linkedInScheduledAt, null,
    'timestamp (audit field) degrades to null rather than throwing');
});

test('buildScheduledPostResult prefers result.scheduledAt and never invokes toScheduledTimestamp when present', () => {
  // When the private API echoes scheduledAt, the malformed postConfig date
  // is irrelevant — the builder uses the echoed value and never reaches the
  // throw-capable reconstruction path.
  const postConfig = { scheduledDate: 'garbage', scheduledTime: 'garbage' };
  const result = { resourceKey: 'urn:li:share:7', scheduledAt: '1799999999000' };

  const output = buildScheduledPostResult(postConfig, result);
  assert.equal(output.linkedInScheduledAt, '1799999999000');
  assert.equal(output.linkedInResourceKey, 'urn:li:share:7');
});

// ─── isLinkedInLoginInterstitialUrl ──────────────────────────────────────────

test('isLinkedInLoginInterstitialUrl returns true for /uas/login URL', () => {
  assert.equal(isLinkedInLoginInterstitialUrl('https://www.linkedin.com/uas/login'), true);
});

test('isLinkedInLoginInterstitialUrl returns true for /login URL', () => {
  assert.equal(isLinkedInLoginInterstitialUrl('https://www.linkedin.com/login'), true);
});

test('isLinkedInLoginInterstitialUrl returns true for /checkpoint/ URL', () => {
  assert.equal(isLinkedInLoginInterstitialUrl('https://www.linkedin.com/checkpoint/challenge/verify'), true);
});

test('isLinkedInLoginInterstitialUrl returns false for feed URL', () => {
  assert.equal(isLinkedInLoginInterstitialUrl('https://www.linkedin.com/feed/'), false);
});

test('isLinkedInLoginInterstitialUrl returns false for null/empty', () => {
  assert.equal(isLinkedInLoginInterstitialUrl(null), false);
  assert.equal(isLinkedInLoginInterstitialUrl(''), false);
});

// ─── buildAccountChooserTokens ────────────────────────────────────────────────

test('buildAccountChooserTokens extracts name and email prefix as tokens', () => {
  const tokens = buildAccountChooserTokens({ name: 'Alice Smith', email: 'alice@example.com' });
  assert.ok(tokens.includes('alice smith'), 'expected full name token');
  assert.ok(tokens.includes('alice@example.com'), 'expected full email token');
  assert.ok(tokens.includes('alice'), 'expected email-prefix token');
});

test('buildAccountChooserTokens returns tokens sorted longest first', () => {
  const tokens = buildAccountChooserTokens({ name: 'Bob', email: 'bob@test.com' });
  for (let i = 1; i < tokens.length; i++) {
    assert.ok(tokens[i - 1].length >= tokens[i].length, 'tokens should be sorted by length descending');
  }
});

test('buildAccountChooserTokens ignores values shorter than 3 chars', () => {
  const tokens = buildAccountChooserTokens({ name: 'Al', email: 'al@example.com' });
  assert.ok(!tokens.includes('al'), 'short name token should be excluded');
});

test('buildAccountChooserTokens returns empty array for empty credentials', () => {
  const tokens = buildAccountChooserTokens({});
  assert.ok(Array.isArray(tokens));
  assert.equal(tokens.length, 0);
});

// ─── toLinkedInDateFormat ─────────────────────────────────────────────────────

test('toLinkedInDateFormat converts YYYY-MM-DD to MM/DD/YYYY', () => {
  assert.equal(toLinkedInDateFormat('2026-04-15'), '04/15/2026');
});

test('toLinkedInDateFormat leaves non-matching strings unchanged', () => {
  assert.equal(toLinkedInDateFormat('April 15'), 'April 15');
  assert.equal(toLinkedInDateFormat(''), '');
});

// ─── toLinkedInTimeFormat ─────────────────────────────────────────────────────

test('toLinkedInTimeFormat returns HH:MM unchanged when useAmPm is false', () => {
  assert.equal(toLinkedInTimeFormat('14:30', false), '14:30');
  assert.equal(toLinkedInTimeFormat('09:00', false), '09:00');
});

test('toLinkedInTimeFormat converts to AM/PM when useAmPm is true', () => {
  assert.equal(toLinkedInTimeFormat('14:30', true), '2:30 PM');
  assert.equal(toLinkedInTimeFormat('09:00', true), '9:00 AM');
  assert.equal(toLinkedInTimeFormat('00:00', true), '12:00 AM');
  assert.equal(toLinkedInTimeFormat('12:00', true), '12:00 PM');
});

test('toLinkedInTimeFormat leaves non-matching strings unchanged', () => {
  assert.equal(toLinkedInTimeFormat('noon', false), 'noon');
});

// ─── toScheduledTimestamp ─────────────────────────────────────────────────────

test('toScheduledTimestamp returns a numeric timestamp string for valid date/time', () => {
  const ts = toScheduledTimestamp('2026-04-15', '10:00');
  const num = Number(ts);
  assert.ok(Number.isFinite(num) && num > 0, 'expected positive numeric timestamp string');
});

test('toScheduledTimestamp throws for invalid date/time', () => {
  // Out-of-range values (month 99, day 99, hour 99) produce Invalid Date → NaN.
  assert.throws(
    () => toScheduledTimestamp('2026-99-99', '99:99'),
    /could not be converted to a timestamp/
  );
});

// ─── mapVisibilityType ────────────────────────────────────────────────────────

test('mapVisibilityType maps "connections" to CONNECTIONS', () => {
  assert.equal(mapVisibilityType('connections'), 'CONNECTIONS');
  assert.equal(mapVisibilityType('connections_only'), 'CONNECTIONS');
  assert.equal(mapVisibilityType('CONNECTIONS'), 'CONNECTIONS');
});

test('mapVisibilityType maps anything else to ANYONE', () => {
  assert.equal(mapVisibilityType('public'), 'ANYONE');
  assert.equal(mapVisibilityType(''), 'ANYONE');
  assert.equal(mapVisibilityType(null), 'ANYONE');
  assert.equal(mapVisibilityType('anyone'), 'ANYONE');
});

test('focusFieldForTyping clicks once and uses focus fallback without repeat clicks', async () => {
  let clickCount = 0;
  let focused = false;
  let focusCalls = 0;
  const handle = {
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { clickCount += 1; },
    focus: async () => {
      focusCalls += 1;
      focused = true;
    },
    evaluate: async () => focused
  };

  const result = await focusFieldForTyping({}, handle, {
    moveMouseNaturally: async () => true,
    randomDelay: async () => {}
  });

  assert.equal(result, true);
  assert.equal(clickCount, 1);
  assert.equal(focusCalls, 1);
});

// ─── Worker dispatch correlation (mock process manager) ───────────────────────

test('dispatchAndAwaitMessage resolves with PUBLISH_POST_RESULT matching requestId', async () => {
  const { EventEmitter } = require('events');
  const AccountWorkerProcessManager = require('../automation/runtime/account-worker-process-manager');

  const fakeWorker = new EventEmitter();
  fakeWorker.accountEmail = 'poster@example.com';
  fakeWorker.closed = false;
  fakeWorker.readyPromise = Promise.resolve();
  fakeWorker.send = async (msg) => {
    // Simulate the worker echoing a PUBLISH_POST_RESULT with a slight delay.
    setImmediate(() => {
      fakeWorker.emit('message', {
        type: ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT,
        requestId: msg.requestId,
        publishResult: { outcome: 'scheduled', deliveryStrategy: 'linkedin_scheduled' }
      });
    });
  };
  fakeWorker.whenReady = () => Promise.resolve();

  const manager = new AccountWorkerProcessManager({
    workerFactory: () => fakeWorker
  });

  const requestId = `test-post-${Date.now()}`;
  const response = await manager.dispatchAndAwaitMessage(
    { email: 'poster@example.com', password: 'x' },
    {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST,
      requestId,
      postConfig: { content: 'Hello world', immediate: true }
    },
    {
      matchMessage: (msg) => (
        msg?.type === ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT
        && msg?.requestId === requestId
      ),
      timeoutMs: 5000
    }
  );

  assert.equal(response.publishResult?.outcome, 'scheduled');
});

test('dispatchAndAwaitMessage ignores PUBLISH_POST_RESULT with a different requestId', async () => {
  const { EventEmitter } = require('events');
  const AccountWorkerProcessManager = require('../automation/runtime/account-worker-process-manager');

  const fakeWorker = new EventEmitter();
  fakeWorker.accountEmail = 'poster2@example.com';
  fakeWorker.closed = false;
  fakeWorker.readyPromise = Promise.resolve();
  let sentMessage = null;
  fakeWorker.send = async (msg) => {
    sentMessage = msg;
    setImmediate(() => {
      // First emit a result for a different requestId — should be ignored.
      fakeWorker.emit('message', {
        type: ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT,
        requestId: 'wrong-id',
        publishResult: { outcome: 'published' }
      });
      // Then emit the correct one.
      fakeWorker.emit('message', {
        type: ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT,
        requestId: msg.requestId,
        publishResult: { outcome: 'scheduled', deliveryStrategy: 'linkedin_scheduled' }
      });
    });
  };
  fakeWorker.whenReady = () => Promise.resolve();

  const manager = new AccountWorkerProcessManager({
    workerFactory: () => fakeWorker
  });

  const requestId = `test-post-2-${Date.now()}`;
  const response = await manager.dispatchAndAwaitMessage(
    { email: 'poster2@example.com', password: 'x' },
    {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST,
      requestId,
      postConfig: { content: 'Test', immediate: false, scheduledDate: '2026-04-15', scheduledTime: '10:00' }
    },
    {
      matchMessage: (msg) => (
        msg?.type === ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT
        && msg?.requestId === requestId
      ),
      timeoutMs: 5000
    }
  );

  // Should resolve with the correct (second) message, not the wrong-id one.
  assert.equal(response.publishResult?.outcome, 'scheduled');
  assert.notEqual(response.requestId, 'wrong-id');
});
