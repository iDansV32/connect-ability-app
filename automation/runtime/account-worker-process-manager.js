const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { fork } = require('child_process');

const { ACCOUNT_WORKER_MESSAGE_TYPES } = require('./account-worker-protocol');
const { normalizeProxyConfig } = require('./proxy-config');
const { normalizeDelayProfileSeed } = require('../safety/account-delay-profile');
const {
  normalizeFingerprintProfileSeed,
  normalizeViewportOverride
} = require('../safety/account-fingerprint-profile');
const { SESSION_LIFECYCLE_EVENT_TYPES } = require('../../activity-event-store');
const { writeJsonFileAtomic } = require('../../connect-documents');
const { EXTERNAL_API_LAUNCH_SOURCE } = require('../../external-api-safety');

const DEFAULT_READY_TIMEOUT_MS = 90000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;

class SpawnedAccountWorkerProcess extends EventEmitter {
  constructor(options = {}) {
    super();

    this.account = { ...(options.account || {}) };
    this.accountEmail = normalizeAccountEmail(options.account);
    this.workerScriptPath = options.workerScriptPath || path.join(__dirname, 'account-worker-process.js');
    this.readyTimeoutMs = normalizePositiveInteger(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
    this.shutdownTimeoutMs = normalizePositiveInteger(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this.spawnProcess = typeof options.spawnProcess === 'function' ? options.spawnProcess : defaultSpawnProcess;
    this.startupConfigPath = options.startupConfigPath || writeWorkerStartupConfig(this.account);
    this.process = this.spawnProcess(this.workerScriptPath, [this.startupConfigPath], options.spawnOptions || {});
    this.ready = false;
    this.closed = false;

    this.process.on('message', (message) => {
      if (message?.type === ACCOUNT_WORKER_MESSAGE_TYPES.WORKER_READY) {
        this.ready = true;
      }
      this.emit('message', message);
    });

    this.process.on('error', (error) => {
      this.emit('error', error);
    });

    this.process.on('exit', (code, signal) => {
      this.closed = true;
      this.emit('exit', code, signal);
    });

    this.process.on('close', (code, signal) => {
      this.closed = true;
      cleanupStartupConfigFile(this.startupConfigPath);
      this.startupConfigPath = null;
      this.emit('close', code, signal);
    });

    this.process.on('spawn', () => {
      this.cleanupStartupConfig();
    });

    this.readyPromise = createReadyPromise(this);
  }

  whenReady() {
    return this.readyPromise;
  }

  async send(message) {
    await this.whenReady();
    if (this.closed || typeof this.process.send !== 'function' || this.process.connected === false) {
      throw new Error(`Account worker for ${this.accountEmail} is not available`);
    }

    this.process.send(message);
  }

  async shutdown(options = {}) {
    if (this.closed) {
      return;
    }

    const timeoutMs = normalizePositiveInteger(options.timeoutMs, this.shutdownTimeoutMs);
    const closePromise = waitForClose(this.process, timeoutMs);

    if (typeof this.process.send === 'function' && this.process.connected !== false) {
      try {
        this.process.send({ type: ACCOUNT_WORKER_MESSAGE_TYPES.SHUTDOWN });
      } catch (_error) {
        // Fall back to kill below.
      }
    }

    try {
      await closePromise;
      return;
    } catch (_error) {
      if (!this.closed && typeof this.process.kill === 'function') {
        this.process.kill('SIGTERM');
      }
    }

    try {
      await waitForClose(this.process, timeoutMs);
      return;
    } catch (_error) {
      if (!this.closed && typeof this.process.kill === 'function') {
        this.process.kill('SIGKILL');
      }
    }

    await waitForClose(this.process, timeoutMs).catch(() => {});
  }

  cleanupStartupConfig() {
    if (!this.startupConfigPath) {
      return;
    }
    if (fs.existsSync(this.startupConfigPath)) {
      return;
    }
    this.startupConfigPath = null;
  }
}

class AccountWorkerProcessManager {
  constructor(options = {}) {
    this.workerScriptPath = options.workerScriptPath || path.join(__dirname, 'account-worker-process.js');
    this.readyTimeoutMs = normalizePositiveInteger(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
    this.shutdownTimeoutMs = normalizePositiveInteger(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this.spawnProcess = typeof options.spawnProcess === 'function' ? options.spawnProcess : defaultSpawnProcess;
    this.onChallengeDetected = typeof options.onChallengeDetected === 'function'
      ? options.onChallengeDetected
      : null;
    this.recordActivityEvent = typeof options.recordActivityEvent === 'function'
      ? options.recordActivityEvent
      : null;
    this.workerFactory = typeof options.workerFactory === 'function'
      ? options.workerFactory
      : (account, factoryOptions = {}) => new SpawnedAccountWorkerProcess({
        account,
        workerScriptPath: factoryOptions.workerScriptPath || this.workerScriptPath,
        readyTimeoutMs: factoryOptions.readyTimeoutMs || this.readyTimeoutMs,
        shutdownTimeoutMs: factoryOptions.shutdownTimeoutMs || this.shutdownTimeoutMs,
        spawnProcess: factoryOptions.spawnProcess || this.spawnProcess
      });
    this.workers = new Map();
  }

  get size() {
    return this.workers.size;
  }

  getOrCreate(account = {}) {
    const accountEmail = normalizeAccountEmail(account);
    const existing = this.workers.get(accountEmail);
    if (existing) {
      // External-API safety, fail closed at the reuse seam. An external_api
      // launch must run visible. A long-lived worker keeps the headless mode it
      // was first launched with, so reusing a worker that was originally spawned
      // headless (by a native/internal flow) would silently run an external-API
      // action in a headless browser — violating the invariant. Refuse to reuse
      // such a worker. The existing worker is left untouched (its native work
      // keeps running); the external-API caller gets a clear, fail-closed error.
      if (
        account.launchSource === EXTERNAL_API_LAUNCH_SOURCE
        && existing.account
        && existing.account.headless !== false
      ) {
        const message = `[external-api-safety] Refusing to reuse headless worker for ${accountEmail} `
          + `(existing worker headless=${JSON.stringify(existing.account.headless)}). External-API `
          + 'browser actions must run visible; cannot reuse an account worker already running headless.';
        console.error(message);
        throw new Error(message);
      }
      return existing;
    }

    const workerLifetimeCorrelationId = createWorkerLifetimeCorrelationId();
    const workerLifetimeStartedAt = Date.now();
    const workerAccount = {
      ...(account || {}),
      workerLifetimeCorrelationId,
      workerLifetimeStartedAt
    };

    const worker = this.workerFactory(workerAccount, {
      workerScriptPath: this.workerScriptPath,
      readyTimeoutMs: this.readyTimeoutMs,
      shutdownTimeoutMs: this.shutdownTimeoutMs,
      spawnProcess: this.spawnProcess
    });

    if (!worker) {
      throw new Error(`Failed to create account worker for ${accountEmail}`);
    }

    worker.account = { ...(worker.account || {}), ...workerAccount };
    worker.accountEmail = worker.accountEmail || accountEmail;
    worker.workerLifetimeCorrelationId = worker.workerLifetimeCorrelationId || workerLifetimeCorrelationId;
    worker.workerLifetimeStartedAt = Number.isFinite(worker.workerLifetimeStartedAt)
      ? worker.workerLifetimeStartedAt
      : workerLifetimeStartedAt;
    this.workers.set(accountEmail, worker);
    this.attachLifecycle(accountEmail, worker);
    return worker;
  }

  async dispatch(account, message) {
    const worker = this.getOrCreate(account);
    if (typeof worker.send !== 'function') {
      throw new Error(`Account worker for ${worker.accountEmail} cannot accept IPC messages`);
    }
    await worker.send(message);
    return worker;
  }

  async dispatchAndAwaitMessage(account, message, options = {}) {
    const worker = await this.dispatch(account, message);
    const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_STEP_TIMEOUT_MS);
    const expectedType = typeof options.type === 'string' ? options.type.trim() : '';
    const timeoutLabel = typeof options.timeoutLabel === 'string' && options.timeoutLabel.trim()
      ? options.timeoutLabel.trim()
      : `${expectedType || 'expected'} message`;
    const closedLabel = typeof options.closedLabel === 'string' && options.closedLabel.trim()
      ? options.closedLabel.trim()
      : `${expectedType || 'expected'} message`;
    const matchMessage = typeof options.matchMessage === 'function'
      ? options.matchMessage
      : ((payload) => !expectedType || payload?.type === expectedType);

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', handleMessage);
        worker.off('close', handleWorkerGone);
        worker.off('exit', handleWorkerGone);
      };

      const handleMessage = (payload) => {
        if (!matchMessage(payload)) {
          return;
        }
        cleanup();
        resolve(payload);
      };

      const handleWorkerGone = (code, signal) => {
        cleanup();
        reject(new Error(
          `Worker for ${worker.accountEmail} closed before ${closedLabel}` +
          ` (code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''})`
        ));
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(
          `Timed out waiting for ${timeoutLabel} from ${worker.accountEmail}`
        ));
      }, timeoutMs);

      worker.on('message', handleMessage);
      worker.on('close', handleWorkerGone);
      worker.on('exit', handleWorkerGone);
    });
  }

  async dispatchAndAwaitResult(account, message, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
    const jobId = message?.jobId || null;
    return this.dispatchAndAwaitMessage(account, message, {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.STEP_RESULT,
      timeoutMs,
      timeoutLabel: `step result for job ${jobId}`,
      closedLabel: `step result for job ${jobId}`,
      matchMessage: (result) => (
        result?.type === ACCOUNT_WORKER_MESSAGE_TYPES.STEP_RESULT
        && result.jobId === jobId
      )
    });
  }

  async release(accountOrEmail) {
    const accountEmail = normalizeAccountEmail(accountOrEmail);
    const worker = this.workers.get(accountEmail);
    if (!worker) {
      return false;
    }

    this.workers.delete(accountEmail);

    if (typeof worker.shutdown === 'function') {
      await Promise.resolve(worker.shutdown());
      return true;
    }

    if (worker.process && typeof worker.process.kill === 'function') {
      worker.process.kill('SIGTERM');
      return true;
    }

    return true;
  }

  /**
   * Forcefully kill a worker by account email and remove it from the map.
   * Used when the worker is stuck (readiness timeout, browser crash) so that
   * subsequent getOrCreate calls spawn a fresh process instead of reusing
   * a dead one.
   *
   * @param {string|object} accountOrEmail
   * @returns {boolean} true if a worker was found and killed
   */
  killWorker(accountOrEmail) {
    const accountEmail = normalizeAccountEmail(accountOrEmail);
    const worker = this.workers.get(accountEmail);
    if (!worker) {
      return false;
    }

    this.workers.delete(accountEmail);

    try {
      if (worker.process && typeof worker.process.kill === 'function') {
        worker.process.kill('SIGKILL');
      }
    } catch (_) { /* best-effort */ }

    return true;
  }

  attachLifecycle(accountEmail, worker) {
    const lifecycleCorrelationId = ensureWorkerLifetimeCorrelationId(
      worker,
      worker.account?.workerLifetimeCorrelationId
    );
    const lifecycleStartedAt = ensureWorkerLifetimeStartedAt(
      worker,
      worker.account?.workerLifetimeStartedAt
    );
    let exitRecorded = false;

    emitWorkerLifecycleEvent(this.recordActivityEvent, {
      type: 'worker_spawn',
      accountId: resolveAccountId(worker.account),
      accountName: resolveAccountName(worker.account, accountEmail),
      correlationId: lifecycleCorrelationId,
      rootCorrelationId: lifecycleCorrelationId,
      metadata: {
        workerId: lifecycleCorrelationId,
        source: 'account_worker_process_manager',
        reason: 'created',
        accountEmail,
        processPid: Number.isFinite(worker.process?.pid) ? worker.process.pid : null,
        workerScriptPath: worker.workerScriptPath || null
      }
    });

    const cleanup = () => {
      if (this.workers.get(accountEmail) === worker) {
        this.workers.delete(accountEmail);
      }
    };

    const recordExit = (code, signal, source) => {
      if (exitRecorded) {
        return;
      }
      exitRecorded = true;
      emitWorkerLifecycleEvent(this.recordActivityEvent, {
        type: 'worker_exit',
        accountId: resolveAccountId(worker.account),
        accountName: resolveAccountName(worker.account, accountEmail),
        correlationId: lifecycleCorrelationId,
        rootCorrelationId: lifecycleCorrelationId,
        metadata: {
          workerId: lifecycleCorrelationId,
          source: 'account_worker_process_manager',
          reason: 'closed',
          exitSource: source,
          exitCode: Number.isFinite(code) ? code : null,
          signal: signal || null,
          durationMs: Math.max(0, Date.now() - lifecycleStartedAt),
          accountEmail,
          processPid: Number.isFinite(worker.process?.pid) ? worker.process.pid : null
        }
      });
    };

    if (typeof worker.on === 'function') {
      worker.on('message', (message) => {
        if (message?.type === ACCOUNT_WORKER_MESSAGE_TYPES.LIFECYCLE_EVENT) {
          const forwardedEvent = normalizeForwardedLifecycleEvent(
            message.event,
            worker,
            accountEmail,
            lifecycleCorrelationId
          );
          if (forwardedEvent) {
            emitWorkerLifecycleEvent(this.recordActivityEvent, forwardedEvent);
          }
          return;
        }
        if (
          message?.type === ACCOUNT_WORKER_MESSAGE_TYPES.CHALLENGE_DETECTED
        ) {
          emitWorkerLifecycleEvent(this.recordActivityEvent, {
            type: 'challenge_detected',
            accountId: String(message.accountId || resolveAccountId(worker.account || {}) || '').trim() || null,
            accountName: String(message.accountName || resolveAccountName(worker.account || {}, accountEmail) || '').trim() || null,
            correlationId: lifecycleCorrelationId,
            rootCorrelationId: lifecycleCorrelationId,
            status: 'warning',
            metadata: {
              workerId: lifecycleCorrelationId,
              accountEmail,
              source: String(message.source || '').trim() || 'worker',
              reason: String(message.reason || '').trim() || null,
              currentUrl: String(message.currentUrl || '').trim() || null,
              detectedAt: String(message.detectedAt || '').trim() || null
            }
          });
          if (this.onChallengeDetected) {
          this.onChallengeDetected(message, worker);
          }
        }
      });
      worker.on('close', (code, signal) => {
        recordExit(code, signal, 'close');
        cleanup();
      });
      worker.on('exit', (code, signal) => {
        recordExit(code, signal, 'exit');
        cleanup();
      });
    }

    if (worker.process?.stdout) {
      attachWorkerLogStream(worker.process.stdout, accountEmail, 'stdout');
    }
    if (worker.process?.stderr) {
      attachWorkerLogStream(worker.process.stderr, accountEmail, 'stderr');
    }
  }
}

function defaultSpawnProcess(workerScriptPath, args = [], spawnOptions = {}) {
  return fork(workerScriptPath, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    ...spawnOptions
  });
}

function createReadyPromise(worker) {
  return new Promise((resolve, reject) => {
    if (worker.ready) {
      resolve(worker);
      return;
    }

    if (worker.closed) {
      reject(new Error(`Account worker ${worker.accountEmail} closed before ready`));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for account worker ${worker.accountEmail} to become ready`));
    }, worker.readyTimeoutMs);

    const handleMessage = (message) => {
      if (message?.type === ACCOUNT_WORKER_MESSAGE_TYPES.WORKER_READY) {
        cleanup();
        resolve(worker);
      }
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    const handleClose = (code, signal) => {
      cleanup();
      reject(new Error(`Account worker ${worker.accountEmail} closed before ready (${code ?? 'null'}${signal ? `/${signal}` : ''})`));
    };

    function cleanup() {
      clearTimeout(timeout);
      worker.off('message', handleMessage);
      worker.off('error', handleError);
      worker.off('close', handleClose);
    }

    worker.on('message', handleMessage);
    worker.on('error', handleError);
    worker.on('close', handleClose);
  });
}

async function waitForClose(processHandle, timeoutMs) {
  if (!processHandle) {
    return;
  }

  if (processHandle.exitCode !== null && processHandle.exitCode !== undefined) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      clearTimeout(timer);
      reject(new Error('Timed out waiting for worker process to close'));
    }, timeoutMs);

    const handleClose = () => {
      cleanup();
      resolve();
    };

    function cleanup() {
      clearTimeout(timer);
      processHandle.off('close', handleClose);
    }

    processHandle.on('close', handleClose);
  });
}

function normalizeAccountEmail(accountOrEmail) {
  const rawValue = typeof accountOrEmail === 'string'
    ? accountOrEmail
    : accountOrEmail?.email || accountOrEmail?.accountEmail || '';
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Account email is required');
  }
  return normalized;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveAccountId(account = {}) {
  return String(account?.id || account?.accountId || '').trim() || null;
}

function resolveAccountName(account = {}, fallbackEmail = null) {
  return String(account?.name || account?.accountName || fallbackEmail || '').trim() || null;
}

function createWorkerLifetimeCorrelationId() {
  if (typeof crypto.randomUUID === 'function') {
    return `worker_${crypto.randomUUID()}`;
  }
  return `worker_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function ensureWorkerLifetimeCorrelationId(worker, fallbackValue = null) {
  if (!worker.workerLifetimeCorrelationId) {
    const seed = String(fallbackValue || '').trim();
    worker.workerLifetimeCorrelationId = seed || createWorkerLifetimeCorrelationId();
  }
  return worker.workerLifetimeCorrelationId;
}

function ensureWorkerLifetimeStartedAt(worker, fallbackValue = null) {
  if (!Number.isFinite(worker.workerLifetimeStartedAt)) {
    worker.workerLifetimeStartedAt = Number.isFinite(fallbackValue)
      ? fallbackValue
      : Date.now();
  }
  return worker.workerLifetimeStartedAt;
}

function normalizeForwardedLifecycleEvent(eventInput, worker, accountEmail, lifecycleCorrelationId) {
  const event = eventInput && typeof eventInput === 'object'
    ? { ...eventInput }
    : null;
  if (!event || !SESSION_LIFECYCLE_EVENT_TYPES.has(String(event.type || '').trim())) {
    return null;
  }

  const account = worker.account || {};
  const correlationId = String(
    event.correlationId
    || event.rootCorrelationId
    || lifecycleCorrelationId
    || ''
  ).trim() || null;

  return {
    ...event,
    accountId: String(event.accountId || resolveAccountId(account) || '').trim() || null,
    accountName: String(event.accountName || resolveAccountName(account, accountEmail) || '').trim() || null,
    correlationId,
    rootCorrelationId: String(event.rootCorrelationId || correlationId || '').trim() || null,
    metadata: {
      ...(event.metadata && typeof event.metadata === 'object' ? event.metadata : {}),
      workerId: String(
        event.metadata?.workerId
        || correlationId
        || ''
      ).trim() || null,
      accountEmail: String(
        event.metadata?.accountEmail
        || accountEmail
        || ''
      ).trim() || null
    }
  };
}

function emitWorkerLifecycleEvent(recordActivityEvent, eventInput) {
  if (typeof recordActivityEvent !== 'function') {
    return null;
  }

  try {
    return recordActivityEvent(eventInput);
  } catch (error) {
    console.error('Failed to record worker lifecycle event:', error);
    return null;
  }
}

function normalizeRequiredTimezoneId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error('Account timezoneId is required');
  }
  return normalized;
}

function writeWorkerStartupConfig(account = {}) {
  const accountEmail = normalizeAccountEmail(account);
  const fileName = `account-worker-${sanitizeFileToken(accountEmail)}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  const filePath = path.join(os.tmpdir(), fileName);
  const payload = {
    accountId: account.id || account.accountId || null,
    accountName: account.name || account.accountName || null,
    email: account.email || account.accountEmail || null,
    workerLifetimeCorrelationId: String(account.workerLifetimeCorrelationId || '').trim() || null,
    password: account.password || null,
    headless: Boolean(account.headless),
    launchSource: String(account.launchSource || '').trim() || null,
    // Session-reuse-only mode. Baked into the worker config from three sources:
    // an explicit per-account flag, the global CONNECT_NO_COLD_LOGIN opt-in
    // (read here in the main process so it doesn't need the worker spawn-env
    // allowlist), and external_api launches (which always fail closed). The
    // worker independently re-forces it for external_api as defense in depth.
    noColdLogin: account.noColdLogin === true
      || process.env.CONNECT_NO_COLD_LOGIN === '1'
      || String(account.launchSource || '').trim() === EXTERNAL_API_LAUNCH_SOURCE,
    slowMo: normalizePositiveInteger(account.slowMo, 50),
    locale: String(account.locale || 'en-US'),
    timezoneId: normalizeRequiredTimezoneId(account.timezoneId),
    // Anti-ban gates read by the worker's action router. Without these two
    // fields the warm-up ramp silently runs at 100% from day one and a
    // per-account working-hours override falls back to the default window.
    workingHours: account.workingHours && typeof account.workingHours === 'object'
      ? account.workingHours
      : null,
    warmUpStartedAt: String(account.warmUpStartedAt || '').trim() || null,
    fingerprintProfileSeed: normalizeFingerprintProfileSeed(account.fingerprintProfileSeed, accountEmail),
    viewport: normalizeViewportOverride(account.viewport),
    delayProfileSeed: normalizeDelayProfileSeed(account.delayProfileSeed, accountEmail),
    strictStealth: account.strictStealth === true,
    proxy: normalizeProxyConfig(account.proxy),
    dbPath: String(account.dbPath || '').trim() || null
  };
  // Atomic — worker reads this config at startup; a crash mid-write would
  // leave the worker unable to bootstrap. writeJsonFileAtomic uses 0o600,
  // matching the prior explicit mode (credentials-grade since the config
  // can reference session paths).
  writeJsonFileAtomic(filePath, payload);
  return filePath;
}

function sanitizeFileToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'account';
}

function attachWorkerLogStream(stream, accountEmail, streamName) {
  if (typeof stream.on !== 'function') {
    return;
  }

  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (streamName === 'stderr') {
        console.error(`[AccountWorker:${accountEmail}] ${trimmed}`);
      } else {
        console.log(`[AccountWorker:${accountEmail}] ${trimmed}`);
      }
    }
  });

  stream.on('end', () => {
    const trimmed = buffer.trim();
    if (!trimmed) {
      return;
    }
    if (streamName === 'stderr') {
      console.error(`[AccountWorker:${accountEmail}] ${trimmed}`);
    } else {
      console.log(`[AccountWorker:${accountEmail}] ${trimmed}`);
    }
  });
}

function cleanupStartupConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (_error) {
    // Best-effort cleanup only.
  }
}

module.exports = AccountWorkerProcessManager;
module.exports._private = { writeWorkerStartupConfig };
