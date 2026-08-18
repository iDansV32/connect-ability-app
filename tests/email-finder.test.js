'use strict';

/**
 * tests/email-finder.test.js
 *
 * Targeted tests for Ticket 14 — email finder integration.
 *
 * Covers:
 *  1. Apollo provider normalizes raw response into internal enrichment shape
 *  2. No-provider-configured path returns clean unavailable result
 *  3. Existing prospect email is not overwritten without overwrite flag
 *  4. Successful enrichment updates SQLite-backed prospect metadata
 *  5. Not-found results do not crash and do not create bogus email data
 *  6. Provider errors surface as clean non-fatal results
 *  7. MCP tool surface includes enrich_prospect_email
 *  8. Insufficient input returns unavailable rather than a broken request
 *  9. createEmailFinderResult normalizes all fields
 * 10. Apollo match params builder validates inputs
 * 11. Null provider always returns unavailable
 * 12. Overwrite flag allows replacing existing email
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTempWorkspace } = require('./test-helpers');
const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const ProspectQueueStore = require('../prospect-queue-store');
const EmailFinderService = require('../agents/email-finder-service');
const {
  createEmailFinderResult,
  createApolloProvider,
  createNullProvider,
  _private: { buildApolloMatchParams, normalizeApolloResponse, normalizeConfidence }
} = require('../enrichment/email-finder-provider');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestStore() {
  const ws = createTempWorkspace('email-finder-');
  const dbPath = ws.path('test.db');
  const db = openDatabase(dbPath);
  const store = new ProspectQueueStore({ db });
  return { ws, db, store };
}

function makeStubProvider(findEmailResult) {
  return {
    name: 'stub',
    isConfigured() { return true; },
    async findEmail() {
      return typeof findEmailResult === 'function'
        ? findEmailResult()
        : findEmailResult;
    }
  };
}

function seedProspect(store, overrides = {}) {
  return store.upsertProspect({
    fullName: 'Alice Smith',
    profileUrl: 'https://www.linkedin.com/in/alice-smith',
    company: 'Acme Corp',
    state: 'queued',
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// 1. Apollo provider normalizes raw response into internal enrichment shape
// ---------------------------------------------------------------------------

test('normalizeApolloResponse maps a found person to standard shape', () => {
  const result = normalizeApolloResponse({
    person: {
      id: 'apollo-123',
      email: 'alice@acme.com',
      email_confidence: 92,
      first_name: 'Alice',
      last_name: 'Smith',
      title: 'VP Engineering',
      organization: { name: 'Acme Corp' },
      email_status: 'verified'
    }
  });

  assert.equal(result.email, 'alice@acme.com');
  assert.equal(result.status, 'found');
  assert.equal(result.provider, 'apollo');
  assert.equal(result.confidence, 92);
  assert.ok(result.foundAt);
  assert.equal(result.sourceMetadata.apolloId, 'apollo-123');
  assert.equal(result.sourceMetadata.title, 'VP Engineering');
  assert.equal(result.sourceMetadata.organization, 'Acme Corp');
});

test('normalizeApolloResponse returns not_found when email is absent', () => {
  const result = normalizeApolloResponse({
    person: {
      id: 'apollo-456',
      first_name: 'Bob',
      last_name: 'Jones'
    }
  });

  assert.equal(result.email, null);
  assert.equal(result.status, 'not_found');
  assert.equal(result.provider, 'apollo');
});

// ---------------------------------------------------------------------------
// 2. No-provider-configured returns clean unavailable result
// ---------------------------------------------------------------------------

test('null provider returns unavailable for all requests', async () => {
  const provider = createNullProvider();
  assert.equal(provider.isConfigured(), false);

  const result = await provider.findEmail({ firstName: 'Alice', lastName: 'Smith' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.provider, 'none');
  assert.equal(result.email, null);
});

test('EmailFinderService with null provider returns unavailable', async () => {
  const service = new EmailFinderService({ provider: createNullProvider() });
  assert.equal(service.isConfigured, false);

  const result = await service.enrichInput({ firstName: 'Alice' });
  assert.equal(result.status, 'unavailable');
});

// ---------------------------------------------------------------------------
// 3. Existing prospect email is not overwritten without overwrite flag
// ---------------------------------------------------------------------------

test('enrichProspect skips lookup when prospect already has email', async () => {
  const { db, store } = makeTestStore();
  try {
    const prospect = seedProspect(store, {
      metadata: { email: 'existing@acme.com', emailProvider: 'manual' }
    });

    let providerCalled = false;
    const service = new EmailFinderService({
      provider: makeStubProvider(() => {
        providerCalled = true;
        return createEmailFinderResult({ email: 'new@acme.com', status: 'found', provider: 'stub' });
      }),
      prospectQueueStore: store
    });

    const result = await service.enrichProspect(prospect.id);

    assert.equal(providerCalled, false, 'provider should NOT be called when email already exists');
    assert.equal(result.enrichment.email, 'existing@acme.com');
    assert.equal(result.enrichment.sourceMetadata.skippedLookup, true);
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 4. Successful enrichment updates SQLite-backed prospect metadata
// ---------------------------------------------------------------------------

test('enrichProspect writes email + provenance to prospect metadata on success', async () => {
  const { db, store } = makeTestStore();
  try {
    const prospect = seedProspect(store);

    const service = new EmailFinderService({
      provider: makeStubProvider(createEmailFinderResult({
        email: 'alice@acme.com',
        status: 'found',
        provider: 'apollo',
        confidence: 95,
        foundAt: '2026-03-22T10:00:00.000Z',
        sourceMetadata: { apolloId: 'ap-1' }
      })),
      prospectQueueStore: store
    });

    const result = await service.enrichProspect(prospect.id);

    assert.equal(result.enrichment.status, 'found');
    assert.equal(result.enrichment.email, 'alice@acme.com');

    // Verify the prospect record was updated
    const updated = store.getProspect(prospect.id);
    assert.equal(updated.metadata.email, 'alice@acme.com');
    assert.equal(updated.metadata.emailProvider, 'apollo');
    assert.equal(updated.metadata.emailConfidence, 95);
    assert.equal(updated.metadata.emailStatus, 'found');
    assert.equal(updated.metadata.emailFoundAt, '2026-03-22T10:00:00.000Z');
    assert.ok(updated.metadata.emailSourceMetadata);
    assert.equal(updated.metadata.emailSourceMetadata.apolloId, 'ap-1');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 5. Not-found results do not crash and do not create bogus email data
// ---------------------------------------------------------------------------

test('enrichProspect does not patch metadata on not_found result', async () => {
  const { db, store } = makeTestStore();
  try {
    const prospect = seedProspect(store);

    const service = new EmailFinderService({
      provider: makeStubProvider(createEmailFinderResult({
        status: 'not_found',
        provider: 'apollo'
      })),
      prospectQueueStore: store
    });

    const result = await service.enrichProspect(prospect.id);

    assert.equal(result.enrichment.status, 'not_found');
    assert.equal(result.enrichment.email, null);

    // Verify the prospect was NOT patched with bogus data
    const unchanged = store.getProspect(prospect.id);
    assert.equal(unchanged.metadata.email, undefined);
    assert.equal(unchanged.metadata.emailProvider, undefined);
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 6. Provider errors surface as clean non-fatal results
// ---------------------------------------------------------------------------

test('Apollo provider returns error result on HTTP failure', async () => {
  const provider = createApolloProvider({
    apiKey: 'test-key',
    fetch: async () => ({ ok: false, status: 429 })
  });

  const result = await provider.findEmail({
    firstName: 'Alice',
    lastName: 'Smith',
    domain: 'acme.com'
  });

  assert.equal(result.status, 'error');
  assert.equal(result.provider, 'apollo');
  assert.equal(result.sourceMetadata.httpStatus, 429);
});

test('Apollo provider returns error result on network exception', async () => {
  const provider = createApolloProvider({
    apiKey: 'test-key',
    fetch: async () => { throw new Error('DNS resolution failed'); }
  });

  const result = await provider.findEmail({
    firstName: 'Alice',
    lastName: 'Smith',
    domain: 'acme.com'
  });

  assert.equal(result.status, 'error');
  assert.equal(result.sourceMetadata.reason, 'DNS resolution failed');
});

// ---------------------------------------------------------------------------
// 7. MCP tool surface includes enrich_prospect_email
// ---------------------------------------------------------------------------

test('MCP server tool schema includes enrich_prospect_email', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../connect-mcp-server.js'), 'utf8');
  assert.ok(
    source.includes("'enrich_prospect_email'") || source.includes('"enrich_prospect_email"'),
    'enrich_prospect_email should appear in MCP server source'
  );
  assert.ok(
    source.includes('prospectId') && source.includes('linkedinProfileUrl'),
    'Tool schema should reference prospectId and linkedinProfileUrl'
  );
});

// ---------------------------------------------------------------------------
// 8. Insufficient input returns unavailable
// ---------------------------------------------------------------------------

test('Apollo provider returns unavailable when input is too sparse', async () => {
  const provider = createApolloProvider({
    apiKey: 'test-key',
    fetch: async () => { throw new Error('should not be called'); }
  });

  // Only first name, no domain or linkedin URL
  const result = await provider.findEmail({ firstName: 'Alice' });

  assert.equal(result.status, 'unavailable');
  assert.ok(result.sourceMetadata.reason.includes('Insufficient'));
});

// ---------------------------------------------------------------------------
// 9. createEmailFinderResult normalizes all fields
// ---------------------------------------------------------------------------

test('createEmailFinderResult clamps confidence and normalizes fields', () => {
  const result = createEmailFinderResult({
    email: 'alice@acme.com',
    status: 'found',
    provider: 'test',
    confidence: 150  // above 100
  });

  assert.equal(result.confidence, 100);
  assert.equal(result.email, 'alice@acme.com');
  assert.equal(result.status, 'found');
});

test('createEmailFinderResult defaults invalid status to error', () => {
  const result = createEmailFinderResult({ status: 'bogus' });
  assert.equal(result.status, 'error');
});

test('normalizeConfidence handles edge cases', () => {
  assert.equal(normalizeConfidence(null), null);
  assert.equal(normalizeConfidence('abc'), null);
  assert.equal(normalizeConfidence(-10), 0);
  assert.equal(normalizeConfidence(50.7), 51);
});

// ---------------------------------------------------------------------------
// 10. Apollo match params builder validates inputs
// ---------------------------------------------------------------------------

test('buildApolloMatchParams returns null for insufficient input', () => {
  assert.equal(buildApolloMatchParams({}), null);
  assert.equal(buildApolloMatchParams({ firstName: 'Alice' }), null);
  assert.equal(buildApolloMatchParams({ firstName: 'Alice', lastName: 'Smith' }), null);
});

test('buildApolloMatchParams builds params from name + domain', () => {
  const params = buildApolloMatchParams({
    firstName: 'Alice',
    lastName: 'Smith',
    domain: 'acme.com'
  });

  assert.deepEqual(params, {
    first_name: 'Alice',
    last_name: 'Smith',
    organization_domain: 'acme.com'
  });
});

test('buildApolloMatchParams builds params from linkedin URL', () => {
  const params = buildApolloMatchParams({
    linkedinProfileUrl: 'https://www.linkedin.com/in/alice-smith'
  });

  assert.deepEqual(params, {
    linkedin_url: 'https://www.linkedin.com/in/alice-smith'
  });
});

test('buildApolloMatchParams splits fullName into first/last', () => {
  const params = buildApolloMatchParams({
    fullName: 'Alice Marie Smith',
    domain: 'acme.com'
  });

  assert.deepEqual(params, {
    first_name: 'Alice',
    last_name: 'Marie Smith',
    organization_domain: 'acme.com'
  });
});

// ---------------------------------------------------------------------------
// 11. Null provider always returns unavailable
// ---------------------------------------------------------------------------

test('createNullProvider has correct interface shape', () => {
  const provider = createNullProvider();
  assert.equal(provider.name, 'none');
  assert.equal(typeof provider.isConfigured, 'function');
  assert.equal(typeof provider.findEmail, 'function');
});

// ---------------------------------------------------------------------------
// 12. Overwrite flag allows replacing existing email
// ---------------------------------------------------------------------------

test('enrichProspect with overwrite=true replaces existing email', async () => {
  const { db, store } = makeTestStore();
  try {
    const prospect = seedProspect(store, {
      metadata: { email: 'old@acme.com', emailProvider: 'manual' }
    });

    const service = new EmailFinderService({
      provider: makeStubProvider(createEmailFinderResult({
        email: 'new@acme.com',
        status: 'found',
        provider: 'apollo',
        confidence: 98
      })),
      prospectQueueStore: store
    });

    const result = await service.enrichProspect(prospect.id, { overwrite: true });

    assert.equal(result.enrichment.email, 'new@acme.com');

    const updated = store.getProspect(prospect.id);
    assert.equal(updated.metadata.email, 'new@acme.com');
    assert.equal(updated.metadata.emailProvider, 'apollo');
    assert.equal(updated.metadata.emailConfidence, 98);
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 13. enrichProspect returns error for missing prospect
// ---------------------------------------------------------------------------

test('enrichProspect returns error when prospect ID not found', async () => {
  const { db, store } = makeTestStore();
  try {
    const service = new EmailFinderService({
      provider: makeStubProvider(createEmailFinderResult({ status: 'found', email: 'x@y.com', provider: 'stub' })),
      prospectQueueStore: store
    });

    const result = await service.enrichProspect('nonexistent-id');
    assert.equal(result.prospect, null);
    assert.equal(result.enrichment.status, 'error');
    assert.ok(result.enrichment.sourceMetadata.reason.includes('not found'));
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 14. Apollo provider with successful JSON response end-to-end
// ---------------------------------------------------------------------------

test('Apollo provider returns found result from mock HTTP response', async () => {
  const provider = createApolloProvider({
    apiKey: 'test-key',
    fetch: async (url, opts) => {
      // Verify the request shape
      assert.ok(url.includes('/people/match'));
      assert.equal(opts.method, 'POST');
      assert.equal(opts.headers['X-Api-Key'], 'test-key');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          person: {
            id: 'ap-99',
            email: 'bob@example.com',
            email_confidence: 87,
            first_name: 'Bob',
            last_name: 'Jones',
            title: 'CTO',
            organization: { name: 'Example Inc' }
          }
        })
      };
    }
  });

  const result = await provider.findEmail({
    firstName: 'Bob',
    lastName: 'Jones',
    domain: 'example.com'
  });

  assert.equal(result.status, 'found');
  assert.equal(result.email, 'bob@example.com');
  assert.equal(result.confidence, 87);
  assert.equal(result.sourceMetadata.apolloId, 'ap-99');
});
