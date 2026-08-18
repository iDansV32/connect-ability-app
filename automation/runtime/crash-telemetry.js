'use strict';

/**
 * automation/runtime/crash-telemetry.js
 *
 * Process-level safety net the codebase didn't have. Before this module, an
 * unhandledRejection or uncaughtException in main, scheduler, or worker just
 * terminated the process with whatever Node's default behavior happened to be
 * for the version — no record, no breadcrumb, the user sees the window
 * disappear. The recent senior review flagged this as the single highest-
 * leverage reliability gap precisely because it gates everything else: you
 * can't tell whether a future Electron upgrade *introduced* a crash class if
 * the current binary's crash classes are invisible.
 *
 * Contract:
 *   - buildCrashRecord({ kind, error, role, context, now }) — pure. Returns a
 *     plain-object record safe to JSON.stringify.
 *   - writeCrashRecord(logDir, record) — synchronous, atomic (tmp + rename),
 *     0o600 perms, one file per crash named crash-<ISO>-<pid>-<role>-<kind>.json.
 *     Returns the path written. Throws on I/O failure (caller decides).
 *   - installCrashHandlers({ role, logDir, context, logger, now, onFatal })
 *     subscribes process to 'unhandledRejection' and 'uncaughtException'. Each
 *     handler builds + writes a record, calls logger (stderr by default), and
 *     calls the optional onFatal callback. It does NOT call process.exit — Node's
 *     default behavior continues. The point is *visibility*, not changing the
 *     exit policy. Returns an uninstall() function (tests rely on it; production
 *     never calls it).
 *
 * Pure I/O is isolated; the install function delegates to the two primitives so
 * tests can exercise record shape and write atomicity independently of process
 * event semantics.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALID_KINDS = Object.freeze(['unhandledRejection', 'uncaughtException']);

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch (_) {
    return fallback;
  }
}

function extractErrorFields(error) {
  // Accept both Error instances and arbitrary thrown values (Node allows `throw 42`).
  if (error && typeof error === 'object') {
    const name = safeString(error.name, 'Error');
    const message = safeString(error.message, '<no message>');
    const stack = typeof error.stack === 'string' ? error.stack : null;
    const code = error.code !== undefined ? safeString(error.code) : null;
    let cause = null;
    if (error.cause !== undefined && error.cause !== null) {
      cause = safeString(error.cause.message || error.cause);
    }
    return { name, message, stack, code, cause };
  }
  // Non-Error throw (string, number, etc.) — preserve what we can.
  return {
    name: 'NonErrorThrow',
    message: safeString(error, '<no message>'),
    stack: null,
    code: null,
    cause: null
  };
}

/**
 * Build a JSON-serializable crash record. Pure.
 *
 * @param {object} params
 * @param {'unhandledRejection'|'uncaughtException'} params.kind
 * @param {*} params.error  — Error instance or arbitrary thrown value
 * @param {string} params.role  — 'main' | 'worker' | 'mcp' etc.
 * @param {object} [params.context]  — extra fields (accountEmail, runId, etc.)
 * @param {Date}   [params.now]
 * @returns {object}
 */
function buildCrashRecord({ kind, error, role, context, now } = {}) {
  const safeKind = VALID_KINDS.includes(kind) ? kind : 'unknown';
  const safeRole = safeString(role, 'unknown');
  const timestamp = (now instanceof Date ? now : new Date()).toISOString();
  return {
    kind: safeKind,
    role: safeRole,
    timestamp,
    pid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    error: extractErrorFields(error),
    context: context && typeof context === 'object' ? { ...context } : {}
  };
}

function buildCrashFilename(record) {
  // ISO with `:` replaced for filesystem-safety on Windows, plus pid + kind.
  const safeTs = record.timestamp.replace(/[:.]/g, '-');
  const safeKind = record.kind.replace(/[^a-z0-9_]/gi, '');
  const safeRole = record.role.replace(/[^a-z0-9_]/gi, '');
  return `crash-${safeTs}-pid${record.pid}-${safeRole}-${safeKind}.json`;
}

/**
 * Write a crash record to logDir atomically. Throws on I/O failure — callers
 * decide whether to swallow. The handler caller already wraps this in try/catch
 * because *failing to write a crash record must not itself crash the process*.
 *
 * @param {string} logDir
 * @param {object} record
 * @returns {string} absolute path written
 */
function writeCrashRecord(logDir, record) {
  if (!logDir || typeof logDir !== 'string') {
    throw new Error('writeCrashRecord: logDir required');
  }
  fs.mkdirSync(logDir, { recursive: true });
  const filename = buildCrashFilename(record);
  const finalPath = path.join(logDir, filename);
  const tmpPath = `${finalPath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  const payload = JSON.stringify(record, null, 2);
  fs.writeFileSync(tmpPath, payload, { mode: 0o600 });
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

/**
 * Install process-level crash handlers. Idempotent at the process level only
 * insofar as you can call uninstall() before re-installing; calling install
 * twice without uninstall registers two listener pairs. Returns uninstall().
 *
 * Deliberately does NOT change exit behavior. Node's default policy
 * (process exits on uncaughtException; on unhandledRejection depends on the
 * --unhandled-rejections flag and Node version) continues to apply. The role
 * of this module is to ensure that *before* whatever exit happens, a JSON
 * crash file has been written to disk.
 *
 * IMPORTANT: this is *observational*, not recovery. Do not extend the handlers
 * to swallow + continue. After an uncaughtException, in-memory state is by
 * definition in an unknown configuration — the safe move is to let Node's
 * default exit happen, and rely on the durable scheduler's lease/claim
 * mechanism to retry whatever was in flight on the next boot. Recovery
 * (e.g., dialog surfacing, controlled shutdown) belongs to the caller via
 * the onFatal hook, not inside this module.
 *
 * @param {object} opts
 * @param {string} opts.role  — 'main' | 'worker' | 'mcp' etc.
 * @param {string} opts.logDir  — absolute path; created if missing
 * @param {object} [opts.context]  — static fields merged into every record
 * @param {(line:string)=>void} [opts.logger]  — defaults to console.error
 * @param {()=>Date} [opts.now]  — clock injection for tests
 * @param {(record:object)=>void} [opts.onFatal]  — optional callback after write
 * @param {object} [opts.processRef]  — defaults to global `process`; tests pass a stub
 * @returns {() => void} uninstall
 */
function installCrashHandlers({
  role,
  logDir,
  context,
  logger,
  now,
  onFatal,
  processRef
} = {}) {
  if (!role) throw new Error('installCrashHandlers: role required');
  if (!logDir) throw new Error('installCrashHandlers: logDir required');
  const proc = processRef || process;
  const log = typeof logger === 'function' ? logger : (line) => console.error(line);
  const clock = typeof now === 'function' ? now : () => new Date();

  const handle = (kind) => (error /* , maybePromise */) => {
    let record;
    try {
      record = buildCrashRecord({ kind, error, role, context, now: clock() });
    } catch (recordErr) {
      // Building the record itself failed — extreme edge case. Bail to stderr.
      log(`[crash-telemetry] failed to build record for ${kind}: ${safeString(recordErr && recordErr.message, recordErr)}`);
      return;
    }
    let writtenPath = null;
    try {
      writtenPath = writeCrashRecord(logDir, record);
    } catch (writeErr) {
      // Writing failed (disk full, permissions, EROFS) — log to stderr and
      // continue. We deliberately do not throw; surfacing one error must not
      // mask the original crash.
      log(`[crash-telemetry] write failed: ${safeString(writeErr && writeErr.message, writeErr)}`);
    }
    log(`[crash-telemetry] ${kind} role=${role} pid=${proc.pid} err=${record.error.message}${writtenPath ? ` written=${writtenPath}` : ''}`);
    if (typeof onFatal === 'function') {
      try {
        onFatal(record);
      } catch (fatalErr) {
        log(`[crash-telemetry] onFatal threw: ${safeString(fatalErr && fatalErr.message, fatalErr)}`);
      }
    }
  };

  const onUnhandled = handle('unhandledRejection');
  const onUncaught = handle('uncaughtException');

  proc.on('unhandledRejection', onUnhandled);
  proc.on('uncaughtException', onUncaught);

  return function uninstall() {
    proc.removeListener('unhandledRejection', onUnhandled);
    proc.removeListener('uncaughtException', onUncaught);
  };
}

module.exports = {
  buildCrashRecord,
  writeCrashRecord,
  installCrashHandlers,
  VALID_KINDS
};
