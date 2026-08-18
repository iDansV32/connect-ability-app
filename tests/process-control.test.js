'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isChildProcessActive,
  isTargetClosedError,
  terminateChildProcess
} = require('../automation/core/process-control');

test('isTargetClosedError detects common Playwright target-closed messages', () => {
  assert.equal(isTargetClosedError(new Error('page.goto: Target page, context or browser has been closed')), true);
  assert.equal(isTargetClosedError(new Error('page.waitForSelector: Target page, context or browser has been closed')), true);
  assert.equal(isTargetClosedError(new Error('browserContext.newPage: Target page, context or browser has been closed')), true);
  assert.equal(isTargetClosedError(new Error('Most likely the page has been closed')), true);
});

test('isTargetClosedError ignores ordinary automation failures', () => {
  assert.equal(isTargetClosedError(new Error('Timeout waiting for any selector')), false);
  assert.equal(isTargetClosedError(new Error('Could not find Connect button on profile')), false);
  assert.equal(isTargetClosedError('plain string error'), false);
});

test('isChildProcessActive returns true only for a live child process', () => {
  assert.equal(isChildProcessActive({ kill() {}, killed: false, exitCode: null }), true);
  assert.equal(isChildProcessActive({ kill() {}, killed: true, exitCode: null }), false);
  assert.equal(isChildProcessActive({ kill() {}, killed: false, exitCode: 0 }), false);
  assert.equal(isChildProcessActive(null), false);
});

test('terminateChildProcess sends SIGTERM then SIGKILL when the child stays alive', () => {
  const calls = [];
  const listeners = {};
  let scheduled = null;
  const child = {
    killed: false,
    exitCode: null,
    kill(signal) {
      calls.push(signal);
    },
    once(event, fn) {
      listeners[event] = fn;
    }
  };

  const stopped = terminateChildProcess(child, {
    forceKillAfterMs: 25,
    scheduleFn(fn) {
      scheduled = fn;
      return { unref() {} };
    },
    clearFn() {}
  });

  assert.equal(stopped, true);
  assert.deepEqual(calls, ['SIGTERM']);
  assert.ok(typeof scheduled === 'function');

  scheduled();
  assert.deepEqual(calls, ['SIGTERM', 'SIGKILL']);
});

test('terminateChildProcess does not SIGKILL a child that already exited', () => {
  const calls = [];
  let scheduled = null;
  const child = {
    killed: false,
    exitCode: null,
    kill(signal) {
      calls.push(signal);
    },
    once() {}
  };

  terminateChildProcess(child, {
    forceKillAfterMs: 25,
    scheduleFn(fn) {
      scheduled = fn;
      return { unref() {} };
    },
    clearFn() {}
  });

  child.exitCode = 0;
  scheduled();
  assert.deepEqual(calls, ['SIGTERM']);
});

test('terminateChildProcess returns false for an already-dead child', () => {
  const child = {
    killed: true,
    exitCode: null,
    kill() {
      throw new Error('should not be called');
    }
  };

  assert.equal(terminateChildProcess(child), false);
});
