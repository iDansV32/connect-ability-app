// Test-only script: intentionally uses default fingerprinting and is not stealth-safe for production accounts.
const { chromium } = require('playwright');
const { loginToLinkedIn } = require('../automation/core/login');
const { setupFingerprinting } = require('../automation/core/fingerprinting');
const { processActivityPage } = require('../automation/activity/like');
const { sendConnectionRequest } = require('../automation/connection/request');
const { humanLikeSearch, extractProfileUrls } = require('../automation/search/search');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isLinkedInPrivateApi(url) {
  return /linkedin\.com\/voyager\/api\//i.test(url) || /linkedin\.com\/graphql/i.test(url);
}

async function slowPause(min, max) {
  await sleep(jitter(min, max));
}

function uniq(items) {
  return [...new Set(items)];
}

function makeStageSummary(stageName, entries) {
  const requests = entries.filter((entry) => entry.type === 'request');
  const responses = entries.filter((entry) => entry.type === 'response');
  const responseMap = new Map();

  for (const response of responses) {
    const key = `${response.method} ${response.url}`;
    if (!responseMap.has(key)) {
      responseMap.set(key, []);
    }
    responseMap.get(key).push(response.status);
  }

  return {
    stage: stageName,
    requestCount: requests.length,
    responseCount: responses.length,
    calls: requests.map((request) => {
      const key = `${request.method} ${request.url}`;
      return {
        method: request.method,
        url: request.url,
        statuses: responseMap.get(key) || []
      };
    })
  };
}

function extractProfilesFromSearchBodies(entries) {
  const urls = new Set();
  let bodyHits = 0;

  for (const entry of entries) {
    if (entry.type !== 'response' || !entry.body) continue;
    bodyHits++;

    const directMatches = entry.body.match(/https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9\-_%]+/g) || [];
    for (const match of directMatches) {
      urls.add(match);
    }

    const publicIdentifierMatches = entry.body.match(/"publicIdentifier":"([^"]+)"/g) || [];
    for (const match of publicIdentifierMatches) {
      const identifier = match.split('"publicIdentifier":"')[1]?.replace(/"$/, '');
      if (identifier) {
        urls.add(`https://www.linkedin.com/in/${identifier}`);
      }
    }
  }

  return {
    urls: [...urls],
    bodyHits
  };
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

async function main() {
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  const searchTerm = process.env.LINKEDIN_SEARCH_TERM || 'software engineer';
  const connectionMessage = process.env.LINKEDIN_CONNECT_MESSAGE || '';

  if (!email || !password) {
    throw new Error('Missing LINKEDIN_EMAIL or LINKEDIN_PASSWORD');
  }

  console.log(`Starting full round probe for search term: ${searchTerm}`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 85,
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
    await slowPause(1200, 2200);

    await loginToLinkedIn(page, email, password);
    console.log('Stage: login complete');
    await slowPause(2500, 4500);

    const stageEntries = {
      search: [],
      open_profile: [],
      like_post: [],
      send_connection: []
    };
    let currentStage = 'search';

    page.on('request', (request) => {
      if (!isLinkedInPrivateApi(request.url())) return;
      stageEntries[currentStage].push({
        type: 'request',
        stage: currentStage,
        method: request.method(),
        url: request.url()
      });
    });

    page.on('response', (response) => {
      if (!isLinkedInPrivateApi(response.url())) return;
      const targetStage = currentStage;
      const record = {
        type: 'response',
        stage: targetStage,
        method: response.request().method(),
        url: response.url(),
        status: response.status()
      };
      stageEntries[targetStage].push(record);

      if (targetStage !== 'search') return;

      response.text()
        .then((body) => {
          record.body = body.slice(0, 50000);
        })
        .catch(() => {});
    });

    console.log(`Stage: search -> humanLikeSearch("${searchTerm}")`);
    const searchOk = await humanLikeSearch(page, searchTerm);
    if (!searchOk) {
      throw new Error('humanLikeSearch failed');
    }
    await slowPause(4000, 7000);

    const profileUrls = await extractProfileUrls(page);
    const visibleProfileCount = await countVisibleProfiles(page);
    const searchFallback = extractProfilesFromSearchBodies(stageEntries.search);
    const allProfileUrls = profileUrls.length ? profileUrls : searchFallback.urls;
    if (!allProfileUrls.length) {
      throw new Error('No profile URLs found in search results or captured search API responses');
    }

    const firstProfile = {
      url: allProfileUrls[0],
      name: allProfileUrls[0].split('/in/')[1]?.replace(/[-_/]+/g, ' ') || 'Unknown'
    };

    console.log(`Search results visible on page: ${visibleProfileCount}`);
    console.log(`Search API-derived profiles: ${searchFallback.urls.length}`);
    console.log(`First profile selected: ${firstProfile.name} (${firstProfile.url})`);

    currentStage = 'open_profile';
    console.log('Stage: open_profile');
    await page.goto(firstProfile.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await slowPause(4000, 7000);

    currentStage = 'like_post';
    console.log('Stage: like_post');
    const likeResult = await processActivityPage(page, firstProfile.url);
    await slowPause(2500, 4500);

    currentStage = 'send_connection';
    console.log('Stage: send_connection');
    const connectResult = await sendConnectionRequest(page, firstProfile.url, connectionMessage);
    await slowPause(2500, 4500);

    const summaries = [
      makeStageSummary('search', stageEntries.search),
      makeStageSummary('open_profile', stageEntries.open_profile),
      makeStageSummary('like_post', stageEntries.like_post),
      makeStageSummary('send_connection', stageEntries.send_connection)
    ];

    const distinctGraphqlCalls = uniq(
      summaries.flatMap((summary) =>
        summary.calls
          .filter((call) => call.url.includes('/graphql'))
          .map((call) => `${call.method} ${call.url}`)
      )
    );

    const distinctVoyagerCalls = uniq(
      summaries.flatMap((summary) =>
        summary.calls
          .filter((call) => call.url.includes('/voyager/api/') && !call.url.includes('/graphql'))
          .map((call) => `${call.method} ${call.url}`)
      )
    );

    console.log(JSON.stringify({
      searchTerm,
      selectedProfile: firstProfile,
      visibleProfileCount,
      searchApiProfileCount: searchFallback.urls.length,
      actionResults: {
        likeResult,
        connectResult
      },
      connectionMessage,
      stageSummaries: summaries,
      distinctGraphqlCalls,
      distinctVoyagerCalls
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
