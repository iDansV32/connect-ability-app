'use strict';

const { execSync } = require('child_process');

/**
 * Single source of truth for the Chrome/Chromium version used by the
 * automation stack.  Derived at require-time from the actual Playwright
 * Chromium binary so it can never go stale.
 *
 * Consumers:
 *   - account-fingerprint-profile.js  (client-hint brands, fullVersion)
 *   - linkedin-private/client.js      (sec-ch-ua, x-li-track)
 *
 * Falls back to a hardcoded version only if the binary probe fails
 * (e.g. CI without browsers installed).
 */

const FALLBACK_CHROME_VERSION = '134.0.6998.35';

let resolvedVersion = null;

function probeChromiumVersion() {
  try {
    const { chromium } = require('playwright');
    const executablePath = chromium.executablePath();
    if (!executablePath) return null;

    const raw = execSync(`"${executablePath}" --version`, {
      timeout: 5000,
      encoding: 'utf8'
    }).trim();

    const match = raw.match(/(\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getChromiumFullVersion() {
  if (resolvedVersion === null) {
    resolvedVersion = probeChromiumVersion() || FALLBACK_CHROME_VERSION;
  }
  return resolvedVersion;
}

function getChromiumMajorVersion() {
  return getChromiumFullVersion().split('.')[0];
}

function resetCachedVersion() {
  resolvedVersion = null;
}

module.exports = {
  getChromiumFullVersion,
  getChromiumMajorVersion,
  resetCachedVersion,
  _private: { probeChromiumVersion, FALLBACK_CHROME_VERSION }
};
