'use strict';

/**
 * enrichment/email-finder-provider.js
 *
 * Provider interface for email finding + concrete Apollo adapter.
 *
 * The provider interface is a plain object with:
 *   name: string          — provider identifier (e.g. 'apollo')
 *   findEmail(input)      — async function returning a normalized EmailFinderResult
 *
 * EmailFinderResult shape:
 *   { email, status, provider, confidence, sourceMetadata, foundAt }
 *
 * Statuses: 'found', 'not_found', 'unavailable', 'error'
 */

const VALID_STATUSES = new Set(['found', 'not_found', 'unavailable', 'error']);

// ---------------------------------------------------------------------------
// Normalized result builder
// ---------------------------------------------------------------------------

function createEmailFinderResult(input = {}) {
  const status = VALID_STATUSES.has(input.status) ? input.status : 'error';
  return {
    email: cleanString(input.email, 320) || null,
    status,
    provider: cleanString(input.provider, 80) || 'unknown',
    confidence: normalizeConfidence(input.confidence),
    sourceMetadata: input.sourceMetadata && typeof input.sourceMetadata === 'object'
      ? { ...input.sourceMetadata }
      : {},
    foundAt: cleanString(input.foundAt, 80) || (status === 'found' ? new Date().toISOString() : null)
  };
}

function normalizeConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

// ---------------------------------------------------------------------------
// Apollo People API adapter
//
// Uses the Apollo /api/v1/people/match endpoint to find an email by name,
// company domain, or LinkedIn URL.
//
// Required env/config: APOLLO_API_KEY or options.apiKey
// ---------------------------------------------------------------------------

function createApolloProvider(options = {}) {
  const apiKey = options.apiKey || process.env.APOLLO_API_KEY || null;
  const baseUrl = options.baseUrl || 'https://api.apollo.io/api/v1';

  return {
    name: 'apollo',

    isConfigured() {
      return Boolean(apiKey);
    },

    async findEmail(input = {}) {
      if (!apiKey) {
        return createEmailFinderResult({
          status: 'unavailable',
          provider: 'apollo',
          sourceMetadata: { reason: 'API key not configured' }
        });
      }

      const params = buildApolloMatchParams(input);
      if (!params) {
        return createEmailFinderResult({
          status: 'unavailable',
          provider: 'apollo',
          sourceMetadata: { reason: 'Insufficient input for lookup — need name+domain or linkedinUrl' }
        });
      }

      try {
        const fetchFn = options.fetch || globalFetch();
        const response = await fetchFn(`${baseUrl}/people/match`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': apiKey
          },
          body: JSON.stringify(params)
        });

        if (!response.ok) {
          return createEmailFinderResult({
            status: 'error',
            provider: 'apollo',
            sourceMetadata: {
              httpStatus: response.status,
              reason: `Apollo API returned ${response.status}`
            }
          });
        }

        const body = await response.json();
        return normalizeApolloResponse(body);
      } catch (err) {
        return createEmailFinderResult({
          status: 'error',
          provider: 'apollo',
          sourceMetadata: { reason: err.message || 'Network error' }
        });
      }
    }
  };
}

function buildApolloMatchParams(input = {}) {
  const firstName = cleanString(input.firstName, 120);
  const lastName = cleanString(input.lastName, 120);
  const domain = cleanString(input.domain, 240);
  const linkedinUrl = cleanString(input.linkedinProfileUrl || input.linkedinUrl || input.profileUrl, 400);

  // Apollo /people/match needs at least name+domain or linkedin_url
  if (linkedinUrl) {
    const params = { linkedin_url: linkedinUrl };
    if (firstName) params.first_name = firstName;
    if (lastName) params.last_name = lastName;
    if (domain) params.organization_domain = domain;
    return params;
  }

  if (firstName && lastName && domain) {
    return {
      first_name: firstName,
      last_name: lastName,
      organization_domain: domain
    };
  }

  // If we have a full name but no split first/last, try splitting
  const fullName = cleanString(input.fullName, 240);
  if (fullName && domain) {
    const parts = fullName.split(/\s+/);
    if (parts.length >= 2) {
      return {
        first_name: parts[0],
        last_name: parts.slice(1).join(' '),
        organization_domain: domain
      };
    }
  }

  return null;
}

function normalizeApolloResponse(body = {}) {
  const person = body.person || body;
  const email = cleanString(person.email, 320);

  if (!email) {
    return createEmailFinderResult({
      status: 'not_found',
      provider: 'apollo',
      sourceMetadata: {
        apolloId: person.id || null,
        name: cleanString(person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(), 240) || null
      }
    });
  }

  return createEmailFinderResult({
    email,
    status: 'found',
    provider: 'apollo',
    confidence: person.email_confidence || person.email_score || null,
    sourceMetadata: {
      apolloId: person.id || null,
      name: cleanString(person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(), 240) || null,
      title: cleanString(person.title, 200) || null,
      organization: cleanString(person.organization?.name || person.organization_name, 200) || null,
      emailStatus: person.email_status || null
    },
    foundAt: new Date().toISOString()
  });
}

// ---------------------------------------------------------------------------
// Null provider — returns unavailable for all requests
// ---------------------------------------------------------------------------

function createNullProvider() {
  return {
    name: 'none',
    isConfigured() { return false; },
    async findEmail() {
      return createEmailFinderResult({
        status: 'unavailable',
        provider: 'none',
        sourceMetadata: { reason: 'No email finder provider configured' }
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function globalFetch() {
  if (typeof fetch === 'function') return fetch;
  throw new Error('fetch is not available — Node 18+ with --experimental-fetch or Node 22+ required');
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  createEmailFinderResult,
  createApolloProvider,
  createNullProvider,
  // Exported for testing
  _private: {
    buildApolloMatchParams,
    normalizeApolloResponse,
    normalizeConfidence
  }
};
