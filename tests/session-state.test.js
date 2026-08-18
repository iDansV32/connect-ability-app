'use strict';

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createTempWorkspace, writeJson } = require('./test-helpers');

const SESSION_MODULE_PATH = require.resolve('../automation/core/session-state');
const ACCOUNT_SESSION_REGISTRY_MODULE_PATH = require.resolve('../automation/runtime/account-session-registry');

function loadSessionStateModule() {
  delete require.cache[SESSION_MODULE_PATH];
  return require(SESSION_MODULE_PATH);
}

function loadAccountSessionRegistryModule() {
  delete require.cache[ACCOUNT_SESSION_REGISTRY_MODULE_PATH];
  return require(ACCOUNT_SESSION_REGISTRY_MODULE_PATH);
}

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

    delete require.cache[SESSION_MODULE_PATH];
    delete require.cache[ACCOUNT_SESSION_REGISTRY_MODULE_PATH];
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

test('getLinkedInSessionStatePath isolates storage by account email', () => {
  const workspace = createTempWorkspace('session-state-path-');
  try {
    withTempHome(workspace, () => {
      const sessionState = loadSessionStateModule();
      const appStateDir = getExpectedAppStateDir(workspace);

      const firstPath = sessionState.getLinkedInSessionStatePath('alice@example.com');
      const secondPath = sessionState.getLinkedInSessionStatePath('bob@example.com');

      assert.notEqual(firstPath, secondPath);
      assert.equal(
        firstPath,
        path.join(appStateDir, 'sessions', 'linkedin-storage-state-alice-example-com.json')
      );
      assert.equal(
        secondPath,
        path.join(appStateDir, 'sessions', 'linkedin-storage-state-bob-example-com.json')
      );
    });
  } finally {
    workspace.cleanup();
  }
});

test('readLinkedInSessionState migrates legacy Documents storage into app-state on first read', () => {
  const workspace = createTempWorkspace('session-state-migrate-');
  try {
    withTempHome(workspace, () => {
      const sessionState = loadSessionStateModule();
      const legacyPath = sessionState.getLegacyLinkedInSessionStatePath('alice@example.com');
      const currentPath = sessionState.getLinkedInSessionStatePath('alice@example.com');

      writeJson(legacyPath, {
        email: 'alice@example.com',
        savedAt: '2026-03-22T10:00:00.000Z',
        origin: sessionState.LINKEDIN_ORIGIN,
        storageState: {
          cookies: [{ name: 'li_at', value: 'cookie-value' }],
          origins: []
        }
      });

      const payload = sessionState.readLinkedInSessionState('alice@example.com');

      assert.equal(payload.email, 'alice@example.com');
      assert.equal(payload.path, currentPath);
      assert.equal(fs.existsSync(currentPath), true);
      assert.equal(fs.existsSync(legacyPath), false);
    });
  } finally {
    workspace.cleanup();
  }
});

test('applyLinkedInSessionState restores cookies and localStorage entries from persisted storage', async () => {
  const workspace = createTempWorkspace('session-state-apply-');
  try {
    await withTempHome(workspace, async () => {
      const sessionState = loadSessionStateModule();
      const storagePath = sessionState.getLinkedInSessionStatePath('alice@example.com');

      writeJson(storagePath, {
        email: 'alice@example.com',
        savedAt: '2026-03-22T10:00:00.000Z',
        origin: sessionState.LINKEDIN_ORIGIN,
        storageState: {
          cookies: [
            {
              name: 'li_at',
              value: 'cookie-value',
              domain: '.linkedin.com',
              path: '/',
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax'
            }
          ],
          origins: [
            {
              origin: 'https://www.linkedin.com',
              localStorage: [
                { name: 'voyager-web:session', value: 'abc123' },
                { name: 'li_theme', value: 'light' }
              ]
            }
          ]
        }
      });

      const calls = {
        cookies: [],
        initScripts: []
      };

      const context = {
        async addCookies(cookies) {
          calls.cookies.push(cookies);
        },
        async addInitScript(fn, originEntries) {
          calls.initScripts.push({ fn, originEntries });
        }
      };

      const page = {
        context() {
          return context;
        }
      };

      const result = await sessionState.applyLinkedInSessionState(page, 'alice@example.com');

      assert.equal(result.applied, true);
      assert.equal(result.email, 'alice@example.com');
      assert.equal(result.path, storagePath);
      assert.equal(calls.cookies.length, 1);
      assert.equal(calls.cookies[0][0].name, 'li_at');
      assert.equal(calls.initScripts.length, 1);
      assert.deepEqual(calls.initScripts[0].originEntries, {
        'https://www.linkedin.com': [
          { name: 'voyager-web:session', value: 'abc123' },
          { name: 'li_theme', value: 'light' }
        ]
      });
      assert.equal(typeof calls.initScripts[0].fn, 'function');
    });
  } finally {
    workspace.cleanup();
  }
});

test('AccountSessionRegistry persists verification state and marks stale or failed sessions for re-authentication', () => {
  const workspace = createTempWorkspace('account-session-registry-');
  try {
    withTempHome(workspace, () => {
      const {
        AccountSessionRegistry,
        DEFAULT_SESSION_VERIFICATION_MAX_AGE_MS
      } = loadAccountSessionRegistryModule();
      const appStateDir = getExpectedAppStateDir(workspace);
      const profilePath = path.join(appStateDir, 'profiles', 'alice');
      const registry = new AccountSessionRegistry();

      assert.equal(
        registry.storePath,
        path.join(appStateDir, 'session-registry.json')
      );

      const verifiedRecord = registry.recordVerified('Alice@example.com', {
        profilePath,
        verifiedBy: 'canary',
        at: '2026-03-22T10:00:00.000Z'
      });

      assert.equal(verifiedRecord.email, 'alice@example.com');
      assert.equal(verifiedRecord.profilePath, profilePath);
      assert.equal(verifiedRecord.lastVerifiedAt, '2026-03-22T10:00:00.000Z');
      assert.equal(verifiedRecord.lastVerifiedBy, 'canary');

      const reloadedRegistry = new AccountSessionRegistry();
      const persistedRecord = reloadedRegistry.getAccount('alice@example.com');
      assert.equal(persistedRecord.email, 'alice@example.com');
      assert.equal(persistedRecord.profilePath, profilePath);
      assert.equal(
        reloadedRegistry.shouldReauthenticate('alice@example.com', {
          now: '2026-03-22T13:59:59.000Z',
          maxAgeMs: DEFAULT_SESSION_VERIFICATION_MAX_AGE_MS
        }),
        false
      );
      assert.equal(
        reloadedRegistry.shouldReauthenticate('alice@example.com', {
          now: '2026-03-22T14:00:01.000Z',
          maxAgeMs: DEFAULT_SESSION_VERIFICATION_MAX_AGE_MS
        }),
        true
      );

      reloadedRegistry.recordAuthFailure('alice@example.com', {
        profilePath,
        at: '2026-03-22T10:30:00.000Z'
      });

      const afterFailure = new AccountSessionRegistry();
      const failedRecord = afterFailure.getAccount('alice@example.com');
      assert.equal(failedRecord.lastAuthFailureAt, '2026-03-22T10:30:00.000Z');
      assert.equal(
        afterFailure.shouldReauthenticate('alice@example.com', {
          now: '2026-03-22T10:30:01.000Z',
          maxAgeMs: DEFAULT_SESSION_VERIFICATION_MAX_AGE_MS
        }),
        true
      );
    });
  } finally {
    workspace.cleanup();
  }
});

test('AccountSessionRegistry migrates legacy Documents storage into app-state on first load', () => {
  const workspace = createTempWorkspace('account-session-registry-migrate-');
  try {
    withTempHome(workspace, () => {
      const legacyStorePath = workspace.path('Documents', 'Connect-Ability', 'session-registry.json');
      writeJson(legacyStorePath, {
        version: 1,
        accounts: {
          'alice@example.com': {
            email: 'alice@example.com',
            profilePath: '/tmp/alice-profile',
            lastVerifiedAt: '2026-03-22T10:00:00.000Z',
            lastVerifiedBy: 'canary',
            updatedAt: '2026-03-22T10:00:00.000Z'
          }
        }
      });

      const { AccountSessionRegistry } = loadAccountSessionRegistryModule();
      const registry = new AccountSessionRegistry();
      const appStatePath = path.join(getExpectedAppStateDir(workspace), 'session-registry.json');

      const record = registry.getAccount('alice@example.com');

      assert.equal(record.email, 'alice@example.com');
      assert.equal(fs.existsSync(appStatePath), true);
      assert.equal(fs.existsSync(legacyStorePath), false);
      assert.equal(registry.storePath, appStatePath);
    });
  } finally {
    workspace.cleanup();
  }
});
