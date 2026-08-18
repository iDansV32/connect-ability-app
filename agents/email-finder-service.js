'use strict';

/**
 * agents/email-finder-service.js
 *
 * Service layer for email enrichment.
 *
 * Accepts prospect/person inputs, calls the configured provider, normalizes
 * the result, and writes enriched email data back to the prospect store.
 *
 * Public API:
 *   enrichProspect(prospectId, options)   — enrich a single prospect by ID
 *   enrichInput(input)                    — enrich from raw person/company fields
 */

const {
  createNullProvider,
  createEmailFinderResult
} = require('../enrichment/email-finder-provider');

class EmailFinderService {
  /**
   * @param {object} options
   * @param {object} options.provider - email finder provider (from email-finder-provider.js)
   * @param {object} [options.prospectQueueStore] - ProspectQueueStore instance
   */
  constructor(options = {}) {
    this._provider = options.provider || createNullProvider();
    this._prospectStore = options.prospectQueueStore || null;
  }

  get providerName() {
    return this._provider.name || 'unknown';
  }

  get isConfigured() {
    return typeof this._provider.isConfigured === 'function'
      ? this._provider.isConfigured()
      : false;
  }

  /**
   * Enrich a prospect by ID.
   *
   * Looks up the prospect in the store, calls the provider, and patches
   * the prospect record with the result.
   *
   * @param {string} prospectId
   * @param {object} [options]
   * @param {boolean} [options.overwrite=false] - if true, overwrite an existing email
   * @param {string}  [options.domain] - company domain hint for the lookup
   * @returns {Promise<{ prospect: object|null, enrichment: object }>}
   */
  async enrichProspect(prospectId, options = {}) {
    if (!this._prospectStore) {
      return {
        prospect: null,
        enrichment: createEmailFinderResult({
          status: 'error',
          provider: this.providerName,
          sourceMetadata: { reason: 'No prospect store configured' }
        })
      };
    }

    const prospect = this._prospectStore.getProspect(prospectId);
    if (!prospect) {
      return {
        prospect: null,
        enrichment: createEmailFinderResult({
          status: 'error',
          provider: this.providerName,
          sourceMetadata: { reason: `Prospect not found: ${prospectId}` }
        })
      };
    }

    // If the prospect already has an email and overwrite is not requested, skip
    const existingEmail = prospect.metadata?.email || null;
    if (existingEmail && options.overwrite !== true) {
      return {
        prospect,
        enrichment: createEmailFinderResult({
          email: existingEmail,
          status: 'found',
          provider: prospect.metadata?.emailProvider || 'existing',
          confidence: prospect.metadata?.emailConfidence || null,
          foundAt: prospect.metadata?.emailFoundAt || null,
          sourceMetadata: { reason: 'Prospect already has an email', skippedLookup: true }
        })
      };
    }

    // Build lookup input from prospect fields
    const nameParts = splitName(prospect.fullName);
    const enrichment = await this.enrichInput({
      firstName: nameParts.firstName,
      lastName: nameParts.lastName,
      fullName: prospect.fullName,
      companyName: prospect.company,
      domain: options.domain || guessDomainFromCompany(prospect.company),
      linkedinProfileUrl: prospect.profileUrl
    });

    // Patch prospect metadata with the result
    if (enrichment.status === 'found' && enrichment.email) {
      this._prospectStore.updateProspectMetadata(prospectId, {
        email: enrichment.email,
        emailProvider: enrichment.provider,
        emailConfidence: enrichment.confidence,
        emailStatus: enrichment.status,
        emailFoundAt: enrichment.foundAt,
        emailSourceMetadata: enrichment.sourceMetadata
      });
      // Re-read the updated prospect
      const updated = this._prospectStore.getProspect(prospectId);
      return { prospect: updated, enrichment };
    }

    return { prospect, enrichment };
  }

  /**
   * Enrich from raw person/company fields without a prospect store lookup.
   *
   * @param {object} input
   * @param {string} [input.firstName]
   * @param {string} [input.lastName]
   * @param {string} [input.fullName]
   * @param {string} [input.companyName]
   * @param {string} [input.domain]
   * @param {string} [input.linkedinProfileUrl]
   * @returns {Promise<object>} - EmailFinderResult
   */
  async enrichInput(input = {}) {
    return this._provider.findEmail(input);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitName(fullName) {
  const clean = String(fullName || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { firstName: null, lastName: null };
  const parts = clean.split(' ');
  return {
    firstName: parts[0] || null,
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null
  };
}

function guessDomainFromCompany(companyName) {
  // Simple heuristic: not reliable enough for production, but useful as a
  // fallback hint.  Returns null when the name is too ambiguous.
  const clean = String(companyName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!clean || clean.length < 2) return null;
  // If the company name looks like it could be a domain already, return it
  if (/^[\w-]+\.[\w.]+$/.test(clean)) return clean;
  return null;
}

module.exports = EmailFinderService;
