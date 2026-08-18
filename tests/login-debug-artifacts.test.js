'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createTempWorkspace } = require('./test-helpers');
const {
  buildLoginDebugArtifactPath,
  captureLoginDebugScreenshot,
  getLoginDebugArtifactsDir,
  LOGIN_DEBUG_ARTIFACTS_ENV
} = require('../automation/core/login-debug-artifacts');

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

async function withLoginDebugEnv(value, fn) {
  const previousValue = process.env[LOGIN_DEBUG_ARTIFACTS_ENV];
  if (value === undefined) {
    delete process.env[LOGIN_DEBUG_ARTIFACTS_ENV];
  } else {
    process.env[LOGIN_DEBUG_ARTIFACTS_ENV] = value;
  }

  try {
    return await fn();
  } finally {
    if (previousValue === undefined) {
      delete process.env[LOGIN_DEBUG_ARTIFACTS_ENV];
    } else {
      process.env[LOGIN_DEBUG_ARTIFACTS_ENV] = previousValue;
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

test('captureLoginDebugScreenshot is disabled by default', { concurrency: false }, async () => {
  const workspace = createTempWorkspace('login-debug-off-');
  try {
    await withLoginDebugEnv(undefined, async () => {
      await withTempHome(workspace, async () => {
        let screenshotCalls = 0;
        const page = {
          async screenshot() {
            screenshotCalls += 1;
          }
        };

        const result = await captureLoginDebugScreenshot(page, 'before-login');

        assert.equal(result, null);
        assert.equal(screenshotCalls, 0);
      });
    });
  } finally {
    workspace.cleanup();
  }
});

test('captureLoginDebugScreenshot writes under app-state/debug/login when enabled', { concurrency: false }, async () => {
  const workspace = createTempWorkspace('login-debug-on-');
  try {
    await withLoginDebugEnv('true', async () => {
      await withTempHome(workspace, async () => {
        const calls = [];
        const page = {
          async screenshot(options) {
            calls.push(options);
          }
        };

        const result = await captureLoginDebugScreenshot(page, 'login-error', {
          at: '2026-03-26T12:00:00.000Z'
        });

        assert.equal(calls.length, 1);
        assert.equal(result, calls[0].path);
        assert.equal(
          getLoginDebugArtifactsDir(),
          path.join(getExpectedAppStateDir(workspace), 'debug', 'login')
        );
        assert.equal(
          result,
          path.join(
            getExpectedAppStateDir(workspace),
            'debug',
            'login',
            'login-error-2026-03-26T12-00-00-000Z.png'
          )
        );
        assert.equal(
          buildLoginDebugArtifactPath('login-error', '2026-03-26T12:00:00.000Z'),
          result
        );
      });
    });
  } finally {
    workspace.cleanup();
  }
});
