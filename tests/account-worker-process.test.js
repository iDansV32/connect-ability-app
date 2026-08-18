'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureWorkerAuthentication,
  buildProfilePath,
  looksLikeChallengeState,
  maybeEmitChallengeDetected,
  verifyWorkerSession,
  runStartupDomCanaries,
  maybeRunConnectionSelectorCanaryAfterStep,
  _private: {
    initializeWorkerPages,
    isUsableLinkedInPageUrl,
    loadStartupConfig
  }
} = require('../automation/runtime/account-worker-process');
const { createTempWorkspace } = require('./test-helpers');

async function withTempHome(workspace, fn) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  process.env.HOME = workspace.root;
  process.env.USERPROFILE = workspace.root;

  try {
    return await fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

function getExpectedAppStateDir(workspace) {
  if (process.platform === 'darwin') {
    return workspace.path('Library', 'Application Support', 'Connect Ability');
  }
  if (process.platform === 'win32') {
    return workspace.path('AppData', 'Roaming', 'Connect Ability');
  }
  return workspace.path('.local', 'state', 'Connect Ability');
}

function getExpectedProfilePath(workspace, email) {
  const emailHash = crypto.createHash('sha256')
    .update(String(email || '').trim().toLowerCase())
    .digest('hex');
  return path.join(getExpectedAppStateDir(workspace), 'profiles', emailHash);
}

function createRegistryStub(options = {}) {
  return {
    upsertCalls: [],
    verifiedCalls: [],
    authFailureCalls: [],
    challengeCalls: [],
    shouldReauthenticate() {
      return options.shouldReauthenticate;
    },
    upsertAccount(email, payload) {
      this.upsertCalls.push({ email, payload });
    },
    recordVerified(email, payload) {
      this.verifiedCalls.push({ email, payload });
    },
    recordAuthFailure(email, payload) {
      this.authFailureCalls.push({ email, payload });
    },
    recordChallenge(email, payload) {
      this.challengeCalls.push({ email, payload });
    }
  };
}

test('buildProfilePath resolves persistent browser profiles under app-state and migrates legacy directories', async () => {
  const workspace = createTempWorkspace('account-worker-profile-path-');
  try {
    await withTempHome(workspace, async () => {
      const email = 'alice@example.com';
      const profilePath = getExpectedProfilePath(workspace, email);
      const legacyPath = workspace.path(
        'Documents',
        'Connect-Ability',
        'profiles',
        path.basename(profilePath)
      );

      fs.mkdirSync(legacyPath, { recursive: true });
      fs.writeFileSync(path.join(legacyPath, 'Preferences'), '{}');

      const resolvedPath = buildProfilePath(email);

      assert.equal(resolvedPath, profilePath);
      assert.equal(fs.existsSync(path.join(profilePath, 'Preferences')), true);
      assert.equal(fs.existsSync(legacyPath), false);
    });
  } finally {
    workspace.cleanup();
  }
});

test('loadStartupConfig requires timezoneId in the worker startup payload', async () => {
  const workspace = createTempWorkspace('account-worker-config-');
  try {
    const configPath = workspace.path('worker-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      email: 'alice@example.com',
      password: 'secret'
    }));

    assert.throws(
      () => loadStartupConfig(configPath),
      /requires timezoneId/
    );
  } finally {
    workspace.cleanup();
  }
});

test('loadStartupConfig derives noColdLogin: forced for external_api, honored from explicit flag, else false', async () => {
  const workspace = createTempWorkspace('account-worker-ncl-config-');
  try {
    const base = { email: 'a@example.com', password: 'secret', timezoneId: 'America/Chicago' };
    const write = (name, extra) => {
      const p = workspace.path(name);
      fs.writeFileSync(p, JSON.stringify({ ...base, ...extra }));
      return p;
    };

    // external_api always forces noColdLogin, even without the explicit flag.
    assert.equal(loadStartupConfig(write('c1.json', { launchSource: 'external_api' })).noColdLogin, true);
    // Explicit flag honored for native launches.
    assert.equal(loadStartupConfig(write('c2.json', { noColdLogin: true })).noColdLogin, true);
    // Native launch with no flag → cold login still permitted (no regression).
    assert.equal(loadStartupConfig(write('c3.json', {})).noColdLogin, false);
    assert.equal(loadStartupConfig(write('c4.json', { launchSource: 'native' })).noColdLogin, false);
  } finally {
    workspace.cleanup();
  }
});

test('ensureWorkerAuthentication reuses a recently verified session without calling login', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: false });
  let verifyCalls = 0;
  let loginCalls = 0;
  const lifecycleEvents = [];

  await ensureWorkerAuthentication(
    {
      email: 'alice@example.com',
      password: 'secret',
      profilePath: '/tmp/alice-profile',
      sessionVerificationMaxAgeMs: 1000,
      workerLifetimeCorrelationId: 'worker-lifetime-1'
    },
    {
      url: async () => 'https://www.linkedin.com/feed/'
    },
    {
      sessionRegistry: registry,
      verifySession: async () => {
        verifyCalls += 1;
        return 'header.global-nav';
      },
      emitLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
      performLogin: async () => {
        loginCalls += 1;
      }
    }
  );

  assert.equal(verifyCalls, 1);
  assert.equal(loginCalls, 0);
  assert.equal(registry.upsertCalls.length, 1);
  assert.equal(registry.verifiedCalls.length, 1);
  assert.equal(registry.verifiedCalls[0].payload.verifiedBy, 'action');
  assert.equal(registry.authFailureCalls.length, 0);
  assert.deepEqual(lifecycleEvents.map((event) => event.type), ['session_verified']);
  assert.equal(lifecycleEvents[0].correlationId, 'worker-lifetime-1');
  assert.equal(lifecycleEvents[0].metadata.method, 'existing_session');
  assert.equal(lifecycleEvents[0].metadata.trigger, 'startup_verify');
});

test('ensureWorkerAuthentication logs in when the registry requires re-authentication', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: true });
  let loginCalls = 0;
  let receivedOptions = null;
  const lifecycleEvents = [];

  await ensureWorkerAuthentication(
    {
      email: 'alice@example.com',
      password: 'secret',
      profilePath: '/tmp/alice-profile',
      sessionVerificationMaxAgeMs: 1000,
      strictStealth: true,
      workerLifetimeCorrelationId: 'worker-lifetime-2'
    },
    {
      url: async () => 'https://www.linkedin.com/feed/'
    },
    {
      sessionRegistry: registry,
      verifySession: async () => {
        throw new Error('verifySession should not run');
      },
      emitLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
      performLogin: async (_page, _email, _password, options) => {
        loginCalls += 1;
        receivedOptions = options;
      }
    }
  );

  assert.equal(loginCalls, 1);
  assert.deepEqual(receivedOptions, { strictStealth: true });
  assert.equal(registry.verifiedCalls.length, 1);
  assert.equal(registry.verifiedCalls[0].payload.verifiedBy, 'login');
  assert.equal(registry.authFailureCalls.length, 0);
  assert.deepEqual(lifecycleEvents.map((event) => event.type), ['login_attempt', 'session_verified']);
  assert.equal(lifecycleEvents[0].metadata.trigger, 'startup_reauthenticate');
  assert.equal(lifecycleEvents[1].metadata.method, 'login');
  assert.equal(lifecycleEvents[1].correlationId, 'worker-lifetime-2');
});

test('ensureWorkerAuthentication falls back to login when verification fails and emits login_attempt before session_verified', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: false });
  let loginCalls = 0;
  const lifecycleEvents = [];

  await ensureWorkerAuthentication(
    {
      email: 'alice@example.com',
      password: 'secret',
      profilePath: '/tmp/alice-profile',
      sessionVerificationMaxAgeMs: 1000,
      workerLifetimeCorrelationId: 'worker-lifetime-3'
    },
    {
      url: async () => 'https://www.linkedin.com/feed/'
    },
    {
      sessionRegistry: registry,
      verifySession: async () => null,
      emitLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
      performLogin: async () => {
        loginCalls += 1;
      }
    }
  );

  assert.equal(loginCalls, 1);
  assert.equal(registry.authFailureCalls.length, 1);
  assert.equal(registry.verifiedCalls.length, 1);
  assert.deepEqual(
    lifecycleEvents.map((event) => event.type),
    ['auth_failure', 'login_attempt', 'session_verified', 'challenge_recovery']
  );
  assert.equal(lifecycleEvents[0].metadata.trigger, 'startup_verify');
  assert.equal(lifecycleEvents[0].metadata.reason, 'verify_failed_fallback');
  assert.equal(lifecycleEvents[1].metadata.trigger, 'startup_verify_fallback');
  assert.equal(lifecycleEvents[2].metadata.method, 'login');
  assert.equal(lifecycleEvents[2].correlationId, 'worker-lifetime-3');
  assert.equal(lifecycleEvents[3].metadata.trigger, 'startup_verify_fallback');
  assert.equal(lifecycleEvents[3].metadata.recoveredFromAuthFailure, true);
  assert.equal(lifecycleEvents[3].metadata.recoveredFromChallenge, false);
});

test('ensureWorkerAuthentication: noColdLogin refuses password login when verification fails (fail closed)', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: false });
  let loginCalls = 0;
  const lifecycleEvents = [];

  await assert.rejects(
    ensureWorkerAuthentication(
      {
        email: 'alice@example.com',
        password: 'secret',
        profilePath: '/tmp/alice-profile',
        sessionVerificationMaxAgeMs: 1000,
        launchSource: 'external_api',
        noColdLogin: true,
        workerLifetimeCorrelationId: 'worker-lifetime-ncl-1'
      },
      { url: async () => 'https://www.linkedin.com/login' },
      {
        sessionRegistry: registry,
        verifySession: async () => null, // stored session can't be confirmed
        emitLifecycleEvent: (event) => { lifecycleEvents.push(event); },
        performLogin: async () => { loginCalls += 1; } // must NOT run
      }
    ),
    (err) => err.name === 'ColdLoginBlockedError' && err.code === 'cold_login_blocked'
  );

  assert.equal(loginCalls, 0, 'cold password login must never run in session-reuse-only mode');
  // The verify-failed fallback auth_failure fires, then the cold_login_blocked one.
  const blocked = lifecycleEvents.find((e) => e.type === 'auth_failure' && e.metadata.reason === 'cold_login_blocked');
  assert.ok(blocked, 'emits a cold_login_blocked auth_failure');
  assert.equal(blocked.metadata.detail, 'session_reuse_unconfirmed');
  assert.equal(lifecycleEvents.some((e) => e.type === 'login_attempt'), false, 'no login_attempt event');
});

test('ensureWorkerAuthentication: noColdLogin refuses login when registry requires reauth (stale session)', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: true });
  let loginCalls = 0;
  const lifecycleEvents = [];

  await assert.rejects(
    ensureWorkerAuthentication(
      {
        email: 'alice@example.com',
        password: 'secret',
        profilePath: '/tmp/alice-profile',
        sessionVerificationMaxAgeMs: 1000,
        noColdLogin: true,
        workerLifetimeCorrelationId: 'worker-lifetime-ncl-2'
      },
      { url: async () => 'https://www.linkedin.com/login' },
      {
        sessionRegistry: registry,
        verifySession: async () => { throw new Error('verifySession should not run'); },
        emitLifecycleEvent: (event) => { lifecycleEvents.push(event); },
        performLogin: async () => { loginCalls += 1; }
      }
    ),
    (err) => err.code === 'cold_login_blocked'
  );

  assert.equal(loginCalls, 0);
  const blocked = lifecycleEvents.find((e) => e.type === 'auth_failure' && e.metadata.reason === 'cold_login_blocked');
  assert.ok(blocked);
  assert.equal(blocked.metadata.detail, 'session_verification_stale');
});

test('ensureWorkerAuthentication: noColdLogin still reuses a valid session (guard does not fire)', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: false });
  let loginCalls = 0;

  await ensureWorkerAuthentication(
    {
      email: 'alice@example.com',
      password: 'secret',
      profilePath: '/tmp/alice-profile',
      sessionVerificationMaxAgeMs: 1000,
      launchSource: 'external_api',
      noColdLogin: true,
      workerLifetimeCorrelationId: 'worker-lifetime-ncl-3'
    },
    { url: async () => 'https://www.linkedin.com/feed/' },
    {
      sessionRegistry: registry,
      verifySession: async () => 'header.global-nav', // session confirmed
      performLogin: async () => { loginCalls += 1; }
    }
  );

  assert.equal(loginCalls, 0, 'no login needed when the session verifies');
  assert.equal(registry.verifiedCalls.length, 1);
  assert.equal(registry.verifiedCalls[0].payload.verifiedBy, 'action');
});

test('ensureWorkerAuthentication records auth_failure and challenges when login fails', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: true });
  const emittedChallenges = [];
  const lifecycleEvents = [];

  await assert.rejects(
    ensureWorkerAuthentication(
      {
        email: 'alice@example.com',
        password: 'secret',
        profilePath: '/tmp/alice-profile',
        sessionVerificationMaxAgeMs: 1000,
        workerLifetimeCorrelationId: 'worker-lifetime-4'
      },
      {
        url: async () => 'https://www.linkedin.com/checkpoint/challenge'
      },
      {
        sessionRegistry: registry,
        emitLifecycleEvent: (event) => {
          lifecycleEvents.push(event);
        },
        emitChallengeDetected: async (payload) => {
          emittedChallenges.push(payload);
        },
        performLogin: async () => {
          throw new Error('Security checkpoint required');
        }
      }
    ),
    /Security checkpoint required/
  );

  assert.equal(registry.authFailureCalls.length, 1);
  assert.equal(registry.challengeCalls.length, 0);
  assert.equal(emittedChallenges.length, 1);
  assert.equal(emittedChallenges[0].source, 'worker_startup_login');
  assert.deepEqual(lifecycleEvents.map((event) => event.type), ['login_attempt', 'auth_failure']);
  assert.equal(lifecycleEvents[0].metadata.trigger, 'startup_reauthenticate');
  assert.match(lifecycleEvents[1].metadata.reason, /Security checkpoint required/);
});

test('looksLikeChallengeState matches both error text and checkpoint URLs', () => {
  assert.equal(looksLikeChallengeState(new Error('captcha required'), ''), true);
  assert.equal(looksLikeChallengeState(null, 'https://www.linkedin.com/checkpoint/challenge'), true);
  assert.equal(looksLikeChallengeState(new Error('temporary network issue'), 'https://www.linkedin.com/feed/'), false);
});

test('maybeEmitChallengeDetected records the challenge and returns a worker payload', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: false });
  const payload = await maybeEmitChallengeDetected({
    error: new Error('Security checkpoint required'),
    currentUrl: 'https://www.linkedin.com/checkpoint/challenge',
    source: 'workflow_step_result',
    accountEmail: 'alice@example.com',
    accountId: 'li_1',
    accountName: 'Alice'
  }, {
    sessionRegistry: registry,
    config: {
      email: 'alice@example.com'
    }
  });

  assert.equal(payload.type, 'challenge_detected');
  assert.equal(payload.accountEmail, 'alice@example.com');
  assert.equal(payload.source, 'workflow_step_result');
  assert.equal(registry.challengeCalls.length, 1);
});

test('verifyWorkerSession records verification when the session is still valid', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: false });
  const lifecycleEvents = [];
  const result = await verifyWorkerSession(
    {
      url: async () => 'https://www.linkedin.com/feed/'
    },
    {
      config: {
        email: 'alice@example.com',
        accountId: 'li_1',
        accountName: 'Alice',
        profilePath: '/tmp/alice-profile',
        workerLifetimeCorrelationId: 'worker-lifetime-runtime-ok'
      },
      sessionRegistry: registry,
      verifySession: async () => 'header.global-nav',
      emitLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.indicator, 'header.global-nav');
  assert.equal(registry.verifiedCalls.length, 1);
  assert.equal(registry.authFailureCalls.length, 0);
  assert.equal(registry.challengeCalls.length, 0);
  assert.deepEqual(lifecycleEvents.map((event) => event.type), ['session_verified']);
  assert.equal(lifecycleEvents[0].metadata.trigger, 'runtime_verify');
  assert.equal(lifecycleEvents[0].metadata.method, 'existing_session');
  assert.equal(lifecycleEvents[0].correlationId, 'worker-lifetime-runtime-ok');
});

test('verifyWorkerSession preserves the challenge when verification fails on a challenge page', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: false });
  const emittedChallenges = [];
  const lifecycleEvents = [];
  const result = await verifyWorkerSession(
    {
      url: async () => 'https://www.linkedin.com/checkpoint/challenge'
    },
    {
      config: {
        email: 'alice@example.com',
        accountId: 'li_1',
        accountName: 'Alice',
        profilePath: '/tmp/alice-profile',
        workerLifetimeCorrelationId: 'worker-lifetime-runtime-fail'
      },
      sessionRegistry: registry,
      verifySession: async () => null,
      emitChallengeDetected: async (payload) => {
        emittedChallenges.push(payload);
      },
      emitLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      }
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /could not be verified/i);
  assert.equal(registry.authFailureCalls.length, 1);
  assert.equal(emittedChallenges.length, 1);
  assert.equal(emittedChallenges[0].source, 'verify_session');
  assert.deepEqual(lifecycleEvents.map((event) => event.type), ['auth_failure']);
  assert.equal(lifecycleEvents[0].metadata.trigger, 'runtime_verify');
  assert.match(lifecycleEvents[0].metadata.reason, /could not be verified/i);
  assert.equal(lifecycleEvents[0].metadata.currentUrl, 'https://www.linkedin.com/checkpoint/challenge');
  assert.equal(lifecycleEvents[0].correlationId, 'worker-lifetime-runtime-fail');
});

test('verifyWorkerSession emits one-shot challenge_recovery after a prior auth failure in the same worker lifetime', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: false });
  const config = {
    email: 'alice@example.com',
    accountId: 'li_1',
    accountName: 'Alice',
    profilePath: '/tmp/alice-profile',
    workerLifetimeCorrelationId: 'worker-lifetime-runtime-recovery'
  };
  const lifecycleEvents = [];

  await verifyWorkerSession(
    {
      url: async () => 'https://www.linkedin.com/feed/'
    },
    {
      config,
      sessionRegistry: registry,
      verifySession: async () => null,
      emitChallengeDetected: async () => null,
      emitLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      }
    }
  );

  await verifyWorkerSession(
    {
      url: async () => 'https://www.linkedin.com/feed/'
    },
    {
      config,
      sessionRegistry: registry,
      verifySession: async () => 'header.global-nav',
      emitLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      }
    }
  );

  await verifyWorkerSession(
    {
      url: async () => 'https://www.linkedin.com/feed/'
    },
    {
      config,
      sessionRegistry: registry,
      verifySession: async () => 'header.global-nav',
      emitLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      }
    }
  );

  assert.deepEqual(
    lifecycleEvents.map((event) => event.type),
    ['auth_failure', 'session_verified', 'challenge_recovery', 'session_verified']
  );
  assert.equal(lifecycleEvents[2].metadata.trigger, 'runtime_verify');
  assert.equal(lifecycleEvents[2].metadata.recoveredFromAuthFailure, true);
  assert.equal(lifecycleEvents[2].metadata.recoveredFromChallenge, false);
});

test('verifyWorkerSession emits challenge_recovery after a prior challenge in the same worker lifetime', async () => {
  const registry = createRegistryStub({ shouldReauthenticate: false });
  const config = {
    email: 'alice@example.com',
    accountId: 'li_1',
    accountName: 'Alice',
    profilePath: '/tmp/alice-profile',
    workerLifetimeCorrelationId: 'worker-lifetime-runtime-challenge-recovery'
  };
  const lifecycleEvents = [];

  await maybeEmitChallengeDetected({
    error: new Error('Security checkpoint required'),
    currentUrl: 'https://www.linkedin.com/checkpoint/challenge',
    source: 'verify_session',
    accountEmail: 'alice@example.com',
    accountId: 'li_1',
    accountName: 'Alice'
  }, {
    sessionRegistry: registry,
    config
  });

  await verifyWorkerSession(
    {
      url: async () => 'https://www.linkedin.com/feed/'
    },
    {
      config,
      sessionRegistry: registry,
      verifySession: async () => 'header.global-nav',
      emitLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      }
    }
  );

  assert.deepEqual(lifecycleEvents.map((event) => event.type), ['session_verified', 'challenge_recovery']);
  assert.equal(lifecycleEvents[1].metadata.trigger, 'runtime_verify');
  assert.equal(lifecycleEvents[1].metadata.recoveredFromAuthFailure, false);
  assert.equal(lifecycleEvents[1].metadata.recoveredFromChallenge, true);
});

test('runStartupDomCanaries runs the connection selector canary on workflow startup', async () => {
  const result = await runStartupDomCanaries(
    {
      email: 'alice@example.com',
      canaryProfileUrl: 'https://www.linkedin.com/in/test-user/'
    },
    {
      transportHealthStore: {
        recordSuccess() {},
        recordFailure() {}
      },
      workflowPage: {},
      runConnectionSelectorCanary: async (workerContext) => ({
        status: 'ok',
        accountEmail: workerContext.accountEmail
      }),
      emitLog() {}
    }
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.accountEmail, 'alice@example.com');
});

test('worker startup initializes only the main workflow tab', async () => {
  const initializedPages = [];

  await initializeWorkerPages({
    ensureRuntimePage: async (pageName) => initializedPages.push(pageName)
  });

  assert.deepEqual(initializedPages, ['workflowPage']);
});

test('worker reuses authenticated LinkedIn pages instead of loading the feed again', () => {
  assert.equal(isUsableLinkedInPageUrl('https://www.linkedin.com/feed/'), true);
  assert.equal(isUsableLinkedInPageUrl('https://www.linkedin.com/search/results/people/'), true);
  assert.equal(isUsableLinkedInPageUrl('https://www.linkedin.com/checkpoint/challenge/'), false);
  assert.equal(isUsableLinkedInPageUrl('about:blank'), false);
});

test('runStartupDomCanaries isolates deferred startup navigation from the workflow page', async () => {
  const calls = [];
  const canaryPage = {
    goto: async (url) => calls.push(['goto', url]),
    close: async () => calls.push(['close'])
  };
  const workflowPage = { name: 'active-workflow-page' };

  const result = await runStartupDomCanaries(
    {
      email: 'alice@example.com',
      canaryProfileUrl: 'https://www.linkedin.com/in/test-user/'
    },
    {
      context: {
        newPage: async () => {
          calls.push(['newPage']);
          return canaryPage;
        }
      },
      runConnectionSelectorCanary: async (workerContext) => {
        assert.equal(workerContext.workflowPage, canaryPage);
        assert.notEqual(workerContext.workflowPage, workflowPage);
        calls.push(['canary']);
        return { status: 'ok' };
      },
      emitLog() {}
    }
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(calls, [
    ['newPage'],
    ['goto', 'https://www.linkedin.com/feed/'],
    ['canary'],
    ['close']
  ]);
});

test('maybeRunConnectionSelectorCanaryAfterStep reruns the DOM selector canary after thresholded send_connection failures', async () => {
  let rerunCalls = 0;

  const result = await maybeRunConnectionSelectorCanaryAfterStep(
    'send_connection',
    { outcomeType: 'failed_transient' },
    {
      config: {
        email: 'alice@example.com',
        canaryProfileUrl: 'https://www.linkedin.com/in/test-user/'
      },
      workflowPage: {},
      transportHealthStore: {},
      shouldRerunConnectionSelectorCanary: () => true,
      runConnectionSelectorCanary: async () => {
        rerunCalls += 1;
        return { status: 'ok' };
      },
      emitLog() {}
    }
  );

  assert.equal(rerunCalls, 1);
  assert.equal(result.status, 'ok');
});

test('warm-up and working-hours survive the manager→worker startup-config round-trip', async () => {
  // REL-2/REL-3 regression guard: the manager's startup-config payload used to
  // drop warmUpStartedAt and workingHours, silently disabling the warm-up ramp
  // and any per-account working-hours override on the canonical worker path.
  const { _private: { writeWorkerStartupConfig } } =
    require('../automation/runtime/account-worker-process-manager');

  const workingHours = {
    timezone: 'America/Chicago',
    days: [1, 2, 3],
    startHour: 10,
    endHour: 15
  };
  const warmUpStartedAt = '2026-07-20T09:00:00.000Z';

  const configPath = writeWorkerStartupConfig({
    id: 'acc_roundtrip',
    name: 'Round Trip',
    email: 'roundtrip@example.com',
    password: 'secret',
    timezoneId: 'America/Chicago',
    workingHours,
    warmUpStartedAt
  });

  // loadStartupConfig unlinks the file after reading (credentials hygiene).
  const parsed = loadStartupConfig(configPath);

  assert.deepEqual(parsed.workingHours, workingHours);
  assert.equal(parsed.warmUpStartedAt, warmUpStartedAt);
  assert.equal(fs.existsSync(configPath), false, 'startup config must be unlinked after read');
});

test('startup config omitting warm-up/working-hours parses to nulls (legacy configs)', async () => {
  const workspace = createTempWorkspace('account-worker-warmup-config-');
  try {
    const configPath = workspace.path('worker-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      email: 'legacy@example.com',
      password: 'secret',
      timezoneId: 'America/Chicago',
      workingHours: 'not-an-object'
    }));

    const parsed = loadStartupConfig(configPath);
    assert.equal(parsed.workingHours, null);
    assert.equal(parsed.warmUpStartedAt, null);
  } finally {
    workspace.cleanup();
  }
});
