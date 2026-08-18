// Test-only script: intentionally uses default fingerprinting and is not stealth-safe for production accounts.
const { chromium } = require('playwright');
const { loginToLinkedIn } = require('../automation/core/login');
const { setupFingerprinting } = require('../automation/core/fingerprinting');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isPrivate(url) { return /linkedin\.com\/voyager\/api\//i.test(url) || /linkedin\.com\/graphql/i.test(url); }

async function findVisible(page, selectors, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        try {
          if (await handle.isVisible()) return handle;
        } catch (_) {}
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function main() {
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  if (!email || !password) throw new Error('Missing credentials');

  const browser = await chromium.launch({ headless: false, slowMo: 50, args: ['--disable-blink-features=AutomationControlled'] });
  let context;
  try {
    context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Chicago', viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await setupFingerprinting(page);
    await loginToLinkedIn(page, email, password);

    const captured = [];
    page.on('request', (request) => {
      if (!isPrivate(request.url())) return;
      captured.push({ type: 'request', method: request.method(), url: request.url() });
    });
    page.on('response', (response) => {
      if (!isPrivate(response.url())) return;
      captured.push({ type: 'response', method: response.request().method(), url: response.url(), status: response.status() });
    });

    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(7000);

    const firstConversation = await findVisible(page, [
      '.msg-conversation-listitem',
      'li.msg-conversations-container__convo-item',
      '.msg-conversations-container__convo-item-container',
      '[data-control-name*="conversation"]'
    ], 20000);

    if (firstConversation) {
      await firstConversation.click({ delay: 60 }).catch(() => {});
      await sleep(5000);
    }

    const requests = captured.filter((e) => e.type === 'request');
    const messagingCalls = requests.filter((e) => /messag|conversation|mailbox/i.test(e.url));
    console.log(JSON.stringify({
      requestUrls: requests.map((e) => `${e.method} ${e.url}`),
      messagingCandidates: messagingCalls
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
