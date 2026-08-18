// Auto-extracted from automation-functions.js
// NOTE: verify imports below and adjust as needed.

const { randomDelay } = require('../human/delay');
const { logAction } = require('../util/log'); // Added missing import

async function handleSecurityChallenges(page) { // Added async keyword
  // 1) Bail out immediately if we're not on a known verification path
  const url = page.url();
  if (
    !url.includes('/checkpoint/') &&
    !url.includes('/security-verification') &&
    !url.includes('/mfa/')
  ) {
    return false;
  }

  // 2) Only consider selectors if their elements are actually visible
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    '.recaptcha-checkbox',
    '#captcha',
    'input[name="pin"]',
    '#input__email_verification_pin'
  ];

  for (const selector of captchaSelectors) {
    const el = await page.$(selector);
    if (el && await el.isVisible()) {
      logAction(`⚠️ Security challenge detected via "${selector}"`);
      
      // 3a) Email PIN flows
      if (selector.includes('verification_pin') || selector === 'input[name="pin"]') {
        logAction('🔐 Email verification PIN required—please check your email');
        // give user time to enter PIN manually
        await randomDelay(60000, 70000);
        return true;
      }
      
      // 3b) reCAPTCHA flows
      if (selector.includes('recaptcha') || selector === '#captcha') {
        logAction('🤖 reCAPTCHA detected—please solve it in the browser');
        // wait briefly for human to solve
        await randomDelay(30000, 40000);
        return true;
      }
    }
  }

  // 4) No genuine challenge identified
  return false;
}

module.exports = { handleSecurityChallenges };