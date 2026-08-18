'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('module');

const { createTempWorkspace } = require('./test-helpers');

const TRACER_MODULE_PATH = require.resolve('../automation/network/tracer');
const tracerRequire = createRequire(TRACER_MODULE_PATH);

function installStub(request, exportsValue, restoredModules) {
  const resolvedPath = tracerRequire.resolve(request);
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

function createTracerHarness(workspace) {
  const restoredModules = new Map();
  const logDir = workspace.path('logs');

  installStub('../util/log', {
    LOG_DIR: logDir,
    logAction() {},
    logError() {}
  }, restoredModules);

  delete require.cache[TRACER_MODULE_PATH];
  const tracer = require(TRACER_MODULE_PATH);

  return {
    tracer,
    traceFile: path.join(logDir, 'network-trace.jsonl'),
    restore() {
      delete require.cache[TRACER_MODULE_PATH];
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

async function withTraceEnv(value, fn) {
  const previousValue = process.env.CONNECT_TRACE_NETWORK;
  if (value === undefined) {
    delete process.env.CONNECT_TRACE_NETWORK;
  } else {
    process.env.CONNECT_TRACE_NETWORK = value;
  }

  try {
    return await fn();
  } finally {
    if (previousValue === undefined) {
      delete process.env.CONNECT_TRACE_NETWORK;
    } else {
      process.env.CONNECT_TRACE_NETWORK = previousValue;
    }
  }
}

function createFakePage() {
  const listeners = new Map();
  const attachedEvents = [];

  return {
    on(event, handler) {
      attachedEvents.push(event);
      listeners.set(event, handler);
    },
    async emit(event, payload) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        await handler(payload);
      }
    },
    getAttachedEvents() {
      return attachedEvents.slice();
    }
  };
}

function createFakeRequest(options = {}) {
  const {
    method = 'POST',
    url = 'https://www.linkedin.com/voyager/api/graphql',
    resourceType = 'xhr',
    headers = {},
    postData = null
  } = options;

  return {
    method: () => method,
    url: () => url,
    resourceType: () => resourceType,
    headers: () => headers,
    postData: () => postData
  };
}

function createFakeResponse(request, options = {}) {
  const {
    status = 200,
    ok = true,
    headers = {},
    body = ''
  } = options;

  return {
    request: () => request,
    status: () => status,
    ok: () => ok,
    headers: () => headers,
    text: async () => body
  };
}

function readTraceEvents(traceFile) {
  const payload = fs.readFileSync(traceFile, 'utf8').trim();
  if (!payload) {
    return [];
  }
  return payload.split('\n').map((line) => JSON.parse(line));
}

test('traceAction is disabled by default when CONNECT_TRACE_NETWORK is unset', { concurrency: false }, async () => {
  await withTraceEnv(undefined, async () => {
    const workspace = createTempWorkspace('network-tracer-disabled-');
    const harness = createTracerHarness(workspace);

    try {
      const page = createFakePage();
      const result = await harness.tracer.traceAction(page, 'send_dm', { message: 'secret' }, async () => 'ok');

      assert.equal(result, 'ok');
      assert.deepEqual(page.getAttachedEvents(), []);
      assert.equal(fs.existsSync(harness.traceFile), false);
    } finally {
      harness.restore();
      workspace.cleanup();
    }
  });
});

test('traceAction redacts sensitive headers and summarizes payloads when tracing is enabled', { concurrency: false }, async () => {
  await withTraceEnv('true', async () => {
    const workspace = createTempWorkspace('network-tracer-enabled-');
    const harness = createTracerHarness(workspace);

    try {
      const page = createFakePage();

      const result = await harness.tracer.traceAction(page, 'send_dm', {
        prospectId: 'prospect-123',
        message: 'hello there',
        nested: {
          token: 'secret-token',
          keep: 'visible'
        }
      }, async () => {
        const request = createFakeRequest({
          headers: {
            authorization: 'Bearer secret',
            cookie: 'li_at=abc',
            'x-trace-id': 'trace-123'
          },
          postData: JSON.stringify({
            message: 'this should not be logged',
            count: 2
          })
        });

        await page.emit('request', request);

        const response = createFakeResponse(request, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': 'session=value'
          },
          body: JSON.stringify({
            status: 'ok',
            text: 'response body should be summarized'
          })
        });

        await page.emit('response', response);
        return 'traced';
      });

      assert.equal(result, 'traced');
      assert.deepEqual(page.getAttachedEvents(), ['request', 'response']);
      assert.equal(fs.existsSync(harness.traceFile), true);

      const events = readTraceEvents(harness.traceFile);
      assert.equal(events.length, 4);

      const [actionStart, requestEvent, responseEvent, actionEnd] = events;
      assert.equal(actionStart.type, 'action_start');
      assert.equal(actionStart.metadata.prospectId, 'prospect-123');
      assert.equal(actionStart.metadata.message, '<redacted>');
      assert.deepEqual(actionStart.metadata.nested, {
        token: '<redacted>',
        keep: 'visible'
      });

      assert.equal(requestEvent.type, 'request');
      assert.equal(requestEvent.headers.authorization, '<redacted>');
      assert.equal(requestEvent.headers.cookie, '<redacted>');
      assert.equal(requestEvent.headers['x-trace-id'], 'trace-123');
      assert.deepEqual(requestEvent.postData, {
        format: 'json',
        length: JSON.stringify({ message: 'this should not be logged', count: 2 }).length,
        redacted: true,
        shape: {
          type: 'object',
          keys: ['count', 'message']
        }
      });
      assert.equal(requestEvent.metadata.message, '<redacted>');
      assert.equal(requestEvent.metadata.nested.token, '<redacted>');
      assert.equal(requestEvent.metadata.nested.keep, 'visible');

      assert.equal(responseEvent.type, 'response');
      assert.equal(responseEvent.headers['set-cookie'], '<redacted>');
      assert.deepEqual(responseEvent.body, {
        format: 'json',
        length: JSON.stringify({ status: 'ok', text: 'response body should be summarized' }).length,
        redacted: true,
        shape: {
          type: 'object',
          keys: ['status', 'text']
        }
      });

      assert.equal(actionEnd.type, 'action_end');
      assert.equal(actionEnd.success, true);
    } finally {
      harness.restore();
      workspace.cleanup();
    }
  });
});
