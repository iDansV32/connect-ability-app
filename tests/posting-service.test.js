'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('module');

const SERVICE_PATH = require.resolve('../automation/posting/service');
const serviceRequire = createRequire(SERVICE_PATH);

function createHarness(options = {}) {
  const restoredModules = new Map();
  const spies = {
    scheduleScheduledPostCalls: [],
    executePostOnPageCalls: []
  };

  installStub('../network/tracer', {
    traceAction: async (_page, _name, _metadata, fn) => fn()
  }, restoredModules);
  installStub('../util/log', {
    logAction() {},
    logError() {}
  }, restoredModules);
  installStub('./post-publisher', {
    executePostOnPage: async (...args) => {
      spies.executePostOnPageCalls.push(args);
      return options.domResult || {
        outcome: 'scheduled',
        linkedInResourceKey: null,
        linkedInScheduledAt: '1774515600000'
      };
    }
  }, restoredModules);
  installStub('./posting-transport', {
    scheduleScheduledPost: async (page, postConfig, transportOptions) => {
      spies.scheduleScheduledPostCalls.push({ page, postConfig, transportOptions });
      if (typeof options.scheduleScheduledPost === 'function') {
        return options.scheduleScheduledPost(page, postConfig, transportOptions, spies);
      }
      return options.transportResult || {
        success: true,
        transport: 'dom',
        resourceKey: null,
        verificationResult: {
          verified: true,
          method: 'dom',
          reason: null
        }
      };
    }
  }, restoredModules);

  delete require.cache[SERVICE_PATH];
  const service = require(SERVICE_PATH);

  return {
    service,
    spies,
    restore() {
      delete require.cache[SERVICE_PATH];
      for (const [resolvedPath, previousEntry] of restoredModules.entries()) {
        if (previousEntry) {
          require.cache[resolvedPath] = previousEntry;
        } else {
          delete require.cache[resolvedPath];
        }
      }
    }
  };
}

function installStub(request, exportsValue, restoredModules) {
  const resolvedPath = serviceRequire.resolve(request);
  if (!restoredModules.has(resolvedPath)) {
    restoredModules.set(
      resolvedPath,
      Object.prototype.hasOwnProperty.call(require.cache, resolvedPath) ? require.cache[resolvedPath] : null
    );
  }

  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue
  };
}

test('scheduleTextPost delegates scheduled-post execution to posting-transport', async () => {
  const harness = createHarness();

  try {
    const result = await harness.service.scheduleTextPost({}, {
      text: 'Hello world',
      scheduledAt: '1774515600000',
      accountEmail: 'alice@example.com'
    });

    assert.equal(result.success, true);
    assert.equal(result.transport, 'dom');
    assert.equal(harness.spies.scheduleScheduledPostCalls.length, 1);
    assert.equal(harness.spies.scheduleScheduledPostCalls[0].postConfig.text, 'Hello world');
    assert.equal(harness.spies.scheduleScheduledPostCalls[0].transportOptions.accountEmail, 'alice@example.com');
  } finally {
    harness.restore();
  }
});

test('scheduleTextPost exposes a domScheduler callback that routes through executePostOnPage', async () => {
  const harness = createHarness({
    scheduleScheduledPost: async (_page, _postConfig, transportOptions) => transportOptions.domScheduler({
      content: 'Fallback post',
      scheduledDate: '2026-03-25',
      scheduledTime: '10:00',
      includeImage: false,
      imagePath: null
    })
  });

  try {
    const result = await harness.service.scheduleTextPost({}, {
      text: 'Fallback post',
      scheduledAt: '1774515600000',
      accountEmail: 'poster@example.com',
      accountName: 'Poster'
    });

    assert.equal(result.outcome, 'scheduled');
    assert.equal(harness.spies.executePostOnPageCalls.length, 1);
    assert.equal(harness.spies.executePostOnPageCalls[0][2].email, 'poster@example.com');
    assert.equal(harness.spies.executePostOnPageCalls[0][2].name, 'Poster');
  } finally {
    harness.restore();
  }
});

test('deleteScheduledPost returns not_supported in DOM-only mode', async () => {
  const harness = createHarness();

  try {
    const result = await harness.service.deleteScheduledPost({
      goto: async () => {}
    }, 'urn:li:share:123');

    assert.equal(result.success, false);
    assert.equal(result.reason, 'not_supported_dom_only');
  } finally {
    harness.restore();
  }
});
