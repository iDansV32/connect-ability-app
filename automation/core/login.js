const { randomDelay } = require('../human/delay');
const { handleSecurityChallenges } = require('./challenges');
const { setupFingerprinting } = require('./fingerprinting');
const { moveMouseNaturally } = require('../mouse/move-naturally');
const { stealthClick } = require('../mouse/stealth-click');
const { resolveAccountFingerprintProfile } = require('../safety/account-fingerprint-profile');
const { waitForAnySelector } = require('../helpers/wait');
const { logAction, logError } = require('../util/log');
const {
  LINKEDIN_ORIGIN,
  clearLinkedInSessionState,
  applyLinkedInSessionState,
  persistLinkedInSessionState
} = require('./session-state');
const { captureLoginDebugScreenshot } = require('./login-debug-artifacts');

// Helper function for retry logic
async function retryWithBackoff(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await randomDelay(1000 * Math.pow(2, i), 2000 * Math.pow(2, i));
    }
  }
}

const VALID_LOGIN_INDICATORS = [
  'img.global-nav__me-photo',
  '.feed-identity-module',
  '.global-nav__me',
  'header.global-nav',
  'nav.global-nav',
  'input[placeholder="Search"]',
  'input[role="combobox"]',
  '.share-box-feed-entry',
  '[data-control-name="nav.settings"]',
  'a[href*="/mynetwork/"]',
  'a[href*="/messaging/"]'
];

const LOGIN_EMAIL_SELECTORS = [
  '#username',
  'input[name="session_key"]',
  'input[autocomplete="username"]',
  'input[type="email"]'
];

const LOGIN_PASSWORD_SELECTORS = [
  '#password',
  'input[name="session_password"]',
  'input[autocomplete="current-password"]',
  'input[type="password"]'
];

const LOGIN_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'button[data-litms-control-urn*="login-submit"]',
  '.login__form_action_container button'
];

const ACCOUNT_SWITCH_SELECTORS = [
  'text="Sign in using another account"',
  'text="Use another account"'
];

async function findFirstVisibleSelector(page, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const handle = await page.$(selector);
        if (handle && await handle.isVisible()) {
          return selector;
        }
      } catch (_) {}
    }
    await page.waitForTimeout(200).catch(() => {});
  }

  return null;
}

async function resolveLoginFieldSelectors(page, timeoutMs = 8000) {
  const emailSelector = await findFirstVisibleSelector(page, LOGIN_EMAIL_SELECTORS, timeoutMs);
  if (!emailSelector) {
    return null;
  }

  const passwordSelector = await findFirstVisibleSelector(page, LOGIN_PASSWORD_SELECTORS, 2000);
  if (!passwordSelector) {
    return null;
  }

  return {
    emailSelector,
    passwordSelector
  };
}

async function clickHandle(page, handle, options = {}) {
  if (!handle) {
    return false;
  }

  if (options.strictStealth === true) {
    return stealthClick(page, handle, options);
  }

  await moveMouseNaturally(page, handle);
  await handle.click({
    delay: 30 + Math.floor(Math.random() * 90)
  }).catch(() => {});
  return true;
}

async function clickIfVisible(page, selectors, timeoutMs = 3000, options = {}) {
  const selector = await findFirstVisibleSelector(page, selectors, timeoutMs);
  if (!selector) {
    return false;
  }

  const handle = await page.$(selector).catch(() => null);
  if (!handle) {
    return false;
  }

  return clickHandle(page, handle, options);
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

async function ensureCredentialLoginForm(page, options = {}) {
  // LinkedIn may redirect /login to /authwall (registration page) for automated
  // browsers. If we detect the authwall, look for the "Sign in" link and click it
  // to reach the real login form.
  const currentUrl = await getCurrentPageUrl(page);
  if (/\/authwall/i.test(currentUrl)) {
    logAction('Detected LinkedIn authwall (registration page), looking for Sign in link');
    const signInLink = await clickIfVisible(page, [
      'a[href*="/login"]',
      'a:has-text("Sign in")',
      'a:has-text("sign in")',
      'a[data-tracking-control-name*="sign_in"]'
    ], 5000, options);
    if (signInLink) {
      logAction('Clicked Sign in link on authwall, waiting for login form');
      await randomDelay(2000, 3500);
    } else {
      // Direct navigation fallback
      logAction('No Sign in link found on authwall, navigating directly to /login');
      await retryWithBackoff(async () => {
        await page.goto('https://www.linkedin.com/login', {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });
      });
      await randomDelay(1500, 2500);
    }
  }

  let fieldSelectors = await resolveLoginFieldSelectors(page, 2500);
  if (fieldSelectors) {
    return fieldSelectors;
  }

  if (await clickIfVisible(page, ACCOUNT_SWITCH_SELECTORS, 3000, options)) {
    logAction('Login account chooser detected, switching to credential form');
    await randomDelay(1200, 2200);
    fieldSelectors = await resolveLoginFieldSelectors(page, 8000);
    if (fieldSelectors) {
      return fieldSelectors;
    }
  }

  const fallbackLoginUrls = [
    'https://www.linkedin.com/checkpoint/lg/sign-in-another-account',
    'https://www.linkedin.com/login'
  ];

  for (const loginUrl of fallbackLoginUrls) {
    await retryWithBackoff(async () => {
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    });
    await randomDelay(1500, 2500);

    fieldSelectors = await resolveLoginFieldSelectors(page, 5000);
    if (fieldSelectors) {
      return fieldSelectors;
    }

    if (await clickIfVisible(page, ACCOUNT_SWITCH_SELECTORS, 2000, options)) {
      logAction(`LinkedIn redirected to account chooser on ${loginUrl}, switching again`);
      await randomDelay(1200, 2200);
      fieldSelectors = await resolveLoginFieldSelectors(page, 8000);
      if (fieldSelectors) {
        return fieldSelectors;
      }
    }
  }

  return null;
}

async function verifyLoggedInSession(page, timeoutMs = 15000, dependencies = {}) {
  const waitForIndicator = dependencies.waitForAnySelector || waitForAnySelector;
  try {
    // Persistent contexts restore their last LinkedIn page. If that page is
    // already authenticated, reuse it instead of visibly navigating to the
    // feed before every search/workflow run.
    const restoredUrl = await getCurrentPageUrl(page);
    if (isUsableAuthenticatedLinkedInUrl(restoredUrl)) {
      const restoredIndicator = await waitForIndicator(
        page,
        VALID_LOGIN_INDICATORS,
        Math.min(2500, timeoutMs)
      ).catch(() => null);
      if (restoredIndicator && isUsableAuthenticatedLinkedInUrl(await getCurrentPageUrl(page))) {
        return restoredIndicator;
      }
    }

    await retryWithBackoff(async () => {
      await page.goto(`${LINKEDIN_ORIGIN}/feed/`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    }, 2);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await randomDelay(1500, 2800);
    await handleSecurityChallenges(page).catch(() => false);
    const foundSelector = await waitForIndicator(page, VALID_LOGIN_INDICATORS, timeoutMs).catch(() => null);
    if (foundSelector) {
      // Double-check: LinkedIn may have served a cached DOM before redirecting.
      // If the page URL is now a login/checkpoint page, the session is stale.
      const urlAfterIndicator = await getCurrentPageUrl(page);
      if (/\/(?:login|uas\/login|checkpoint|challenge)\b/i.test(urlAfterIndicator)) {
        logAction(`Session indicator "${foundSelector}" found but URL is ${urlAfterIndicator} — session is stale`);
        return null;
      }
      return foundSelector;
    }

    const currentUrl = await getCurrentPageUrl(page);
    if (!/\/(?:login|uas\/login|checkpoint|challenge)\b/i.test(currentUrl)) {
      const fallbackSelector = await findFirstVisibleSelector(page, [
        'header.global-nav',
        'nav.global-nav',
        'a[href="/feed/"]',
        'a[href="https://www.linkedin.com/feed/"]',
        'a[href*="/mynetwork/"]',
        'a[href*="/messaging/"]'
      ], 3000);
      if (fallbackSelector) {
        return fallbackSelector;
      }
    }

    return foundSelector;
  } catch (_) {
    return null;
  }
}

function isUsableAuthenticatedLinkedInUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\//i.test(url)) return false;
  return !/\/(?:login|uas\/login|checkpoint|challenge)\b/i.test(url);
}

async function loginToLinkedIn(browser, email, password, options = {}) {
  logAction('Starting LinkedIn login process');

  // CRITICAL: Check if browser is actually a page object
  let page;
  if (browser.goto && typeof browser.goto === 'function') {
    // browser is actually a page, use it directly
    page = browser;
    logAction('Using existing page object');
  } else if (browser.newPage) {
    // browser is a browser object, create new page
    page = await browser.newPage();
    logAction('Created new page from browser');
  } else {
    throw new Error('Invalid browser/page object provided to loginToLinkedIn');
  }

  try {
    const fingerprintProfile = options.fingerprintProfile
      || page.__connectFingerprintProfile
      || resolveAccountFingerprintProfile({
        email,
        fingerprintProfileSeed: options.fingerprintProfileSeed || null
      });

    await setupFingerprinting(page, { fingerprintProfile });

    const restoredSession = await applyLinkedInSessionState(page, email || null);
    if (restoredSession.applied) {
      logAction(`Attempting stored LinkedIn session reuse from ${restoredSession.path}`);
      const restoredIndicator = await verifyLoggedInSession(page, 12000);
      if (restoredIndicator) {
        logAction(`Reused stored LinkedIn session (detected ${restoredIndicator})`);
        const persistedPath = await persistLinkedInSessionState(page, email || restoredSession.email || null).catch(() => null);
        if (persistedPath) {
          logAction(`Refreshed LinkedIn session cache at ${persistedPath}`);
        }
        return page;
      }

      logAction('Stored LinkedIn session could not be confirmed, falling back to credential login');
    }

    if (!email || email.trim() === '') {
      throw new Error('Email credential is missing or empty');
    }
    if (!password || password.trim() === '') {
      throw new Error('Password credential is missing or empty');
    }

    logAction(`Using credentials for: ${email.slice(0, 3)}...`);
    await retryWithBackoff(async () => {
      await page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    });
    await randomDelay(2000, 4000);

    const pageTitle = await page.title();
    logAction(`Login page loaded with title: ${pageTitle}`);

    const fieldSelectors = await ensureCredentialLoginForm(page, options);
    if (!fieldSelectors) {
      clearLinkedInSessionState(email || null);
      logError('Login page elements not found. Page may not have loaded correctly');
      throw new Error('Login page elements not found');
    }

    const { emailSelector, passwordSelector } = fieldSelectors;

    // Enter email
    logAction(`Entering email: ${email.slice(0, 3)}...`);
    const emailInput = await page.$(emailSelector);
    const emailClicked = await clickHandle(page, emailInput, options);
    if (!emailClicked) {
      throw new Error('Could not focus LinkedIn email field');
    }
    await randomDelay(300, 600);
    await page.evaluate((selector) => {
      const input = document.querySelector(selector);
      if (input) input.value = '';
    }, emailSelector);
    for (const char of email) {
      await page.keyboard.type(char);
      await randomDelay(50, 150);
    }
    await randomDelay(1000, 2000);

    // Enter password
    logAction('Entering password');
    const passwordInput = await page.$(passwordSelector);
    const passwordClicked = await clickHandle(page, passwordInput, options);
    if (!passwordClicked) {
      throw new Error('Could not focus LinkedIn password field');
    }
    await randomDelay(300, 600);
    await page.evaluate((selector) => {
      const input = document.querySelector(selector);
      if (input) input.value = '';
    }, passwordSelector);
    for (const char of password) {
      await page.keyboard.type(char);
      await randomDelay(50, 150);
    }
    await randomDelay(1000, 2000);

    // Take a screenshot before clicking sign in when explicit login debug artifacts are enabled
    try {
      const beforeLoginPath = await captureLoginDebugScreenshot(page, 'before-login');
      if (beforeLoginPath) {
        logAction(`Saved pre-login screenshot to ${beforeLoginPath}`);
      }
    } catch (e) {
      // Continue even if screenshot fails
    }

    // Submit login
    logAction('Clicking sign in');
    const signInButtonSelector = await findFirstVisibleSelector(page, LOGIN_SUBMIT_SELECTORS, 5000);
    if (!signInButtonSelector) {
      clearLinkedInSessionState(email || null);
      throw new Error('LinkedIn sign-in button not found');
    }
    const signInButton = await page.$(signInButtonSelector);
    const signInClicked = await clickHandle(page, signInButton, options);
    if (!signInClicked) {
      throw new Error('Could not click LinkedIn sign-in button');
    }
    await randomDelay(3000, 5000);

    // Check for errors
    const errorSelectors = [
      '.form__input--error',
      '.error-msg',
      'div[role="alert"][class*="error"]',
      'div[id="error-for-username"]',
      'div[id="error-for-password"]'
    ];

    let hasError = false;
    let errorText = '';

    for (const selector of errorSelectors) {
      const errorElement = await page.$(selector);
      if (errorElement) {
        const text = await errorElement.textContent();
        if (
          text &&
          text.trim().length > 0 &&
          (
            text.toLowerCase().includes('wrong') ||
            text.toLowerCase().includes('error') ||
            text.toLowerCase().includes('invalid') ||
            text.toLowerCase().includes('incorrect')
          )
        ) {
          hasError = true;
          errorText = text.trim();
          break;
        }
      }
    }

    if (hasError && errorText) {
      logError(`Login error detected: ${errorText}`);
      try {
        const errorPath = await captureLoginDebugScreenshot(page, 'login-error');
        if (errorPath) {
          logAction(`Saved login error screenshot to ${errorPath}`);
        }
      } catch (_) {}
      throw new Error(`LinkedIn login failed: ${errorText}`);
    }

    // Check if we're still on the login page
    await randomDelay(2000, 3000);
    const currentUrl = await page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/uas/login')) {
      const linkedInError = await page.$('.alert-content, .form__input--error');
      if (linkedInError) {
        const errorMsg = await linkedInError.textContent();
        if (errorMsg && errorMsg.trim()) {
          throw new Error(`LinkedIn login failed: ${errorMsg}`);
        }
      }
    }

    // Handle security challenges
    const hasChallenges = await handleSecurityChallenges(page);
    if (hasChallenges) {
      logAction('Handled security challenges, continuing');
    }

    // Wait for successful login indicators
    const foundSelector = await waitForAnySelector(page, VALID_LOGIN_INDICATORS, 45000);
    logAction(`Successfully logged in (detected ${foundSelector})`);

    const persistedPath = await persistLinkedInSessionState(page, email).catch(() => null);
    if (persistedPath) {
      logAction(`Saved LinkedIn session cache to ${persistedPath}`);
    }

    // CRITICAL: Return the page WITHOUT closing it
    return page;
  } catch (error) {
    // Take a screenshot for debugging if login fails
    try {
      const screenshotPath = await captureLoginDebugScreenshot(page, 'login-error');
      if (screenshotPath) {
        logError(`Login failed, saved screenshot to ${screenshotPath}`, error);
      }
    } catch (screenshotError) {
      logError('Failed to save error screenshot', screenshotError);
    }

    logError('Login failed', error);
    throw error;
  }
}

module.exports = {
  loginToLinkedIn,
  verifyLoggedInSession,
  _private: {
    isUsableAuthenticatedLinkedInUrl
  }
};
