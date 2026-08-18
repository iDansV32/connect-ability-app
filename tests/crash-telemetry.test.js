'use strict';

/**
 * tests/crash-telemetry.test.js
 *
 * Pins the process-level safety net contract: build a record (pure), write it
 * atomically per-crash, and install listeners that fire those without changing
 * exit behavior. The handler must survive write failures — its job is to make
 * the crash *visible*, not to mask a second failure with a third.
 *
 * All I/O happens in a tempdir. The install tests use a fake EventEmitter as
 * processRef so they never touch the real `process` listeners (which would
 * leak into the test runner).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { createTempWorkspace } = require('./test-helpers');
const {
  buildCrashRecord,
  writeCrashRecord,
  installCrashHandlers,
  VALID_KINDS
} = require('../automation/runtime/crash-telemetry');

const FIXED_NOW = new Date('2026-05-28T12:34:56.789Z');

// ---------------------------------------------------------------------------
// buildCrashRecord — purity + shape
// ---------------------------------------------------------------------------

test('buildCrashRecord: full Error → all fields populated', () => {
  const err = new TypeError('bad shape');
  err.code = 'EBADSHAPE';
  err.cause = new Error('underlying');
  const record = buildCrashRecord({
    kind: 'uncaughtException',
    error: err,
    role: 'main',
    context: { accountEmail: 'a@b.c' },
    now: FIXED_NOW
  });
  assert.equal(record.kind, 'uncaughtException');
  assert.equal(record.role, 'main');
  assert.equal(record.timestamp, '2026-05-28T12:34:56.789Z');
  assert.equal(record.pid, process.pid);
  assert.equal(record.nodeVersion, process.version);
  assert.equal(record.platform, process.platform);
  assert.equal(record.error.name, 'TypeError');
  assert.equal(record.error.message, 'bad shape');
  assert.equal(record.error.code, 'EBADSHAPE');
  assert.equal(record.error.cause, 'underlying');
  assert.ok(typeof record.error.stack === 'string' && record.error.stack.includes('bad shape'));
  assert.deepEqual(record.context, { accountEmail: 'a@b.c' });
});

test('buildCrashRecord: non-Error throws (string, number, null) still produce a record', () => {
  const r1 = buildCrashRecord({ kind: 'unhandledRejection', error: 'oops', role: 'worker' });
  assert.equal(r1.error.name, 'NonErrorThrow');
  assert.equal(r1.error.message, 'oops');
  assert.equal(r1.error.stack, null);

  const r2 = buildCrashRecord({ kind: 'unhandledRejection', error: 42, role: 'worker' });
  assert.equal(r2.error.message, '42');

  const r3 = buildCrashRecord({ kind: 'unhandledRejection', error: null, role: 'worker' });
  assert.equal(r3.error.message, '<no message>');
});

test('buildCrashRecord: invalid kind falls back to "unknown"; defaults role/context', () => {
  const r = buildCrashRecord({ kind: 'invented', error: new Error('x') });
  assert.equal(r.kind, 'unknown');
  assert.equal(r.role, 'unknown');
  assert.deepEqual(r.context, {});
});

test('buildCrashRecord: VALID_KINDS exports the two real kinds (locks the contract)', () => {
  assert.deepEqual([...VALID_KINDS].sort(), ['uncaughtException', 'unhandledRejection']);
});

// ---------------------------------------------------------------------------
// writeCrashRecord — atomic + parseable + 0o600
// ---------------------------------------------------------------------------

test('writeCrashRecord: creates parent dir, writes parseable JSON, returns final path', () => {
  const ws = createTempWorkspace('crash-telemetry-');
  try {
    const logDir = ws.path('crash-logs', 'nested');
    const record = buildCrashRecord({
      kind: 'uncaughtException',
      error: new Error('boom'),
      role: 'main',
      now: FIXED_NOW
    });
    const out = writeCrashRecord(logDir, record);
    assert.ok(out.startsWith(logDir));
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(parsed.error.message, 'boom');
    assert.equal(parsed.role, 'main');
  } finally {
    ws.cleanup();
  }
});

test('writeCrashRecord: filename encodes timestamp + pid + role + kind', () => {
  const ws = createTempWorkspace('crash-telemetry-');
  try {
    const record = buildCrashRecord({
      kind: 'unhandledRejection',
      error: new Error('x'),
      role: 'worker',
      now: FIXED_NOW
    });
    const out = writeCrashRecord(ws.root, record);
    const filename = path.basename(out);
    assert.ok(filename.startsWith('crash-'));
    assert.ok(filename.includes('worker'));
    assert.ok(filename.includes('unhandledRejection'));
    assert.ok(filename.includes(String(process.pid)));
    assert.ok(filename.endsWith('.json'));
    // No `:` in filename (Windows-safety)
    assert.ok(!filename.includes(':'));
  } finally {
    ws.cleanup();
  }
});

test('writeCrashRecord: file mode is 0o600', { skip: process.platform === 'win32' }, () => {
  const ws = createTempWorkspace('crash-telemetry-');
  try {
    const record = buildCrashRecord({ kind: 'uncaughtException', error: new Error('x'), role: 'main', now: FIXED_NOW });
    const out = writeCrashRecord(ws.root, record);
    const mode = fs.statSync(out).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    ws.cleanup();
  }
});

test('writeCrashRecord: no .tmp file left behind on success', () => {
  const ws = createTempWorkspace('crash-telemetry-');
  try {
    const record = buildCrashRecord({ kind: 'uncaughtException', error: new Error('x'), role: 'main', now: FIXED_NOW });
    writeCrashRecord(ws.root, record);
    const leftovers = fs.readdirSync(ws.root).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    ws.cleanup();
  }
});

test('writeCrashRecord: empty logDir throws (contract guard)', () => {
  assert.throws(() => writeCrashRecord('', { kind: 'uncaughtException' }), /logDir required/);
});

// ---------------------------------------------------------------------------
// installCrashHandlers — listener registration via fake processRef
// ---------------------------------------------------------------------------

test('installCrashHandlers: uncaughtException emit writes a file and calls onFatal', () => {
  const ws = createTempWorkspace('crash-telemetry-');
  const fakeProc = new EventEmitter();
  const logs = [];
  const fatals = [];
  try {
    const uninstall = installCrashHandlers({
      role: 'main',
      logDir: ws.root,
      context: { tag: 't' },
      logger: (line) => logs.push(line),
      now: () => FIXED_NOW,
      onFatal: (rec) => fatals.push(rec),
      processRef: fakeProc
    });

    fakeProc.emit('uncaughtException', new Error('synthetic'));

    const files = fs.readdirSync(ws.root).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 1, 'one crash file written');
    const parsed = JSON.parse(fs.readFileSync(path.join(ws.root, files[0]), 'utf8'));
    assert.equal(parsed.kind, 'uncaughtException');
    assert.equal(parsed.error.message, 'synthetic');
    assert.equal(parsed.context.tag, 't');
    assert.equal(fatals.length, 1, 'onFatal called once');
    assert.equal(fatals[0].error.message, 'synthetic');
    assert.ok(logs.some((l) => l.includes('uncaughtException')), 'logger surfaced a line');

    uninstall();
    fakeProc.emit('uncaughtException', new Error('after-uninstall'));
    const filesAfter = fs.readdirSync(ws.root).filter((n) => n.endsWith('.json'));
    assert.equal(filesAfter.length, 1, 'no additional file after uninstall');
  } finally {
    ws.cleanup();
  }
});

test('installCrashHandlers: unhandledRejection emit produces a record', () => {
  const ws = createTempWorkspace('crash-telemetry-');
  const fakeProc = new EventEmitter();
  try {
    const uninstall = installCrashHandlers({
      role: 'worker',
      logDir: ws.root,
      logger: () => {},
      now: () => FIXED_NOW,
      processRef: fakeProc
    });
    fakeProc.emit('unhandledRejection', new Error('async-boom'), Promise.resolve());
    const files = fs.readdirSync(ws.root).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 1);
    const parsed = JSON.parse(fs.readFileSync(path.join(ws.root, files[0]), 'utf8'));
    assert.equal(parsed.kind, 'unhandledRejection');
    assert.equal(parsed.role, 'worker');
    assert.equal(parsed.error.message, 'async-boom');
    uninstall();
  } finally {
    ws.cleanup();
  }
});

test('installCrashHandlers: write failure still triggers onFatal + logger (resilience)', () => {
  const fakeProc = new EventEmitter();
  const logs = [];
  const fatals = [];
  const uninstall = installCrashHandlers({
    role: 'main',
    // Path that points at an existing file → mkdirSync errors with ENOTDIR
    // when recursive=true encounters a file in the chain. Use a nonsense
    // path that mkdir can't create either (a null byte forces EINVAL).
    logDir: '/nonexistent\0invalid/crash-logs',
    logger: (line) => logs.push(line),
    now: () => FIXED_NOW,
    onFatal: (rec) => fatals.push(rec),
    processRef: fakeProc
  });
  fakeProc.emit('uncaughtException', new Error('still-here'));
  assert.equal(fatals.length, 1, 'onFatal called even when write fails');
  assert.equal(fatals[0].error.message, 'still-here');
  assert.ok(logs.some((l) => l.includes('write failed')), 'write failure surfaced to logger');
  assert.ok(logs.some((l) => l.includes('uncaughtException')), 'crash still logged');
  uninstall();
});

test('installCrashHandlers: onFatal throwing does not break the handler', () => {
  const ws = createTempWorkspace('crash-telemetry-');
  const fakeProc = new EventEmitter();
  const logs = [];
  try {
    const uninstall = installCrashHandlers({
      role: 'main',
      logDir: ws.root,
      logger: (line) => logs.push(line),
      now: () => FIXED_NOW,
      onFatal: () => { throw new Error('downstream-boom'); },
      processRef: fakeProc
    });
    assert.doesNotThrow(() => fakeProc.emit('uncaughtException', new Error('primary')));
    assert.ok(logs.some((l) => l.includes('onFatal threw')), 'onFatal failure surfaced');
    const files = fs.readdirSync(ws.root).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 1, 'crash file still written');
    uninstall();
  } finally {
    ws.cleanup();
  }
});

test('installCrashHandlers: missing role throws (contract guard)', () => {
  assert.throws(() => installCrashHandlers({ logDir: '/tmp/x' }), /role required/);
  assert.throws(() => installCrashHandlers({ role: 'main' }), /logDir required/);
});

test('installCrashHandlers: non-Error throw produces a record with NonErrorThrow name', () => {
  const ws = createTempWorkspace('crash-telemetry-');
  const fakeProc = new EventEmitter();
  try {
    const uninstall = installCrashHandlers({
      role: 'main',
      logDir: ws.root,
      logger: () => {},
      now: () => FIXED_NOW,
      processRef: fakeProc
    });
    fakeProc.emit('uncaughtException', 'string-throw');
    const files = fs.readdirSync(ws.root).filter((n) => n.endsWith('.json'));
    const parsed = JSON.parse(fs.readFileSync(path.join(ws.root, files[0]), 'utf8'));
    assert.equal(parsed.error.name, 'NonErrorThrow');
    assert.equal(parsed.error.message, 'string-throw');
    uninstall();
  } finally {
    ws.cleanup();
  }
});
