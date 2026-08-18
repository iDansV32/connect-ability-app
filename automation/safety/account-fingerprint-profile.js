'use strict';

const crypto = require('crypto');
const { getChromiumFullVersion, getChromiumMajorVersion } = require('../core/browser-version');

// Common desktop viewport sizes from global browser telemetry (StatCounter / MDN).
// Sorted by approximate market share. Per-session jitter (±30px × ±20px) adds
// further variation so the effective pool is much larger than the base set.
const VIEWPORT_PROFILES = Object.freeze([
  Object.freeze({ width: 1920, height: 1080 }),
  Object.freeze({ width: 1366, height: 768 }),
  Object.freeze({ width: 1536, height: 864 }),
  Object.freeze({ width: 1440, height: 900 }),
  Object.freeze({ width: 1280, height: 720 }),
  Object.freeze({ width: 1280, height: 800 }),
  Object.freeze({ width: 1600, height: 900 }),
  Object.freeze({ width: 1680, height: 1050 }),
  Object.freeze({ width: 1280, height: 1024 }),
  Object.freeze({ width: 1400, height: 900 }),
  Object.freeze({ width: 1512, height: 982 }),
  Object.freeze({ width: 1360, height: 768 }),
  Object.freeze({ width: 1440, height: 1024 }),
  Object.freeze({ width: 1600, height: 1024 }),
  Object.freeze({ width: 1504, height: 846 }),
  Object.freeze({ width: 1352, height: 878 })
]);

const PLUGIN_PACKS = Object.freeze([
  Object.freeze([
    Object.freeze({
      name: 'PDF Viewer',
      filename: 'internal-pdf-viewer',
      description: 'Portable Document Format',
      mimeTypes: Object.freeze([
        Object.freeze({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' })
      ])
    }),
    Object.freeze({
      name: 'Chrome PDF Viewer',
      filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
      description: 'Portable Document Format',
      mimeTypes: Object.freeze([
        Object.freeze({ type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' })
      ])
    }),
    Object.freeze({
      name: 'Chromium PDF Viewer',
      filename: 'internal-pdf-viewer',
      description: 'Portable Document Format',
      mimeTypes: Object.freeze([])
    }),
    Object.freeze({
      name: 'Microsoft Edge PDF Viewer',
      filename: 'internal-pdf-viewer',
      description: 'Portable Document Format',
      mimeTypes: Object.freeze([])
    })
  ]),
  Object.freeze([
    Object.freeze({
      name: 'PDF Viewer',
      filename: 'internal-pdf-viewer',
      description: 'Portable Document Format',
      mimeTypes: Object.freeze([
        Object.freeze({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' })
      ])
    }),
    Object.freeze({
      name: 'Chrome PDF Viewer',
      filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
      description: 'Portable Document Format',
      mimeTypes: Object.freeze([
        Object.freeze({ type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' })
      ])
    }),
    Object.freeze({
      name: 'Widevine Content Decryption Module',
      filename: 'widevinecdmadapter.plugin',
      description: 'Enables Widevine licenses for playback of HTML audio/video content.',
      mimeTypes: Object.freeze([])
    })
  ]),
  Object.freeze([
    Object.freeze({
      name: 'PDF Viewer',
      filename: 'internal-pdf-viewer',
      description: 'Portable Document Format',
      mimeTypes: Object.freeze([
        Object.freeze({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' })
      ])
    }),
    Object.freeze({
      name: 'Chromium PDF Viewer',
      filename: 'internal-pdf-viewer',
      description: 'Portable Document Format',
      mimeTypes: Object.freeze([
        Object.freeze({ type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' })
      ])
    }),
    Object.freeze({
      name: 'WebKit built-in PDF',
      filename: 'internal-pdf-viewer',
      description: 'Portable Document Format',
      mimeTypes: Object.freeze([])
    })
  ])
]);

function buildClientHintBrands() {
  const majorVersion = getChromiumMajorVersion();
  return Object.freeze([
    Object.freeze({ brand: 'Not_A Brand', version: '24' }),
    Object.freeze({ brand: 'Chromium', version: majorVersion }),
    Object.freeze({ brand: 'Google Chrome', version: majorVersion })
  ]);
}

const VIEWPORT_JITTER_LIMITS = Object.freeze({
  width: 30,
  height: 20
});

const VIEWPORT_CLAMP_BOUNDS = Object.freeze({
  minWidth: 1100,
  maxWidth: 1960,
  minHeight: 680,
  maxHeight: 1120
});

function normalizeFingerprintProfileSeed(value, fallbackIdentity = '') {
  const explicitValue = String(value || '').trim();
  if (explicitValue) {
    return explicitValue.slice(0, 120);
  }

  const normalizedIdentity = String(fallbackIdentity || '').trim().toLowerCase();
  if (!normalizedIdentity) {
    return 'li-fingerprint-default';
  }

  const digest = crypto
    .createHash('sha256')
    .update(normalizedIdentity)
    .digest('hex')
    .slice(0, 20);

  return `li-fingerprint-${digest}`;
}

function resolveAccountFingerprintProfile(account = {}) {
  const accountEmail = typeof account === 'string'
    ? account
    : account.email || account.accountEmail || '';
  const explicitSeed = typeof account === 'string'
    ? ''
    : account.fingerprintProfileSeed || '';
  const normalizedSeed = normalizeFingerprintProfileSeed(explicitSeed, accountEmail);
  return buildFingerprintProfileFromSeed(normalizedSeed);
}

function buildFingerprintProfileFromSeed(seed) {
  const normalizedSeed = normalizeFingerprintProfileSeed(seed);
  const viewport = VIEWPORT_PROFILES[pickIndex(normalizedSeed, 'viewport', VIEWPORT_PROFILES.length)];
  const pluginPack = PLUGIN_PACKS[pickIndex(normalizedSeed, 'plugins', PLUGIN_PACKS.length)];

  return {
    seed: normalizedSeed,
    canvasNoiseSeed: normalizedSeed,
    viewport: { ...viewport },
    clientHints: buildClientHintsProfile(),
    pluginDescriptors: clonePluginPack(pluginPack),
    mimeTypeDescriptors: buildMimeTypeDescriptors(pluginPack),
    pdfViewerEnabled: true
  };
}

/**
 * Returns a shallow copy of the fingerprint profile with the canvas noise seed
 * mixed with the session seed so that canvas fingerprints shift daily while
 * remaining deterministic within a single session.
 */
function applySessionSeedToProfile(profile, sessionSeed) {
  if (!profile || !sessionSeed) return profile;
  const baseSeed = profile.canvasNoiseSeed || profile.seed || '';
  const combined = crypto
    .createHash('sha256')
    .update(`${baseSeed}:canvas:${sessionSeed}`)
    .digest('hex')
    .slice(0, 24);
  return {
    ...profile,
    canvasNoiseSeed: `li-canvas-${combined}`
  };
}

function resolveViewportForFingerprint(viewport, seed) {
  const override = normalizeViewportOverride(viewport);
  if (override) {
    return override;
  }
  return buildFingerprintProfileFromSeed(seed).viewport;
}

function normalizeViewportOverride(viewport) {
  const width = Number.parseInt(viewport?.width, 10);
  const height = Number.parseInt(viewport?.height, 10);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }
  return null;
}

function buildFingerprintSessionSeed(identity, referenceTime = Date.now()) {
  const normalizedIdentity = String(identity || '').trim().toLowerCase() || 'li-fingerprint-default';
  const date = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
  const dateKey = Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const digest = crypto
    .createHash('sha256')
    .update(`${normalizedIdentity}:${dateKey}`)
    .digest('hex')
    .slice(0, 20);

  return `li-session-${digest}`;
}

function resolveSessionViewport(fingerprintProfile, sessionSeed, viewportOverride = null) {
  const override = normalizeViewportOverride(viewportOverride);
  if (override) {
    return override;
  }

  const baseViewport = normalizeViewportOverride(fingerprintProfile?.viewport)
    || VIEWPORT_PROFILES[0];
  const normalizedSessionSeed = String(sessionSeed || '').trim() || buildFingerprintSessionSeed(fingerprintProfile?.seed || '');
  const widthOffset = pickSignedOffset(normalizedSessionSeed, 'session-viewport-width', VIEWPORT_JITTER_LIMITS.width);
  const heightOffset = pickSignedOffset(normalizedSessionSeed, 'session-viewport-height', VIEWPORT_JITTER_LIMITS.height);

  return {
    width: clamp(baseViewport.width + widthOffset, VIEWPORT_CLAMP_BOUNDS.minWidth, VIEWPORT_CLAMP_BOUNDS.maxWidth),
    height: clamp(baseViewport.height + heightOffset, VIEWPORT_CLAMP_BOUNDS.minHeight, VIEWPORT_CLAMP_BOUNDS.maxHeight)
  };
}

function buildMimeTypeDescriptors(pluginPack) {
  const mimeTypes = [];
  const seenTypes = new Set();

  pluginPack.forEach((plugin) => {
    const pluginMimeTypes = Array.isArray(plugin?.mimeTypes) ? plugin.mimeTypes : [];
    pluginMimeTypes.forEach((mimeType) => {
      const type = String(mimeType?.type || '').trim();
      if (!type || seenTypes.has(type)) {
        return;
      }
      seenTypes.add(type);
      mimeTypes.push({
        type,
        suffixes: String(mimeType?.suffixes || '').trim(),
        description: String(mimeType?.description || '').trim()
      });
    });
  });

  return mimeTypes;
}

function clonePluginPack(pluginPack) {
  return pluginPack.map((plugin) => ({
    name: plugin.name,
    filename: plugin.filename,
    description: plugin.description,
    mimeTypes: Array.isArray(plugin.mimeTypes)
      ? plugin.mimeTypes.map((mimeType) => ({
          type: mimeType.type,
          suffixes: mimeType.suffixes,
          description: mimeType.description
        }))
      : []
  }));
}

function buildClientHintsProfile() {
  return {
    brands: buildClientHintBrands().map((entry) => ({
      brand: entry.brand,
      version: entry.version
    })),
    mobile: false,
    platform: resolveClientHintPlatform(),
    fullVersion: getChromiumFullVersion()
  };
}

function pickIndex(seed, label, length) {
  if (!Number.isFinite(length) || length <= 1) {
    return 0;
  }

  const digest = crypto
    .createHash('sha256')
    .update(`${seed}:${label}`)
    .digest();

  return digest.readUInt32BE(0) % length;
}

function pickSignedOffset(seed, label, maxMagnitude) {
  const magnitude = Number.parseInt(maxMagnitude, 10);
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return 0;
  }

  const digest = crypto
    .createHash('sha256')
    .update(`${seed}:${label}`)
    .digest();
  const space = (magnitude * 2) + 1;
  return (digest.readUInt32BE(0) % space) - magnitude;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveClientHintPlatform() {
  switch (process.platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return 'Unknown';
  }
}

module.exports = {
  normalizeFingerprintProfileSeed,
  buildFingerprintProfileFromSeed,
  buildFingerprintSessionSeed,
  resolveAccountFingerprintProfile,
  normalizeViewportOverride,
  resolveSessionViewport,
  resolveViewportForFingerprint,
  applySessionSeedToProfile
};
