'use strict';

const crypto = require('crypto');

const DEFAULT_DELAY_PROFILE = Object.freeze({
  seed: null,
  baseMultiplier: 1,
  typingMultiplier: 1
});

let processDelayProfile = DEFAULT_DELAY_PROFILE;

async function randomDelay(min, max, options = {}) {
  const { minDelay, maxDelay } = applyDelayProfileRange(min, max, options.delayProfile);
  const delay = Math.floor(sampleUnitInterval(options.rng) * (maxDelay - minDelay + 1)) + minDelay;
  await new Promise((resolve) => setTimeout(resolve, delay));
  return delay;
}

function getTypingDelay(options = {}) {
  const profile = resolveDelayProfile(options.delayProfile);
  return (45 + sampleUnitInterval(options.rng) * 55) * profile.typingMultiplier;
}

async function readingDelay(wordCount = 10, options = {}) {
  const msPerWord = 250;
  const baseDelay = wordCount * msPerWord;
  const variation = baseDelay * 0.2;
  await randomDelay(baseDelay - variation, baseDelay + variation, options);
}

async function thinkingPause(options = {}) {
  await randomDelay(800, 1500, options);
}

async function reactionDelay(options = {}) {
  await randomDelay(200, 400, options);
}

function buildDelayProfileFromSeed(seed) {
  const normalizedSeed = String(seed || '').trim();
  if (!normalizedSeed) {
    return { ...DEFAULT_DELAY_PROFILE };
  }

  return {
    seed: normalizedSeed,
    baseMultiplier: roundToThreeDecimals(scaleUnitInterval(hashSeed(normalizedSeed, 'base'), 0.75, 1.30)),
    typingMultiplier: roundToThreeDecimals(scaleUnitInterval(hashSeed(normalizedSeed, 'typing'), 0.78, 1.28))
  };
}

function setProcessDelayProfile(profileOrSeed) {
  processDelayProfile = resolveDelayProfile(profileOrSeed);
  return getProcessDelayProfile();
}

function getProcessDelayProfile() {
  return { ...processDelayProfile };
}

function resetProcessDelayProfile() {
  processDelayProfile = DEFAULT_DELAY_PROFILE;
  return getProcessDelayProfile();
}

function applyDelayProfileRange(min, max, delayProfile = null) {
  const profile = resolveDelayProfile(delayProfile);
  const normalizedMin = normalizeFiniteNumber(min, 0);
  const normalizedMax = normalizeFiniteNumber(max, normalizedMin);
  const lowerBound = Math.max(0, Math.min(normalizedMin, normalizedMax));
  const upperBound = Math.max(lowerBound, Math.max(normalizedMin, normalizedMax));

  const scaledMin = Math.max(0, Math.round(lowerBound * profile.baseMultiplier));
  let scaledMax = Math.max(scaledMin, Math.round(upperBound * profile.baseMultiplier));

  if (scaledMax === scaledMin && upperBound > lowerBound) {
    scaledMax = scaledMin + 1;
  }

  return {
    minDelay: scaledMin,
    maxDelay: scaledMax,
    multiplier: profile.baseMultiplier,
    seed: profile.seed
  };
}

function resolveDelayProfile(profileOrSeed) {
  if (!profileOrSeed) {
    return processDelayProfile;
  }

  if (typeof profileOrSeed === 'string') {
    return buildDelayProfileFromSeed(profileOrSeed);
  }

  return {
    seed: String(profileOrSeed.seed || '').trim() || null,
    baseMultiplier: normalizeMultiplier(profileOrSeed.baseMultiplier, 1),
    typingMultiplier: normalizeMultiplier(profileOrSeed.typingMultiplier, 1)
  };
}

function hashSeed(seed, label) {
  const digest = crypto
    .createHash('sha256')
    .update(`${seed}:${label}`)
    .digest();
  const value = digest.readUInt32BE(0);
  return value / 0xffffffff;
}

function scaleUnitInterval(unitValue, minValue, maxValue) {
  return minValue + (maxValue - minValue) * unitValue;
}

function normalizeFiniteNumber(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeMultiplier(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
}

function sampleUnitInterval(rng) {
  const source = typeof rng === 'function' ? rng : Math.random;
  const value = Number(source());
  if (!Number.isFinite(value)) {
    return Math.random();
  }
  return Math.min(0.999999999, Math.max(0, value));
}

function roundToThreeDecimals(value) {
  return Math.round(value * 1000) / 1000;
}

module.exports = {
  randomDelay,
  getTypingDelay,
  readingDelay,
  thinkingPause,
  reactionDelay,
  buildDelayProfileFromSeed,
  setProcessDelayProfile,
  getProcessDelayProfile,
  resetProcessDelayProfile,
  applyDelayProfileRange
};
