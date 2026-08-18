const fs = require('fs');
const {
  appendJsonLine,
  createId,
  getConnectAbilityAppStateDir,
  resolveInternalStatePath
} = require('./connect-documents');

const DEFAULT_MAX_RUNTIME_LOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RUNTIME_LOG_ENTRIES = 10000;
// 7 days. Matches the runtime-logs row in docs/telemetry-retention.md. The
// previous 4-hour proposal was too aggressive for overnight-failure debugging.
const DEFAULT_MAX_RUNTIME_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Age pruning scans the full file, which is too expensive to do on every
// append. The byte/count caps stay on the fast on-append path; the age sweep
// runs at most once per this interval per store instance.
const DEFAULT_AGE_PRUNE_THROTTLE_MS = 10 * 60 * 1000;

class RuntimeLogStore {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.logsPath = options.logsPath || resolveInternalStatePath('runtime-logs.jsonl');
    this.maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULT_MAX_RUNTIME_LOG_BYTES);
    this.maxEntries = Math.max(100, Number(options.maxEntries) || DEFAULT_MAX_RUNTIME_LOG_ENTRIES);
    this.maxAgeMs = resolveMaxAgeMs(options.maxAgeMs, DEFAULT_MAX_RUNTIME_LOG_AGE_MS);
    this.minAgePruneIntervalMs = Math.max(0,
      Number.isFinite(Number(options.minAgePruneIntervalMs))
        ? Number(options.minAgePruneIntervalMs)
        : DEFAULT_AGE_PRUNE_THROTTLE_MS
    );
    // Per-instance throttle state — module-scoped would leak across tests.
    this._lastAgePruneAt = 0;
  }

  append(entryInput = {}) {
    const entry = normalizeLogEntry(entryInput);
    appendJsonLine(this.logsPath, entry);

    const nowMs = Date.now();
    // Decide whether this append should also do an age sweep. The byte/count
    // caps always fire; the age sweep is throttled because it reads the full
    // file.
    //
    // Note: _lastAgePruneAt is stamped BEFORE pruneLogFile runs. If the prune
    // I/O throws, the next age sweep is still throttled for the full interval.
    // That's acceptable here — pruneLogFile catches its own I/O errors and
    // logs them via console.warn, so a transient failure surfaces in logs
    // without causing a busy retry loop. Move the stamp inside pruneLogFile's
    // success path if stricter retry behavior is ever needed.
    const shouldRunAgeSweep = this.maxAgeMs !== null
      && (nowMs - this._lastAgePruneAt) >= this.minAgePruneIntervalMs;
    if (shouldRunAgeSweep) {
      this._lastAgePruneAt = nowMs;
    }

    pruneLogFile(this.logsPath, {
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
      maxAgeMs: shouldRunAgeSweep ? this.maxAgeMs : null,
      nowMs
    });
    return entry;
  }

  getEntries(filters = {}) {
    const normalizedFilters = normalizeFilters(filters);
    return readJsonLines(this.logsPath)
      .map((entry) => normalizeLogEntry(entry))
      .filter((entry) => matchesFilters(entry, normalizedFilters))
      .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
      .slice(0, normalizedFilters.limit);
  }
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    console.warn(`Failed to read runtime logs from ${filePath}: ${error.message}`);
    return [];
  }
}

function normalizeLogEntry(entryInput = {}) {
  return {
    id: cleanString(entryInput.id, 160) || createId('log'),
    timestamp: cleanString(entryInput.timestamp, 80) || new Date().toISOString(),
    type: cleanString(entryInput.type, 40) || 'info',
    source: cleanString(entryInput.source, 60) || 'main',
    message: cleanString(entryInput.message, 1200) || 'Runtime log entry',
    accountId: cleanString(entryInput.accountId, 120) || null,
    accountName: cleanString(entryInput.accountName, 160) || null,
    workflowId: cleanString(entryInput.workflowId, 160) || null,
    workflowName: cleanString(entryInput.workflowName, 160) || null,
    runId: cleanString(entryInput.runId, 160) || null,
    targetId: cleanString(entryInput.targetId, 160) || null,
    prospectId: cleanString(entryInput.prospectId, 160) || null,
    stepIndex: Number.isFinite(Number(entryInput.stepIndex)) ? Number(entryInput.stepIndex) : null,
    stepType: cleanString(entryInput.stepType, 80) || null,
    correlationId: cleanString(entryInput.correlationId, 160) || null,
    rootCorrelationId: cleanString(entryInput.rootCorrelationId, 160) || null,
    metadata: normalizeMetadata(entryInput.metadata)
  };
}

function normalizeFilters(filters = {}) {
  return {
    limit: Math.max(1, Number(filters.limit) || 500),
    accountId: cleanString(filters.accountId, 120) || null,
    workflowId: cleanString(filters.workflowId, 160) || null,
    runId: cleanString(filters.runId, 160) || null,
    correlationAnyId: cleanString(filters.correlationAnyId, 160) || null,
    correlationId: cleanString(filters.correlationId, 160) || null,
    rootCorrelationId: cleanString(filters.rootCorrelationId, 160) || null
  };
}

function matchesFilters(entry, filters) {
  if (filters.accountId && entry.accountId !== filters.accountId) return false;
  if (filters.workflowId && entry.workflowId !== filters.workflowId) return false;
  if (filters.runId && entry.runId !== filters.runId) return false;
  if (
    filters.correlationAnyId
    && entry.correlationId !== filters.correlationAnyId
    && entry.rootCorrelationId !== filters.correlationAnyId
  ) return false;
  if (filters.correlationId && entry.correlationId !== filters.correlationId) return false;
  if (filters.rootCorrelationId && entry.rootCorrelationId !== filters.rootCorrelationId) return false;
  return true;
}

function pruneLogFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULT_MAX_RUNTIME_LOG_BYTES);
  const maxEntries = Math.max(100, Number(options.maxEntries) || DEFAULT_MAX_RUNTIME_LOG_ENTRIES);
  const maxAgeMs = resolveMaxAgeMs(options.maxAgeMs, null);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();

  // Decide whether the file even needs to be read.
  //   - Size over cap → must scan.
  //   - Age cap requested → must scan (we cannot tell from stat alone whether
  //     the oldest entry is past the cutoff).
  // No reason to scan if both conditions are false.
  let needsScan = false;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) needsScan = true;
    if (maxAgeMs !== null) needsScan = true;
  } catch (error) {
    console.warn(`Failed to stat runtime logs at ${filePath}: ${error.message}`);
    return;
  }
  if (!needsScan) return;

  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.warn(`Failed to prune runtime logs from ${filePath}: ${error.message}`);
    return;
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return;
  }

  // Age filter first. Drop lines whose timestamp is past the cutoff. Lines
  // with unparseable timestamps are KEPT — better to leak a corrupted line
  // for a debugger to find than to silently delete the entry that might
  // explain the corruption.
  let candidates = lines;
  if (maxAgeMs !== null) {
    const cutoffMs = nowMs - maxAgeMs;
    candidates = lines.filter((line) => {
      const ts = parseLineTimestampMs(line);
      if (ts === null) return true;
      return ts >= cutoffMs;
    });
  }

  // Then byte/count caps from the tail (newest first).
  const retained = [];
  let retainedBytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const line = candidates[index];
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (retained.length >= maxEntries) break;
    if (retained.length > 0 && retainedBytes + lineBytes > maxBytes) break;
    retained.unshift(line);
    retainedBytes += lineBytes;
  }

  // Idempotent: skip the rewrite if nothing changed. Important because the
  // age sweep runs on every throttled tick even when the file is fine.
  if (retained.length === lines.length) return;

  const payload = retained.length ? `${retained.join('\n')}\n` : '';
  try {
    fs.writeFileSync(filePath, payload, { mode: 0o600 });
  } catch (error) {
    console.warn(`Failed to rewrite pruned runtime logs to ${filePath}: ${error.message}`);
  }
}

// Returns ms epoch from a JSONL line, or null when the line is not parseable
// or the timestamp field is missing/invalid. Used by age-based pruning.
function parseLineTimestampMs(line) {
  try {
    const entry = JSON.parse(line);
    const tsStr = entry && entry.timestamp;
    if (!tsStr) return null;
    const ts = new Date(tsStr).getTime();
    return Number.isFinite(ts) ? ts : null;
  } catch (_error) {
    return null;
  }
}

// Normalize maxAgeMs across constructor option, prune-fn option, and the
// default. Allows `null` / `0` / negative / non-finite to mean "no age cap".
function resolveMaxAgeMs(value, fallback) {
  if (value === null) return null;
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = RuntimeLogStore;
// Internal-but-testable surface. `pruneLogFile` is the pure helper that
// drives both byte/count and age pruning; tests exercise it directly so the
// throttle in `RuntimeLogStore.append` doesn't get in the way of behavior
// assertions.
module.exports._private = {
  pruneLogFile,
  parseLineTimestampMs,
  resolveMaxAgeMs,
  DEFAULT_MAX_RUNTIME_LOG_AGE_MS,
  DEFAULT_AGE_PRUNE_THROTTLE_MS
};
