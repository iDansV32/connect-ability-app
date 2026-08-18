// Test-only script: intentionally uses default fingerprinting and is not stealth-safe for production accounts.
const { chromium } = require('playwright');
const { loginToLinkedIn } = require('../automation/core/login');
const { setupFingerprinting } = require('../automation/core/fingerprinting');
const { openComposer, isComposerOpen } = require('../automation/posting/composer');

const SAMPLE_POST = [
  'Customer success is full of small delights.',
  '',
  'A clear onboarding email.',
  'A proactive check-in before a blocker grows.',
  'A fast answer that turns confusion into momentum.',
  '',
  'The best teams make customers feel understood, supported, and confident long before renewal season.',
  '',
  'That is the delight of customer success: consistent trust, delivered in tiny moments.',
  '',
  '#CustomerSuccess #CX #SaaS'
].join('\n');

const START_POST_SELECTORS = [
  'button.share-box-feed-entry__trigger',
  'button[aria-label*="Start a post"]',
  'button[aria-label*="Create a post"]',
  'div[role="button"][aria-label*="Start a post"]',
  'div[role="button"][aria-label*="Create a post"]',
  '.share-box-feed-entry__closed-share-box',
  '.share-box-feed-entry'
];

const EDITOR_SELECTORS = [
  'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]'
];

const POST_BUTTON_SELECTORS = [
  'div[role="dialog"] button:has-text("Post")',
  'button[aria-label="Post"]',
  'button.share-actions__primary-action'
];

const SUCCESS_TOAST_SELECTORS = [
  '[role="alert"]:has-text("shared")',
  '[role="alert"]:has-text("posted")',
  '.artdeco-toast-item:has-text("shared")'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveCsrfToken(cookies) {
  const jsession = cookies.find((cookie) => cookie.name === 'JSESSIONID');
  return jsession?.value ? jsession.value.replace(/^"|"$/g, '') : '';
}

function buildCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function sanitizeHeaders(headers, csrfToken, cookieHeader) {
  const next = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'cookie' ||
      lower === 'csrf-token' ||
      lower.startsWith(':')
    ) {
      continue;
    }
    next[key] = value;
  }
  if (cookieHeader) next.Cookie = cookieHeader;
  if (csrfToken) next['csrf-token'] = csrfToken;
  if (!next['x-restli-protocol-version']) {
    next['x-restli-protocol-version'] = '2.0.0';
  }
  return next;
}

function isLinkedInApiRequest(url) {
  return /linkedin\.com\/voyager\/api\//i.test(url) || /linkedin\.com\/graphql/i.test(url);
}

async function findVisible(page, selectors, timeoutMs = 20000) {
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

async function clickSlow(page, handle) {
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  const box = await handle.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(
      box.x + box.width / 2,
      box.y + box.height / 2,
      { steps: 18 }
    );
  }
  await sleep(300 + Math.floor(Math.random() * 400));
  await handle.click({ delay: 70 + Math.floor(Math.random() * 120) });
  await sleep(400 + Math.floor(Math.random() * 500));
}

async function typePost(page, text) {
  const editor = await findVisible(page, EDITOR_SELECTORS, 20000);
  if (!editor) throw new Error('Post editor not found');
  await clickSlow(page, editor);

  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      await page.keyboard.type(ch, { delay: 55 + Math.floor(Math.random() * 95) });
      if (Math.random() < 0.06) {
        await sleep(200 + Math.floor(Math.random() * 500));
      }
    }
    if (i < lines.length - 1) {
      await page.keyboard.press('Shift+Enter');
      await sleep(150 + Math.floor(Math.random() * 300));
    }
  }
}

async function waitForSuccess(page, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findVisible(page, SUCCESS_TOAST_SELECTORS, 800);
    if (found) return true;

    const composerOpen = await isComposerOpen(page, 800);
    const postButton = await findVisible(page, POST_BUTTON_SELECTORS, 800);
    if (!composerOpen && !postButton) {
      return true;
    }

    await page.waitForTimeout(350);
  }

  return false;
}

async function findStartPostHandle(page, timeoutMs = 25000) {
  const direct = await findVisible(page, START_POST_SELECTORS, timeoutMs);
  if (direct) return direct;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fallback = await page.evaluateHandle(() => {
      const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
      const match = candidates.find((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const combined = `${text} ${aria}`;
        const style = window.getComputedStyle(el);
        const visible = style && style.visibility !== 'hidden' && style.display !== 'none';
        const rect = el.getBoundingClientRect();
        return visible &&
          rect.width > 0 &&
          rect.height > 0 &&
          (
            combined.includes('start a post') ||
            combined.includes('create a post') ||
            combined.includes('write a post') ||
            combined.includes('share a post')
          );
      });
      return match || null;
    });

    const asElement = fallback.asElement();
    if (asElement) {
      return asElement;
    }
    await page.waitForTimeout(300);
  }

  return null;
}

function chooseReplayCandidate(requests) {
  const safePost = requests.find((entry) => {
    if (entry.method !== 'POST') return false;
    const url = entry.url.toLowerCase();
    return !url.includes('ugc') &&
      !url.includes('share') &&
      !url.includes('post') &&
      !url.includes('create');
  });
  return safePost || requests.find((entry) => entry.method === 'GET') || requests[0] || null;
}

async function main() {
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Missing LINKEDIN_EMAIL or LINKEDIN_PASSWORD');
  }

  console.log('Starting LinkedIn post API probe');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 60,
    args: ['--disable-blink-features=AutomationControlled']
  });

  let context;
  try {
    context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/Chicago',
      viewport: { width: 1366, height: 768 }
    });
    const page = await context.newPage();

    await setupFingerprinting(page);
    console.log('Stage: fingerprinting complete');
    await sleep(1200);
    await loginToLinkedIn(page, email, password);
    console.log('Stage: login complete');
    await sleep(2500);
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`Stage: feed loaded at ${page.url()}`);
    await sleep(3500);

    const captured = [];
    page.on('request', (request) => {
      if (!isLinkedInApiRequest(request.url())) return;
      captured.push({
        type: 'request',
        ts: Date.now(),
        method: request.method(),
        url: request.url(),
        headers: request.headers(),
        postData: request.postData() || null
      });
    });
    page.on('response', async (response) => {
      if (!isLinkedInApiRequest(response.url())) return;
      captured.push({
        type: 'response',
        ts: Date.now(),
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
        headers: response.headers()
      });
    });

    console.log('Stage: opening composer');
    const composerOpened = await openComposer(page, { timeoutMs: 25000 });
    if (!composerOpened) throw new Error('Start post button not found');
    await sleep(1200);

    console.log('Stage: typing post body');
    await typePost(page, SAMPLE_POST);
    await sleep(1800);

    console.log('Stage: locating publish button');
    const postButton = await findVisible(page, POST_BUTTON_SELECTORS, 20000);
    if (!postButton) throw new Error('Post button not found');
    console.log('Stage: clicking publish');
    await clickSlow(page, postButton);

    console.log('Stage: waiting for publish success');
    const success = await waitForSuccess(page, 45000);
    if (!success) {
      throw new Error('No LinkedIn publish confirmation detected');
    }
    console.log('Stage: publish confirmed');

    await sleep(5000);

    const requests = captured.filter((entry) => entry.type === 'request');
    const responses = captured.filter((entry) => entry.type === 'response');
    const candidate = chooseReplayCandidate(requests);
    if (!candidate) {
      throw new Error('No API replay candidate was captured during the post flow');
    }

    const cookies = await context.cookies('https://www.linkedin.com');
    const csrfToken = deriveCsrfToken(cookies);
    const cookieHeader = buildCookieHeader(cookies);
    const replayHeaders = sanitizeHeaders(candidate.headers, csrfToken, cookieHeader);

    const replayResponse = await fetch(candidate.url, {
      method: candidate.method,
      headers: replayHeaders,
      body: candidate.method === 'GET' ? undefined : candidate.postData || undefined
    });
    const replayText = await replayResponse.text();

    const summary = {
      postPublished: true,
      capturedRequestCount: requests.length,
      capturedResponseCount: responses.length,
      requestUrls: requests.map((entry) => `${entry.method} ${entry.url}`).slice(0, 20),
      replayCandidate: {
        method: candidate.method,
        url: candidate.url
      },
      replayResponse: {
        status: replayResponse.status,
        ok: replayResponse.ok,
        contentType: replayResponse.headers.get('content-type') || '',
        bodySample: replayText.slice(0, 1000)
      }
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
