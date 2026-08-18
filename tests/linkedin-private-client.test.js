'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { LinkedInPrivateApiClient, MESSAGING_QUERY_IDS } = require('../automation/linkedin-private/client');
const { buildFingerprintProfileFromSeed } = require('../automation/safety/account-fingerprint-profile');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a minimal Playwright-like context whose cookies() method returns the
 * provided cookie array without any real browser or network call.
 */
function buildMockContext(cookies = []) {
  return {
    async cookies() { return cookies; }
  };
}

/**
 * Builds a minimal page stub. evaluate() returns the provided pageInstanceId
 * so tests can control what refreshSessionHeaders reads from the DOM.
 */
function buildMockPage(pageInstanceId = '') {
  return {
    async evaluate() { return pageInstanceId; }
  };
}

/**
 * Constructs a client with zero-delay pauses (naturalPause becomes a no-op)
 * and the provided context/page stubs.
 */
function buildClient(options = {}) {
  return new LinkedInPrivateApiClient({
    minDelayMs: 0,
    maxDelayMs: 0,
    timezoneId: 'America/New_York',
    ...options
  });
}

/**
 * Installs a stub for globalThis.fetch for the duration of fn(), then restores
 * the previous value even if fn() throws.  setup-no-network.js sets fetch to a
 * blocker; overriding it here is intentional for transport-layer unit tests.
 */
async function withFetchStub(stubFetch, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = stubFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

/**
 * Returns a minimal fetch-compatible response object.
 */
function buildFetchResponse({ ok = true, status = 200, body = '{}', headers = {} } = {}) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        if (!name) return null;
        const key = String(name).toLowerCase();
        for (const [k, v] of Object.entries(headers)) {
          if (String(k).toLowerCase() === key) return v;
        }
        return null;
      }
    },
    async text() { return body; }
  };
}

// ─── MESSAGING_QUERY_IDS ─────────────────────────────────────────────────────

test('MESSAGING_QUERY_IDS exports expected query IDs for messaging operations', () => {
  const requiredKeys = [
    'inboxBootstrap',
    'inboxPaged',
    'mailboxCounts',
    'conversationMessages',
    'conversationMessagesDelta',
    'seenReceipts',
    'composeViewContext'
  ];

  for (const key of requiredKeys) {
    assert.ok(
      typeof MESSAGING_QUERY_IDS[key] === 'string' && MESSAGING_QUERY_IDS[key].length > 0,
      `expected MESSAGING_QUERY_IDS.${key} to be a non-empty string`
    );
  }
});

// ─── CSRF derivation ──────────────────────────────────────────────────────────

test('refreshSessionHeaders strips surrounding quotes from JSESSIONID to form the csrf-token', async () => {
  const cookies = [
    { name: 'JSESSIONID', value: '"ajax:9876543210987654"' },
    { name: 'li_at', value: 'session-token' }
  ];

  const client = buildClient({
    context: buildMockContext(cookies),
    page: buildMockPage('page-instance-id')
  });

  const headers = await client.refreshSessionHeaders();

  assert.equal(headers['csrf-token'], 'ajax:9876543210987654');
});

test('refreshSessionHeaders returns empty csrf-token when JSESSIONID cookie is absent', async () => {
  const cookies = [{ name: 'li_at', value: 'session-token' }];

  const client = buildClient({
    context: buildMockContext(cookies),
    page: buildMockPage()
  });

  const headers = await client.refreshSessionHeaders();

  assert.equal(headers['csrf-token'], '');
});

// ─── Header assembly ──────────────────────────────────────────────────────────

test('refreshSessionHeaders assembles all required headers from session cookies and page state', async () => {
  const cookies = [
    { name: 'JSESSIONID', value: '"token-abc"' },
    { name: 'li_at', value: 'auth-value' },
    { name: 'bcookie', value: 'v2_abc123' }
  ];

  const client = buildClient({
    context: buildMockContext(cookies),
    page: buildMockPage('instance-xyz')
  });

  const headers = await client.refreshSessionHeaders();

  // Accept header from DEFAULT_HEADERS
  assert.equal(headers['accept'], 'application/vnd.linkedin.normalized+json+2.1');
  // Cookie header joins all cookies
  assert.ok(headers['cookie'].includes('li_at=auth-value'));
  assert.ok(headers['cookie'].includes('bcookie=v2_abc123'));
  // CSRF token derived from JSESSIONID
  assert.equal(headers['csrf-token'], 'token-abc');
  // Page instance forwarded from evaluate()
  assert.equal(headers['x-li-page-instance'], 'instance-xyz');
  // Tracking header is valid JSON
  const tracking = JSON.parse(headers['x-li-track']);
  assert.equal(tracking.mpName, 'voyager-web');
  assert.equal(tracking.osName, 'web');
});

test('refreshSessionHeaders includes client hint headers derived from the fingerprint profile', async () => {
  const client = buildClient({
    context: buildMockContext([{ name: 'JSESSIONID', value: '"tok"' }]),
    page: buildMockPage('instance-xyz'),
    fingerprintProfile: buildFingerprintProfileFromSeed('fingerprint-seed-abc')
  });

  const headers = await client.refreshSessionHeaders();

  assert.match(headers['sec-ch-ua'], /Google Chrome/);
  assert.equal(headers['sec-ch-ua-mobile'], '?0');
  assert.match(headers['sec-ch-ua-platform'], /^".+"$/);
});

test('refreshSessionHeaders sets x-li-page-instance to undefined when page evaluate returns empty string', async () => {
  const client = buildClient({
    context: buildMockContext([{ name: 'JSESSIONID', value: '"tok"' }]),
    page: buildMockPage('')   // empty string → pageInstance || undefined
  });

  const headers = await client.refreshSessionHeaders();

  assert.equal(headers['x-li-page-instance'], undefined);
});

// ─── Header caching ───────────────────────────────────────────────────────────

test('getHeaders returns cached headers on second call without re-reading cookies', async () => {
  let cookieReadCount = 0;
  const context = {
    async cookies() {
      cookieReadCount += 1;
      return [{ name: 'JSESSIONID', value: '"cached"' }];
    }
  };

  const client = buildClient({ context, page: buildMockPage() });

  await client.getHeaders();   // populates cache
  await client.getHeaders();   // should reuse cache

  assert.equal(cookieReadCount, 1);
});

test('getHeaders merges extra headers over the cached base without mutating it', async () => {
  const client = buildClient({
    context: buildMockContext([{ name: 'JSESSIONID', value: '"tok"' }]),
    page: buildMockPage()
  });

  const base = await client.getHeaders();
  const withExtra = await client.getHeaders({ 'x-custom-header': 'hello' });

  assert.equal(withExtra['x-custom-header'], 'hello');
  assert.equal(base['x-custom-header'], undefined);  // base not mutated
});

// ─── HTTP error propagation ───────────────────────────────────────────────────

test('request() throws an error containing the HTTP status when response.ok is false', async () => {
  const client = buildClient({
    context: buildMockContext([{ name: 'JSESSIONID', value: '"tok"' }]),
    page: buildMockPage()
  });

  await withFetchStub(
    async () => buildFetchResponse({ ok: false, status: 429, body: 'rate limited' }),
    async () => {
      await assert.rejects(
        client.request('GET', 'https://www.linkedin.com/voyager/api/test', {
          minDelayMs: 0,
          maxDelayMs: 0
        }),
        (err) => {
          assert.ok(err.message.includes('429'), `expected 429 in error, got: ${err.message}`);
          return true;
        }
      );
    }
  );
});

test('request() error carries httpStatus, retryAfterMs, retryAfterHeader, responseBodyPreview fields', async () => {
  // Structured fields make Retry-After-aware cooldown decisions possible
  // upstream without re-parsing the message string. See
  // automation/safety/retry-after.js for the consumer contract.
  const client = buildClient({
    context: buildMockContext([{ name: 'JSESSIONID', value: '"tok"' }]),
    page: buildMockPage()
  });

  await withFetchStub(
    async () => buildFetchResponse({
      ok: false,
      status: 429,
      body: 'rate limited',
      headers: { 'Retry-After': '120' }
    }),
    async () => {
      await assert.rejects(
        client.request('GET', 'https://www.linkedin.com/voyager/api/test', {
          minDelayMs: 0,
          maxDelayMs: 0
        }),
        (err) => {
          assert.equal(err.httpStatus, 429, 'httpStatus on the error');
          assert.equal(err.retryAfterHeader, '120', 'raw header preserved');
          assert.equal(err.retryAfterMs, 120 * 1000, 'header parsed to ms');
          assert.equal(err.responseBodyPreview, 'rate limited', 'short body excerpt');
          // Backward-compat: message still contains the status for legacy regex.
          assert.ok(err.message.includes('429'));
          return true;
        }
      );
    }
  );
});

test('request() error omits retryAfter* fields when no Retry-After header is present', async () => {
  // Non-429 errors (or 429s without the header) should still carry
  // httpStatus + body preview but no retry-after fields. Resolver upstream
  // handles the absence gracefully.
  const client = buildClient({
    context: buildMockContext([{ name: 'JSESSIONID', value: '"tok"' }]),
    page: buildMockPage()
  });

  await withFetchStub(
    async () => buildFetchResponse({ ok: false, status: 500, body: 'internal error' }),
    async () => {
      await assert.rejects(
        client.request('GET', 'https://www.linkedin.com/voyager/api/test', {
          minDelayMs: 0,
          maxDelayMs: 0
        }),
        (err) => {
          assert.equal(err.httpStatus, 500);
          assert.equal(err.retryAfterMs, undefined);
          assert.equal(err.retryAfterHeader, undefined);
          assert.equal(err.responseBodyPreview, 'internal error');
          return true;
        }
      );
    }
  );
});

test('request() returns parsed JSON body on a successful response', async () => {
  const client = buildClient({
    context: buildMockContext([{ name: 'JSESSIONID', value: '"tok"' }]),
    page: buildMockPage()
  });

  const payload = { data: { value: 42 } };

  const result = await withFetchStub(
    async () => buildFetchResponse({ ok: true, status: 200, body: JSON.stringify(payload) }),
    () => client.request('GET', 'https://www.linkedin.com/voyager/api/test', {
      minDelayMs: 0,
      maxDelayMs: 0
    })
  );

  assert.deepEqual(result.json, payload);
  assert.equal(result.text, JSON.stringify(payload));
});

// ─── Error guards ─────────────────────────────────────────────────────────────

test('refreshSessionHeaders throws when neither context nor page is provided', async () => {
  const client = new LinkedInPrivateApiClient({ minDelayMs: 0, maxDelayMs: 0 });
  await assert.rejects(
    client.refreshSessionHeaders(),
    /requires a live Playwright page\/context/
  );
});

test('refreshSessionHeaders throws when timezoneId is not set', async () => {
  const client = new LinkedInPrivateApiClient({
    minDelayMs: 0,
    maxDelayMs: 0,
    context: buildMockContext([{ name: 'JSESSIONID', value: '"tok"' }]),
    page: buildMockPage('instance-xyz')
  });

  await assert.rejects(
    client.refreshSessionHeaders(),
    /requires timezoneId to be set/
  );
});
