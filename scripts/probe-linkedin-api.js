const { chromium } = require('playwright');
const { loginToLinkedIn } = require('../automation/core/login');

function maskEmail(email) {
  if (!email) return '';
  const [name, domain] = String(email).split('@');
  return `${(name || '').slice(0, 3)}...@${domain || ''}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveCsrfToken(cookies) {
  const jsession = cookies.find((cookie) => cookie.name === 'JSESSIONID');
  if (!jsession || !jsession.value) return '';
  return jsession.value.replace(/^"|"$/g, '');
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
      lower.startsWith(':') ||
      lower === 'cookie' ||
      lower === 'csrf-token' ||
      lower === 'x-li-track' ||
      lower === 'x-li-page-instance' ||
      lower === 'x-li-lang' ||
      lower === 'x-li-pem-metadata' ||
      lower === 'x-li-fabric'
    ) {
      continue;
    }
    next[key] = value;
  }

  if (cookieHeader) {
    next.Cookie = cookieHeader;
  }
  if (csrfToken) {
    next['csrf-token'] = csrfToken;
  }
  if (!next['x-restli-protocol-version']) {
    next['x-restli-protocol-version'] = '2.0.0';
  }
  return next;
}

function isVoyagerRequest(url) {
  return /linkedin\.com\/voyager\/api\//i.test(url) || /linkedin\.com\/graphql/i.test(url);
}

async function main() {
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  const query = process.env.LINKEDIN_PROBE_QUERY || 'software engineer';

  if (!email || !password) {
    throw new Error('Missing LINKEDIN_EMAIL or LINKEDIN_PASSWORD');
  }

  console.log(`Starting LinkedIn API probe with ${maskEmail(email)}`);

  const browser = await chromium.launch({
    headless: true,
    slowMo: 50,
    args: ['--disable-blink-features=AutomationControlled']
  });

  let context;
  try {
    context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/Chicago',
      viewport: { width: 1440, height: 900 }
    });

    const page = await context.newPage();
    await loginToLinkedIn(page, email, password);
    console.log(`Logged in. Current URL: ${page.url()}`);

    const captured = [];
    page.on('request', (request) => {
      if (!isVoyagerRequest(request.url())) return;
      captured.push({
        type: 'request',
        ts: Date.now(),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        headers: request.headers(),
        postData: request.postData() || null
      });
    });

    page.on('response', async (response) => {
      if (!isVoyagerRequest(response.url())) return;
      let body = null;
      try {
        const headers = response.headers();
        const contentType = String(headers['content-type'] || '').toLowerCase();
        if (contentType.includes('application/json')) {
          body = await response.text();
        }
      } catch (_) {
        body = null;
      }
      captured.push({
        type: 'response',
        ts: Date.now(),
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
        body: body ? body.slice(0, 4000) : null
      });
    });

    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`;
    console.log(`Navigating to search URL: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(7000);

    const requests = captured.filter((entry) => entry.type === 'request');
    const responses = captured.filter((entry) => entry.type === 'response');
    console.log(`Captured ${requests.length} voyager/graphql requests and ${responses.length} responses`);

    const replayCandidate = requests.find((entry) => entry.method === 'GET') || requests[0];
    if (!replayCandidate) {
      throw new Error('No LinkedIn private API request was captured');
    }

    const cookies = await context.cookies('https://www.linkedin.com');
    const csrfToken = deriveCsrfToken(cookies);
    const cookieHeader = buildCookieHeader(cookies);
    const headers = sanitizeHeaders(replayCandidate.headers, csrfToken, cookieHeader);

    console.log(`Replaying ${replayCandidate.method} ${replayCandidate.url}`);

    const replayResponse = await fetch(replayCandidate.url, {
      method: replayCandidate.method,
      headers,
      body: replayCandidate.method === 'GET' ? undefined : replayCandidate.postData || undefined
    });

    const replayText = await replayResponse.text();
    const sampleResponse = responses.find((entry) => entry.url === replayCandidate.url);

    const result = {
      query,
      replayCandidate: {
        method: replayCandidate.method,
        url: replayCandidate.url
      },
      capturedCounts: {
        requests: requests.length,
        responses: responses.length
      },
      browserResponse: sampleResponse
        ? {
            status: sampleResponse.status,
            contentType: sampleResponse.headers['content-type'] || ''
          }
        : null,
      replayResponse: {
        status: replayResponse.status,
        ok: replayResponse.ok,
        contentType: replayResponse.headers.get('content-type') || '',
        bodySample: replayText.slice(0, 1000)
      }
    };

    console.log(JSON.stringify(result, null, 2));
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
