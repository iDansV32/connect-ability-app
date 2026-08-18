const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { EventEmitter } = require('events');

const AccountWorkerProcessManager = require('../automation/runtime/account-worker-process-manager');
const { writeWorkerStartupConfig } = require('../automation/runtime/account-worker-process-manager')._private;
const { ACCOUNT_WORKER_MESSAGE_TYPES } = require('../automation/runtime/account-worker-protocol');
const { normalizeDelayProfileSeed } = require('../automation/safety/account-delay-profile');
const {
  normalizeFingerprintProfileSeed,
  normalizeViewportOverride
} = require('../automation/safety/account-fingerprint-profile');

class StubWorker extends EventEmitter {
  constructor(account = {}) {
    super();
    this.account = { ...account };
    this.accountEmail = String(account.email || account.accountEmail || '').trim().toLowerCase();
    this.shutdownCalls = 0;
    this.sentMessages = [];
    this.closed = false;
    this.onSend = null;
  }

  async send(message) {
    this.sentMessages.push(message);
    if (typeof this.onSend === 'function') {
      await this.onSend(message, this);
    }
  }

  async shutdown() {
    this.shutdownCalls += 1;
     this.closed = true;
    this.emit('close', 0, null);
  }
}

test('AccountWorkerProcessManager creates workers lazily and reuses them per normalized email', () => {
  let factoryCalls = 0;
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => {
      factoryCalls += 1;
      return new StubWorker(account);
    }
  });

  assert.equal(factoryCalls, 0);

  const first = manager.getOrCreate({ email: 'Alice@example.com' });
  const second = manager.getOrCreate({ email: '  alice@example.com ' });

  assert.equal(factoryCalls, 1);
  assert.equal(first, second);
  assert.equal(manager.size, 1);
});

test('getOrCreate refuses to reuse a headless worker for an external_api launch (fail closed)', () => {
  let factoryCalls = 0;
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => {
      factoryCalls += 1;
      return new StubWorker(account);
    }
  });

  // A native/internal flow spawns the worker headless first.
  const nativeWorker = manager.getOrCreate({ email: 'shared@example.com', headless: true });
  assert.equal(factoryCalls, 1);
  assert.equal(nativeWorker.account.headless, true);

  // A later external_api launch for the same account must NOT silently reuse
  // the headless browser — it throws rather than running an API action headless.
  assert.throws(
    () => manager.getOrCreate({ email: 'shared@example.com', launchSource: 'external_api', headless: false }),
    /Refusing to reuse headless worker/
  );

  // The existing worker is untouched and no new worker was spawned.
  assert.equal(factoryCalls, 1, 'no replacement worker spawned');
  assert.equal(manager.size, 1);
  assert.equal(manager.getOrCreate({ email: 'shared@example.com', headless: true }), nativeWorker);
});

test('getOrCreate reuses an already-visible worker for an external_api launch', () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => new StubWorker(account)
  });

  // Worker first spawned visible (headless:false) — by native UI or a prior
  // external_api call. An external_api launch may safely reuse it.
  const visibleWorker = manager.getOrCreate({ email: 'visible@example.com', headless: false });
  const reused = manager.getOrCreate({ email: 'visible@example.com', launchSource: 'external_api', headless: false });
  assert.equal(reused, visibleWorker, 'external_api reuses a visible worker');
  assert.equal(manager.size, 1);
});

test('getOrCreate allows native (non-external) launches to reuse a headless worker', () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => new StubWorker(account)
  });

  const headlessWorker = manager.getOrCreate({ email: 'native@example.com', headless: true });
  // No launchSource → native; reuse is fine regardless of headless mode.
  const reused = manager.getOrCreate({ email: 'native@example.com', headless: true });
  assert.equal(reused, headlessWorker);
  assert.equal(manager.size, 1);
});

test('writeWorkerStartupConfig: noColdLogin resolves from env toggle, explicit flag, and external_api', () => {
  const baseAccount = { email: 'a@example.com', password: 'secret', timezoneId: 'America/Chicago' };
  const readBack = (account) => {
    const p = writeWorkerStartupConfig(account);
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } finally {
      fs.unlinkSync(p);
    }
  };
  const prevEnv = process.env.CONNECT_NO_COLD_LOGIN;
  try {
    // Global env toggle ON → baked into config for an otherwise-plain native account.
    process.env.CONNECT_NO_COLD_LOGIN = '1';
    assert.equal(readBack({ ...baseAccount }).noColdLogin, true, 'env toggle forces noColdLogin');

    // Toggle OFF → native account with no flag is permitted to cold-login (no regression).
    delete process.env.CONNECT_NO_COLD_LOGIN;
    assert.equal(readBack({ ...baseAccount }).noColdLogin, false, 'native default permits cold login');

    // Explicit per-account flag honored with the env toggle off.
    assert.equal(readBack({ ...baseAccount, noColdLogin: true }).noColdLogin, true, 'explicit flag honored');

    // external_api always fails closed regardless of env/flag.
    assert.equal(readBack({ ...baseAccount, launchSource: 'external_api' }).noColdLogin, true, 'external_api forces noColdLogin');
  } finally {
    if (prevEnv === undefined) delete process.env.CONNECT_NO_COLD_LOGIN;
    else process.env.CONNECT_NO_COLD_LOGIN = prevEnv;
  }
});

test('AccountWorkerProcessManager release shuts down worker and removes it from the cache', async () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => new StubWorker(account)
  });

  const worker = manager.getOrCreate({ email: 'owner@example.com' });
  assert.equal(manager.size, 1);

  const released = await manager.release('OWNER@example.com');
  assert.equal(released, true);
  assert.equal(worker.shutdownCalls, 1);
  assert.equal(manager.size, 0);

  const replacement = manager.getOrCreate({ email: 'owner@example.com' });
  assert.notEqual(replacement, worker);
});

test('AccountWorkerProcessManager drops a worker from the cache when it closes unexpectedly', () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => new StubWorker(account)
  });

  const worker = manager.getOrCreate({ email: 'ops@example.com' });
  assert.equal(manager.size, 1);

  worker.emit('close', 1, null);
  assert.equal(manager.size, 0);
});

test('AccountWorkerProcessManager emits worker_spawn and a single deduped worker_exit with a shared correlation id', () => {
  const recordedEvents = [];
  const manager = new AccountWorkerProcessManager({
    recordActivityEvent: (event) => {
      recordedEvents.push(event);
      return event;
    },
    workerFactory: (account) => {
      const worker = new StubWorker(account);
      worker.process = { pid: 4242 };
      return worker;
    }
  });

  const worker = manager.getOrCreate({
    id: 'account-123',
    name: 'Alice SDR',
    email: 'Alice@example.com'
  });

  assert.equal(recordedEvents.length, 1);
  const spawnEvent = recordedEvents[0];
  assert.equal(spawnEvent.type, 'worker_spawn');
  assert.equal(spawnEvent.accountId, 'account-123');
  assert.equal(spawnEvent.accountName, 'Alice SDR');
  assert.equal(spawnEvent.correlationId, spawnEvent.rootCorrelationId);
  assert.equal(spawnEvent.correlationId, worker.workerLifetimeCorrelationId);
  assert.equal(spawnEvent.metadata.workerId, worker.workerLifetimeCorrelationId);
  assert.equal(spawnEvent.metadata.accountEmail, 'alice@example.com');
  assert.equal(spawnEvent.metadata.processPid, 4242);

  worker.emit('exit', 0, null);
  worker.emit('close', 0, null);

  assert.equal(recordedEvents.length, 2);
  const exitEvent = recordedEvents[1];
  assert.equal(exitEvent.type, 'worker_exit');
  assert.equal(exitEvent.correlationId, spawnEvent.correlationId);
  assert.equal(exitEvent.rootCorrelationId, spawnEvent.rootCorrelationId);
  assert.equal(exitEvent.metadata.workerId, spawnEvent.metadata.workerId);
  assert.equal(exitEvent.metadata.exitSource, 'exit');
  assert.equal(exitEvent.metadata.exitCode, 0);
  assert.equal(exitEvent.metadata.accountEmail, 'alice@example.com');
  assert.equal(typeof exitEvent.metadata.durationMs, 'number');
  assert.ok(exitEvent.metadata.durationMs >= 0);
});

test('AccountWorkerProcessManager does not emit a second worker_spawn when reusing a cached worker', () => {
  const recordedEvents = [];
  const manager = new AccountWorkerProcessManager({
    recordActivityEvent: (event) => {
      recordedEvents.push(event);
      return event;
    },
    workerFactory: (account) => new StubWorker(account)
  });

  const first = manager.getOrCreate({ email: 'reuse@example.com' });
  const second = manager.getOrCreate({ email: 'reuse@example.com' });

  assert.equal(first, second);
  assert.equal(recordedEvents.length, 1);
  assert.equal(recordedEvents[0].type, 'worker_spawn');
});

test('AccountWorkerProcessManager dispatch forwards messages through the cached worker', async () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => new StubWorker(account)
  });

  const worker = await manager.dispatch(
    { email: 'queue@example.com' },
    { type: 'execute_step', jobId: 'job-1' }
  );

  assert.equal(worker.sentMessages.length, 1);
  assert.deepEqual(worker.sentMessages[0], { type: 'execute_step', jobId: 'job-1' });
  assert.equal(manager.size, 1);
});

test('AccountWorkerProcessManager writes startup config and passes its path as a worker argv entry', () => {
  let receivedScriptPath = null;
  let receivedArgs = null;
  let capturedWorkerLifetimeCorrelationId = null;

  const manager = new AccountWorkerProcessManager({
    workerScriptPath: '/tmp/account-worker-process.js',
    spawnProcess: (workerScriptPath, args = []) => {
      receivedScriptPath = workerScriptPath;
      receivedArgs = args;

      const fakeProcess = new EventEmitter();
      fakeProcess.connected = true;
      fakeProcess.exitCode = null;
      fakeProcess.send = () => {};
      fakeProcess.kill = () => {};

      const configPath = args[0];
      const payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(payload.email, 'startup@example.com');
      assert.equal(payload.password, 'secret');
      assert.equal(payload.locale, 'en-US');
      assert.equal(payload.timezoneId, 'America/New_York');
      assert.equal(typeof payload.workerLifetimeCorrelationId, 'string');
      assert.ok(payload.workerLifetimeCorrelationId.length > 0);
      assert.equal(payload.fingerprintProfileSeed, normalizeFingerprintProfileSeed(null, 'startup@example.com'));
      assert.equal(payload.viewport, null);
      assert.equal(payload.delayProfileSeed, normalizeDelayProfileSeed(null, 'startup@example.com'));
      capturedWorkerLifetimeCorrelationId = payload.workerLifetimeCorrelationId;

      fs.unlinkSync(configPath);
      process.nextTick(() => {
        fakeProcess.emit('spawn');
        fakeProcess.emit('message', { type: ACCOUNT_WORKER_MESSAGE_TYPES.WORKER_READY });
      });

      return fakeProcess;
    }
  });

  const worker = manager.getOrCreate({
    email: 'startup@example.com',
    password: 'secret',
    timezoneId: 'America/New_York'
  });

  assert.equal(receivedScriptPath, '/tmp/account-worker-process.js');
  assert.equal(Array.isArray(receivedArgs), true);
  assert.equal(receivedArgs.length, 1);
  assert.equal(fs.existsSync(receivedArgs[0]), false);
  assert.equal(worker.accountEmail, 'startup@example.com');
  assert.equal(worker.workerLifetimeCorrelationId, capturedWorkerLifetimeCorrelationId);
});

test('AccountWorkerProcessManager preserves an explicit fingerprint profile seed in startup config', () => {
  const manager = new AccountWorkerProcessManager({
    workerScriptPath: '/tmp/account-worker-process.js',
    spawnProcess: (_workerScriptPath, args = []) => {
      const fakeProcess = new EventEmitter();
      fakeProcess.connected = true;
      fakeProcess.exitCode = null;
      fakeProcess.send = () => {};
      fakeProcess.kill = () => {};

      const configPath = args[0];
      const payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(payload.fingerprintProfileSeed, 'fingerprint-seed-123');
      assert.equal(payload.viewport, null);

      fs.unlinkSync(configPath);
      process.nextTick(() => {
        fakeProcess.emit('spawn');
        fakeProcess.emit('message', { type: ACCOUNT_WORKER_MESSAGE_TYPES.WORKER_READY });
      });

      return fakeProcess;
    }
  });

  const worker = manager.getOrCreate({
    email: 'fingerprint@example.com',
    password: 'secret',
    timezoneId: 'America/New_York',
    fingerprintProfileSeed: 'fingerprint-seed-123'
  });

  assert.equal(worker.accountEmail, 'fingerprint@example.com');
});

test('AccountWorkerProcessManager preserves an explicit viewport override in startup config', () => {
  const manager = new AccountWorkerProcessManager({
    workerScriptPath: '/tmp/account-worker-process.js',
    spawnProcess: (_workerScriptPath, args = []) => {
      const fakeProcess = new EventEmitter();
      fakeProcess.connected = true;
      fakeProcess.exitCode = null;
      fakeProcess.send = () => {};
      fakeProcess.kill = () => {};

      const configPath = args[0];
      const payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.deepEqual(payload.viewport, normalizeViewportOverride({ width: 1600, height: 900 }));

      fs.unlinkSync(configPath);
      process.nextTick(() => {
        fakeProcess.emit('spawn');
        fakeProcess.emit('message', { type: ACCOUNT_WORKER_MESSAGE_TYPES.WORKER_READY });
      });

      return fakeProcess;
    }
  });

  const worker = manager.getOrCreate({
    email: 'viewport@example.com',
    password: 'secret',
    timezoneId: 'America/New_York',
    viewport: { width: 1600, height: 900 }
  });

  assert.equal(worker.accountEmail, 'viewport@example.com');
});

test('AccountWorkerProcessManager preserves an explicit delay profile seed in startup config', () => {
  const manager = new AccountWorkerProcessManager({
    workerScriptPath: '/tmp/account-worker-process.js',
    spawnProcess: (_workerScriptPath, args = []) => {
      const fakeProcess = new EventEmitter();
      fakeProcess.connected = true;
      fakeProcess.exitCode = null;
      fakeProcess.send = () => {};
      fakeProcess.kill = () => {};

      const configPath = args[0];
      const payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(payload.delayProfileSeed, 'seed-explicit-123');

      fs.unlinkSync(configPath);
      process.nextTick(() => {
        fakeProcess.emit('spawn');
        fakeProcess.emit('message', { type: ACCOUNT_WORKER_MESSAGE_TYPES.WORKER_READY });
      });

      return fakeProcess;
    }
  });

  const worker = manager.getOrCreate({
    email: 'seeded@example.com',
    password: 'secret',
    timezoneId: 'America/New_York',
    delayProfileSeed: 'seed-explicit-123'
  });

  assert.equal(worker.accountEmail, 'seeded@example.com');
});

test('AccountWorkerProcessManager preserves strictStealth in startup config', () => {
  const manager = new AccountWorkerProcessManager({
    workerScriptPath: '/tmp/account-worker-process.js',
    spawnProcess: (_workerScriptPath, args = []) => {
      const fakeProcess = new EventEmitter();
      fakeProcess.connected = true;
      fakeProcess.exitCode = null;
      fakeProcess.send = () => {};
      fakeProcess.kill = () => {};

      const configPath = args[0];
      const payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(payload.strictStealth, true);

      fs.unlinkSync(configPath);
      process.nextTick(() => {
        fakeProcess.emit('spawn');
        fakeProcess.emit('message', { type: ACCOUNT_WORKER_MESSAGE_TYPES.WORKER_READY });
      });

      return fakeProcess;
    }
  });

  const worker = manager.getOrCreate({
    email: 'stealth@example.com',
    password: 'secret',
    timezoneId: 'America/New_York',
    strictStealth: true
  });

  assert.equal(worker.accountEmail, 'stealth@example.com');
});

test('AccountWorkerProcessManager requires timezoneId when writing worker startup config', () => {
  const manager = new AccountWorkerProcessManager({
    workerScriptPath: '/tmp/account-worker-process.js',
    spawnProcess: () => {
      throw new Error('should not spawn without timezoneId');
    }
  });

  assert.throws(
    () => manager.getOrCreate({
      email: 'missing-timezone@example.com',
      password: 'secret'
    }),
    /timezoneId is required/
  );
});

test('AccountWorkerProcessManager dispatchAndAwaitResult resolves when a matching step result arrives', async () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => {
      const worker = new StubWorker(account);
      worker.onSend = (message) => {
        process.nextTick(() => {
          worker.emit('message', {
            type: ACCOUNT_WORKER_MESSAGE_TYPES.STEP_RESULT,
            jobId: message.jobId,
            stepResult: {
              outcomeType: 'completed',
              stepType: 'send_connection'
            }
          });
        });
      };
      return worker;
    }
  });

  const result = await manager.dispatchAndAwaitResult(
    { email: 'result@example.com' },
    { type: ACCOUNT_WORKER_MESSAGE_TYPES.EXECUTE_STEP, jobId: 'job-result' }
  );

  assert.deepEqual(result, {
    type: ACCOUNT_WORKER_MESSAGE_TYPES.STEP_RESULT,
    jobId: 'job-result',
    stepResult: {
      outcomeType: 'completed',
      stepType: 'send_connection'
    }
  });
});

test('AccountWorkerProcessManager dispatchAndAwaitResult ignores heartbeats before the matching step result', async () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => {
      const worker = new StubWorker(account);
      worker.onSend = (message) => {
        process.nextTick(() => {
          worker.emit('message', {
            type: ACCOUNT_WORKER_MESSAGE_TYPES.HEARTBEAT,
            jobId: message.jobId
          });
          worker.emit('message', {
            type: ACCOUNT_WORKER_MESSAGE_TYPES.STEP_RESULT,
            jobId: message.jobId,
            stepResult: {
              outcomeType: 'skipped_invite_pending',
              stepType: 'send_connection'
            }
          });
        });
      };
      return worker;
    }
  });

  const result = await manager.dispatchAndAwaitResult(
    { email: 'heartbeat@example.com' },
    { type: ACCOUNT_WORKER_MESSAGE_TYPES.EXECUTE_STEP, jobId: 'job-heartbeat' }
  );

  assert.equal(result.type, ACCOUNT_WORKER_MESSAGE_TYPES.STEP_RESULT);
  assert.equal(result.jobId, 'job-heartbeat');
  assert.equal(result.stepResult.outcomeType, 'skipped_invite_pending');
});

test('AccountWorkerProcessManager dispatchAndAwaitMessage resolves on a matching arbitrary message type', async () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => {
      const worker = new StubWorker(account);
      worker.onSend = (message) => {
        process.nextTick(() => {
          worker.emit('message', {
            type: ACCOUNT_WORKER_MESSAGE_TYPES.HEARTBEAT,
            requestId: message.requestId
          });
          worker.emit('message', {
            type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT,
            requestId: message.requestId,
            pollResult: {
              mailboxUrn: 'urn:li:fsd_profile:self',
              conversations: []
            }
          });
        });
      };
      return worker;
    }
  });

  const result = await manager.dispatchAndAwaitMessage(
    { email: 'poll@example.com' },
    { type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES, requestId: 'poll-1' },
    {
      type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT,
      timeoutMs: 1000,
      matchMessage: (payload) => (
        payload?.type === ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT
        && payload.requestId === 'poll-1'
      )
    }
  );

  assert.equal(result.type, ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT);
  assert.equal(result.requestId, 'poll-1');
  assert.equal(result.pollResult.mailboxUrn, 'urn:li:fsd_profile:self');
});

test('AccountWorkerProcessManager records challenge-detected worker messages and forwards them to the configured callback', () => {
  const observed = [];
  const recordedEvents = [];
  const manager = new AccountWorkerProcessManager({
    recordActivityEvent: (event) => {
      recordedEvents.push(event);
      return event;
    },
    onChallengeDetected: (payload, worker) => {
      observed.push({ payload, worker });
    },
    workerFactory: (account) => new StubWorker(account)
  });

  const worker = manager.getOrCreate({ email: 'alerts@example.com' });
  worker.emit('message', {
    type: ACCOUNT_WORKER_MESSAGE_TYPES.CHALLENGE_DETECTED,
    accountEmail: 'alerts@example.com',
    reason: 'Security checkpoint required'
  });

  assert.equal(observed.length, 1);
  assert.equal(observed[0].payload.reason, 'Security checkpoint required');
  assert.equal(observed[0].worker, worker);
  assert.equal(recordedEvents.length, 2);
  assert.equal(recordedEvents[1].type, 'challenge_detected');
  assert.equal(recordedEvents[1].correlationId, worker.workerLifetimeCorrelationId);
  assert.equal(recordedEvents[1].metadata.reason, 'Security checkpoint required');
  assert.equal(recordedEvents[1].metadata.accountEmail, 'alerts@example.com');
});

test('AccountWorkerProcessManager forwards child lifecycle events through recordActivityEvent with the worker lifetime correlation id', () => {
  const recordedEvents = [];
  const manager = new AccountWorkerProcessManager({
    recordActivityEvent: (event) => {
      recordedEvents.push(event);
      return event;
    },
    workerFactory: (account) => new StubWorker(account)
  });

  const worker = manager.getOrCreate({
    id: 'account-9',
    name: 'Alice SDR',
    email: 'forward@example.com'
  });

  worker.emit('message', {
    type: ACCOUNT_WORKER_MESSAGE_TYPES.LIFECYCLE_EVENT,
    event: {
      type: 'session_verified',
      metadata: {
        method: 'existing_session',
        trigger: 'startup_verify'
      }
    }
  });

  assert.equal(recordedEvents.length, 2);
  const forwarded = recordedEvents[1];
  assert.equal(forwarded.type, 'session_verified');
  assert.equal(forwarded.accountId, 'account-9');
  assert.equal(forwarded.accountName, 'Alice SDR');
  assert.equal(forwarded.correlationId, worker.workerLifetimeCorrelationId);
  assert.equal(forwarded.rootCorrelationId, worker.workerLifetimeCorrelationId);
  assert.equal(forwarded.metadata.workerId, worker.workerLifetimeCorrelationId);
  assert.equal(forwarded.metadata.accountEmail, 'forward@example.com');
  assert.equal(forwarded.metadata.method, 'existing_session');
});

test('AccountWorkerProcessManager dispatchAndAwaitResult rejects when the worker closes before a step result arrives', async () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => {
      const worker = new StubWorker(account);
      worker.onSend = () => {
        process.nextTick(() => {
          worker.closed = true;
          worker.emit('close', 1, null);
        });
      };
      return worker;
    }
  });

  await assert.rejects(
    manager.dispatchAndAwaitResult(
      { email: 'close@example.com' },
      { type: ACCOUNT_WORKER_MESSAGE_TYPES.EXECUTE_STEP, jobId: 'job-close' }
    ),
    /closed before step result for job job-close/
  );
});

test('AccountWorkerProcessManager dispatchAndAwaitResult rejects on timeout when no result arrives', async () => {
  const manager = new AccountWorkerProcessManager({
    workerFactory: (account) => new StubWorker(account)
  });

  await assert.rejects(
    manager.dispatchAndAwaitResult(
      { email: 'timeout@example.com' },
      { type: ACCOUNT_WORKER_MESSAGE_TYPES.EXECUTE_STEP, jobId: 'job-timeout' },
      50
    ),
    /Timed out waiting for step result for job job-timeout from timeout@example.com/
  );
});
