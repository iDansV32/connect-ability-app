const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const { ACCOUNT_WORKER_MESSAGE_TYPES } = require('./account-worker-protocol');
const { normalizeProxyConfig, buildPlaywrightProxyOption, formatProxyForLog } = require('./proxy-config');
const { loginToLinkedIn, verifyLoggedInSession } = require('../core/login');
const { setupFingerprinting } = require('../core/fingerprinting');
const { buildDelayProfileFromSeed, setProcessDelayProfile } = require('../human/delay');
const {
  normalizeFingerprintProfileSeed,
  buildFingerprintProfileFromSeed,
  buildFingerprintSessionSeed,
  resolveSessionViewport,
  applySessionSeedToProfile
} = require('../safety/account-fingerprint-profile');
const {
  AccountSessionRegistry,
  DEFAULT_SESSION_VERIFICATION_MAX_AGE_MS
} = require('./account-session-registry');
const TransportHealthStore = require('./transport-health-store');
const { createWorkflowStepResult } = require('../../workflow-step-result');
const { executeWorkflowStep } = require('./action-router');
const {
  fetchConversationThread,
  pollMessagingReplies,
  sendConversationReply
} = require('../messaging/reply-polling');
const { executePostOnPage } = require('../posting/post-publisher');
const {
  runConnectionSelectorCanary,
  shouldRerunConnectionSelectorCanary
} = require('../dom/selector-canary');
const {
  ensureDirectoryExists,
  getConnectAbilityAppStateDir,
  getConnectAbilityDocumentsDir
} = require('../../connect-documents');
const { EXTERNAL_API_LAUNCH_SOURCE } = require('../../external-api-safety');
const { installCrashHandlers } = require('./crash-telemetry');

const LINKEDIN_FEED_URL = 'https://www.linkedin.com/feed/';
const LINKEDIN_MESSAGING_URL = 'https://www.linkedin.com/messaging/';
const PAGE_BOOT_URLS = Object.freeze({
  workflowPage: LINKEDIN_FEED_URL,
  messagingPage: LINKEDIN_MESSAGING_URL,
  postingPage: LINKEDIN_FEED_URL
});

const runtimeState = {
  startupConfig: null,
  context: null,
  pages: new Map(),
  sessionRegistry: null,
  transportHealthStore: null
};

/**
 * Build the optional structured error-metadata envelope for STEP_RESULT /
 * PUBLISH_POST_RESULT messages. Returns null when the error carries no
 * useful structured fields, in which case callers should omit errorMeta
 * from the message entirely (no point sending an empty object over IPC).
 *
 * Fields surfaced when present on the source error:
 *   - httpStatus           (number) — e.g. 429
 *   - retryAfterMs         (number) — already-parsed cooldown
 *   - retryAfterHeader     (string) — raw header in case main wants to log
 *   - responseBodyPreview  (string) — short excerpt of the response body
 *
 * Origin contract: automation/linkedin-private/client.js#request stamps
 * these on the Error it throws. Any other throw site can do the same and
 * the metadata flows through unchanged.
 */
function buildErrorMeta(error) {
  if (!error || typeof error !== 'object') return null;
  const meta = {};
  if (Number.isFinite(Number(error.httpStatus))) meta.httpStatus = Number(error.httpStatus);
  if (Number.isFinite(Number(error.retryAfterMs)) && Number(error.retryAfterMs) > 0) {
    meta.retryAfterMs = Number(error.retryAfterMs);
  }
  if (typeof error.retryAfterHeader === 'string' && error.retryAfterHeader.trim()) {
    meta.retryAfterHeader = error.retryAfterHeader;
  }
  if (typeof error.responseBodyPreview === 'string' && error.responseBodyPreview.trim()) {
    meta.responseBodyPreview = error.responseBodyPreview;
  }
  return Object.keys(meta).length ? meta : null;
}

function sendWorkerMessage(message) {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

function sendWorkerLifecycleEvent(event, dependencies = {}) {
  const emitLifecycleEvent = typeof dependencies.emitLifecycleEvent === 'function'
    ? dependencies.emitLifecycleEvent
    : null;
  const normalizedEvent = normalizeWorkerLifecycleEvent(event, dependencies.config || runtimeState.startupConfig || {});
  if (!normalizedEvent) {
    return null;
  }

  if (emitLifecycleEvent) {
    emitLifecycleEvent(normalizedEvent);
    return normalizedEvent;
  }

  sendWorkerMessage({
    type: ACCOUNT_WORKER_MESSAGE_TYPES.LIFECYCLE_EVENT,
    event: normalizedEvent
  });
  return normalizedEvent;
}

function getWorkerLifetimeState(config = runtimeState.startupConfig) {
  if (!config || typeof config !== 'object') {
    return null;
  }

  if (!Object.prototype.hasOwnProperty.call(config, '__workerLifecycleState')) {
    Object.defineProperty(config, '__workerLifecycleState', {
      value: {
        hadAuthFailureInLifetime: false,
        hadChallengeInLifetime: false
      },
      configurable: true,
      writable: true
    });
  }

  return config.__workerLifecycleState;
}

function markWorkerLifetimeAuthFailure(config = runtimeState.startupConfig) {
  const state = getWorkerLifetimeState(config);
  if (state) {
    state.hadAuthFailureInLifetime = true;
  }
}

function markWorkerLifetimeChallenge(config = runtimeState.startupConfig) {
  const state = getWorkerLifetimeState(config);
  if (state) {
    state.hadChallengeInLifetime = true;
  }
}

function maybeEmitChallengeRecovery(config, dependencies = {}, metadata = {}) {
  const state = getWorkerLifetimeState(config);
  if (!state) {
    return null;
  }

  const recoveredFromAuthFailure = state.hadAuthFailureInLifetime === true;
  const recoveredFromChallenge = state.hadChallengeInLifetime === true;
  if (!recoveredFromAuthFailure && !recoveredFromChallenge) {
    return null;
  }

  const emittedEvent = sendWorkerLifecycleEvent({
    type: 'challenge_recovery',
    accountId: config.accountId || null,
    accountName: config.accountName || config.email || null,
    correlationId: config.workerLifetimeCorrelationId || null,
    rootCorrelationId: config.workerLifetimeCorrelationId || null,
    metadata: {
      workerId: config.workerLifetimeCorrelationId || null,
      accountEmail: config.email || null,
      ...metadata,
      recoveredFromAuthFailure,
      recoveredFromChallenge
    }
  }, dependencies);

  if (emittedEvent) {
    state.hadAuthFailureInLifetime = false;
    state.hadChallengeInLifetime = false;
  }

  return emittedEvent;
}

async function startAccountWorkerProcess() {
  runtimeState.startupConfig = loadStartupConfig(process.argv[2]);
  setProcessDelayProfile(buildDelayProfileFromSeed(runtimeState.startupConfig.delayProfileSeed));
  runtimeState.sessionRegistry = new AccountSessionRegistry();
  runtimeState.transportHealthStore = new TransportHealthStore(
    runtimeState.startupConfig.dbPath ? { dbPath: runtimeState.startupConfig.dbPath } : {}
  );
  runtimeState.context = await launchWorkerContext(runtimeState.startupConfig);

  // If the browser context is closed externally (user closes Chromium window),
  // exit the worker so the manager removes it and spawns a fresh one next run.
  runtimeState.context.on('close', () => {
    console.warn(`[worker] Browser context closed for ${runtimeState.startupConfig.email} — exiting worker`);
    runtimeState.context = null;
    runtimeState.pages.clear();
    process.exit(0);
  });

  // Send WORKER_READY as soon as the browser is launched and authenticated.
  // Feature-specific pages are created lazily when their handlers need them.
  console.log(`Worker ready for ${runtimeState.startupConfig.email}`);
  sendWorkerMessage({
    type: ACCOUNT_WORKER_MESSAGE_TYPES.WORKER_READY,
    pid: process.pid,
    accountEmail: runtimeState.startupConfig.email
  });

  // Keep startup to the main workflow page. Messaging and posting pages are
  // created lazily by their handlers, so view/like/connect opens one tab.
  initializeWorkerPages().catch((err) => {
    console.warn(`[worker] Deferred page init failed: ${err.message}`);
  });

  process.on('message', (message) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === ACCOUNT_WORKER_MESSAGE_TYPES.SHUTDOWN) {
      shutdownWorkerProcess().finally(() => {
        process.exit(0);
      });
      return;
    }

    if (message.type === ACCOUNT_WORKER_MESSAGE_TYPES.EXECUTE_STEP) {
      void handleExecuteStepMessage(message);
      return;
    }

    if (message.type === ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES) {
      void handlePollRepliesMessage(message);
      return;
    }

    if (message.type === ACCOUNT_WORKER_MESSAGE_TYPES.FETCH_INBOX_THREAD) {
      void handleFetchInboxThreadMessage(message);
      return;
    }

    if (message.type === ACCOUNT_WORKER_MESSAGE_TYPES.SEND_INBOX_REPLY) {
      void handleSendInboxReplyMessage(message);
      return;
    }

    if (message.type === ACCOUNT_WORKER_MESSAGE_TYPES.VERIFY_SESSION) {
      void handleVerifySessionMessage(message);
      return;
    }

    if (message.type === ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST) {
      void handlePublishPostMessage(message);
      return;
    }

    if (message.type === ACCOUNT_WORKER_MESSAGE_TYPES.DISCOVER_BY_SEARCH) {
      void handleDiscoverBySearchMessage(message);
      return;
    }

    if (message.type === ACCOUNT_WORKER_MESSAGE_TYPES.SEND_NEW_DM) {
      void handleSendNewDmMessage(message);
    }
  });
}

if (require.main === module) {
  // Install process-level crash handlers BEFORE boot, so any uncaught error
  // during startup (config parse, browser launch, login) gets written as a
  // JSON crash record alongside the main process's records. The log dir is
  // passed in via CONNECT_CRASH_LOG_DIR (forwarded by the spawn-env
  // allowlist); if unset (e.g. running this script standalone outside the
  // Electron app), the handler install is skipped — crashes still surface on
  // stderr the way they always did.
  if (process.env.CONNECT_CRASH_LOG_DIR) {
    installCrashHandlers({
      role: 'worker',
      logDir: process.env.CONNECT_CRASH_LOG_DIR,
      context: { workerPid: process.pid }
    });
  }
  startAccountWorkerProcess().catch((error) => {
    console.error(`Account worker startup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  startAccountWorkerProcess,
  ensureWorkerAuthentication,
  buildProfilePath,
  looksLikeChallengeState,
  maybeEmitChallengeDetected,
  verifyWorkerSession,
  runStartupDomCanaries,
  maybeRunConnectionSelectorCanaryAfterStep,
  assertExternalApiLaunchVisible,
  _private: {
    attachFingerprintMetadata,
    initializeWorkerPages,
    isUsableLinkedInPageUrl,
    loadStartupConfig,
    buildPlaywrightProxyOption,
    assertExternalApiLaunchVisible
  }
};

function loadStartupConfig(configPath) {
  if (!configPath) {
    throw new Error('Account worker startup config path is required');
  }

  let rawConfig = null;
  try {
    rawConfig = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Failed reading startup config ${configPath}: ${error.message}`);
  } finally {
    try {
      fs.unlinkSync(configPath);
    } catch (_error) {
      // Best-effort cleanup only.
    }
  }

  const parsed = JSON.parse(rawConfig);
  if (!parsed?.email || !parsed?.password) {
    throw new Error('Account worker startup config requires email and password');
  }

  const email = String(parsed.email).trim();
  const timezoneId = String(parsed.timezoneId || '').trim();
  if (!timezoneId) {
    throw new Error('Account worker startup config requires timezoneId');
  }
  const fingerprintProfileSeed = normalizeFingerprintProfileSeed(parsed.fingerprintProfileSeed, email);
  const baseFingerprintProfile = buildFingerprintProfileFromSeed(fingerprintProfileSeed);
  const sessionViewportSeed = buildFingerprintSessionSeed(fingerprintProfileSeed, Date.now());
  const fingerprintProfile = applySessionSeedToProfile(baseFingerprintProfile, sessionViewportSeed);

  return {
    accountId: parsed.accountId || null,
    accountName: parsed.accountName || null,
    email,
    workerLifetimeCorrelationId: normalizeWorkerLifetimeCorrelationId(parsed.workerLifetimeCorrelationId),
    password: String(parsed.password),
    headless: Boolean(parsed.headless),
    launchSource: String(parsed.launchSource || '').trim() || null,
    // Session-reuse-only: refuse cold password login when the stored session
    // can't be confirmed. external_api launches force this on regardless of how
    // the config was written (defense in depth); the manager also bakes in the
    // global CONNECT_NO_COLD_LOGIN opt-in via parsed.noColdLogin.
    noColdLogin: parsed.noColdLogin === true
      || String(parsed.launchSource || '').trim() === EXTERNAL_API_LAUNCH_SOURCE,
    slowMo: normalizePositiveInteger(parsed.slowMo, 50),
    locale: String(parsed.locale || 'en-US'),
    timezoneId,
    workingHours: parsed.workingHours && typeof parsed.workingHours === 'object'
      ? parsed.workingHours
      : null,
    warmUpStartedAt: String(parsed.warmUpStartedAt || '').trim() || null,
    fingerprintProfileSeed,
    fingerprintProfile,
    sessionViewportSeed,
    viewport: resolveSessionViewport(baseFingerprintProfile, sessionViewportSeed, parsed.viewport),
    profilePath: parsed.profilePath || buildProfilePath(email),
    canaryProfileUrl: String(parsed.canaryProfileUrl || '').trim() || null,
    delayProfileSeed: String(parsed.delayProfileSeed || email || '').trim().slice(0, 120) || email,
    strictStealth: parsed.strictStealth === true,
    sessionVerificationMaxAgeMs: normalizePositiveInteger(
      parsed.sessionVerificationMaxAgeMs,
      DEFAULT_SESSION_VERIFICATION_MAX_AGE_MS
    ),
    proxy: normalizeProxyConfig(parsed.proxy),
    dbPath: String(parsed.dbPath || '').trim() || null
  };
}

/**
 * Fail closed: any browser launch attributed to the external HTTP API must be
 * visible. If an external_api-sourced launch ever reaches here with anything
 * other than headless:false, refuse to open the browser. This is the last line
 * of defence behind the external-api-safety policy — if the policy is bypassed
 * upstream, the browser still never opens headless under that source.
 *
 * Throws (after an audit log) when the invariant is violated; returns silently
 * otherwise. Kept pure (no browser side-effects) so it is unit-testable offline.
 */
function assertExternalApiLaunchVisible(config = {}) {
  if (config.launchSource !== EXTERNAL_API_LAUNCH_SOURCE) return;

  if (config.headless !== false) {
    const auditMessage = `[external-api-safety] BLOCKED headless browser launch for ${config.email || 'unknown account'} `
      + `(launchSource=${config.launchSource}, headless=${JSON.stringify(config.headless)}). `
      + 'External-API automation must run visible; refusing to launch.';
    console.error(auditMessage);
    throw new Error(auditMessage);
  }

  // Positive audit trail: every allowed external-API browser launch is logged
  // with the source, the enforced visible mode, and the canonical-worker path,
  // so operators watching live tests can confirm the invariant is holding.
  console.log(
    `[external-api-safety] ALLOWED visible browser launch for ${config.email || 'unknown account'} `
    + `(launchSource=${config.launchSource} headless=false path=canonical-worker).`
  );
}

async function launchWorkerContext(config) {
  assertExternalApiLaunchVisible(config);

  ensureDirectoryExists(config.profilePath);
  const proxyLog = formatProxyForLog(config.proxy);
  console.log(`Launching persistent context for ${config.email} at ${config.profilePath} (proxy: ${proxyLog})`);

  const playwrightProxy = buildPlaywrightProxyOption(config.proxy);
  const context = await chromium.launchPersistentContext(config.profilePath, {
    headless: config.headless,
    slowMo: config.slowMo,
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: config.viewport,
    ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage'
    ]
  });

  // Once the persistent context is open, any failure before we hand it back
  // (notably the fail-closed ColdLoginBlockedError from ensureWorkerAuthentication)
  // must explicitly close the browser here. The top-level catch only logs and
  // process.exit(1)s — which usually tears the browser down, but on the safety
  // path we don't want to rely on that. Close locally, then rethrow.
  try {
    const bootstrapPage = context.pages()[0] || await context.newPage();
    attachFingerprintMetadata(bootstrapPage, config);
    await setupFingerprinting(bootstrapPage, {
      fingerprintProfile: config.fingerprintProfile
    }).catch(() => {});
    await ensureWorkerAuthentication(config, bootstrapPage);
    runtimeState.pages.set('workflowPage', attachPageLifecycle('workflowPage', bootstrapPage));
    const authenticatedUrl = await getCurrentPageUrl(bootstrapPage);
    if (!isUsableLinkedInPageUrl(authenticatedUrl)) {
      await bootstrapPage.goto(PAGE_BOOT_URLS.workflowPage, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    }

    return context;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function ensureWorkerAuthentication(config, bootstrapPage, dependencies = {}) {
  const sessionRegistry = dependencies.sessionRegistry
    || runtimeState.sessionRegistry
    || new AccountSessionRegistry();
  const verifySession = typeof dependencies.verifySession === 'function'
    ? dependencies.verifySession
    : verifyLoggedInSession;
  const performLogin = typeof dependencies.performLogin === 'function'
    ? dependencies.performLogin
    : loginToLinkedIn;
  const emitChallenge = typeof dependencies.emitChallengeDetected === 'function'
    ? dependencies.emitChallengeDetected
    : maybeEmitChallengeDetected;

  sessionRegistry.upsertAccount(config.email, {
    profilePath: config.profilePath
  });

  const shouldReauthenticate = sessionRegistry.shouldReauthenticate(config.email, {
    maxAgeMs: config.sessionVerificationMaxAgeMs
  });

  if (!shouldReauthenticate) {
    console.log(`Verifying previously confirmed LinkedIn session for ${config.email}`);
    const verifiedIndicator = await verifySession(bootstrapPage, 12000).catch(() => null);
    if (verifiedIndicator) {
      sessionRegistry.recordVerified(config.email, {
        profilePath: config.profilePath,
        verifiedBy: 'action'
      });
      sendWorkerLifecycleEvent({
        type: 'session_verified',
        accountId: config.accountId || null,
        accountName: config.accountName || config.email || null,
        correlationId: config.workerLifetimeCorrelationId || null,
        rootCorrelationId: config.workerLifetimeCorrelationId || null,
        metadata: {
          workerId: config.workerLifetimeCorrelationId || null,
          accountEmail: config.email || null,
          method: 'existing_session',
          trigger: 'startup_verify',
          verifiedBy: 'action'
        }
      }, dependencies);
      maybeEmitChallengeRecovery(config, dependencies, {
        method: 'existing_session',
        trigger: 'startup_verify',
        verifiedBy: 'action'
      });
      return bootstrapPage;
    }

    const verifyFallbackReason = 'Existing LinkedIn session could not be re-verified at worker startup';
    sessionRegistry.recordAuthFailure(config.email, {
      profilePath: config.profilePath,
      error: verifyFallbackReason
    });
    markWorkerLifetimeAuthFailure(config);
    sendWorkerLifecycleEvent({
      type: 'auth_failure',
      accountId: config.accountId || null,
      accountName: config.accountName || config.email || null,
      correlationId: config.workerLifetimeCorrelationId || null,
      rootCorrelationId: config.workerLifetimeCorrelationId || null,
      metadata: {
        workerId: config.workerLifetimeCorrelationId || null,
        accountEmail: config.email || null,
        trigger: 'startup_verify',
        reason: 'verify_failed_fallback',
        detail: verifyFallbackReason
      }
    }, dependencies);
  }

  const loginTrigger = shouldReauthenticate ? 'startup_reauthenticate' : 'startup_verify_fallback';

  // Fail-closed cold-login guard. In session-reuse-only mode the worker must
  // never fall back to an automated password login when the stored session is
  // stale or unconfirmed — that is the cold automated login we forbid during
  // API/live testing. external_api launches are always in this mode; a global
  // CONNECT_NO_COLD_LOGIN opt-in extends it to native launches too (both are
  // resolved into config.noColdLogin upstream). Refuse, surface a clear
  // "manual re-auth required" auth_failure, and throw so worker startup fails
  // closed instead of typing the password into LinkedIn.
  if (config.noColdLogin) {
    const detail = shouldReauthenticate ? 'session_verification_stale' : 'session_reuse_unconfirmed';
    const message = `[no-cold-login] Refusing automated password login for ${config.email || 'unknown account'} `
      + `(reason=${detail}, launchSource=${config.launchSource || 'native'}). Session-reuse-only mode is active; `
      + 'manual re-authentication is required.';
    console.error(message);
    sessionRegistry.recordAuthFailure(config.email, {
      profilePath: config.profilePath,
      error: message
    });
    markWorkerLifetimeAuthFailure(config);
    sendWorkerLifecycleEvent({
      type: 'auth_failure',
      accountId: config.accountId || null,
      accountName: config.accountName || config.email || null,
      correlationId: config.workerLifetimeCorrelationId || null,
      rootCorrelationId: config.workerLifetimeCorrelationId || null,
      metadata: {
        workerId: config.workerLifetimeCorrelationId || null,
        accountEmail: config.email || null,
        trigger: loginTrigger,
        reason: 'cold_login_blocked',
        detail
      }
    }, dependencies);
    const err = new Error(message);
    err.name = 'ColdLoginBlockedError';
    err.code = 'cold_login_blocked';
    throw err;
  }

  sendWorkerLifecycleEvent({
    type: 'login_attempt',
    accountId: config.accountId || null,
    accountName: config.accountName || config.email || null,
    correlationId: config.workerLifetimeCorrelationId || null,
    rootCorrelationId: config.workerLifetimeCorrelationId || null,
    metadata: {
      workerId: config.workerLifetimeCorrelationId || null,
      accountEmail: config.email || null,
      trigger: loginTrigger
    }
  }, dependencies);

  console.log(`Logging into LinkedIn for ${config.email}`);
  try {
    await performLogin(bootstrapPage, config.email, config.password, {
      strictStealth: config.strictStealth === true
    });
    sessionRegistry.recordVerified(config.email, {
      profilePath: config.profilePath,
      verifiedBy: 'login'
    });
    sendWorkerLifecycleEvent({
      type: 'session_verified',
      accountId: config.accountId || null,
      accountName: config.accountName || config.email || null,
      correlationId: config.workerLifetimeCorrelationId || null,
      rootCorrelationId: config.workerLifetimeCorrelationId || null,
      metadata: {
        workerId: config.workerLifetimeCorrelationId || null,
        accountEmail: config.email || null,
        method: 'login',
        trigger: loginTrigger,
        verifiedBy: 'login'
      }
    }, dependencies);
    maybeEmitChallengeRecovery(config, dependencies, {
      method: 'login',
      trigger: loginTrigger,
      verifiedBy: 'login'
    });
    return bootstrapPage;
  } catch (error) {
    sessionRegistry.recordAuthFailure(config.email, {
      profilePath: config.profilePath,
      error: error?.message || String(error)
    });
    markWorkerLifetimeAuthFailure(config);
    sendWorkerLifecycleEvent({
      type: 'auth_failure',
      accountId: config.accountId || null,
      accountName: config.accountName || config.email || null,
      correlationId: config.workerLifetimeCorrelationId || null,
      rootCorrelationId: config.workerLifetimeCorrelationId || null,
      metadata: {
        workerId: config.workerLifetimeCorrelationId || null,
        accountEmail: config.email || null,
        trigger: loginTrigger,
        reason: error?.message || String(error)
      }
    }, dependencies);

    const currentUrl = await getCurrentPageUrl(bootstrapPage);
    if (looksLikeChallengeState(error, currentUrl)) {
      await emitChallenge({
        error,
        currentUrl,
        source: 'worker_startup_login',
        accountEmail: config.email,
        accountId: config.accountId || null,
        accountName: config.accountName || config.email || null,
        profilePath: config.profilePath || null,
        sessionRegistry
      });
    }
    throw error;
  }
}

async function initializeWorkerPages(dependencies = {}) {
  const ensurePage = dependencies.ensureRuntimePage || ensureRuntimePage;
  await ensurePage('workflowPage');
}

async function runStartupDomCanaries(config, dependencies = {}) {
  const transportHealthStore = dependencies.transportHealthStore
    || runtimeState.transportHealthStore
    || new TransportHealthStore();
  // Startup canaries must never share the live workflow tab. The worker sends
  // WORKER_READY before deferred canaries begin, so navigating workflowPage
  // here races the first durable step and can abort or visibly reload the
  // prospect page. Use a short-lived isolated tab in production; tests and
  // explicit callers can still inject a page directly.
  const injectedPage = dependencies.workflowPage || dependencies.page || null;
  const context = dependencies.context || runtimeState.context || null;
  let canaryPage = injectedPage;
  let ownsCanaryPage = false;

  if (!canaryPage && context && typeof context.newPage === 'function') {
    canaryPage = await context.newPage();
    ownsCanaryPage = true;
    attachFingerprintMetadata(canaryPage, config || {});
    await setupFingerprinting(canaryPage, {
      fingerprintProfile: config?.fingerprintProfile || null
    }).catch(() => {});
    await canaryPage.goto(LINKEDIN_FEED_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
  }
  const emitLog = typeof dependencies.emitLog === 'function'
    ? dependencies.emitLog
    : (entry = {}) => {
        sendWorkerLog(
          null,
          entry.level || 'info',
          entry.message || '',
          entry.source || 'selector-canary',
          entry.metadata || {}
        );
      };
  const runCanary = typeof dependencies.runConnectionSelectorCanary === 'function'
    ? dependencies.runConnectionSelectorCanary
    : runConnectionSelectorCanary;

  try {
    return await runCanary({
      accountEmail: config?.email || null,
      email: config?.email || null,
      canaryProfileUrl: config?.canaryProfileUrl || null,
      workflowPage: canaryPage,
      transportHealthStore
    }, {
      emitLog
    });
  } finally {
    if (ownsCanaryPage && canaryPage && typeof canaryPage.close === 'function') {
      await canaryPage.close().catch(() => {});
    }
  }
}

async function maybeRunConnectionSelectorCanaryAfterStep(stepType, stepResult, dependencies = {}) {
  if (String(stepType || '').trim() !== 'send_connection') {
    return null;
  }

  const config = dependencies.config || runtimeState.startupConfig || {};
  const transportHealthStore = dependencies.transportHealthStore
    || runtimeState.transportHealthStore
    || null;
  const workflowPage = dependencies.workflowPage || runtimeState.pages.get('workflowPage') || null;
  const emitLog = typeof dependencies.emitLog === 'function'
    ? dependencies.emitLog
    : (entry = {}) => {
        sendWorkerLog(
          null,
          entry.level || 'info',
          entry.message || '',
          entry.source || 'selector-canary',
          entry.metadata || {}
        );
      };
  const shouldRerun = typeof dependencies.shouldRerunConnectionSelectorCanary === 'function'
    ? dependencies.shouldRerunConnectionSelectorCanary
    : shouldRerunConnectionSelectorCanary;
  const runCanary = typeof dependencies.runConnectionSelectorCanary === 'function'
    ? dependencies.runConnectionSelectorCanary
    : runConnectionSelectorCanary;

  const accountEmail = config?.email || null;
  if (!accountEmail || !shouldRerun(transportHealthStore, accountEmail)) {
    return null;
  }

  return runCanary({
    accountEmail,
    email: accountEmail,
    canaryProfileUrl: config?.canaryProfileUrl || null,
    workflowPage,
    transportHealthStore
  }, {
    emitLog
  });
}

async function ensureRuntimePage(pageName) {
  const existingPage = runtimeState.pages.get(pageName);
  if (existingPage && typeof existingPage.isClosed === 'function' && !existingPage.isClosed()) {
    return existingPage;
  }

  const context = runtimeState.context;
  if (!context) {
    throw new Error(`Cannot initialize ${pageName} before browser context is ready`);
  }

  const page = pageName === 'workflowPage' && existingPage
    ? existingPage
    : await context.newPage();
  attachFingerprintMetadata(page, runtimeState.startupConfig || {});
  await setupFingerprinting(page, {
    fingerprintProfile: runtimeState.startupConfig?.fingerprintProfile || null
  }).catch(() => {});
  const trackedPage = attachPageLifecycle(pageName, page);
  runtimeState.pages.set(pageName, trackedPage);
  await trackedPage.goto(PAGE_BOOT_URLS[pageName], {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  return trackedPage;
}

function attachPageLifecycle(pageName, page) {
  if (!page || typeof page.on !== 'function') {
    return page;
  }

  page.on('crash', () => {
    console.error(`${pageName} crashed; it will be recreated on next access`);
    runtimeState.pages.delete(pageName);
  });

  page.on('close', () => {
    runtimeState.pages.delete(pageName);
  });

  return page;
}

function attachFingerprintMetadata(page, config = {}) {
  if (!page || typeof page !== 'object') {
    return page;
  }

  const fingerprintProfile = config.fingerprintProfile || null;
  const viewport = config.viewport || null;
  const strictStealth = config.strictStealth === true;
  const timezoneId = String(config.timezoneId || '').trim() || null;

  try {
    Object.defineProperty(page, '__connectFingerprintProfile', {
      value: fingerprintProfile,
      configurable: true,
      writable: true
    });
  } catch (_) {
    page.__connectFingerprintProfile = fingerprintProfile;
  }

  try {
    Object.defineProperty(page, '__connectViewport', {
      value: viewport,
      configurable: true,
      writable: true
    });
  } catch (_) {
    page.__connectViewport = viewport;
  }

  try {
    Object.defineProperty(page, '__connectTimezoneId', {
      value: timezoneId,
      configurable: true,
      writable: true
    });
  } catch (_) {
    page.__connectTimezoneId = timezoneId;
  }

  try {
    Object.defineProperty(page, '__connectStrictStealth', {
      value: strictStealth,
      configurable: true,
      writable: true
    });
  } catch (_) {
    page.__connectStrictStealth = strictStealth;
  }

  return page;
}

function isUsableLinkedInPageUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\//i.test(url)) return false;
  return !/\/(?:login|uas\/login|checkpoint|challenge)\b/i.test(url);
}

async function shutdownWorkerProcess() {
  const pages = Array.from(runtimeState.pages.values());
  runtimeState.pages.clear();
  for (const page of pages) {
    if (page && typeof page.isClosed === 'function' && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  }

  if (runtimeState.context) {
    await runtimeState.context.close().catch(() => {});
    runtimeState.context = null;
  }
}

function buildProfilePath(email) {
  const emailHash = crypto.createHash('sha256')
    .update(String(email || '').trim().toLowerCase())
    .digest('hex');
  const nextPath = path.join(getConnectAbilityAppStateDir(), 'profiles', emailHash);
  const legacyPath = path.join(getConnectAbilityDocumentsDir(), 'profiles', emailHash);

  if (fs.existsSync(nextPath) || !fs.existsSync(legacyPath)) {
    return nextPath;
  }

  try {
    ensureDirectoryExists(path.dirname(nextPath));
    fs.renameSync(legacyPath, nextPath);
    return nextPath;
  } catch (_) {
    return legacyPath;
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeWorkerLifetimeCorrelationId(value) {
  const normalized = String(value || '').trim().slice(0, 160);
  return normalized || null;
}

async function getCurrentPageUrl(page) {
  if (!page || typeof page.url !== 'function') {
    return '';
  }
  try {
    const value = page.url();
    if (value && typeof value.then === 'function') {
      return String(await value);
    }
    return String(value || '');
  } catch (_) {
    return '';
  }
}

function looksLikeChallengeState(error, currentUrl = '') {
  const message = String(error?.message || error || '').toLowerCase();
  if (/challenge|checkpoint|security|verification|captcha|restricted/.test(message)) {
    return true;
  }
  return /linkedin\.com\/(?:checkpoint\/|challenge)/i.test(String(currentUrl || '').trim());
}

function normalizeWorkerLifecycleEvent(eventInput, config = {}) {
  if (!eventInput || typeof eventInput !== 'object') {
    return null;
  }

  const type = String(eventInput.type || '').trim();
  if (!type) {
    return null;
  }

  const correlationId = normalizeWorkerLifetimeCorrelationId(
    eventInput.correlationId
    || eventInput.rootCorrelationId
    || config.workerLifetimeCorrelationId
  );

  return {
    ...eventInput,
    type,
    accountId: String(eventInput.accountId || config.accountId || '').trim() || null,
    accountName: String(eventInput.accountName || config.accountName || config.email || '').trim() || null,
    correlationId,
    rootCorrelationId: normalizeWorkerLifetimeCorrelationId(
      eventInput.rootCorrelationId
      || correlationId
    ),
    metadata: {
      ...(eventInput.metadata && typeof eventInput.metadata === 'object' ? eventInput.metadata : {}),
      workerId: normalizeWorkerLifetimeCorrelationId(
        eventInput.metadata?.workerId
        || correlationId
      ),
      accountEmail: String(
        eventInput.metadata?.accountEmail
        || config.email
        || ''
      ).trim() || null
    }
  };
}

async function maybeEmitChallengeDetected(input = {}, dependencies = {}) {
  const errorInput = input?.error ?? input?.reason ?? null;
  const currentUrl = input?.currentUrl || '';
  if (!looksLikeChallengeState(errorInput, currentUrl)) {
    return null;
  }

  const config = dependencies.config || runtimeState.startupConfig || {};
  const sessionRegistry = dependencies.sessionRegistry || input.sessionRegistry || runtimeState.sessionRegistry || null;
  const accountEmail = String(input.accountEmail || config.email || '').trim().toLowerCase() || null;
  const accountId = input.accountId || config.accountId || null;
  const accountName = input.accountName || config.accountName || accountEmail || null;
  const profilePath = input.profilePath || config.profilePath || null;
  const detectedAt = new Date().toISOString();
  const reason = String(errorInput?.message || errorInput || 'LinkedIn challenge detected').trim();
  const source = String(input.source || 'worker').trim() || 'worker';
  const jobId = input.jobId || null;

  if (sessionRegistry && accountEmail && typeof sessionRegistry.recordChallenge === 'function') {
    sessionRegistry.recordChallenge(accountEmail, {
      profilePath,
      at: detectedAt
    });
  }
  markWorkerLifetimeChallenge(config);

  sendWorkerLog(jobId, 'warning', `LinkedIn challenge detected for ${accountName}.`, source, {
    currentUrl: currentUrl || null,
    reason
  });

  const payload = {
    type: ACCOUNT_WORKER_MESSAGE_TYPES.CHALLENGE_DETECTED,
    accountId,
    accountName,
    accountEmail,
    currentUrl: currentUrl || null,
    source,
    reason,
    detectedAt
  };
  sendWorkerMessage(payload);
  return payload;
}

async function verifyWorkerSession(page, dependencies = {}) {
  const config = dependencies.config || runtimeState.startupConfig || {};
  const sessionRegistry = dependencies.sessionRegistry
    || runtimeState.sessionRegistry
    || new AccountSessionRegistry();
  const verifySession = typeof dependencies.verifySession === 'function'
    ? dependencies.verifySession
    : verifyLoggedInSession;
  const emitChallenge = typeof dependencies.emitChallengeDetected === 'function'
    ? dependencies.emitChallengeDetected
    : maybeEmitChallengeDetected;

  const accountEmail = String(config.email || '').trim().toLowerCase() || null;
  const accountId = config.accountId || null;
  const accountName = config.accountName || accountEmail || null;
  const profilePath = config.profilePath || null;
  const workerLifetimeCorrelationId = config.workerLifetimeCorrelationId || null;
  const verifiedAt = new Date().toISOString();
  const indicator = await verifySession(page, 12000).catch(() => null);

  if (indicator) {
    if (sessionRegistry && accountEmail && typeof sessionRegistry.recordVerified === 'function') {
      sessionRegistry.recordVerified(accountEmail, {
        at: verifiedAt,
        profilePath,
        verifiedBy: 'action'
      });
    }
    sendWorkerLifecycleEvent({
      type: 'session_verified',
      accountId,
      accountName,
      correlationId: workerLifetimeCorrelationId,
      rootCorrelationId: workerLifetimeCorrelationId,
      metadata: {
        workerId: workerLifetimeCorrelationId,
        accountEmail,
        method: 'existing_session',
        trigger: 'runtime_verify',
        verifiedBy: 'action'
      }
    }, dependencies);
    maybeEmitChallengeRecovery(config, dependencies, {
      method: 'existing_session',
      trigger: 'runtime_verify',
      verifiedBy: 'action'
    });
    return {
      ok: true,
      verifiedAt,
      indicator
    };
  }

  const currentUrl = await getCurrentPageUrl(page);
  const errorMessage = 'LinkedIn session could not be verified';

  if (sessionRegistry && accountEmail && typeof sessionRegistry.recordAuthFailure === 'function') {
    sessionRegistry.recordAuthFailure(accountEmail, {
      at: verifiedAt,
      profilePath,
      error: errorMessage
    });
  }

  markWorkerLifetimeAuthFailure(config);
  sendWorkerLifecycleEvent({
    type: 'auth_failure',
    accountId,
    accountName,
    correlationId: workerLifetimeCorrelationId,
    rootCorrelationId: workerLifetimeCorrelationId,
    metadata: {
      workerId: workerLifetimeCorrelationId,
      accountEmail,
      trigger: 'runtime_verify',
      reason: errorMessage,
      currentUrl: currentUrl || null
    }
  }, dependencies);

  await emitChallenge({
    reason: errorMessage,
    currentUrl,
    source: 'verify_session',
    accountEmail,
    accountId,
    accountName,
    profilePath
  }, {
    sessionRegistry,
    config
  });

  return {
    ok: false,
    verifiedAt,
    indicator: null,
    currentUrl: currentUrl || null,
    error: errorMessage
  };
}

async function handleExecuteStepMessage(message = {}) {
  const jobId = message.jobId || null;
  const stepType = String(message.stepType || message.step?.type || '').trim() || null;
  const targetLabel = message.targetLabel || message.targetValue || 'target';
  let page = null;

  try {
    page = await ensureRuntimePage('workflowPage');
    sendWorkerLog(jobId, 'info', `Executing ${stepType || 'workflow'} step for ${targetLabel}.`, 'workflow-worker', {
      stepType,
      targetId: message.targetId || null
    });

    // P5 observability will thread job-scoped correlation through deeper action-module logs.
    // For now, only top-level worker lifecycle logs cross IPC; nested legacy logs still flow via stdout/stderr.
    const stepResult = await executeWorkflowStep(page, {
      targetValue: message.targetValue,
      targetLabel: message.targetLabel,
      prospectId: message.prospectId || null,
      accountId: message.accountId || runtimeState.startupConfig?.accountId || null,
      accountName: message.accountName || runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null,
      accountEmail: runtimeState.startupConfig?.email || null,
      email: runtimeState.startupConfig?.email || null,
      timezoneId: runtimeState.startupConfig?.timezoneId || null,
      workingHours: runtimeState.startupConfig?.workingHours || null,
      warmUpStartedAt: runtimeState.startupConfig?.warmUpStartedAt || null,
      strictStealth: runtimeState.startupConfig?.strictStealth === true,
      // Manual-launch runs flag this on the EXECUTE_STEP message so the
      // action-router skips its per-step working-hours guard.
      bypassWorkingHours: !!message.bypassWorkingHours,
      agentId: message.agentId || null,
      agentName: message.agentName || null,
      step: message.step,
      stepIndex: message.stepIndex
    }, {
      transportHealthStore: runtimeState.transportHealthStore
    });
    await maybeRunConnectionSelectorCanaryAfterStep(stepType, stepResult);

    if (stepResult && isWorkflowResultFailure(stepResult)) {
      const currentUrl = await getCurrentPageUrl(page);
      await maybeEmitChallengeDetected({
        reason: stepResult.reason || null,
        currentUrl,
        source: 'workflow_step_result',
        jobId,
        accountEmail: runtimeState.startupConfig?.email || null,
        accountId: runtimeState.startupConfig?.accountId || null,
        accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null
      });
    }

    sendWorkerLog(jobId, 'info', `Completed ${stepType || 'workflow'} step for ${targetLabel} with outcome ${stepResult?.outcomeType || 'unknown'}.`, 'workflow-worker', {
      stepType,
      outcomeType: stepResult?.outcomeType || null
    });
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.STEP_RESULT,
      jobId,
      stepResult: stepResult || null
    });
  } catch (error) {
    const currentUrl = await getCurrentPageUrl(page);
    await maybeEmitChallengeDetected({
      error,
      currentUrl,
      source: 'workflow_step_exception',
      jobId,
      accountEmail: runtimeState.startupConfig?.email || null,
      accountId: runtimeState.startupConfig?.accountId || null,
      accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null
    });
    sendWorkerLog(jobId, 'error', `Workflow step failed: ${error.message}`, 'workflow-worker', {
      stepType
    });
    // Structured error metadata for 429/Retry-After-aware cooldown handling
    // upstream. Optional fields — main reads errorMeta when present and
    // falls back to message-string parsing when not. See
    // automation/safety/retry-after.js for the consumer contract.
    const errorMeta = buildErrorMeta(error);
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.STEP_RESULT,
      jobId,
      stepResult: createWorkflowStepResult({
        stepType,
        outcomeType: 'failed_transient',
        reason: error.message,
        profileUrl: message.targetValue || null,
        recipientName: message.targetLabel || message.targetValue || null
      }),
      ...(errorMeta ? { errorMeta } : {})
    });
  }
}

async function handlePollRepliesMessage(message = {}) {
  const requestId = message.requestId || null;
  let page = null;

  try {
    page = await ensureRuntimePage('messagingPage');
    const pollResult = await pollMessagingReplies({
      page,
      context: runtimeState.context,
      initialized: message.initialized === true,
      conversationStates: message.conversationStates
    });

    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT,
      requestId,
      pollResult
    });
  } catch (error) {
    const currentUrl = await getCurrentPageUrl(page);
    await maybeEmitChallengeDetected({
      error,
      currentUrl,
      source: 'reply_poll',
      jobId: requestId,
      accountEmail: runtimeState.startupConfig?.email || null,
      accountId: runtimeState.startupConfig?.accountId || null,
      accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null
    });
    sendWorkerLog(requestId, 'error', `Reply poll failed: ${error.message}`, 'reply-monitor-worker');
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT,
      requestId,
      error: error.message || String(error),
      pollResult: null
    });
  }
}

async function handlePublishPostMessage(message = {}) {
  const requestId = message.requestId || null;
  let page = null;

  try {
    page = await ensureRuntimePage('postingPage');
    const postConfig = message.postConfig || {};

    if (!postConfig?.content || !String(postConfig.content).trim()) {
      throw new Error('Post content is required');
    }

    sendWorkerLog(requestId, 'info', 'Starting LinkedIn post publish via worker...', 'posting-worker');

    const workerEmitLog = (entry) => {
      const msgText = typeof entry === 'string' ? entry : entry?.message;
      const level = typeof entry === 'object' ? (entry?.type || 'info') : 'info';
      if (msgText) {
        sendWorkerLog(requestId, level, String(msgText), 'posting-worker');
      }
    };

    const publishResult = await executePostOnPage(
      page,
      postConfig,
      runtimeState.startupConfig,
      workerEmitLog
    );

    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT,
      requestId,
      publishResult
    });
  } catch (error) {
    const currentUrl = await getCurrentPageUrl(page);
    await maybeEmitChallengeDetected({
      error,
      currentUrl,
      source: 'publish_post',
      jobId: requestId,
      accountEmail: runtimeState.startupConfig?.email || null,
      accountId: runtimeState.startupConfig?.accountId || null,
      accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null
    });
    sendWorkerLog(requestId, 'error', `Post publishing failed: ${error.message}`, 'posting-worker');
    // Same errorMeta carry-through as STEP_RESULT — Retry-After-aware
    // cooldown decisions on main need the structured fields when the
    // error came from a LinkedIn API throw.
    const errorMeta = buildErrorMeta(error);
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.PUBLISH_POST_RESULT,
      requestId,
      error: error.message || String(error),
      publishResult: null,
      ...(errorMeta ? { errorMeta } : {})
    });
  }
}

// Runs a LinkedIn people-search inside the worker's existing persistent
// browser session so discovery and per-step execution happen in one window.
async function handleDiscoverBySearchMessage(message = {}) {
  const requestId = message.requestId || null;
  const term = String(message.searchTerm || '').trim();
  const maxResults = Math.max(1, Math.min(50, Number(message.maxResults) || 10));
  const maxPages = Math.max(1, Math.min(5, Number(message.maxPages) || 3));
  let page = null;

  try {
    if (!term) throw new Error('searchTerm is required');

    page = await ensureRuntimePage('workflowPage');
    sendWorkerLog(requestId, 'info', `Searching LinkedIn for "${term}"…`, 'discovery-worker');

    const { humanLikeSearch } = require('../search/search');
    const searchOk = await humanLikeSearch(page, term, {});
    if (!searchOk) {
      throw new Error('LinkedIn search failed — session may have been redirected to login.');
    }

    await new Promise((r) => setTimeout(r, 2500));

    const { buildPeopleSearchProfiles, waitForPeopleSearchCandidatesFromPage, describePeopleSearchPage } = require('../search/people-search-results');
    const candidates = [];
    // Built incrementally each page; the unique-profile count (not a raw URL
    // list) gates both the page loop and the early break, so we stop as soon as
    // we have maxResults distinct People-results profiles.
    let profiles = [];
    for (let pageIdx = 1; pageIdx <= maxPages && profiles.length < maxResults; pageIdx++) {
      const searchPageUrl = typeof page.url === 'function'
        ? await Promise.resolve().then(() => page.url()).catch(() => '')
        : '';
      const pageCandidates = await waitForPeopleSearchCandidatesFromPage(page, {
        timeoutMs: 12000,
        intervalMs: 500
      });
      for (const candidate of pageCandidates) {
        candidates.push({
          ...candidate,
          searchPageUrl,
          searchPageIndex: pageIdx
        });
      }
      profiles = buildPeopleSearchProfiles(candidates, {
        searchTerm: term,
        maxResults
      });

      sendWorkerLog(requestId, 'info', `Page ${pageIdx}: ${pageCandidates.length} People results · ${profiles.length} unique so far`, 'discovery-worker');

      // Diagnostic: extraction found nothing on a page that should have results.
      // Dump the live DOM shape to stdout (worker console.log reaches the app
      // log) so the real result-card container can be identified precisely.
      if (pageCandidates.length === 0) {
        try {
          const diag = await describePeopleSearchPage(page);
          console.log(`[search-diagnostic] page ${pageIdx}: ${JSON.stringify(diag)}`);
        } catch (diagErr) {
          console.log(`[search-diagnostic] failed: ${diagErr && diagErr.message}`);
        }
      }

      if (profiles.length >= maxResults || pageIdx >= maxPages) break;
      const next = await page.$('button[aria-label="Next"]');
      if (!next) break;
      await next.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Final rebuild from the full candidate set — keeps order/rank deterministic
    // regardless of how the loop terminated.
    profiles = buildPeopleSearchProfiles(candidates, {
      searchTerm: term,
      maxResults
    });
    const trimmed = profiles.map((profile) => profile.profileUrl);
    sendWorkerLog(requestId, 'info', `Found ${trimmed.length} profiles for "${term}"`, 'discovery-worker');
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.DISCOVER_BY_SEARCH_RESULT,
      requestId,
      success: true,
      urls: trimmed,
      profiles,
      count: trimmed.length,
      searchTerm: term,
      searchPageUrl: profiles[0]?.searchPageUrl || null
    });
  } catch (error) {
    const currentUrl = await getCurrentPageUrl(page);
    await maybeEmitChallengeDetected({
      error,
      currentUrl,
      source: 'discover_by_search',
      jobId: requestId,
      accountEmail: runtimeState.startupConfig?.email || null,
      accountId: runtimeState.startupConfig?.accountId || null,
      accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null
    });
    sendWorkerLog(requestId, 'error', `LinkedIn search failed: ${error.message}`, 'discovery-worker');
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.DISCOVER_BY_SEARCH_RESULT,
      requestId,
      success: false,
      error: error.message || String(error),
      urls: [],
    });
  }
}

// Operator-initiated direct message — opens the recipient's profile in the
// worker's existing browser session and sends a one-off DM using the same
// orchestrator the workflow runtime uses.
async function handleSendNewDmMessage(message = {}) {
  const requestId = message.requestId || null;
  const profileUrl = String(message.profileUrl || '').trim();
  const messageBody = String(message.message || '').trim();
  const recipientName = String(message.recipientName || '').trim() || null;
  let page = null;

  try {
    if (!profileUrl) throw new Error('profileUrl is required');
    if (!messageBody) throw new Error('message body is required');

    page = await ensureRuntimePage('workflowPage');
    sendWorkerLog(requestId, 'info', `Sending DM to ${recipientName || profileUrl}…`, 'compose-dm');

    const { sendLinkedInMessage } = require('../messaging/orchestrator');
    const dmResult = await sendLinkedInMessage(page, profileUrl, messageBody, {
      checkHistory: false,
      useMessagingDrawer: false,
      recipientName,
      accountId: runtimeState.startupConfig?.accountId || null,
      accountEmail: runtimeState.startupConfig?.email || null,
      accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null,
      warmUpStartedAt: runtimeState.startupConfig?.warmUpStartedAt || null,
      strictStealth: runtimeState.startupConfig?.strictStealth === true,
      timezoneId: runtimeState.startupConfig?.timezoneId || null,
    });

    if (!dmResult || dmResult.success !== true) {
      throw new Error((dmResult && (dmResult.reason || dmResult.error)) || 'DM send failed');
    }

    sendWorkerLog(requestId, 'success', `DM delivered to ${recipientName || profileUrl}`, 'compose-dm');
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.SEND_NEW_DM_RESULT,
      requestId,
      success: true,
      profileUrl,
      recipientName: recipientName || (dmResult && dmResult.recipientName) || null,
      conversationUrn: (dmResult && dmResult.conversationUrn) || null,
      messagePreview: messageBody.slice(0, 160),
    });
  } catch (error) {
    const currentUrl = await getCurrentPageUrl(page);
    await maybeEmitChallengeDetected({
      error,
      currentUrl,
      source: 'send_new_dm',
      jobId: requestId,
      accountEmail: runtimeState.startupConfig?.email || null,
      accountId: runtimeState.startupConfig?.accountId || null,
      accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null
    });
    sendWorkerLog(requestId, 'error', `DM send failed: ${error.message || String(error)}`, 'compose-dm');
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.SEND_NEW_DM_RESULT,
      requestId,
      success: false,
      error: error.message || String(error),
      profileUrl,
    });
  }
}

async function handleVerifySessionMessage(message = {}) {
  const requestId = message.requestId || null;
  let page = null;

  try {
    page = await ensureRuntimePage('workflowPage');
    const result = await verifyWorkerSession(page, {
      requestId
    });

    if (!result.ok) {
      sendWorkerLog(requestId, 'warning', result.error || 'LinkedIn session verification failed.', 'workflow-worker', {
        currentUrl: result.currentUrl || null
      });
    }

    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.VERIFY_SESSION_RESULT,
      requestId,
      ...result
    });
  } catch (error) {
    const currentUrl = await getCurrentPageUrl(page);
    await maybeEmitChallengeDetected({
      error,
      currentUrl,
      source: 'verify_session',
      jobId: requestId,
      accountEmail: runtimeState.startupConfig?.email || null,
      accountId: runtimeState.startupConfig?.accountId || null,
      accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null
    });
    sendWorkerLog(requestId, 'error', `Session verification failed: ${error.message}`, 'workflow-worker', {
      currentUrl: currentUrl || null
    });
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.VERIFY_SESSION_RESULT,
      requestId,
      ok: false,
      verifiedAt: new Date().toISOString(),
      indicator: null,
      currentUrl: currentUrl || null,
      error: error.message || String(error)
    });
  }
}

async function handleFetchInboxThreadMessage(message = {}) {
  const requestId = message.requestId || null;
  let page = null;

  try {
    page = await ensureRuntimePage('messagingPage');
    const thread = await fetchConversationThread({
      page,
      context: runtimeState.context,
      conversationUrn: message.conversationUrn,
      mailboxUrn: message.mailboxUrn || null
    });

    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.FETCH_INBOX_THREAD_RESULT,
      requestId,
      thread
    });
  } catch (error) {
    const currentUrl = await getCurrentPageUrl(page);
    await maybeEmitChallengeDetected({
      error,
      currentUrl,
      source: 'fetch_inbox_thread',
      jobId: requestId,
      accountEmail: runtimeState.startupConfig?.email || null,
      accountId: runtimeState.startupConfig?.accountId || null,
      accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null
    });
    sendWorkerLog(requestId, 'error', `Inbox thread fetch failed: ${error.message}`, 'messaging-worker');
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.FETCH_INBOX_THREAD_RESULT,
      requestId,
      error: error.message || String(error),
      thread: null
    });
  }
}

async function handleSendInboxReplyMessage(message = {}) {
  const requestId = message.requestId || null;
  let page = null;

  try {
    page = await ensureRuntimePage('messagingPage');
    const replyResult = await sendConversationReply({
      page,
      context: runtimeState.context,
      conversationUrn: message.conversationUrn,
      mailboxUrn: message.mailboxUrn || null,
      recipientProfileUrn: message.recipientProfileUrn || null,
      text: message.text || ''
    });

    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.SEND_INBOX_REPLY_RESULT,
      requestId,
      replyResult
    });
  } catch (error) {
    const currentUrl = await getCurrentPageUrl(page);
    await maybeEmitChallengeDetected({
      error,
      currentUrl,
      source: 'send_inbox_reply',
      jobId: requestId,
      accountEmail: runtimeState.startupConfig?.email || null,
      accountId: runtimeState.startupConfig?.accountId || null,
      accountName: runtimeState.startupConfig?.accountName || runtimeState.startupConfig?.email || null
    });
    sendWorkerLog(requestId, 'error', `Inbox reply failed: ${error.message}`, 'messaging-worker');
    sendWorkerMessage({
      type: ACCOUNT_WORKER_MESSAGE_TYPES.SEND_INBOX_REPLY_RESULT,
      requestId,
      error: error.message || String(error),
      replyResult: null
    });
  }
}

function sendWorkerLog(jobId, level, message, source = 'workflow-worker', metadata = {}) {
  sendWorkerMessage({
    type: ACCOUNT_WORKER_MESSAGE_TYPES.LOG,
    jobId: jobId || null,
    level: String(level || 'info').trim().toLowerCase() || 'info',
    message: String(message || '').trim(),
    source,
    metadata: metadata && typeof metadata === 'object' ? metadata : {}
  });
}

function isWorkflowResultFailure(stepResult) {
  return /^failed_/i.test(String(stepResult?.outcomeType || '').trim());
}
