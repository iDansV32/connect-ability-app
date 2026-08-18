'use strict';

const { logAction, logError } = require('../util/log');

/**
 * Apply light-touch fingerprinting tweaks before any page scripts run.
 * Call this AFTER creating a page, BEFORE navigating to LinkedIn.
 */
async function setupFingerprinting(page, options = {}) {
  const fingerprintProfile = normalizeFingerprintProfile(options.fingerprintProfile);

  try {
    await page.addInitScript((profile) => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

        const pluginArray = buildArrayLike(
          (profile.pluginDescriptors || []).map((pluginDescriptor) => ({
            name: pluginDescriptor.name,
            filename: pluginDescriptor.filename,
            description: pluginDescriptor.description
          })),
          'name'
        );

        const mimeTypeArray = buildArrayLike(
          (profile.mimeTypeDescriptors || []).map((mimeTypeDescriptor) => ({
            type: mimeTypeDescriptor.type,
            suffixes: mimeTypeDescriptor.suffixes,
            description: mimeTypeDescriptor.description
          })),
          'type'
        );

        for (let pluginIndex = 0; pluginIndex < pluginArray.length; pluginIndex += 1) {
          const plugin = pluginArray[pluginIndex];
          const sourcePlugin = profile.pluginDescriptors?.[pluginIndex] || {};
          const mimeTypes = Array.isArray(sourcePlugin.mimeTypes)
            ? sourcePlugin.mimeTypes
                .map((mimeType) => mimeTypeArray.namedItem(mimeType.type))
                .filter(Boolean)
            : [];

          Object.defineProperty(plugin, 'length', { value: mimeTypes.length });
          Object.defineProperty(plugin, 'item', {
            value: (index) => mimeTypes[index] || null
          });
          Object.defineProperty(plugin, 'namedItem', {
            value: (name) => mimeTypes.find((mimeType) => mimeType.type === name) || null
          });

          mimeTypes.forEach((mimeType, mimeIndex) => {
            Object.defineProperty(plugin, mimeIndex, { value: mimeType });
            Object.defineProperty(mimeType, 'enabledPlugin', {
              value: plugin,
              configurable: true
            });
          });
        }

        Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });
        Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeTypeArray });
        Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => Boolean(profile.pdfViewerEnabled) });

        const canvasSeed = String(profile.canvasNoiseSeed || profile.seed || 'li-canvas-default');
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;

        Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
          configurable: true,
          writable: true,
          value: function patchedToDataURL(...args) {
            try {
              const width = Number(this.width) || 0;
              const height = Number(this.height) || 0;
              if (!width || !height) {
                return originalToDataURL.apply(this, args);
              }

              const clone = document.createElement('canvas');
              clone.width = width;
              clone.height = height;
              const cloneContext = clone.getContext('2d');
              if (!cloneContext) {
                return originalToDataURL.apply(this, args);
              }

              cloneContext.drawImage(this, 0, 0);
              const cloneImageData = originalGetImageData.call(cloneContext, 0, 0, width, height);
              applyCanvasNoise(cloneImageData, `${canvasSeed}:${width}x${height}`);
              cloneContext.putImageData(cloneImageData, 0, 0);
              return originalToDataURL.apply(clone, args);
            } catch {
              return originalToDataURL.apply(this, args);
            }
          }
        });

        Object.defineProperty(CanvasRenderingContext2D.prototype, 'getImageData', {
          configurable: true,
          writable: true,
          value: function patchedGetImageData(...args) {
            const imageData = originalGetImageData.apply(this, args);
            try {
              applyCanvasNoise(imageData, `${canvasSeed}:${imageData.width}x${imageData.height}`);
            } catch {}
            return imageData;
          }
        });
      } catch {}

      function buildArrayLike(items, keyField) {
        const arrayLike = [];
        items.forEach((item, index) => {
          arrayLike.push(item);
          Object.defineProperty(arrayLike, index, { value: item });
        });
        Object.defineProperty(arrayLike, 'item', {
          value: (index) => arrayLike[index] || null
        });
        Object.defineProperty(arrayLike, 'namedItem', {
          value: (name) => arrayLike.find((item) => item?.[keyField] === name) || null
        });
        Object.defineProperty(arrayLike, 'refresh', {
          value: () => undefined
        });
        return arrayLike;
      }

      function applyCanvasNoise(imageData, seed) {
        if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
          return;
        }

        const plan = buildCanvasNoisePlan(seed, imageData.width, imageData.height);
        const data = imageData.data;

        plan.forEach((entry) => {
          const index = ((entry.y * imageData.width) + entry.x) * 4;
          const channelIndex = index + entry.channel;
          if (channelIndex < 0 || channelIndex >= data.length) {
            return;
          }
          data[channelIndex] = clampChannel(data[channelIndex] + entry.delta);
        });
      }

      function buildCanvasNoisePlan(seed, width, height) {
        const count = Math.max(8, Math.min(16, Math.floor((width * height) / 50000) || 8));
        const plan = [];
        for (let index = 0; index < count; index += 1) {
          const x = Math.abs(hashSeed(`${seed}:x:${index}`)) % width;
          const y = Math.abs(hashSeed(`${seed}:y:${index}`)) % height;
          const channel = Math.abs(hashSeed(`${seed}:channel:${index}`)) % 3;
          const delta = (Math.abs(hashSeed(`${seed}:delta:${index}`)) % 2) + 1;
          const sign = Math.abs(hashSeed(`${seed}:sign:${index}`)) % 2 === 0 ? 1 : -1;
          plan.push({ x, y, channel, delta: delta * sign });
        }
        return plan;
      }

      function hashSeed(input) {
        let hash = 2166136261;
        const text = String(input || '');
        for (let index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        return hash | 0;
      }

      function clampChannel(value) {
        return Math.max(0, Math.min(255, value));
      }
    }, fingerprintProfile);

    logAction(`Applied fingerprint profile with ${fingerprintProfile.pluginDescriptors.length} plugin entries`);
    return true;
  } catch (error) {
    logError('Fingerprinting setup failed', error);
    return false;
  }
}

function normalizeFingerprintProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return {
      seed: 'li-fingerprint-default',
      canvasNoiseSeed: 'li-fingerprint-default',
      pluginDescriptors: [{
        name: 'Chrome PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: []
      }],
      mimeTypeDescriptors: [],
      pdfViewerEnabled: true
    };
  }

  return {
    seed: String(profile.seed || '').trim() || 'li-fingerprint-default',
    canvasNoiseSeed: String(profile.canvasNoiseSeed || profile.seed || '').trim() || 'li-fingerprint-default',
    pluginDescriptors: Array.isArray(profile.pluginDescriptors)
      ? profile.pluginDescriptors
          .map((plugin) => ({
            name: String(plugin?.name || '').trim(),
            filename: String(plugin?.filename || '').trim(),
            description: String(plugin?.description || '').trim(),
            mimeTypes: Array.isArray(plugin?.mimeTypes)
              ? plugin.mimeTypes.map((mimeType) => ({
                  type: String(mimeType?.type || '').trim(),
                  suffixes: String(mimeType?.suffixes || '').trim(),
                  description: String(mimeType?.description || '').trim()
                }))
              : []
          }))
          .filter((plugin) => plugin.name)
      : [],
    mimeTypeDescriptors: Array.isArray(profile.mimeTypeDescriptors)
      ? profile.mimeTypeDescriptors
          .map((mimeType) => ({
            type: String(mimeType?.type || '').trim(),
            suffixes: String(mimeType?.suffixes || '').trim(),
            description: String(mimeType?.description || '').trim()
          }))
          .filter((mimeType) => mimeType.type)
      : [],
    pdfViewerEnabled: profile.pdfViewerEnabled !== false
  };
}

function buildCanvasNoisePlan(seed, width, height) {
  const resolvedWidth = Number.parseInt(width, 10);
  const resolvedHeight = Number.parseInt(height, 10);
  if (!Number.isFinite(resolvedWidth) || resolvedWidth <= 0 || !Number.isFinite(resolvedHeight) || resolvedHeight <= 0) {
    return [];
  }

  const count = Math.max(8, Math.min(16, Math.floor((resolvedWidth * resolvedHeight) / 50000) || 8));
  const plan = [];
  for (let index = 0; index < count; index += 1) {
    const x = Math.abs(hashSeed(`${seed}:x:${index}`)) % resolvedWidth;
    const y = Math.abs(hashSeed(`${seed}:y:${index}`)) % resolvedHeight;
    const channel = Math.abs(hashSeed(`${seed}:channel:${index}`)) % 3;
    const delta = (Math.abs(hashSeed(`${seed}:delta:${index}`)) % 2) + 1;
    const sign = Math.abs(hashSeed(`${seed}:sign:${index}`)) % 2 === 0 ? 1 : -1;
    plan.push({ x, y, channel, delta: delta * sign });
  }
  return plan;
}

function applyCanvasNoise(imageData, seed) {
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
    return imageData;
  }

  const plan = buildCanvasNoisePlan(seed, imageData.width, imageData.height);
  plan.forEach((entry) => {
    const index = ((entry.y * imageData.width) + entry.x) * 4;
    const channelIndex = index + entry.channel;
    if (channelIndex < 0 || channelIndex >= imageData.data.length) {
      return;
    }
    imageData.data[channelIndex] = clampChannel(imageData.data[channelIndex] + entry.delta);
  });
  return imageData;
}

function hashSeed(input) {
  let hash = 2166136261;
  const text = String(input || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, value));
}

module.exports = {
  setupFingerprinting,
  _private: {
    applyCanvasNoise,
    buildCanvasNoisePlan,
    normalizeFingerprintProfile
  }
};
