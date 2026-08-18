const fs = require('fs');
const path = require('path');
const {
  ensureDirectoryExists,
  ensureParentDirectory,
  getConnectAbilityAppStateDir,
  getConnectAbilityDocumentsDir,
  writeJsonFileAtomic
} = require('../../connect-documents');

const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

function getBaseDir() {
  return path.join(getConnectAbilityAppStateDir(), 'sessions');
}

function ensureBaseDir() {
  const baseDir = getBaseDir();
  ensureDirectoryExists(baseDir);
  return baseDir;
}

function getLegacyBaseDir() {
  return path.join(getConnectAbilityDocumentsDir(), 'sessions');
}

function buildSessionStatePath(baseDir, email = null) {
  if (!email) {
    return path.join(baseDir, 'linkedin-storage-state.json');
  }
  return path.join(baseDir, `linkedin-storage-state-${sanitizeEmailKey(email)}.json`);
}

function getLegacyLinkedInSessionStatePath(email = null) {
  return buildSessionStatePath(getLegacyBaseDir(), email);
}

function sanitizeEmailKey(email = null) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

function getLinkedInSessionStatePath(email = null) {
  return buildSessionStatePath(ensureBaseDir(), email);
}

function parseLinkedInSessionState(storagePath) {
  if (!storagePath || !fs.existsSync(storagePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    if (raw && raw.storageState) {
      return {
        ...raw,
        path: storagePath
      };
    }
    return {
      email: null,
      savedAt: null,
      storageState: raw,
      path: storagePath
    };
  } catch (_) {
    return null;
  }
}

function getCandidatePaths(email = null) {
  const candidates = email
    ? [
        getLinkedInSessionStatePath(email),
        getLegacyLinkedInSessionStatePath(email),
        getLinkedInSessionStatePath(),
        getLegacyLinkedInSessionStatePath()
      ]
    : [
        getLinkedInSessionStatePath(),
        getLegacyLinkedInSessionStatePath()
      ];

  return [...new Set(candidates.filter(Boolean))];
}

function migrateLinkedInSessionStatePath(legacyPath, nextPath) {
  if (!legacyPath || !nextPath || legacyPath === nextPath) {
    return nextPath;
  }

  if (!fs.existsSync(legacyPath)) {
    return nextPath;
  }

  if (fs.existsSync(nextPath)) {
    return nextPath;
  }

  try {
    ensureParentDirectory(nextPath);
    fs.copyFileSync(legacyPath, nextPath);
    fs.chmodSync(nextPath, 0o600);
    fs.unlinkSync(legacyPath);
    return nextPath;
  } catch (_) {
    return legacyPath;
  }
}

function readLinkedInSessionState(email = null) {
  const currentScopedPath = getLinkedInSessionStatePath(email);
  const currentGenericPath = getLinkedInSessionStatePath();

  for (const storagePath of getCandidatePaths(email)) {
    const payload = parseLinkedInSessionState(storagePath);
    if (!payload?.storageState) {
      continue;
    }

    if (
      email &&
      payload.email &&
      String(payload.email).trim().toLowerCase() !== String(email).trim().toLowerCase()
    ) {
      continue;
    }

    const targetPath = storagePath.startsWith(getLegacyBaseDir())
      ? migrateLinkedInSessionStatePath(
          storagePath,
          email ? currentScopedPath : currentGenericPath
        )
      : storagePath;

    if (targetPath !== storagePath) {
      const migratedPayload = parseLinkedInSessionState(targetPath);
      if (migratedPayload?.storageState) {
        return migratedPayload;
      }
    }

    return {
      ...payload,
      path: targetPath
    };
  }

  return null;
}

function clearLinkedInSessionState(email = null) {
  for (const targetPath of getCandidatePaths(email)) {
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  }
}

async function applyLinkedInSessionState(page, email = null) {
  const payload = readLinkedInSessionState(email);
  if (!payload?.storageState) {
    return { applied: false, reason: 'missing_state' };
  }

  const state = payload.storageState;
  const context = page?.context?.();
  if (!context) {
    return { applied: false, reason: 'missing_context' };
  }

  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  if (cookies.length) {
    await context.addCookies(cookies).catch(() => {});
  }

  const entriesByOrigin = {};
  for (const originState of Array.isArray(state.origins) ? state.origins : []) {
    if (!originState?.origin || !Array.isArray(originState.localStorage)) continue;
    entriesByOrigin[originState.origin] = originState.localStorage;
  }

  if (Object.keys(entriesByOrigin).length) {
    await context.addInitScript((originEntries) => {
      const entries = originEntries[window.location.origin];
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!entry || typeof entry.name !== 'string') continue;
        try {
          window.localStorage.setItem(entry.name, String(entry.value ?? ''));
        } catch (_) {}
      }
    }, entriesByOrigin).catch(() => {});
  }

  return {
    applied: cookies.length > 0 || Object.keys(entriesByOrigin).length > 0,
    path: payload.path || getLinkedInSessionStatePath(email),
    savedAt: payload.savedAt,
    email: payload.email || null
  };
}

async function persistLinkedInSessionState(page, email = null) {
  const context = page?.context?.();
  if (!context) {
    return null;
  }

  const storageState = await context.storageState();
  const payload = {
    email: email || null,
    savedAt: new Date().toISOString(),
    origin: LINKEDIN_ORIGIN,
    storageState
  };

  const storagePath = getLinkedInSessionStatePath(email);
  writeJsonFileAtomic(storagePath, payload);
  return storagePath;
}

/**
 * Check whether a URL indicates a LinkedIn authentication redirect.
 * This covers login pages, security checkpoints, and challenge screens.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isLinkedInAuthRedirect(url) {
  const normalized = String(url || '').toLowerCase();
  return /\/(?:uas\/login|login|authwall|checkpoint|challenge)\b/i.test(normalized);
}

/**
 * After a page.goto(), check whether LinkedIn redirected to a login/checkpoint
 * page, indicating the session is invalid.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if the page is on an auth redirect
 */
async function isPageOnAuthRedirect(page) {
  try {
    const url = typeof page.url === 'function' ? page.url() : '';
    const resolved = (url && typeof url.then === 'function') ? await url : url;
    return isLinkedInAuthRedirect(String(resolved || ''));
  } catch (_) {
    return false;
  }
}

module.exports = {
  LINKEDIN_ORIGIN,
  getLegacyLinkedInSessionStatePath,
  getLinkedInSessionStatePath,
  readLinkedInSessionState,
  clearLinkedInSessionState,
  applyLinkedInSessionState,
  persistLinkedInSessionState,
  isLinkedInAuthRedirect,
  isPageOnAuthRedirect
};
