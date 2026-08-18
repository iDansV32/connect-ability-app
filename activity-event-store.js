const crypto = require('crypto');
const fs = require('fs');
const {
  appendJsonLine,
  createId,
  ensureParentDirectory,
  getConnectAbilityAppStateDir,
  resolveInternalStatePath
} = require('./connect-documents');
const SqliteActivityEventRepository = require('./storage/sqlite-activity-event-repository');

const ALLOWED_EVENT_TYPES = new Set([
  'profile_viewed',
  'post_liked',
  'connection_requested',
  'connection_accepted',
  'dm_sent',
  'dm_reply_received',
  'profile_followed',
  'profile_unfollowed',
  'skill_endorsed',
  'post_commented',
  'post_published',
  'post_liked_by_others',
  'profile_view_metric_updated',
  'workflow_started',
  'workflow_step_completed',
  'workflow_step_failed',
  'workflow_completed',
  'workflow_failed',
  'telemetry_prune_completed',
  'telemetry_prune_failed',
  'legacy_direct_login_used',
  // Session lifecycle family. Emitted by account-worker-process and every
  // remaining direct-login entry point. Each worker lifetime shares a single
  // correlationId that flows through worker_spawn → login_attempt →
  // session_verified (or auth_failure / challenge_detected / challenge_recovery)
  // → worker_exit, so the telemetry can reconstruct the full chain offline.
  'worker_spawn',
  'worker_exit',
  'login_attempt',
  'session_verified',
  'auth_failure',
  'challenge_detected',
  'challenge_recovery'
]);

const SESSION_LIFECYCLE_EVENT_TYPES = new Set([
  'worker_spawn',
  'worker_exit',
  'login_attempt',
  'session_verified',
  'auth_failure',
  'challenge_detected',
  'challenge_recovery'
]);

const RETAINED_RAW_EVENT_RETENTION_DAYS = 180;
const RETAINED_RAW_EVENT_RETENTION_MS = RETAINED_RAW_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const RETAINED_RAW_EVENT_PREFIXES = Object.freeze(['scrutiny_']);

class ActivityEventStore {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.eventsPath = options.eventsPath || resolveInternalStatePath('activity-events.jsonl');
    this._repo = options.db ? new SqliteActivityEventRepository(options.db) : null;

    if (options.enableRetentionPrune === true) {
      try {
        const result = this.pruneRetainedRawEvents();
        this.append(buildTelemetryPruneEvent('telemetry_prune_completed', 'activity_events', result, {
          backend: this._repo ? 'sqlite' : 'jsonl'
        }));
      } catch (error) {
        try {
          this.append(buildTelemetryPruneEvent('telemetry_prune_failed', 'activity_events', null, {
            backend: this._repo ? 'sqlite' : 'jsonl',
            error: error.message || String(error)
          }));
        } catch (_) {
          // Best effort: if event emission fails, preserve the original warning path.
        }
        console.warn(`Failed to prune retained activity events: ${error.message}`);
      }
    }
  }

  append(eventInput = {}) {
    const event = normalizeEvent(eventInput);
    if (this._repo) {
      this._repo.append(event);
    } else {
      appendJsonLine(this.eventsPath, event);
    }
    return event;
  }

  pruneRetainedRawEvents(options = {}) {
    const cutoffMs = resolveCutoffMs(options.nowMs);
    const cutoffIso = new Date(cutoffMs).toISOString();
    if (this._repo) {
      return this._repo.pruneRetainedRawEvents({
        cutoffIso,
        retainedTypes: [...SESSION_LIFECYCLE_EVENT_TYPES],
        retainedPrefixes: [...RETAINED_RAW_EVENT_PREFIXES]
      });
    }

    return pruneRetainedRawEventsJsonl(this.eventsPath, {
      cutoffMs
    });
  }
}

function normalizeEvent(eventInput = {}) {
  const type = String(eventInput.type || '').trim();
  if (!ALLOWED_EVENT_TYPES.has(type)) {
    throw new Error(`Unsupported activity event type: ${type || 'unknown'}`);
  }

  return {
    id: cleanString(eventInput.id, 160) || createId('evt'),
    type,
    timestamp: cleanString(eventInput.timestamp, 80) || new Date().toISOString(),
    accountId: cleanString(eventInput.accountId, 120) || null,
    accountName: cleanString(eventInput.accountName, 160) || null,
    agentId: cleanString(eventInput.agentId, 120) || null,
    agentName: cleanString(eventInput.agentName, 160) || null,
    workflowId: cleanString(eventInput.workflowId, 160) || null,
    workflowName: cleanString(eventInput.workflowName, 160) || null,
    runId: cleanString(eventInput.runId, 160) || null,
    correlationId: cleanString(eventInput.correlationId || eventInput.metadata?.correlationId, 160) || null,
    rootCorrelationId:
      cleanString(eventInput.rootCorrelationId || eventInput.metadata?.rootCorrelationId, 160)
      || cleanString(eventInput.correlationId || eventInput.metadata?.correlationId, 160)
      || null,
    targetId: cleanString(eventInput.targetId, 160) || null,
    prospectId: cleanString(eventInput.prospectId, 160) || null,
    targetValue: cleanString(eventInput.targetValue, 400) || null,
    profileUrl: cleanString(eventInput.profileUrl, 400) || null,
    postId: cleanString(eventInput.postId, 160) || null,
    status: cleanString(eventInput.status, 40) || 'ok',
    metadata: normalizeMetadata(eventInput.metadata)
  };
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function resolveCutoffMs(nowMs) {
  const baseNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return baseNow - RETAINED_RAW_EVENT_RETENTION_MS;
}

function shouldPruneRetainedRawEvent(type) {
  const normalizedType = String(type || '').trim();
  return SESSION_LIFECYCLE_EVENT_TYPES.has(normalizedType)
    || RETAINED_RAW_EVENT_PREFIXES.some((prefix) => normalizedType.startsWith(prefix));
}

function pruneRetainedRawEventsJsonl(eventsPath, options = {}) {
  if (!eventsPath || !fs.existsSync(eventsPath)) {
    return {
      pruned: false,
      keptCount: 0,
      removedCount: 0,
      invalidCount: 0
    };
  }

  const raw = fs.readFileSync(eventsPath, 'utf8');
  if (!raw.trim()) {
    return {
      pruned: false,
      keptCount: 0,
      removedCount: 0,
      invalidCount: 0
    };
  }

  const cutoffMs = Number.isFinite(Number(options.cutoffMs))
    ? Number(options.cutoffMs)
    : resolveCutoffMs(options.nowMs);

  let removedCount = 0;
  let invalidCount = 0;
  const keptEntries = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      invalidCount += 1;
      continue;
    }

    if (!shouldPruneRetainedRawEvent(parsed.type)) {
      keptEntries.push(parsed);
      continue;
    }

    const timestampMs = Date.parse(String(parsed.timestamp || ''));
    if (!Number.isFinite(timestampMs) || timestampMs >= cutoffMs) {
      keptEntries.push(parsed);
      continue;
    }

    removedCount += 1;
  }

  if (removedCount === 0 && invalidCount === 0) {
    return {
      pruned: false,
      keptCount: keptEntries.length,
      removedCount,
      invalidCount
    };
  }

  ensureParentDirectory(eventsPath);
  const tempPath = createTempPath(eventsPath);
  const payload = keptEntries.map((entry) => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(tempPath, payload ? `${payload}\n` : '', { mode: 0o600 });
  fs.renameSync(tempPath, eventsPath);

  return {
    pruned: true,
    keptCount: keptEntries.length,
    removedCount,
    invalidCount
  };
}

function createTempPath(filePath) {
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return `${filePath}.${suffix}.tmp`;
}

function buildTelemetryPruneEvent(type, target, result, metadata = {}) {
  const invalidCount = Number(result?.invalidCount || 0);
  return {
    type,
    status: type === 'telemetry_prune_failed'
      ? 'failed'
      : (invalidCount > 0 ? 'warning' : 'ok'),
    targetValue: target,
    metadata: {
      target,
      pruned: Boolean(result?.pruned),
      keptCount: Number(result?.keptCount || 0),
      removedCount: Number(result?.removedCount || 0),
      invalidCount,
      bytesFreed: Number(result?.bytesFreed || 0),
      ...metadata
    }
  };
}

module.exports = ActivityEventStore;
module.exports.ALLOWED_EVENT_TYPES = ALLOWED_EVENT_TYPES;
module.exports.SESSION_LIFECYCLE_EVENT_TYPES = SESSION_LIFECYCLE_EVENT_TYPES;
module.exports.RETAINED_RAW_EVENT_RETENTION_DAYS = RETAINED_RAW_EVENT_RETENTION_DAYS;
