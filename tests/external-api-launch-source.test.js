'use strict';

/**
 * tests/external-api-launch-source.test.js
 *
 * Integration tests for the launchSource thread that backs the external-API
 * visible-browser guarantee. The policy module (external-api-safety.js) stamps
 * launchSource:'external_api' + headless:false on API-triggered browser calls;
 * these tests pin the two seams that turn that stamp into an enforced invariant:
 *
 *  1. Persistence — a run created with launchSource survives a round-trip
 *     through WorkflowRunManager + the SQLite repository, so the durable
 *     scheduler can read it back and thread it into the worker startup config.
 *
 *  2. Fail-closed launch — the worker's launch-time assertion refuses to open
 *     a browser when an external_api-sourced launch is anything but visible,
 *     and leaves every other launch untouched.
 *
 * Offline-safe: in-memory SQLite, no browser, no network. The launch assertion
 * is exercised through the exported pure helper so no chromium call is reached.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const SqliteWorkflowRepository = require('../storage/sqlite-workflow-repository');
const WorkflowRunManager = require('../workflow-run-manager');
const { EXTERNAL_API_LAUNCH_SOURCE } = require('../external-api-safety');
const { assertExternalApiLaunchVisible } = require('../automation/runtime/account-worker-process');

function openMemory() {
  return openDatabase(':memory:');
}

function runInput(overrides = {}) {
  return {
    workflowName: 'Launch Source Run',
    accountId:    'acc-ls',
    steps:    [{ type: 'view_profile' }],
    targets:  [{ value: 'https://linkedin.com/in/ls-user', label: 'LS User', prospectId: 'p-ls' }],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. launch_source persistence round-trip
// ---------------------------------------------------------------------------

describe('launch_source persistence', () => {
  test('createRun stamps launchSource and SQLite round-trips it across re-instantiation', () => {
    const db = openMemory();
    try {
      const repo1 = new SqliteWorkflowRepository(db);
      const mgr1 = new WorkflowRunManager({ repo: repo1 });
      const { run } = mgr1.createRun(runInput({ launchSource: EXTERNAL_API_LAUNCH_SOURCE }));
      assert.equal(run.launchSource, EXTERNAL_API_LAUNCH_SOURCE, 'createRun keeps launchSource on the returned run');

      // Re-open against the same db handle — proves the value lives in SQLite,
      // not in the first manager's memory.
      const repo2 = new SqliteWorkflowRepository(db);
      const reloaded = repo2.readRuns().runs.find((r) => r.id === run.id);
      assert.ok(reloaded, 'run is readable after re-instantiation');
      assert.equal(reloaded.launchSource, EXTERNAL_API_LAUNCH_SOURCE, 'launch_source persisted to the DB');
    } finally {
      closeDatabase(db);
    }
  });

  test('manual-launch working-hours bypass survives a SQLite round-trip', () => {
    const db = openMemory();
    try {
      const repo1 = new SqliteWorkflowRepository(db);
      const mgr1 = new WorkflowRunManager({ repo: repo1 });
      const { run } = mgr1.createRun(runInput({ bypassWorkingHours: true }));
      assert.equal(run.bypassWorkingHours, true);

      const repo2 = new SqliteWorkflowRepository(db);
      const reloaded = repo2.readRuns().runs.find((entry) => entry.id === run.id);
      assert.ok(reloaded);
      assert.equal(reloaded.bypassWorkingHours, true, 'manual run must not become blocked by account hours after persistence');
    } finally {
      closeDatabase(db);
    }
  });

  test('createRun without launchSource persists null (native runs are unmarked)', () => {
    const db = openMemory();
    try {
      const repo = new SqliteWorkflowRepository(db);
      const mgr = new WorkflowRunManager({ repo });
      const { run } = mgr.createRun(runInput());
      assert.equal(run.launchSource, null, 'native run carries no launch source');

      const reloaded = new SqliteWorkflowRepository(db).readRuns().runs.find((r) => r.id === run.id);
      assert.equal(reloaded.launchSource, null, 'null launch_source round-trips');
    } finally {
      closeDatabase(db);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Worker fail-closed launch assertion
// ---------------------------------------------------------------------------

describe('assertExternalApiLaunchVisible (worker fail-closed)', () => {
  test('throws when external_api launch is headless:true', () => {
    assert.throws(
      () => assertExternalApiLaunchVisible({ launchSource: EXTERNAL_API_LAUNCH_SOURCE, headless: true, email: 'x@y.z' }),
      /BLOCKED headless browser launch/
    );
  });

  test('throws when external_api launch has headless undefined (must be explicitly false)', () => {
    assert.throws(
      () => assertExternalApiLaunchVisible({ launchSource: EXTERNAL_API_LAUNCH_SOURCE, email: 'x@y.z' }),
      /BLOCKED headless browser launch/
    );
  });

  test('passes when external_api launch is headless:false', () => {
    assert.doesNotThrow(
      () => assertExternalApiLaunchVisible({ launchSource: EXTERNAL_API_LAUNCH_SOURCE, headless: false, email: 'x@y.z' })
    );
  });

  test('ignores non-external launches — native headless runs are allowed', () => {
    assert.doesNotThrow(() => assertExternalApiLaunchVisible({ launchSource: null, headless: true }));
    assert.doesNotThrow(() => assertExternalApiLaunchVisible({ launchSource: 'native', headless: true }));
    assert.doesNotThrow(() => assertExternalApiLaunchVisible({}));
  });
});
