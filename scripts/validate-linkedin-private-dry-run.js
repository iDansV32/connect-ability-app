// Test-only script: intentionally uses default fingerprinting and is not stealth-safe for production accounts.
const { chromium } = require('playwright');
const { loginToLinkedIn } = require('../automation/core/login');
const { setupFingerprinting } = require('../automation/core/fingerprinting');
const { humanLikeSearch, extractProfileUrls } = require('../automation/search/search');
const { sendConnectionRequest } = require('../automation/connection/request');
const { sendLinkedInMessage } = require('../automation/messaging/orchestrator');
const { scheduleTextPost } = require('../automation/posting/service');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function slowPause(min, max) {
  await sleep(jitter(min, max));
}

async function countVisibleProfiles(page) {
  return page.evaluate(() => {
    const urls = new Set();
    const links = Array.from(document.querySelectorAll('a[href*="/in/"]'));
    for (const link of links) {
      const href = link.href ? link.href.split('?')[0] : '';
      if (href.includes('linkedin.com/in/')) {
        urls.add(href);
      }
    }
    return urls.size;
  });
}

function buildFutureTimestamp(hoursAhead = 26) {
  return String(Date.now() + hoursAhead * 60 * 60 * 1000);
}

function normalizeActionResult(name, result, extras = {}) {
  const success = result === true || Boolean(result && result.success);
  const mode =
    result?.transport === 'private_api_dry_run' || result?.dryRun
      ? 'private_api_dry_run'
      : success
        ? 'ok'
        : 'failed';

  return {
    action: name,
    success,
    mode,
    reason: result?.reason || null,
    error: result?.error || null,
    details: {
      ...extras,
      transport: result?.transport || null,
      preview: result?.preview || null,
      resourceKey: result?.resourceKey || null
    }
  };
}

async function main() {
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  const searchTerm = process.env.LINKEDIN_SEARCH_TERM || 'Ivan Dans';
  const dmMessage = process.env.LINKEDIN_DM_MESSAGE || 'Hello';
  const postText = process.env.LINKEDIN_POST_TEXT || 'Customer success dry-run scheduled post validation';

  if (!email || !password) {
    throw new Error('Missing LINKEDIN_EMAIL or LINKEDIN_PASSWORD');
  }

  process.env.LINKEDIN_PRIVATE_API_WRITES = 'true';
  process.env.LINKEDIN_PRIVATE_API_CONNECTIONS = 'true';
  process.env.LINKEDIN_PRIVATE_API_DMS = 'true';
  process.env.LINKEDIN_PRIVATE_API_POSTS = 'true';
  process.env.LINKEDIN_PRIVATE_API_DRY_RUN = 'true';

  const browser = await chromium.launch({
    headless: false,
    slowMo: 75,
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
    await slowPause(1200, 2200);

    await loginToLinkedIn(page, email, password);
    await slowPause(2400, 4200);

    const searchOk = await humanLikeSearch(page, searchTerm);
    if (!searchOk) {
      throw new Error('Search failed during dry-run validation');
    }
    await slowPause(3500, 6200);

    const profileUrls = await extractProfileUrls(page);
    const visibleProfileCount = await countVisibleProfiles(page);
    if (!profileUrls.length) {
      throw new Error('No profile URLs found during dry-run validation');
    }

    const profileUrl = profileUrls[0];

    const connectionResult = await sendConnectionRequest(page, profileUrl, '');
    await slowPause(2200, 4200);

    const dmResult = await sendLinkedInMessage(page, profileUrl, dmMessage, {
      checkHistory: false
    });
    await slowPause(2200, 4200);

    const scheduledAt = buildFutureTimestamp();
    const scheduleResult = await scheduleTextPost(page, {
      text: postText,
      scheduledAt,
      visibilityType: 'ANYONE',
      allowedCommentersScope: 'ALL',
      origin: 'FEED'
    });

    const actionSummaries = [
      normalizeActionResult('connection', connectionResult, {
        note: false
      }),
      normalizeActionResult('dm', dmResult, {
        messageLength: dmMessage.length
      }),
      normalizeActionResult('scheduled_post', scheduleResult, {
        scheduledAt,
        visibilityType: 'ANYONE'
      })
    ];

    const passCount = actionSummaries.filter((item) => item.success).length;
    const failCount = actionSummaries.length - passCount;

    console.log(JSON.stringify({
      mode: 'dry_run',
      searchTerm,
      visibleProfileCount,
      selectedProfileUrl: profileUrl,
      summary: {
        totalActions: actionSummaries.length,
        passed: passCount,
        failed: failCount
      },
      actions: actionSummaries,
      raw: {
        connectionResult,
        dmResult,
        scheduleResult
      }
    }, null, 2));
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
