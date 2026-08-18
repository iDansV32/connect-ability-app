// Test-only script: intentionally uses default fingerprinting and is not stealth-safe for production accounts.
const { chromium } = require('playwright');
const { loginToLinkedIn } = require('../automation/core/login');
const { setupFingerprinting } = require('../automation/core/fingerprinting');
const { navigateToProfile, openMessageInterface, openDrawerConversation } = require('../automation/messaging/navigator');
const { findMessageInput, typeMessage } = require('../automation/messaging/composer');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isPrivate(url) { return /linkedin\.com\/voyager\/api\//i.test(url) || /linkedin\.com\/graphql/i.test(url); }

async function clickSendButton(page) {
  const selectors = [
    'button[type="submit"].msg-form__send-button',
    'button.msg-form__send-button',
    'button[aria-label="Send"]',
    '.msg-form__send-btn'
  ];
  for (const selector of selectors) {
    const button = await page.$(selector);
    if (button && await button.isVisible().catch(() => false)) {
      await button.click();
      return true;
    }
  }
  await page.keyboard.press('Enter').catch(() => {});
  return true;
}

async function main() {
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  const recipientName = process.env.LINKEDIN_DM_RECIPIENT || 'Ivan Dans';
  const profileUrl = process.env.LINKEDIN_DM_PROFILE_URL || 'https://www.linkedin.com/in/ivan-dans-517204886/';
  const message = process.env.LINKEDIN_DM_MESSAGE || 'Hello';
  if (!email || !password) throw new Error('Missing credentials');

  const browser = await chromium.launch({ headless: false, slowMo: 60, args: ['--disable-blink-features=AutomationControlled'] });
  let context;
  try {
    context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Chicago', viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await setupFingerprinting(page);
    await loginToLinkedIn(page, email, password);

    const captured = [];
    page.on('request', (request) => {
      if (!isPrivate(request.url())) return;
      captured.push({
        type: 'request',
        method: request.method(),
        url: request.url(),
        postData: request.postData() || null
      });
    });
    page.on('response', (response) => {
      if (!isPrivate(response.url())) return;
      captured.push({
        type: 'response',
        method: response.request().method(),
        url: response.url(),
        status: response.status()
      });
    });

    let opened = false;
    if (profileUrl) {
      await navigateToProfile(page, profileUrl);
      await sleep(2500);
      opened = await openMessageInterface(page);
    }

    if (!opened) {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
      opened = await openDrawerConversation(page, recipientName);
    }

    if (!opened) {
      throw new Error('Could not open a DM conversation');
    }

    const input = await findMessageInput(page);
    if (!input) throw new Error('Message input not found');
    await typeMessage(page, input, message);
    await sleep(1000);
    await clickSendButton(page);
    await sleep(5000);

    const requests = captured.filter((e) => e.type === 'request');
    const dmCandidates = requests.filter((e) => /messag|conversation|compose|mailbox/i.test(e.url));
    console.log(JSON.stringify({
      recipientName,
      profileUrl,
      message,
      requestUrls: requests.map((e) => `${e.method} ${e.url}`),
      dmCandidates
    }, null, 2));
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
