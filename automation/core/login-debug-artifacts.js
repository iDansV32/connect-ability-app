'use strict';

const path = require('path');

const {
  ensureDirectoryExists,
  getConnectAbilityAppStateDir
} = require('../../connect-documents');

const LOGIN_DEBUG_ARTIFACTS_ENV = 'CONNECT_DEBUG_LOGIN_ARTIFACTS';

function isLoginDebugArtifactsEnabled() {
  const normalized = String(process.env[LOGIN_DEBUG_ARTIFACTS_ENV] || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function getLoginDebugArtifactsDir() {
  return path.join(getConnectAbilityAppStateDir(), 'debug', 'login');
}

function buildLoginDebugArtifactPath(label = 'login-debug', at = new Date()) {
  const timestamp = normalizeTimestamp(at);
  const safeLabel = String(label || 'login-debug')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'login-debug';

  return path.join(getLoginDebugArtifactsDir(), `${safeLabel}-${timestamp}.png`);
}

async function captureLoginDebugScreenshot(page, label, options = {}) {
  if (!isLoginDebugArtifactsEnabled() || !page || typeof page.screenshot !== 'function') {
    return null;
  }

  const screenshotPath = buildLoginDebugArtifactPath(label, options.at);
  ensureDirectoryExists(path.dirname(screenshotPath));
  await page.screenshot({ path: screenshotPath });
  return screenshotPath;
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  return safeDate.toISOString().replace(/[:.]/g, '-');
}

module.exports = {
  LOGIN_DEBUG_ARTIFACTS_ENV,
  isLoginDebugArtifactsEnabled,
  getLoginDebugArtifactsDir,
  buildLoginDebugArtifactPath,
  captureLoginDebugScreenshot
};
