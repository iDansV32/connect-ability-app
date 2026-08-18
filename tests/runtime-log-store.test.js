const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const RuntimeLogStore = require('../runtime-log-store');
const {
  pruneLogFile,
  parseLineTimestampMs,
  resolveMaxAgeMs,
  DEFAULT_MAX_RUNTIME_LOG_AGE_MS
} = require('../runtime-log-store')._private;
const { createTempWorkspace } = require('./test-helpers');

function writeJsonLines(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('RuntimeLogStore appends structured logs and filters by correlation and account', () => {
  const workspace = createTempWorkspace('runtime-log-store-');
  try {
    // maxAgeMs:null isolates this test from age pruning — we're exercising
    // append/filter behavior with fixed timestamps, not retention.
    const store = new RuntimeLogStore({
      logsPath: workspace.path('runtime-logs.jsonl'),
      maxAgeMs: null
    });

    store.append({
      timestamp: '2026-03-21T12:00:00.000Z',
      type: 'info',
      message: 'Started workflow step',
      accountId: 'account-1',
      runId: 'run-1',
      correlationId: 'corr-step-1',
      rootCorrelationId: 'corr-run-1'
    });
    store.append({
      timestamp: '2026-03-21T12:05:00.000Z',
      type: 'error',
      message: 'Selector timeout',
      accountId: 'account-2',
      runId: 'run-2',
      correlationId: 'corr-step-2',
      rootCorrelationId: 'corr-run-2'
    });

    const byAccount = store.getEntries({ accountId: 'account-1' });
    const byCorrelation = store.getEntries({ correlationId: 'corr-step-2' });

    assert.equal(byAccount.length, 1);
    assert.equal(byAccount[0].message, 'Started workflow step');
    assert.equal(byCorrelation.length, 1);
    assert.equal(byCorrelation[0].accountId, 'account-2');
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Age-based pruning (pure helper)
// ---------------------------------------------------------------------------

test('pruneLogFile drops entries older than maxAgeMs and keeps newer ones', () => {
  const ws = createTempWorkspace('rl-prune-age-');
  try {
    const p = ws.path('logs.jsonl');
    // nowMs is fixed for the test; entries are 1h, 1d, 8d old.
    const nowMs = Date.parse('2026-05-26T12:00:00.000Z');
    writeJsonLines(p, [
      { id: 'old', timestamp: '2026-05-18T12:00:00.000Z', message: '8 days old' },
      { id: 'mid', timestamp: '2026-05-25T12:00:00.000Z', message: '1 day old' },
      { id: 'new', timestamp: '2026-05-26T11:00:00.000Z', message: '1 hour old' }
    ]);

    pruneLogFile(p, { maxAgeMs: 7 * 24 * 60 * 60 * 1000, nowMs });

    const kept = readJsonLines(p);
    const ids = kept.map((e) => e.id);
    assert.deepEqual(ids, ['mid', 'new'], '8-day-old entry should be pruned; mid+new kept');
  } finally {
    ws.cleanup();
  }
});

test('pruneLogFile runs age sweep even when file is under byte/count limits', () => {
  const ws = createTempWorkspace('rl-prune-age-under-size-');
  try {
    const p = ws.path('logs.jsonl');
    const nowMs = Date.parse('2026-05-26T12:00:00.000Z');
    writeJsonLines(p, [
      { id: 'old', timestamp: '2026-04-01T00:00:00.000Z', message: 'months old' }
    ]);
    // File is well under default size + count caps. Without an age sweep this
    // would not be touched. With age sweep, the entry must be dropped.
    pruneLogFile(p, { maxAgeMs: 7 * 24 * 60 * 60 * 1000, nowMs });

    const kept = readJsonLines(p);
    assert.equal(kept.length, 0, 'old entry should be pruned even though file is small');
  } finally {
    ws.cleanup();
  }
});

test('pruneLogFile preserves entries with unparseable timestamps (defensive)', () => {
  const ws = createTempWorkspace('rl-prune-age-bad-ts-');
  try {
    const p = ws.path('logs.jsonl');
    const nowMs = Date.parse('2026-05-26T12:00:00.000Z');
    // Mix: one parseable old, one missing ts, one parseable-but-corrupt ts, one new.
    writeJsonLines(p, [
      { id: 'old', timestamp: '2026-04-01T00:00:00.000Z', message: 'old, dropped' },
      { id: 'no-ts', message: 'no timestamp field at all' },
      { id: 'bad-ts', timestamp: 'not-a-date', message: 'unparseable' },
      { id: 'new', timestamp: '2026-05-26T11:00:00.000Z', message: 'new' }
    ]);

    pruneLogFile(p, { maxAgeMs: 7 * 24 * 60 * 60 * 1000, nowMs });

    const ids = readJsonLines(p).map((e) => e.id);
    assert.deepEqual(ids, ['no-ts', 'bad-ts', 'new'],
      'unparseable-timestamp entries kept; only the cleanly-old one dropped');
  } finally {
    ws.cleanup();
  }
});

test('pruneLogFile is idempotent: no rewrite when nothing changes', () => {
  const ws = createTempWorkspace('rl-prune-idempotent-');
  try {
    const p = ws.path('logs.jsonl');
    const nowMs = Date.parse('2026-05-26T12:00:00.000Z');
    writeJsonLines(p, [
      { id: 'fresh', timestamp: '2026-05-26T11:00:00.000Z', message: 'fresh' }
    ]);
    const mtimeBefore = fs.statSync(p).mtimeMs;
    // Sleep is too slow; instead just check that the byte content is unchanged.
    const contentBefore = fs.readFileSync(p, 'utf8');

    pruneLogFile(p, { maxAgeMs: 7 * 24 * 60 * 60 * 1000, nowMs });

    const contentAfter = fs.readFileSync(p, 'utf8');
    assert.equal(contentAfter, contentBefore, 'file content should be byte-identical when no prune is needed');
  } finally {
    ws.cleanup();
  }
});

test('pruneLogFile applies age AND byte/count caps together (newest survives both)', () => {
  const ws = createTempWorkspace('rl-prune-combined-');
  try {
    const p = ws.path('logs.jsonl');
    const nowMs = Date.parse('2026-05-26T12:00:00.000Z');
    // pruneLogFile clamps maxBytes to at least 1024 (safety floor). To force
    // the byte cap to actually trim, write entries large enough that 5 of
    // them exceed 1024 bytes. ~400-char padded message gives ~450-byte lines.
    const pad = 'x'.repeat(380);
    writeJsonLines(p, [
      { id: 'e1', timestamp: '2026-05-26T11:00:00.000Z', message: 'a' + pad },
      { id: 'e2', timestamp: '2026-05-26T11:10:00.000Z', message: 'b' + pad },
      { id: 'e3', timestamp: '2026-05-26T11:20:00.000Z', message: 'c' + pad },
      { id: 'e4', timestamp: '2026-05-26T11:30:00.000Z', message: 'd' + pad },
      { id: 'e5', timestamp: '2026-05-26T11:40:00.000Z', message: 'e' + pad }
    ]);

    pruneLogFile(p, {
      maxBytes: 1024,                    // clamped to 1024; ~2 lines fit
      maxEntries: 50,
      maxAgeMs: 24 * 60 * 60 * 1000,     // 1 day; all entries pass age check
      nowMs
    });

    const ids = readJsonLines(p).map((e) => e.id);
    // Newest entries should survive — byte trim works from the tail forward.
    assert.ok(ids.includes('e5'), 'newest entry must survive');
    assert.ok(ids.length < 5, 'at least one entry should be trimmed by byte cap');
  } finally {
    ws.cleanup();
  }
});

test('pruneLogFile with maxAgeMs=null does not run age sweep (legacy callers)', () => {
  const ws = createTempWorkspace('rl-prune-no-age-');
  try {
    const p = ws.path('logs.jsonl');
    const nowMs = Date.parse('2026-05-26T12:00:00.000Z');
    writeJsonLines(p, [
      { id: 'ancient', timestamp: '2020-01-01T00:00:00.000Z', message: 'very old' }
    ]);

    // No maxAgeMs option → no age sweep, file under byte cap → no scan at all.
    pruneLogFile(p, { maxBytes: 8 * 1024 * 1024, maxEntries: 10000, nowMs });

    const ids = readJsonLines(p).map((e) => e.id);
    assert.deepEqual(ids, ['ancient'], 'ancient entry should remain when age sweep is not requested');
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Helper-level unit tests
// ---------------------------------------------------------------------------

test('parseLineTimestampMs returns ms epoch for valid lines, null for invalid', () => {
  assert.equal(parseLineTimestampMs('{"timestamp":"2026-05-26T12:00:00.000Z"}'),
    Date.parse('2026-05-26T12:00:00.000Z'));
  assert.equal(parseLineTimestampMs('{"timestamp":"not-a-date"}'), null);
  assert.equal(parseLineTimestampMs('{"no":"timestamp"}'), null);
  assert.equal(parseLineTimestampMs('this is not JSON'), null);
  assert.equal(parseLineTimestampMs(''), null);
});

test('resolveMaxAgeMs treats null/0/negative/non-finite as no-age-cap', () => {
  assert.equal(resolveMaxAgeMs(null, 999), null);
  assert.equal(resolveMaxAgeMs(0, 999), null);
  assert.equal(resolveMaxAgeMs(-1, 999), null);
  assert.equal(resolveMaxAgeMs(NaN, 999), null);
  assert.equal(resolveMaxAgeMs(Infinity, 999), null);
  // undefined → fallback (constructor-default behavior)
  assert.equal(resolveMaxAgeMs(undefined, 999), 999);
  // Valid number passes through.
  assert.equal(resolveMaxAgeMs(60000, 999), 60000);
});

test('DEFAULT_MAX_RUNTIME_LOG_AGE_MS is 7 days (matches docs/telemetry-retention.md)', () => {
  assert.equal(DEFAULT_MAX_RUNTIME_LOG_AGE_MS, 7 * 24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Throttle (RuntimeLogStore.append) — verifies the age sweep doesn't fire on
// every append. Byte/count caps continue to fire as before.
// ---------------------------------------------------------------------------

test('RuntimeLogStore throttles age sweep but always honors byte/count caps', () => {
  const ws = createTempWorkspace('rl-throttle-');
  try {
    const store = new RuntimeLogStore({
      logsPath: ws.path('logs.jsonl'),
      maxBytes: 1024,
      maxEntries: 100,
      // Very long throttle: first append age-sweeps; subsequent appends do not.
      minAgePruneIntervalMs: 60 * 60 * 1000,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000
    });

    // First append: lastAgePruneAt starts at 0, so the age sweep runs and
    // stamps lastAgePruneAt to Date.now(). The throttle was set to 1h, so the
    // next append within the test window must NOT trigger another age sweep.
    store.append({ timestamp: '2026-05-26T11:00:00.000Z', message: 'first' });
    const firstStamp = store._lastAgePruneAt;
    assert.ok(firstStamp > 0, 'first append should stamp _lastAgePruneAt');

    // Second append shortly after — throttle blocks the age sweep.
    store.append({ timestamp: '2026-05-26T11:00:01.000Z', message: 'second' });
    assert.equal(store._lastAgePruneAt, firstStamp,
      'second append within throttle window must not re-stamp');
  } finally {
    ws.cleanup();
  }
});

test('RuntimeLogStore constructor accepts maxAgeMs=null (disables age pruning)', () => {
  const ws = createTempWorkspace('rl-no-age-');
  try {
    const store = new RuntimeLogStore({
      logsPath: ws.path('logs.jsonl'),
      maxAgeMs: null
    });
    assert.equal(store.maxAgeMs, null);

    // Pre-seed with an ancient entry and confirm append doesn't drop it.
    writeJsonLines(ws.path('logs.jsonl'), [
      { id: 'ancient', timestamp: '2020-01-01T00:00:00.000Z', message: 'very old' }
    ]);
    store.append({ message: 'fresh' });
    const ids = readJsonLines(ws.path('logs.jsonl')).map((e) => e.id);
    assert.ok(ids.includes('ancient'), 'ancient entry preserved when age cap disabled');
  } finally {
    ws.cleanup();
  }
});

test('RuntimeLogStore supports correlationAnyId matching and prunes oversized logs', () => {
  const workspace = createTempWorkspace('runtime-log-store-prune-');
  try {
    // maxAgeMs:null — this test exercises byte-cap pruning with fixed
    // timestamps; age pruning would mask the byte-cap behavior we're checking.
    const store = new RuntimeLogStore({
      logsPath: workspace.path('runtime-logs.jsonl'),
      maxBytes: 350,
      maxEntries: 50,
      maxAgeMs: null
    });

    store.append({
      timestamp: '2026-03-21T12:00:00.000Z',
      type: 'info',
      message: 'Root workflow log entry that should be pruned first',
      accountId: 'account-1',
      correlationId: 'corr-run-1',
      rootCorrelationId: 'corr-run-1'
    });
    store.append({
      timestamp: '2026-03-21T12:01:00.000Z',
      type: 'info',
      message: 'Child job log entry that should still match root correlation',
      accountId: 'account-1',
      correlationId: 'corr-job-1',
      rootCorrelationId: 'corr-run-1'
    });
    store.append({
      timestamp: '2026-03-21T12:02:00.000Z',
      type: 'error',
      message: 'Newest log entry kept after prune',
      accountId: 'account-1',
      correlationId: 'corr-job-2',
      rootCorrelationId: 'corr-run-1'
    });

    const anyCorrelation = store.getEntries({ correlationAnyId: 'corr-run-1', limit: 10 });
    const exactRoot = store.getEntries({ correlationId: 'corr-run-1', limit: 10 });
    const allEntries = store.getEntries({ limit: 10 });

    assert.equal(anyCorrelation.length >= 2, true);
    assert.equal(anyCorrelation.every((entry) => entry.rootCorrelationId === 'corr-run-1' || entry.correlationId === 'corr-run-1'), true);
    assert.equal(exactRoot.every((entry) => entry.correlationId === 'corr-run-1'), true);
    assert.equal(allEntries.length < 3, true);
    assert.equal(allEntries.some((entry) => entry.message.includes('should be pruned first')), false);
  } finally {
    workspace.cleanup();
  }
});
