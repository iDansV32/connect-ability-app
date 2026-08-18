'use strict';

/**
 * tests/proxy-config.test.js
 *
 * Targeted tests for Ticket 5 — per-account proxy support.
 *
 * Covers:
 *  1. normalizeProxyConfig: valid configs, null/absent, and malformed cases.
 *  2. buildPlaywrightProxyOption: correct Playwright proxy object shape.
 *  3. Worker startup config serialisation: proxy is written to the startup JSON.
 *  4. Worker startup config parsing: proxy is read back by loadStartupConfig.
 *  5. No-proxy accounts: null proxy propagates cleanly; no proxy key in launch options.
 *  6. formatProxyForLog: password is never included in log output.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProxyConfig,
  buildPlaywrightProxyOption,
  formatProxyForLog
} = require('../automation/runtime/proxy-config');

const AccountWorkerProcessManager = require('../automation/runtime/account-worker-process-manager');
const { writeWorkerStartupConfig } = AccountWorkerProcessManager._private;

const { _private: workerPrivate } = require('../automation/runtime/account-worker-process');
const { loadStartupConfig, buildPlaywrightProxyOption: buildProxy } = workerPrivate;

const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid startup config payload that loadStartupConfig accepts. */
function makeStartupPayload(overrides = {}) {
  return {
    email:              'test@example.com',
    password:           'secret',
    timezoneId:         'America/New_York',
    headless:           false,
    slowMo:             50,
    locale:             'en-US',
    fingerprintProfileSeed: null,
    delayProfileSeed:   null,
    strictStealth:      false,
    ...overrides
  };
}

/** Write a startup config JSON to a temp file, return the file path. */
function writeStartupJson(ws, payload) {
  const p = ws.path('startup.json');
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return p;
}

// ---------------------------------------------------------------------------
// 1. normalizeProxyConfig
// ---------------------------------------------------------------------------

describe('1 — normalizeProxyConfig: valid configs', () => {

  test('minimal valid proxy (host + port)', () => {
    const result = normalizeProxyConfig({ host: '10.0.0.1', port: 8080 });
    assert.deepEqual(result, {
      host: '10.0.0.1',
      port: 8080,
      protocol: 'http',
      username: null,
      password: null
    });
  });

  test('full proxy with credentials and protocol', () => {
    const result = normalizeProxyConfig({
      host: 'proxy.example.com', port: 3128,
      protocol: 'https',
      username: 'alice', password: 'secret'
    });
    assert.equal(result.protocol, 'https');
    assert.equal(result.username, 'alice');
    assert.equal(result.password, 'secret');
  });

  test('socks5 protocol accepted', () => {
    const result = normalizeProxyConfig({ host: '127.0.0.1', port: 1080, protocol: 'socks5' });
    assert.equal(result.protocol, 'socks5');
  });

  test('protocol defaults to http when omitted', () => {
    const result = normalizeProxyConfig({ host: 'h', port: 1 });
    assert.equal(result.protocol, 'http');
  });

  test('port 1 and port 65535 are both valid boundaries', () => {
    assert.ok(normalizeProxyConfig({ host: 'h', port: 1 }));
    assert.ok(normalizeProxyConfig({ host: 'h', port: 65535 }));
  });

});

describe('1 — normalizeProxyConfig: null / absent / empty', () => {

  test('null returns null (no proxy)', () => {
    assert.equal(normalizeProxyConfig(null), null);
  });

  test('undefined returns null', () => {
    assert.equal(normalizeProxyConfig(undefined), null);
  });

  test('false returns null', () => {
    assert.equal(normalizeProxyConfig(false), null);
  });

  test('empty object {} returns null (no-proxy intent)', () => {
    assert.equal(normalizeProxyConfig({}), null);
  });

  test('object with only null/empty string values returns null', () => {
    assert.equal(normalizeProxyConfig({ host: '', port: null }), null);
  });

});

describe('1 — normalizeProxyConfig: malformed — fails loudly', () => {

  test('host provided but port missing → throws', () => {
    assert.throws(
      () => normalizeProxyConfig({ host: '10.0.0.1' }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('port'), `expected port mention: ${err.message}`);
        return true;
      }
    );
  });

  test('port provided but host missing → throws', () => {
    assert.throws(
      () => normalizeProxyConfig({ port: 8080 }),
      (err) => {
        assert.ok(err.message.includes('host'));
        return true;
      }
    );
  });

  test('port 0 → throws (out of range)', () => {
    assert.throws(() => normalizeProxyConfig({ host: 'h', port: 0 }), Error);
  });

  test('port 65536 → throws (out of range)', () => {
    assert.throws(() => normalizeProxyConfig({ host: 'h', port: 65536 }), Error);
  });

  test('port as non-numeric string → throws', () => {
    assert.throws(() => normalizeProxyConfig({ host: 'h', port: 'abc' }), Error);
  });

  test('unknown protocol → throws', () => {
    assert.throws(
      () => normalizeProxyConfig({ host: 'h', port: 80, protocol: 'ftp' }),
      (err) => {
        assert.ok(err.message.includes('protocol'));
        return true;
      }
    );
  });

});

// ---------------------------------------------------------------------------
// 2. buildPlaywrightProxyOption
// ---------------------------------------------------------------------------

describe('2 — buildPlaywrightProxyOption', () => {

  test('returns null when proxy is null', () => {
    assert.equal(buildPlaywrightProxyOption(null), null);
  });

  test('produces correct server URL for http proxy', () => {
    const opt = buildPlaywrightProxyOption(
      normalizeProxyConfig({ host: '10.0.0.1', port: 8080 })
    );
    assert.equal(opt.server, 'http://10.0.0.1:8080');
    assert.equal(opt.username, undefined);
    assert.equal(opt.password, undefined);
  });

  test('includes credentials when present', () => {
    const opt = buildPlaywrightProxyOption(
      normalizeProxyConfig({ host: 'p', port: 3128, username: 'u', password: 'pw' })
    );
    assert.equal(opt.username, 'u');
    assert.equal(opt.password, 'pw');
  });

  test('socks5 server URL is well-formed', () => {
    const opt = buildPlaywrightProxyOption(
      normalizeProxyConfig({ host: '127.0.0.1', port: 1080, protocol: 'socks5' })
    );
    assert.equal(opt.server, 'socks5://127.0.0.1:1080');
  });

});

// ---------------------------------------------------------------------------
// 3. formatProxyForLog
// ---------------------------------------------------------------------------

describe('3 — formatProxyForLog: password redaction', () => {

  test('returns "none" for null proxy', () => {
    assert.equal(formatProxyForLog(null), 'none');
  });

  test('does NOT include password in log output', () => {
    const proxy = normalizeProxyConfig({ host: 'h', port: 80, username: 'u', password: 'topsecret' });
    const logged = formatProxyForLog(proxy);
    assert.ok(!logged.includes('topsecret'), `password leaked in log: ${logged}`);
  });

  test('includes host and port in log output', () => {
    const proxy = normalizeProxyConfig({ host: '10.0.0.1', port: 8080 });
    const logged = formatProxyForLog(proxy);
    assert.ok(logged.includes('10.0.0.1'), `host missing: ${logged}`);
    assert.ok(logged.includes('8080'),     `port missing: ${logged}`);
  });

});

// ---------------------------------------------------------------------------
// 4. Worker startup config: proxy written to JSON and read back
// ---------------------------------------------------------------------------

describe('4 — writeWorkerStartupConfig threads proxy into JSON', () => {

  test('proxy fields appear in the startup JSON file', () => {
    const ws = createTempWorkspace('proxy-write-');
    // Override the file path so we can read it before the worker deletes it
    const configPath = ws.path('startup.json');
    try {
      // Call writeWorkerStartupConfig with account that has a proxy
      // It writes to os.tmpdir() by default — we intercept by calling with
      // a modified account and then read whatever path it returns.
      const written = writeWorkerStartupConfig({
        email:      'proxy-test@example.com',
        password:   'pw',
        timezoneId: 'UTC',
        proxy: { host: '192.168.1.1', port: 3128, username: 'u', password: 'p' }
      });

      const payload = JSON.parse(fs.readFileSync(written, 'utf8'));
      assert.ok(payload.proxy,                         'proxy key present in startup JSON');
      assert.equal(payload.proxy.host, '192.168.1.1');
      assert.equal(payload.proxy.port, 3128);
      assert.equal(payload.proxy.protocol, 'http');
      assert.equal(payload.proxy.username, 'u');

      // Clean up temp file
      fs.unlinkSync(written);
    } finally {
      ws.cleanup();
    }
  });

  test('null proxy when account has no proxy configured', () => {
    const written = writeWorkerStartupConfig({
      email:      'noproxy@example.com',
      password:   'pw',
      timezoneId: 'UTC'
    });
    const payload = JSON.parse(fs.readFileSync(written, 'utf8'));
    assert.equal(payload.proxy, null, 'proxy should be null when not configured');
    fs.unlinkSync(written);
  });

  test('malformed proxy in account causes writeWorkerStartupConfig to throw', () => {
    assert.throws(
      () => writeWorkerStartupConfig({
        email:      'bad@example.com',
        password:   'pw',
        timezoneId: 'UTC',
        proxy: { host: '10.0.0.1' }   // missing port
      }),
      (err) => {
        assert.ok(err.message.includes('port'));
        return true;
      }
    );
  });

});

// ---------------------------------------------------------------------------
// 5. loadStartupConfig reads proxy back from JSON
// ---------------------------------------------------------------------------

describe('5 — loadStartupConfig parses proxy from startup JSON', () => {

  test('proxy present in startup JSON → proxy in returned config', () => {
    const ws = createTempWorkspace('proxy-load-');
    try {
      const p = writeStartupJson(ws, makeStartupPayload({
        proxy: { host: '10.1.2.3', port: 9050, protocol: 'socks5' }
      }));
      const config = loadStartupConfig(p);
      assert.ok(config.proxy,                        'proxy should be in config');
      assert.equal(config.proxy.host, '10.1.2.3');
      assert.equal(config.proxy.port, 9050);
      assert.equal(config.proxy.protocol, 'socks5');
    } finally {
      ws.cleanup();
    }
  });

  test('proxy absent in startup JSON → config.proxy is null', () => {
    const ws = createTempWorkspace('proxy-null-load-');
    try {
      const p = writeStartupJson(ws, makeStartupPayload());
      const config = loadStartupConfig(p);
      assert.equal(config.proxy, null, 'proxy should be null when not in config');
    } finally {
      ws.cleanup();
    }
  });

  test('malformed proxy in startup JSON → loadStartupConfig throws', () => {
    const ws = createTempWorkspace('proxy-bad-load-');
    try {
      const p = writeStartupJson(ws, makeStartupPayload({
        proxy: { port: 8080 }   // missing host
      }));
      assert.throws(
        () => loadStartupConfig(p),
        (err) => {
          assert.ok(err.message.includes('host'));
          return true;
        }
      );
    } finally {
      ws.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// 6. No-proxy accounts: current launch behavior preserved
// ---------------------------------------------------------------------------

describe('6 — no-proxy accounts preserve current behavior', () => {

  test('buildPlaywrightProxyOption(null) returns null — no proxy key injected', () => {
    const proxyOpt = buildPlaywrightProxyOption(null);
    assert.equal(proxyOpt, null, 'should be null for accounts without proxy');

    // Simulate spread: { ...other_opts, ...(proxyOpt ? { proxy: proxyOpt } : {}) }
    const launchOpts = {
      headless: false,
      ...(proxyOpt ? { proxy: proxyOpt } : {})
    };
    assert.ok(!Object.prototype.hasOwnProperty.call(launchOpts, 'proxy'),
      'proxy key should NOT be present in launch options for no-proxy accounts');
  });

  test('startup config with null proxy produces config.proxy === null', () => {
    const ws = createTempWorkspace('proxy-absent-');
    try {
      const p = writeStartupJson(ws, makeStartupPayload({ proxy: null }));
      const config = loadStartupConfig(p);
      assert.equal(config.proxy, null);
    } finally {
      ws.cleanup();
    }
  });

});
