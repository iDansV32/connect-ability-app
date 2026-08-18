/**
 * LEGACY — no new features. Exists for compatibility only.
 *
 * automation-adapter.js
 *
 * Bridges your LinkedIn automation with the Electron app.
 * - Configuration loading & credential handling
 * - Structured logging & progress events (stdout JSON)
 * - Optional IPC handlers for Electron main
 * - Graceful fallbacks for missing functions
 * - Scheduled message sending workflow
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { resolveLinkedInAccountCredentials } = require('./linkedin-credential-store');
const { readEnvCredential } = require('./automation/safety/secret-source');
const { assertLegacyDirectLoginAllowed } = require('./automation/runtime/legacy-direct-login-guard');
const { recordLegacyDirectLoginUsage } = require('./automation/runtime/legacy-direct-login-telemetry');
const {
  buildQuotaExceededReason,
  canConsumeActionQuota,
  consumeActionQuota
} = require('./linkedin-action-quota-store');
const {
  createWorkflowStepResult,
  shouldStopWorkflowAfterStepResult
} = require('./workflow-step-result');
const { buildConnectionAcceptedInferenceMetadata } = require('./workflow-connection-inference');
const ProspectQueueStore = require('./prospect-queue-store');
const { isTargetClosedError } = require('./automation/core/process-control');
// dotenv is useful in local dev, but may be absent in packaged runtime.
try {
  require('dotenv').config();
} catch (error) {
  if (!error || error.code !== 'MODULE_NOT_FOUND') throw error;
}

// --------------------------- Import automation functions (modular) ---------------------------
let automation;
try {
  // IMPORTANT: Submodules must never import this file, only each other.
  automation = require('./automation/index.js');
} catch (error) {
  console.error('Error loading automation functions:', error);
  process.exit(1);
}

// Small helpers to select functions with safe fallbacks
const pick = (name, fallback) => {
  const fn = automation && automation[name];
  return typeof fn === 'function' ? fn : fallback;
};
const noopAsync = async () => {};
const noop = () => {};
const boolFalse = async () => false;
const identity = (x) => x;
const normalizeUrlFallback = (url) =>
  url?.toLowerCase().split('?')[0].split('/recent-activity')[0] || '';
const randomDelayFallback = async (min = 200, max = 400) =>
  new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));

// ---- Core building blocks (each independently optional) ----
const setupFingerprinting        = pick('setupFingerprinting',        noopAsync);
const checkForRateLimiting       = pick('checkForRateLimiting',       boolFalse);
const handleSecurityChallenges   = pick('handleSecurityChallenges',   boolFalse);
const loginToLinkedIn            = pick('loginToLinkedIn',            async () => { throw new Error('loginToLinkedIn not implemented'); });

const searchForProfiles          = pick('searchForProfiles',          noopAsync);
const extractProfileUrls         = pick('extractProfileUrls',         async () => []);
const extractProfileDetails      = pick('extractProfileDetails',      noopAsync);
const extractEmailFromProfile    = pick('extractEmailFromProfile',    async () => null);

const navigateToActivityPage     = pick('navigateToActivityPage',     noopAsync);
const checkForShowPostsButton    = pick('checkForShowPostsButton',    boolFalse);
const enhancedLikePost           = pick('enhancedLikePost',           boolFalse);
const verifyReaction             = pick('verifyReaction',             boolFalse);
const processActivityPage        = pick('processActivityPage',        noopAsync);
const processActivityPageDetailed= pick('processActivityPageDetailed', noopAsync);

const sendConnectionRequest      = pick('sendConnectionRequest',      boolFalse);
const sendConnectionRequestDetailed = pick('sendConnectionRequestDetailed', noopAsync);
const storeProfileAction         = pick('storeProfileAction',         noop);
const updateProfileDisplay       = pick('updateProfileDisplay',       noop);
const updateRecentActivityDisplay= pick('updateRecentActivityDisplay', noop);
const displayProfileInformation  = pick('displayProfileInformation',  noop);

// renderer-only features: keep fallbacks so calls don’t crash
const openWorkflowManager        = pick('openWorkflowManager',        noopAsync);
const startWorkflow              = pick('startWorkflow',              noopAsync);

// human helpers
const humanType                  = pick('humanType',                  noopAsync);
const randomDelay                = pick('randomDelay',                randomDelayFallback);
const moveMouseNaturally         = pick('moveMouseNaturally',         noopAsync);
const humanScroll                = pick('humanScroll',                noopAsync);
const retryWithBackoff           = pick('retryWithBackoff',           async (fn, ...args) => fn(...args));
const waitForAnySelector         = pick('waitForAnySelector',         async () => null);

// logging – fall back to console if not present
const logAction                  = pick('logAction',                  (m) => console.log(m));
const logError                   = pick('logError',                   (m, e) => console.error(m, e ?? ''));

// “newer” functions used by name-list/search flows
const searchForProfilesWithPagination = pick('searchForProfilesWithPagination', async () => ({ results: [], next: null }));
const processProfileWithHistory       = pick('processProfileWithHistory',       noopAsync);
const hasProfileBeenProcessed         = pick('hasProfileBeenProcessed',         async () => false);
const hasProfileAction                = pick('hasProfileAction',                async () => false);
const runEnhancedWorkflow             = pick('runEnhancedWorkflow',             noopAsync);
const runNameListAutomation           = pick('runNameListAutomation',           noopAsync);
const searchForSpecificPerson         = pick('searchForSpecificPerson',         async () => null);
const calculateNameMatchScore         = pick('calculateNameMatchScore',         async () => 0);
const storeNameMapping                = pick('storeNameMapping',                noop);
const parseNameList                   = pick('parseNameList',                   (text) =>
  Array.isArray(text) ? text : String(text || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
);
const sendLinkedInMessage             = pick('sendLinkedInMessage',             async () => false);
const personalizeMessage              = pick('personalizeMessage',              identity);
const getStoredProfileDetails         = pick('getStoredProfileDetails',         async () => null);
const normalizeProfileUrl             = pick('normalizeProfileUrl',             normalizeUrlFallback);
const prospectQueueStore             = new ProspectQueueStore();

let activeAutomationBrowser = null;
let activeAutomationContext = null;
let activeAutomationPage = null;
let automationStopRequested = false;
let automationShutdownPromise = null;

async function closeAutomationBrowserGracefully(browser) {
  if (!browser) {
    activeAutomationPage = null;
    activeAutomationContext = null;
    activeAutomationBrowser = null;
    return;
  }

  automationStopRequested = true;
  try {
    await browser.close();
  } catch (_) {
    // best effort shutdown only
  } finally {
    activeAutomationPage = null;
    activeAutomationContext = null;
    activeAutomationBrowser = null;
  }
}

async function requestImmediateAutomationShutdown(reason = 'Automation stop requested') {
  if (automationShutdownPromise) {
    return automationShutdownPromise;
  }

  automationStopRequested = true;
  automationShutdownPromise = (async () => {
    logAction(reason);
    const hardExitTimer = setTimeout(() => {
      process.exit(1);
    }, 500);
    if (typeof hardExitTimer.unref === 'function') {
      hardExitTimer.unref();
    }

    try {
      if (activeAutomationBrowser) {
        await activeAutomationBrowser.close().catch(() => {});
      } else if (activeAutomationContext) {
        await activeAutomationContext.close().catch(() => {});
      } else if (activeAutomationPage && typeof activeAutomationPage.close === 'function' && !activeAutomationPage.isClosed?.()) {
        await activeAutomationPage.close().catch(() => {});
      }
    } finally {
      clearTimeout(hardExitTimer);
      process.exit(1);
    }
  })();

  return automationShutdownPromise;
}

// --------------------------- Constants & browser profiles ---------------------------
const browserProfiles = [
  {
    name: 'Windows Chrome',
    viewport: { width: 1280, height: 800 },
    platform: 'Win32',
    vendor: 'Google Inc.',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    webgl: { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' }
  },
  {
    name: 'Mac Chrome',
    viewport: { width: 1440, height: 900 },
    platform: 'MacIntel',
    vendor: 'Apple Computer, Inc.',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    webgl: { vendor: 'Apple', renderer: 'Apple M1' }
  }
];

const securitySettings = {
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins',
    '--disable-site-isolation-trials',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-notifications',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-extensions',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-default-browser-check'
  ]
};

// --------------------------- Utilities ---------------------------
function reportProgress(current, total, extra = {}) {
  const progressData = {
    timestamp: new Date().toISOString(),
    type: 'progress',
    current,
    total,
    message: `Progress: ${current}/${total} (${Math.round((current / total) * 100)}%)`,
    ...extra
  };
  console.log(JSON.stringify(progressData));
}

const MAX_WORKFLOW_DELAY_CHUNK_MS = 60 * 60 * 1000;

function formatWorkflowDelay(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || !parts.length) parts.push(`${seconds}s`);

  return parts.join(' ');
}

function chooseWorkflowDelayMs(minMs, maxMs) {
  const floor = Math.max(0, Math.floor(Number(minMs) || 0));
  const ceil = Math.max(floor, Math.floor(Number(maxMs) || floor));
  if (ceil <= floor) return floor;
  return floor + Math.floor(Math.random() * (ceil - floor + 1));
}

async function waitForWorkflowDelay(minMs, maxMs, label = 'workflow delay') {
  const durationMs = chooseWorkflowDelayMs(minMs, maxMs);
  if (!durationMs) return 0;

  logAction(`Waiting ${formatWorkflowDelay(durationMs)} for ${label}`);
  let remainingMs = durationMs;

  while (remainingMs > 0) {
    const chunkMs = Math.min(remainingMs, MAX_WORKFLOW_DELAY_CHUNK_MS);
    await new Promise((resolve) => setTimeout(resolve, chunkMs));
    remainingMs -= chunkMs;
  }

  return durationMs;
}

async function loadCredentials(config = {}) {
  if (config.email && config.password) {
    return {
      email: config.email,
      password: config.password
    };
  }

  const storedCredentials = await resolveLinkedInAccountCredentials({
    id: config.accountId || null,
    accountId: config.accountId || null,
    email: config.accountEmail || config.email || null
  }).catch(() => null);

  if (storedCredentials?.email && storedCredentials?.password) {
    return {
      email: storedCredentials.email,
      password: storedCredentials.password
    };
  }

  // Legacy fallback: env credentials are gated behind CONNECT_ALLOW_ENV_CREDENTIALS.
  // Default returns empty strings so the caller fails closed.
  const envPassword = readEnvCredential('LINKEDIN_PASSWORD', { name: 'LinkedIn password (legacy automation.js)' });
  return {
    email: process.env.LINKEDIN_EMAIL || '',
    password: envPassword ? envPassword.value : ''
  };
}

async function debugCredentials(configPath) {
  try {
    logAction('Debugging credential handling');
    if (!fs.existsSync(configPath)) {
      logAction(`Config file not found at: ${configPath}`);
      return false;
    }
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    const hasEmail = Boolean(config.email);
    const hasPassword = Boolean(config.password);
    logAction('Config file parsed successfully');
    logAction(`Config contains email: ${hasEmail}`);
    logAction(`Config contains password: ${hasPassword}`);
    if (hasEmail) {
      logAction(`Email format validation: ${/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)}`);
    }
    // Post-hardening: whether the LINKEDIN_PASSWORD env var is set is no longer
    // the right signal — the var is ignored unless CONNECT_ALLOW_ENV_CREDENTIALS=1.
    // Log the gate state and whether the env path actually contributes.
    const envCredentialsAllowed = (() => {
      const allow = String(process.env.CONNECT_ALLOW_ENV_CREDENTIALS || '').trim().toLowerCase();
      return allow === '1' || allow === 'true' || allow === 'yes';
    })();
    logAction(`LINKEDIN_EMAIL env present: ${Boolean(process.env.LINKEDIN_EMAIL)}`);
    logAction(`CONNECT_ALLOW_ENV_CREDENTIALS gate: ${envCredentialsAllowed ? 'enabled' : 'disabled'}`);
    logAction(`Env-fallback would contribute LINKEDIN_PASSWORD: ${envCredentialsAllowed && Boolean(process.env.LINKEDIN_PASSWORD)}`);
    return true;
  } catch (error) {
    logError('Error debugging credentials', error);
    return false;
  }
}

// --------------------------- Create Browser / Context (Enhanced) ---------------------------
async function createBrowserContext(config = {}) {
  const browserOptions = {
    headless: config.headless ?? false,
    slowMo: config.slowMo ?? 100,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-features=VizDisplayCompositor',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      ...(securitySettings.args || [])
    ]
  };

  const currentProfile =
    config.browserProfile === 'windows' ? browserProfiles[0]
    : config.browserProfile === 'mac'   ? browserProfiles[1]
    : browserProfiles[Math.floor(Math.random() * browserProfiles.length)];

  const browser = await chromium.launch(browserOptions);
  const context = await browser.newContext({
    userAgent: currentProfile.userAgent,
    viewport: currentProfile.viewport,
    deviceScaleFactor: 1,
    hasTouch: false,
    locale: 'en-US',
    timezoneId: config.timezoneId || 'America/Los_Angeles'
  });

  // Basic anti-detection script
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    try {
      Object.defineProperty(screen, 'availWidth', { get: () => 1366 });
      Object.defineProperty(screen, 'availHeight', { get: () => 728 });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5].map(() => ({ length: Math.floor(Math.random() * 10), name: 'Chrome PDF Plugin' }))
      });
    } catch (_) {}
  });

  return { browser, context };
}

async function createEnhancedBrowser(config) {
  assertLegacyDirectLoginAllowed('legacy.createEnhancedBrowser', {
    onAllowed: ({ entryPoint }) => recordLegacyDirectLoginUsage({
      entryPoint,
      accountId: config?.accountId || null,
      accountName: config?.accountName || config?.accountEmail || null,
      accountEmail: config?.accountEmail || config?.email || null,
      source: 'legacy.createEnhancedBrowser'
    })
  });
  const { browser, context } = await createBrowserContext(config);
  const page = await context.newPage();
  return { browser, context, page };
}

// --------------------------- Fallback builders for critical functions ---------------------------
function createFallbackFunction(funcName) {
  switch (funcName) {
    case 'extractEmailFromProfile':
      global.extractEmailFromProfile = async function (page) {
        logAction('Using fallback email extraction function');
        try {
          const email = await page.evaluate(() => {
            const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
            const text = document.body.innerText;
            const matches = text.match(emailRegex);
            return matches && matches.length > 0 ? matches[0] : null;
          });
          return email || 'Not Available';
        } catch (error) {
          logError('Error in fallback email extraction', error);
          return 'Not Available';
        }
      };
      break;

    case 'displayProfileInformation':
      global.displayProfileInformation = async function (_page, profileDetails) {
        logAction('Using fallback profile display function');
        try {
          logAction(`Profile: ${profileDetails.firstName} ${profileDetails.lastName}`);
          logAction(`Position: ${profileDetails.position}`);
          logAction(`Company: ${profileDetails.company}`);
          logAction(`Email: ${profileDetails.email}`);
          return true;
        } catch (error) {
          logError('Error in fallback profile display', error);
          return false;
        }
      };
      break;

    case 'extractProfileDetails':
      global.extractProfileDetails = async function (page, profileUrl) {
        logAction('Using fallback profile extraction function');
        try {
          const info = await page.evaluate(() => {
            const pick = (sels) => {
              for (const s of sels) {
                const el = document.querySelector(s);
                if (el) return el.textContent.trim();
              }
              return '';
            };
            const fullName = pick(['h1.text-heading-xlarge','h1.inline.t-24','h1.pv-top-card-section__name','.profile-topcard-person-entity__name']);
            const headline = pick(['.text-body-medium.break-words','.pv-top-card-section__headline','.profile-topcard-person-entity__headline']);
            const company  = pick(['.pv-top-card-v2-section__link-text','.pv-entity__secondary-title','.profile-topcard-person-entity__secondary-title','[aria-label*="Current company"]']);
            const parts = fullName ? fullName.split(' ') : [];
            return {
              firstName: parts[0] || 'Unknown',
              lastName: parts.slice(1).join(' ') || 'Profile',
              fullName, headline, company
            };
          });
          return {
            firstName: info.firstName,
            lastName: info.lastName,
            fullName: info.fullName || 'Unknown Profile',
            position: info.headline || 'Not Available',
            company: info.company || 'Not Available',
            email: 'Not Available',
            profileUrl
          };
        } catch (error) {
          logError('Error in fallback profile extraction', error);
          return {
            firstName: 'Unknown',
            lastName: 'Profile',
            fullName: 'Unknown Profile',
            position: 'Not Available',
            company: 'Not Available',
            email: 'Not Available',
            profileUrl
          };
        }
      };
      break;

    case 'storeProfileAction':
      global.storeProfileAction = function (profileUrl, profileDetails, actionType, notes, searchQuery = null) {
        logAction(`Fallback store profile action: ${profileUrl} - ${actionType}`);
        try {
          const userHome = process.env.HOME || process.env.USERPROFILE;
          const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
          if (!fs.existsSync(documentsDir)) fs.mkdirSync(documentsDir, { recursive: true });
          const profilesPath = path.join(documentsDir, 'profiles.json');

          let profiles = [];
          if (fs.existsSync(profilesPath)) {
            try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); }
            catch (e) { logError('Error reading profiles file', e); }
          }

          const accountContext = global.currentLinkedInAccountContext || {};
          const accountId = String(accountContext.accountId || '').trim() || null;
          const accountName = String(accountContext.accountName || accountContext.accountEmail || '').trim() || null;
          const idx = profiles.findIndex((p) => p.url === profileUrl && (accountId ? p.accountId === accountId : !p.accountId));
          const profileData = {
            url: profileUrl,
            firstName: profileDetails.firstName || '',
            lastName:  profileDetails.lastName  || '',
            fullName:  profileDetails.fullName  || '',
            title:     profileDetails.position  || '',
            company:   profileDetails.company   || '',
            email:     profileDetails.email     || 'Not Available',
            linkedInProfileUrl: profileUrl,
            accountId,
            accountName,
            firstInteraction: idx === -1 ? new Date().toISOString() : profiles[idx].firstInteraction,
            lastInteraction: new Date().toISOString(),
            actions: []
          };

          if (idx !== -1) {
            if (profileData.email === 'Not Available' && profiles[idx].email !== 'Not Available') {
              profileData.email = profiles[idx].email;
            }
            profileData.actions = profiles[idx].actions;
            profileData.actions.push({ type: actionType, timestamp: new Date().toISOString(), notes: notes || '', searchQuery });
            profiles[idx] = profileData;
          } else {
            profileData.actions.push({ type: actionType, timestamp: new Date().toISOString(), notes: notes || '', searchQuery });
            profiles.push(profileData);
          }

          fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
          return profileData;
        } catch (error) {
          logError('Error in fallback storeProfileAction', error);
          return profileDetails;
        }
      };
      break;

    case 'searchForProfilesWithPagination':
      global.searchForProfilesWithPagination = async function (page, searchQuery, _maxPages = 3) {
        logAction(`Using fallback searchForProfilesWithPagination for: ${searchQuery}`);
        try {
          if (typeof searchForProfiles === 'function') {
            logAction('Using regular searchForProfiles as fallback');
            return await searchForProfiles(page, searchQuery);
          }
          await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await randomDelay(3000, 5000);
          const urls = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/in/"]'))
              .filter(a => a.href.includes('linkedin.com/in/') && !a.href.includes('ads') && !a.href.includes('sponsored'))
              .map(a => a.href.split('?')[0]);
            return [...new Set(links)];
          });
          logAction(`Found ${urls.length} profiles with fallback search`);
          return urls;
        } catch (error) {
          logError('Error in fallback search with pagination', error);
          return [];
        }
      };
      break;

    case 'processProfileWithHistory':
      global.processProfileWithHistory = async function (page, profileUrl, config, processedProfiles) {
        logAction(`Using fallback processProfileWithHistory for: ${profileUrl}`);
        try {
          const cleanUrl = normalizeProfileUrl(profileUrl);
          if (processedProfiles && processedProfiles.has(cleanUrl)) {
            logAction(`Profile already processed in this session, skipping: ${cleanUrl}`);
            return { likeResult: false, connectResult: false, profileDetails: null };
          }
          await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => logAction('Navigation timeout, continuing...'));
          await randomDelay(2000, 3000);
          let details;
          try {
            details = await extractProfileDetails(page, cleanUrl);
          } catch (e) {
            logError(`Failed to extract profile details: ${e.message}`, e);
            details = {
              firstName: 'Unknown', lastName: 'Profile', position: 'Not Available',
              company: 'Not Available', email: 'Not Available', profileUrl: cleanUrl
            };
          }
          if (processedProfiles) processedProfiles.add(cleanUrl);
          return { likeResult: false, connectResult: false, profileDetails: details };
        } catch (error) {
          logError(`Error in fallback profile processing: ${error.message}`, error);
          return { likeResult: false, connectResult: false, profileDetails: null };
        }
      };
      break;
  }
}

function verifyRequiredFunctions() {
  const critical = [
    'loginToLinkedIn',
    'searchForProfiles',
    'extractProfileUrls',
    'extractProfileDetails',
    'extractEmailFromProfile',
    'displayProfileInformation',
    'storeProfileAction',
    'searchForProfilesWithPagination',
    'processProfileWithHistory'
  ];

  const missing = [];
  for (const name of critical) {
    const present = typeof (automation && automation[name]) === 'function' || typeof global[name] === 'function';
    if (!present) {
      missing.push(name);
      createFallbackFunction(name);
    }
  }

  if (missing.length) {
    logError(`WARNING: Missing critical functions: ${missing.join(', ')}`);
    logError('Fallback implementations will be used; functionality may be limited.');
  }
}

// Run verification asap
verifyRequiredFunctions();

// --------------------------- Scheduled Messages Processor ---------------------------
async function processScheduledMessages(page, config) {
  console.log('=== STARTING PROCESS SCHEDULED MESSAGES ===');
  console.log('Config received:', JSON.stringify({
    ...config,
    password: '***hidden***',
    profileIds: config.profileIds,
    message: (config.message || '').substring(0, 50) + '...'
  }));

  const { profileIds = [], message = '' } = config;

  if (!Array.isArray(profileIds) || profileIds.length === 0) {
    logError('No profile IDs provided!');
    return { sent: 0, failed: 0, details: [] };
  }
  if (!message) {
    logError('No message text provided!');
    return { sent: 0, failed: 0, details: [] };
  }

  try {
    logAction(`🚀 Starting to process ${profileIds.length} profiles for messaging`);
    logAction(`Message to send: "${message.substring(0, 100)}..."`);

    const results = { sent: 0, failed: 0, skipped: 0, details: [] };
    const { sendLinkedInMessage } = require('./automation/messaging/orchestrator');

    const cleanToken = (token) => {
      if (!token) return '';
      // Remove pure numeric slug fragments from names.
      if (/^\d+$/.test(token)) return '';
      return token.replace(/[^a-zA-Z]/g, '');
    };

    const toSearchName = (rawTarget) => {
      const raw = String(rawTarget || '').trim();
      if (!raw) return '';

      // Prefer stored profile details if available.
      try {
        const stored = getStoredProfileDetails(raw);
        const full = [stored?.firstName, stored?.lastName].filter(Boolean).join(' ').trim();
        if (full) return full;
      } catch (_) {}

      // URL / slug fallback
      if (raw.includes('/in/')) {
        const m = raw.match(/\/in\/([^\/\?]+)/);
        if (m && m[1]) {
          const words = m[1]
            .split('-')
            .map(cleanToken)
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
          return words.join(' ').trim();
        }
      }

      // Generic fallback: strip trailing digits and compress spaces
      return raw.replace(/\s+\d+$/, '').replace(/\s+/g, ' ').trim();
    };

    for (let i = 0; i < profileIds.length; i++) {
      const profileId = String(profileIds[i] || '').trim();
      logAction(`\n📍 Processing profile ${i + 1}/${profileIds.length}: ${profileId}`);

      try {
        // Name-list style: type exact name, search people, open matching profile.
        const searchName = toSearchName(profileId);

        if (!searchName) {
          logError(`❌ Could not extract name from profile ID: ${profileId}`);
          results.failed++; results.details.push({ profileId, status: 'failed', reason: 'name-extract' });
          continue;
        }

        // Keep current feed/dashboard page and use the bottom-right LinkedIn drawer flow:
        // Messaging -> Search messages -> select conversation -> type -> Send.
        const sendResult = await sendLinkedInMessage(
          page,
          profileId.includes('/in/') ? profileId : '',
          message,
          {
            checkHistory: false,
            useMessagingDrawer: true,
            recipientName: searchName,
            accountId: config.accountId || null,
            accountEmail: config.accountEmail || config.email || null,
            accountName: config.accountName || null
          }
        );

        if (sendResult?.success) {
          logAction(`✅ Message sent to ${searchName}`);
          results.sent++;
          results.details.push({
            profileId,
            searchName,
            status: 'sent'
          });
        } else {
          const reason = sendResult?.reason || 'unknown';
          const missing = Array.isArray(sendResult?.missingFields) && sendResult.missingFields.length
            ? ` (missing fields: ${sendResult.missingFields.join(', ')})`
            : '';
          logError(`❌ Failed to send message to ${searchName}: ${reason}${missing}`);
          results.failed++;
          results.details.push({
            profileId,
            searchName,
            status: 'failed',
            reason,
            missingFields: sendResult?.missingFields || []
          });
        }

        if (sendResult?.reason === 'quota_exceeded') {
          const remainingTargets = profileIds.slice(i + 1);
          if (remainingTargets.length > 0) {
            results.skipped += remainingTargets.length;
            results.details.push(
              ...remainingTargets.map((remainingProfileId) => ({
                profileId: remainingProfileId,
                status: 'skipped',
                reason: 'quota_exceeded'
              }))
            );
          }
          logAction('⛔ Message quota reached, stopping the remaining send queue');
          break;
        }

        // pacing
        if (i < profileIds.length - 1) {
          const delay = 30000 + Math.random() * 30000;
          logAction(`⏳ Waiting ${Math.round(delay / 1000)}s before next profile...`);
          await randomDelay(delay, delay);
        }

      } catch (err) {
        logError(`❌ Error processing profile ${profileId}: ${err.message}`, err);
        results.failed++; results.details.push({ profileId, status: 'failed', reason: err.message });
      }
    }

    console.log(JSON.stringify({ type: 'message-result', result: results }));
    return results;

  } catch (error) {
    logError(`Fatal error in processScheduledMessages: ${error.message}`, error);
    throw error;
  }
}

function deriveRecipientNameFromProfileUrl(profileUrl) {
  const raw = String(profileUrl || '');
  const m = raw.match(/\/in\/([^\/\?]+)/);
  if (!m || !m[1]) return '';
  return m[1]
    .split('-')
    .filter((part) => part && !/^\d+$/.test(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

async function resolveWorkflowTarget(page, rawTarget) {
  const target = String(rawTarget || '').trim();
  if (!target) {
    throw new Error('Workflow target is empty');
  }

  if (/linkedin\.com\/in\//i.test(target)) {
    return {
      profileUrl: target.split('?')[0],
      recipientName: deriveRecipientNameFromProfileUrl(target)
    };
  }

  const matches = await searchForProfiles(page, target);
  const profileUrl = Array.isArray(matches)
    ? matches.find((url) => /linkedin\.com\/in\//i.test(url || ''))
    : null;

  if (!profileUrl) {
    throw new Error(`Could not find a LinkedIn profile for "${target}"`);
  }

  storeNameMapping(target, profileUrl);

  return {
    profileUrl,
    recipientName: target
  };
}

async function getWorkflowProfileDetails(page, profileUrl, recipientName = '') {
  try {
    const details = await extractProfileDetails(page, profileUrl);
    if (details && (details.firstName || details.fullName)) {
      return details;
    }
  } catch (error) {
    logError(`Failed to extract workflow profile details for ${profileUrl}: ${error.message}`, error);
  }

  const stored = await getStoredProfileDetails(profileUrl).catch(() => null);
  if (stored) {
    return {
      firstName: stored.firstName || recipientName.split(' ')[0] || 'Unknown',
      lastName: stored.lastName || recipientName.split(' ').slice(1).join(' ') || 'Profile',
      fullName: stored.fullName || recipientName || 'Unknown Profile',
      position: stored.title || stored.position || 'Not Available',
      company: stored.company || 'Not Available',
      email: stored.email || 'Not Available',
      profileUrl
    };
  }

  return {
    firstName: recipientName.split(' ')[0] || 'Unknown',
    lastName: recipientName.split(' ').slice(1).join(' ') || 'Profile',
    fullName: recipientName || 'Unknown Profile',
    position: 'Not Available',
    company: 'Not Available',
    email: 'Not Available',
    profileUrl
  };
}

function persistWorkflowProfileAction(profileUrl, profileDetails, actionType, notes) {
  try {
    storeProfileAction(profileUrl, profileDetails, actionType, notes || '');
  } catch (error) {
    logError(`Failed to store workflow profile action (${actionType}) for ${profileUrl}: ${error.message}`, error);
  }
}

function buildWorkflowStepMetadata(extra = {}) {
  return Object.entries(extra).reduce((accumulator, [key, value]) => {
    if (value === undefined) {
      return accumulator;
    }
    accumulator[key] = value;
    return accumulator;
  }, {});
}

function buildActionQuotaOptions(config = {}) {
  return {
    accountId: config.accountId || null,
    accountEmail: config.accountEmail || config.email || null,
    accountName: config.accountName || null
  };
}

function getActionQuotaExceededResult(stepType, actionType, quotaState, extra = {}) {
  return createWorkflowStepResult({
    stepType,
    outcomeType: 'skipped_quota_exceeded',
    reason: buildQuotaExceededReason(actionType, quotaState),
    profileUrl: extra.profileUrl || null,
    recipientName: extra.recipientName || null,
    metadata: buildWorkflowStepMetadata({
      actionType,
      exceeded: Array.isArray(quotaState?.exceeded) ? quotaState.exceeded : undefined,
      quota: quotaState?.quota || undefined
    })
  });
}

function formatContactOwnerLabel(entry = {}) {
  const agentName = String(entry.agentName || '').trim();
  const accountName = String(entry.accountName || '').trim();
  if (agentName && accountName) {
    return `${agentName} (${accountName})`;
  }
  return agentName || accountName || 'another SDR account';
}

function buildManagedElsewhereResult(stepType, summary, extra = {}) {
  const primary = summary?.handlersInContact?.[0] || null;
  const reason = primary
    ? primary.contactStage === 'responded'
      ? `Prospect already replied to ${formatContactOwnerLabel(primary)} and is being handled there`
      : `Prospect already has an accepted connection with ${formatContactOwnerLabel(primary)} and is being handled there`
    : 'Prospect is already being handled by another SDR account';

  return createWorkflowStepResult({
    stepType,
    outcomeType: 'skipped_managed_elsewhere',
    reason,
    profileUrl: extra.profileUrl || null,
    recipientName: extra.recipientName || null,
    metadata: buildWorkflowStepMetadata({
      blockReason: summary?.blockReason || null,
      leadIdentityKey: summary?.leadIdentityKey || null,
      blockingProspectId: primary?.prospectId || null,
      blockingAccountId: primary?.accountId || null,
      blockingAccountName: primary?.accountName || null,
      blockingAgentId: primary?.agentId || null,
      blockingAgentName: primary?.agentName || null,
      blockingContactStage: primary?.contactStage || null,
      relatedProspectCount: Array.isArray(summary?.relatedProspectIds) ? summary.relatedProspectIds.length : undefined
    })
  });
}

function resolveManagedElsewhereSummary(config = {}, prospect, resolvedTarget, recipientName) {
  return prospectQueueStore.getContactOwnershipSummary({
    prospectId: config.prospectId || prospect?.id || null,
    accountId: config.accountId || prospect?.accountId || null,
    agentId: config.agentId || prospect?.agentId || null,
    fullName: prospect?.fullName || recipientName || null,
    company: prospect?.company || null,
    profileUrl: prospect?.profileUrl || resolvedTarget?.profileUrl || null
  });
}

function mapDmOutcome(result = {}) {
  switch (result.reason) {
    case 'recent_message_exists':
      return 'skipped_thread_exists';
    case 'missing_template_fields':
    case 'missing_recipient_name':
      return 'failed_permanent';
    case 'conversation_not_found':
    case 'navigation_failed':
    case 'profile_extraction_failed':
    case 'message_interface_failed':
    case 'send_failed':
    case 'quota_exceeded':
      return 'skipped_quota_exceeded';
    case 'private_api_dry_run_failed':
    case 'missing_messaging_context':
    case 'missing_recipient_profile_urn':
    case 'missing_message_response':
    case 'exception':
    default:
      return 'failed_transient';
  }
}

async function executeWorkflowStep(page, config = {}) {
  const step = config.step || {};
  const stepType = String(step.type || '').trim();
  const messageTemplate = String(step.messageTemplate || '').trim();
  const resolvedTarget = config.resolvedTarget || await resolveWorkflowTarget(page, config.targetValue || config.rawTarget);
  const profileUrl = resolvedTarget.profileUrl;
  const recipientName =
    resolvedTarget.recipientName ||
    config.targetLabel ||
    deriveRecipientNameFromProfileUrl(profileUrl);
  const profileDetails = await getWorkflowProfileDetails(page, profileUrl, recipientName);
  const prospect = config.prospectId ? prospectQueueStore.getProspect(config.prospectId) : null;
  const managedElsewhereSummary = stepType !== 'delay'
    ? resolveManagedElsewhereSummary(config, prospect, resolvedTarget, recipientName)
    : null;

  try {
    if (managedElsewhereSummary?.blocked) {
      return buildManagedElsewhereResult(stepType, managedElsewhereSummary, {
        profileUrl,
        recipientName
      });
    }

    switch (stepType) {
      case 'view_profile': {
        const quotaOptions = buildActionQuotaOptions(config);
        const quotaState = canConsumeActionQuota('profile_viewed', 1, quotaOptions);
        if (!quotaState.allowed) {
          return getActionQuotaExceededResult(stepType, 'profile_viewed', quotaState, {
            profileUrl,
            recipientName
          });
        }
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(1200, 2600);
        await humanScroll(page);
        consumeActionQuota('profile_viewed', 1, quotaOptions);
        persistWorkflowProfileAction(profileUrl, profileDetails, 'Profile Viewed', 'Viewed during workflow step');
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'completed',
          profileUrl,
          recipientName
        });
      }
      case 'like_posts': {
        const likeResult = await processActivityPageDetailed(page, profileUrl, buildActionQuotaOptions(config));
        if (!likeResult.success) {
          return createWorkflowStepResult({
            ...likeResult,
            stepType,
            profileUrl,
            recipientName
          });
        }
        if (likeResult.outcomeType !== 'completed') {
          return createWorkflowStepResult({
            ...likeResult,
            stepType,
            profileUrl,
            recipientName
          });
        }
        persistWorkflowProfileAction(profileUrl, profileDetails, 'Post Liked', 'Liked post during workflow');
        return createWorkflowStepResult({
          ...likeResult,
          stepType,
          profileUrl,
          recipientName
        });
      }
      case 'send_connection': {
        const connectionResult = await sendConnectionRequestDetailed(
          page,
          profileUrl,
          messageTemplate,
          buildActionQuotaOptions(config)
        );
        if (connectionResult.outcomeType === 'completed') {
          persistWorkflowProfileAction(
            profileUrl,
            profileDetails,
            'Connection Request Sent',
            messageTemplate ? `Sent request with note: ${messageTemplate}` : 'Sent connection request without note'
          );
        }
        return createWorkflowStepResult({
          ...connectionResult,
          stepType,
          profileUrl,
          recipientName,
          metadata: buildWorkflowStepMetadata({
            ...(connectionResult.metadata || {}),
            hasNote: Boolean(messageTemplate)
          })
        });
      }
      case 'send_dm': {
        if (!messageTemplate) {
          return createWorkflowStepResult({
            stepType,
            outcomeType: 'failed_permanent',
            reason: 'Message template is required for DM steps',
            profileUrl,
            recipientName
          });
        }
        const dmOk = await sendLinkedInMessage(page, profileUrl, messageTemplate, {
          checkHistory: false,
          useMessagingDrawer: true,
          recipientName,
          accountId: config.accountId || null,
          accountEmail: config.accountEmail || config.email || null,
          accountName: config.accountName || null
        });
        if (!dmOk?.success) {
          return createWorkflowStepResult({
            stepType,
            outcomeType: mapDmOutcome(dmOk),
            reason: dmOk?.reason || dmOk?.error || 'Failed to send DM',
            profileUrl,
            recipientName,
            metadata: buildWorkflowStepMetadata({
              transport: dmOk?.transport || null,
              missingFields: Array.isArray(dmOk?.missingFields) ? dmOk.missingFields : undefined
            })
          });
        }
        const connectionAcceptedMetadata = buildConnectionAcceptedInferenceMetadata(prospect, {
          timestamp: new Date().toISOString()
        });
        if (connectionAcceptedMetadata.connectionAcceptedInferred) {
          persistWorkflowProfileAction(
            profileUrl,
            profileDetails,
            'Connection Accepted',
            'Inferred from successful DM after a recorded connection request'
          );
        }
        persistWorkflowProfileAction(profileUrl, profileDetails, 'Message Sent', messageTemplate);
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'completed',
          profileUrl,
          recipientName,
          metadata: buildWorkflowStepMetadata({
            transport: dmOk?.transport || null,
            ...connectionAcceptedMetadata
          })
        });
      }
      case 'delay': {
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'completed',
          profileUrl,
          recipientName,
          metadata: buildWorkflowStepMetadata({
            delayValue: step.delayValue ?? step.delayAmount,
            delayUnit: step.delayUnit || null,
            minDelayMs: step.minDelayMs ?? null,
            maxDelayMs: step.maxDelayMs ?? null
          })
        });
      }
      default:
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'failed_permanent',
          reason: `Unsupported workflow step type: ${stepType}`,
          profileUrl,
          recipientName
        });
    }
  } catch (error) {
    return createWorkflowStepResult({
      stepType,
      outcomeType: 'failed_transient',
      profileUrl,
      recipientName,
      reason: error.message
    });
  }
}

async function processGroupWorkflow(page, config) {
  const groupMembers = Array.isArray(config.groupMembers) ? config.groupMembers : [];
  const steps = Array.isArray(config.steps) ? config.steps : [];

  if (!groupMembers.length) {
    throw new Error('No group members found for group workflow');
  }
  if (!steps.length) {
    throw new Error('No workflow steps provided');
  }

  const results = {
    totalMembers: groupMembers.length,
    processed: 0,
    failed: 0,
    details: []
  };

  logAction(`Starting group workflow for ${groupMembers.length} members with ${steps.length} steps`);

  for (let i = 0; i < groupMembers.length; i++) {
    const rawTarget = String(groupMembers[i] || '').trim();
    if (!rawTarget) continue;

    let resolvedTarget;
    try {
      resolvedTarget = await resolveWorkflowTarget(page, rawTarget);
    } catch (targetError) {
      results.processed++;
      results.failed++;
      logError(`Failed to resolve workflow target "${rawTarget}": ${targetError.message}`, targetError);
      continue;
    }

    const profileUrl = resolvedTarget.profileUrl;
    const resolvedRecipientName = resolvedTarget.recipientName || deriveRecipientNameFromProfileUrl(profileUrl);
    const memberResult = { rawTarget, profileUrl, status: 'completed', stepResults: [] };
    logAction(`Group workflow member ${i + 1}/${groupMembers.length}: ${rawTarget} -> ${profileUrl}`);

    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
      const step = steps[stepIndex] || {};
      const stepType = String(step.type || '').trim();
      const nextStepType = String(steps[stepIndex + 1]?.type || '').trim();
      const minDelayMs = Math.max(300, Number(step.minDelayMs || 1000));
      const maxDelayMs = Math.max(minDelayMs, Number(step.maxDelayMs || minDelayMs));

      try {
        logAction(`Executing step ${stepIndex + 1}/${steps.length}: ${stepType}`);
        if (stepType === 'delay') {
          await waitForWorkflowDelay(minDelayMs, maxDelayMs, `workflow step ${stepIndex + 1}`);
          memberResult.stepResults.push({
            stepType,
            status: 'ok',
            outcomeType: 'completed'
          });
        } else {
          const stepResult = await executeWorkflowStep(page, {
            rawTarget,
            targetValue: rawTarget,
            targetLabel: resolvedRecipientName,
            resolvedTarget,
            accountId: config.accountId || null,
            accountName: config.accountName || null,
            agentId: config.agentId || null,
            agentName: config.agentName || null,
            step
          });
          if (!stepResult.success) {
            throw new Error(stepResult.reason || `Failed executing ${stepType}`);
          }
          memberResult.stepResults.push({
            stepType,
            status: stepResult.outcomeType && stepResult.outcomeType.startsWith('skipped_') ? 'skipped' : 'ok',
            outcomeType: stepResult.outcomeType || 'completed',
            reason: stepResult.reason || null
          });
          if (shouldStopWorkflowAfterStepResult(stepResult)) {
            memberResult.status = 'skipped';
            break;
          }
        }
      } catch (stepError) {
        memberResult.stepResults.push({ stepType, status: 'failed', reason: stepError.message });
        memberResult.status = 'failed';
        results.failed++;
        logError(`Step failed (${stepType}) for ${profileUrl}: ${stepError.message}`, stepError);
        break;
      }

      if (stepType !== 'delay' && nextStepType !== 'delay' && stepIndex < steps.length - 1) {
        await randomDelay(minDelayMs, maxDelayMs);
      }
    }

    results.processed++;
    results.details.push(memberResult);
    reportProgress(i + 1, groupMembers.length, { mode: 'group-workflow', profileUrl });
  }

  return results;
}

// --------------------------- Enhanced automation orchestrator ---------------------------
async function runEnhancedAutomation(config) {
  let browser;
  try {
    assertLegacyDirectLoginAllowed('legacy.runEnhancedAutomation', {
      onAllowed: ({ entryPoint }) => recordLegacyDirectLoginUsage({
        entryPoint,
        accountId: config?.accountId || null,
        accountName: config?.accountName || config?.accountEmail || null,
        accountEmail: config?.accountEmail || config?.email || null,
        source: 'legacy.runEnhancedAutomation'
      })
    });
    logAction('Starting enhanced automation process');

    if (!config.email || !config.password) {
      throw new Error('LinkedIn credentials are required');
    }

    const { browser: b, context } = await createBrowserContext(config);
    browser = b;

    const page = await loginToLinkedIn(context, config.email, config.password);
    if (!page) throw new Error('Failed to login to LinkedIn');

    logAction('Successfully logged into LinkedIn');

    let results;
    if (config.searchType === 'names' && Array.isArray(config.nameList) && config.nameList.length > 0) {
      logAction(`Running name list automation for ${config.nameList.length} names`);
      results = await runNameListAutomation(page, config);
    } else if (config.searchQuery) {
      logAction(`Running search automation for query: "${config.searchQuery}"`);
      results = await runEnhancedWorkflow(page, config);
    } else {
      throw new Error('No valid search configuration provided');
    }

    await browser.close();
    return results;

  } catch (error) {
    logError(`Enhanced automation failed: ${error.message}`, error);
    try { if (browser) await browser.close(); } catch (e) { logError('Error closing browser', e); }
    throw error;
  }
}

// --------------------------- IPC handlers (optional, used from Electron main) ---------------------------
function setupEnhancedIPCHandlers(ipcMain, mainWindow) {
  ipcMain.handle('start-automation', async (_event, config) => {
    try {
      logAction('Received automation start request');
      const credentials = await loadCredentials(config);
      if (!credentials.email || !credentials.password) throw new Error('Please configure your LinkedIn credentials first');

      config.email = credentials.email;
      config.password = credentials.password;

      if (config.searchType === 'names') {
        if (!config.nameList || config.nameList.length === 0) throw new Error('Name list is required for name-based automation');
        if (Array.isArray(config.nameList)) config.nameList = parseNameList(config.nameList.join('\n'));
        else if (typeof config.nameList === 'string') config.nameList = parseNameList(config.nameList);
        if (!config.nameList.length) throw new Error('No valid names found in the provided list');
        logAction(`Parsed ${config.nameList.length} valid names from input`);
      } else if (!config.searchQuery) {
        throw new Error('Search query is required for keyword-based automation');
      }

      const results = await runEnhancedAutomation(config);
      mainWindow.webContents.send('automation-completed', results);
      return { success: true, results };

    } catch (error) {
      logError(`Automation failed: ${error.message}`, error);
      mainWindow.webContents.send('automation-error', { message: error.message, type: 'error' });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('start-name-list-automation', async (_event, config) => {
    try {
      logAction('Received name list automation start request');
      const credentials = await loadCredentials(config);
      if (!credentials.email || !credentials.password) throw new Error('Please configure your LinkedIn credentials first');

      config.email = credentials.email;
      config.password = credentials.password;
      config.searchType = 'names';

      if (!config.nameList || config.nameList.length === 0) throw new Error('Name list is required');
      if (typeof config.nameList[0] === 'string') config.nameList = parseNameList(config.nameList.join('\n'));
      if (!config.nameList.length) throw new Error('No valid names found in the provided list');

      logAction(`Starting name list automation for ${config.nameList.length} names`);
      const results = await runEnhancedAutomation(config);

      mainWindow.webContents.send('name-list-automation-completed', results);
      return { success: true, results };

    } catch (error) {
      logError(`Name list automation failed: ${error.message}`, error);
      mainWindow.webContents.send('automation-error', { message: error.message, type: 'error' });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-name-mappings', async () => {
    try {
      const userHome = process.env.HOME || process.env.USERPROFILE;
      const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
      const mappingPath = path.join(documentsDir, 'name-mappings.json');
      if (!fs.existsSync(mappingPath)) return [];
      return JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    } catch (error) {
      logError('Error reading name mappings', error);
      return [];
    }
  });

  ipcMain.handle('parse-name-list', async (_e, nameListText) => {
    try {
      const names = parseNameList(nameListText);
      return { success: true, names };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

// --------------------------- Profile processor (used by fallback path) ---------------------------
async function processProfile(page, profileUrl, config, processedProfiles) {
  const cleanProfileUrl = normalizeProfileUrl(profileUrl);

  if (processedProfiles.has(cleanProfileUrl)) {
    logAction(`Profile already processed, skipping: ${cleanProfileUrl}`);
    return { likeResult: false, connectResult: false, profileDetails: null };
  }

  try {
    const quotaOptions = buildActionQuotaOptions(config);
    const profileViewQuota = canConsumeActionQuota('profile_viewed', 1, quotaOptions);
    if (!profileViewQuota.allowed) {
      logAction(`Skipping profile view for ${cleanProfileUrl}: ${buildQuotaExceededReason('profile_viewed', profileViewQuota)}`);
      return { likeResult: false, connectResult: false, profileDetails: null, skippedReason: 'quota_exceeded' };
    }

    await page.goto(cleanProfileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => logAction('Navigation timeout, continuing...'));
    await randomDelay(2000, 3000);
    consumeActionQuota('profile_viewed', 1, quotaOptions);

    let profileDetails;
    try {
      profileDetails = await extractProfileDetails(page, cleanProfileUrl);
      if (!profileDetails || !profileDetails.firstName || profileDetails.firstName === 'Unknown') {
        throw new Error('Profile details extraction returned incomplete data');
      }
    } catch (extractError) {
      logError(`Failed to extract details for ${cleanProfileUrl}: ${extractError.message}`, extractError);
      profileDetails = {
        firstName: 'Unknown',
        lastName: 'Profile',
        position: 'Not Available',
        company: 'Not Available',
        email: 'Not Available',
        profileUrl: cleanProfileUrl
      };
    }

    logAction(`Profile extracted - Name: ${profileDetails.firstName} ${profileDetails.lastName}, Title: ${profileDetails.position}`);

    try {
      storeProfileAction(
        cleanProfileUrl,
        profileDetails,
        'Profile Viewed',
        `Viewed during search for: ${config.searchQuery}`,
        config.searchQuery
      );
    } catch (storeError) {
      logError(`Failed to store profile action for ${cleanProfileUrl}: ${storeError.message}`, storeError);
    }

    try {
      await displayProfileInformation(page, profileDetails);
    } catch (displayError) {
      logError(`Error displaying profile information: ${displayError.message}`, displayError);
    }

    let likeResult = false;
    if (config.likePosts) {
      try {
        likeResult = await processActivityPage(page, cleanProfileUrl, quotaOptions);
        if (likeResult) {
          storeProfileAction(cleanProfileUrl, profileDetails, 'Post Liked', 'Liked post during automation');
        }
      } catch (likeError) {
        logError(`Error liking posts for ${cleanProfileUrl}: ${likeError.message}`, likeError);
      }
    }

    let connectResult = false;
    if (config.sendConnection) {
      try {
        const connectionMessage = (config.sendWithNote && config.connectMessage?.trim()) ? config.connectMessage : '';
        connectResult = await sendConnectionRequest(page, cleanProfileUrl, connectionMessage, quotaOptions);
        if (connectResult) {
          storeProfileAction(
            cleanProfileUrl,
            profileDetails,
            'Connection Request Sent',
            connectionMessage ? `Sent request with message: ${connectionMessage}` : 'Sent connection request without message'
          );
        }
      } catch (connectError) {
        logError(`Error sending connection request for ${cleanProfileUrl}: ${connectError.message}`, connectError);
      }
    }

    processedProfiles.add(cleanProfileUrl);
    return { likeResult, connectResult, profileDetails };

  } catch (error) {
    logError(`Error processing profile ${cleanProfileUrl} - ${error.message}`, error);
    return { likeResult: false, connectResult: false, profileDetails: null };
  }
}

// --------------------------- Config resolution ---------------------------
function resolveConfigPath() {
  const flag = process.argv.find(a => a.startsWith('--config='))?.split('=')[1];
  const positional = process.argv[2];
  const envPath = process.env.ADAPTER_CONFIG;

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const defaultPath = path.join(home, 'Documents', 'Connect-Ability', 'config.json');

  return flag || positional || envPath || defaultPath;
}

function syncProspectFromSearchResult(config, profileUrl, profileDetails, results = {}) {
  try {
    const normalizedProfileUrl = normalizeProfileUrl(profileUrl || profileDetails?.profileUrl || '');
    const fullName = String(
      profileDetails?.fullName
      || `${profileDetails?.firstName || ''} ${profileDetails?.lastName || ''}`.trim()
      || normalizedProfileUrl
    ).trim();

    if (!fullName && !normalizedProfileUrl) {
      return null;
    }

    const accountId = config?.accountId || null;
    const accountName = config?.accountName || config?.accountEmail || null;
    const agentId = config?.agentId || null;
    const agentName = config?.agentName || null;
    const searchQuery = config?.searchQuery || null;
    const searchPresetId = config?.searchPresetId || null;
    const searchPresetLabel = config?.searchPresetLabel || null;
    const searchPresetKind = config?.searchPresetKind || null;
    const sourceLabel = searchPresetLabel || searchQuery || 'Search automation';

    const prospect = prospectQueueStore.upsertProspect({
      accountId,
      accountName,
      agentId,
      agentName,
      fullName: fullName || null,
      profileUrl: normalizedProfileUrl || profileUrl || null,
      title: profileDetails?.position || profileDetails?.title || null,
      company: profileDetails?.company || null,
      state: 'active',
      sourceType: 'search',
      sourceId: searchPresetId || null,
      sourceLabel,
      metadata: {
        searchQuery,
        searchPresetId,
        searchPresetLabel,
        searchPresetKind
      }
    });

    if (!prospect?.id) {
      return null;
    }

    const timestamp = new Date().toISOString();
    const baseEvent = {
      prospectId: prospect.id,
      accountId,
      accountName,
      agentId,
      agentName,
      targetValue: fullName || normalizedProfileUrl,
      profileUrl: normalizedProfileUrl || null,
      timestamp,
      status: 'ok',
      metadata: {
        source: 'search',
        recipientName: fullName || null,
        searchQuery,
        searchPresetId,
        searchPresetLabel,
        searchPresetKind
      }
    };

    prospectQueueStore.recordActivity({
      ...baseEvent,
      type: 'profile_viewed'
    });

    if (results.likeResult) {
      prospectQueueStore.recordActivity({
        ...baseEvent,
        type: 'post_liked'
      });
    }

    if (results.connectResult) {
      prospectQueueStore.recordActivity({
        ...baseEvent,
        type: 'connection_requested'
      });
    }

    return prospect;
  } catch (error) {
    logError(`Failed syncing search result to prospect queue: ${error.message}`, error);
    return null;
  }
}

// --------------------------- MAIN (CLI entry) ---------------------------
async function main() {
  console.log('=== AUTOMATION ADAPTER STARTED ===');
  console.log('Process arguments:', process.argv);

  const configPath = resolveConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    logError('Configuration file not found at: ' + configPath);
    process.exit(1);
  }

  let config;
  try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configContent);
  } catch (error) {
    logError('Failed to parse configuration: ' + error.message);
    process.exit(1);
  }

  if (!config.email || !config.password) {
    logAction('Credentials not found in config, resolving secure account credentials');
    const resolvedCredentials = await loadCredentials(config);
    config.email = config.email || resolvedCredentials.email;
    config.password = config.password || resolvedCredentials.password;
  }
  if (!config.email || !config.password) {
    logError('Missing LinkedIn credentials. Please provide them in the configuration.');
    process.exit(1);
  }

  global.currentLinkedInAccountContext = {
    accountId: config.accountId || null,
    accountName: config.accountName || config.accountEmail || null,
    accountEmail: config.accountEmail || config.email || null
  };

  assertLegacyDirectLoginAllowed('legacy.automation-cli', {
    onAllowed: ({ entryPoint }) => recordLegacyDirectLoginUsage({
      entryPoint,
      accountId: config?.accountId || null,
      accountName: config?.accountName || config?.accountEmail || null,
      accountEmail: config?.accountEmail || config?.email || null,
      source: 'legacy.automation-cli',
      metadata: {
        mode: config?.mode || null
      }
    })
  });

  logAction(`Starting LinkedIn automation with email: ${String(config.email).slice(0, 3)}...`);

  let browser;
  let keepBrowserOpen = false;
  const startTime = new Date().toISOString();

  try {
    const currentProfile = browserProfiles[Math.floor(Math.random() * browserProfiles.length)];

    logAction('Launching browser...');
    browser = await chromium.launch({
      headless: config.headless || false,
      slowMo: config.slowMo || 100,
      args: securitySettings.args
    });

    const context = await browser.newContext({
      userAgent: currentProfile.userAgent,
      viewport: currentProfile.viewport,
      deviceScaleFactor: 1,
      hasTouch: false,
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles'
    });
    activeAutomationBrowser = browser;
    activeAutomationContext = context;

    context.on('close', () => {
      if (!automationStopRequested) {
        void requestImmediateAutomationShutdown('Browser context closed, stopping automation immediately...');
      }
    });

    logAction(`Attempting to login with credentials: ${String(config.email).slice(0, 3)}...`);
    const page = await loginToLinkedIn(context, config.email, config.password);
    if (!page) throw new Error('Failed to login to LinkedIn');
    activeAutomationPage = page;
    page.on('close', () => {
      if (!automationStopRequested) {
        void requestImmediateAutomationShutdown('Browser page closed, stopping automation immediately...');
      }
    });
    logAction('Successfully logged into LinkedIn');

    // Message sending mode (searchAndMessage legacy flag supported)
    if (config.mode === 'send-messages' || config.searchAndMessage) {
      logAction('=== MESSAGE SENDING MODE DETECTED ===');
      if (!config.profileIds || !config.profileIds.length) throw new Error('No profile IDs provided for messaging');
      if (!config.message) throw new Error('No message text provided');

      const results = await processScheduledMessages(page, config);
      logAction('=== MESSAGE SENDING COMPLETED ===');
      logAction(`Results: ${results.sent} sent, ${results.failed} failed`);

      console.log(JSON.stringify({ type: 'automation-completed', results }));
      await closeAutomationBrowserGracefully(browser);
      logAction('Browser closed, exiting process');
      process.exit(0);
    }

    if (config.mode === 'workflow-step') {
      logAction('=== DURABLE WORKFLOW STEP MODE DETECTED ===');
      const result = await executeWorkflowStep(page, {
        targetValue: config.targetValue,
        targetLabel: config.targetLabel,
        prospectId: config.prospectId,
        accountId: config.accountId || null,
        accountName: config.accountName || null,
        agentId: config.agentId || null,
        agentName: config.agentName || null,
        step: config.step,
        stepIndex: config.stepIndex
      });
      console.log(JSON.stringify({
        type: 'workflow-step-result',
        ...result,
        metadata: {
          ...(result.metadata && typeof result.metadata === 'object' ? result.metadata : {}),
          correlationId: config.correlationId || null,
          rootCorrelationId: config.rootCorrelationId || config.correlationId || null
        }
      }));
      await closeAutomationBrowserGracefully(browser);
      process.exit(result.success ? 0 : 1);
    }

    if (config.mode === 'group-workflow') {
      logAction('=== GROUP WORKFLOW MODE DETECTED ===');
      const results = await processGroupWorkflow(page, config);
      logAction(`=== GROUP WORKFLOW COMPLETED === processed: ${results.processed}, failed: ${results.failed}`);
      console.log(JSON.stringify({ type: 'automation-completed', results }));
      await closeAutomationBrowserGracefully(browser);
      process.exit(0);
    }

    // Interactive/manager modes
    if (config.mode === 'profile-manager' || process.argv.includes('--workflow-manager') || config.showWorkflowManager) {
      logAction('Opening workflow manager');
      await openWorkflowManager(page);
      keepBrowserOpen = true;
      // Keep the process alive for interactive work
      await new Promise(() => {});
    }

    // Standard automation
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
    fs.mkdirSync(documentsDir, { recursive: true });

    const isNameListMode = config.searchType === 'names' && Array.isArray(config.nameList) && config.nameList.length > 0;
    const isSearchMode   = config.searchType === 'query' || config.searchQuery;

    if (!isNameListMode && !isSearchMode) {
      logError('No valid automation mode detected');
      await closeAutomationBrowserGracefully(browser);
      process.exit(1);
    }

    let automationResult;
    if (isNameListMode) {
      logAction(`Starting name list automation for ${config.nameList.length} names`);
      automationResult = await runNameListAutomation(page, config);
    } else {
      logAction(`Starting search automation for: ${config.searchQuery}`);
      const profileUrls = await searchForProfilesWithPagination(page, config.searchQuery, config.maxPages || 3);
      if (!Array.isArray(profileUrls) || profileUrls.length === 0) {
        logAction('No profiles found');
        automationResult = { profilesProcessed: 0, status: 'no-results' };
      } else {
        const processedProfiles = new Set();
        const targets = profileUrls.slice(0, config.profileLimit || profileUrls.length);

        for (let i = 0; i < targets.length; i++) {
          if (automationStopRequested) {
            throw new Error('Automation stop requested');
          }
          const profileUrl = targets[i];
          const { likeResult, connectResult, profileDetails } = await processProfileWithHistory(page, profileUrl, config, processedProfiles);
          if (profileDetails) {
            syncProspectFromSearchResult(config, profileUrl, profileDetails, {
              likeResult,
              connectResult
            });
          }
          if (profileDetails) logAction(`Processed: ${profileDetails.firstName} ${profileDetails.lastName}`);

          console.log(JSON.stringify({ type: 'progress', current: i + 1, total: targets.length }));

          if (i < targets.length - 1) {
            const delay = 30000 + Math.random() * 30000;
            await randomDelay(delay, delay);
          }
        }

        automationResult = { profilesProcessed: processedProfiles.size, status: 'completed' };
      }
    }

    const stats = {
      mode: isNameListMode ? 'name-list' : 'search-query',
      ...automationResult,
      startTime,
      endTime: new Date().toISOString()
    };
    const statsPath = path.join(documentsDir, `automation_stats_${Date.now()}.json`);
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));

    logAction('Automation completed successfully');

    if (config.showWorkflowManager) {
      logAction('Opening workflow manager');
      await openWorkflowManager(page);
      keepBrowserOpen = true;
      await new Promise(() => {});
    }

  } catch (error) {
    if (isTargetClosedError(error)) {
      logError('Automation aborted because the browser/page/context was closed', error);
      process.exitCode = 1;
      return;
    }
    logError(`Automation failed: ${error.message}`, error);
    console.error(error);
    console.log(JSON.stringify({ type: 'automation-error', error: error.message, stack: error.stack }));
  } finally {
    if (typeof browser !== 'undefined') {
      try {
        if (!keepBrowserOpen) {
          await closeAutomationBrowserGracefully(browser);
          logAction('Browser closed');
        }
      } catch (_) {}
    }
  }
}

// --------------------------- Signals & Boot ---------------------------
// Only run CLI mode if executed directly: `node automation-adapter.js ...`
if (require.main === module) {
  main().catch((error) => {
    logError('Unhandled error in main function', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    void requestImmediateAutomationShutdown('Received SIGINT signal, stopping automation immediately...');
  });
  process.on('SIGTERM', () => {
    void requestImmediateAutomationShutdown('Received SIGTERM signal, stopping automation immediately...');
  });
}

// --------------------------- Exports ---------------------------
module.exports = {
  processScheduledMessages,
  runEnhancedAutomation,
  setupEnhancedIPCHandlers,
  reportProgress,
  createEnhancedBrowser,
  createBrowserContext,
  executeWorkflowStep,
  main
};
