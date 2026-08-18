'use strict';

const HIGH_CONFIDENCE = 'high';
const MEDIUM_CONFIDENCE = 'medium';
const NO_CONFIDENCE = 'none';

const SOURCE_STORED_CONTACT_ID = 'stored_contact_id';
const SOURCE_PEOPLE_MATCH_LINKEDIN = 'people_match_linkedin';
const SOURCE_PEOPLE_MATCH_EMAIL = 'people_match_email';
const SOURCE_NO_MATCH = 'no_match';

const OUTCOME_RESOLVED = 'resolved';
const OUTCOME_NOT_FOUND = 'not_found';
const OUTCOME_AMBIGUOUS = 'ambiguous';
const OUTCOME_UNREACHABLE = 'unreachable';
const OUTCOME_INVALID_INPUT = 'invalid_input';

async function resolveApolloIdentity(prospect = {}, apolloClient) {
  if (!apolloClient || typeof apolloClient !== 'object') {
    throw new Error('Apollo client is required');
  }

  const storedContactId = cleanString(prospect?.metadata?.integrations?.apollo?.apolloContactId, 160) || null;
  const linkedinUrl = cleanString(prospect?.profileUrl || prospect?.linkedinUrl, 400) || null;
  const email = cleanString(prospect?.email, 240) || null;

  const attemptedOutcomes = [];

  if (storedContactId) {
    if (typeof apolloClient.getContact !== 'function') {
      throw new Error('Apollo client must implement getContact(contactId) for deterministic identity resolution');
    }
    try {
      const contact = await apolloClient.getContact(storedContactId);
      if (contact?.id) {
        return buildResolvedIdentity({
          contactId: contact.id,
          source: SOURCE_STORED_CONTACT_ID,
          confidence: HIGH_CONFIDENCE,
          contact,
          personId: cleanString(contact.personId || contact.person_id, 160) || null
        });
      }
      attemptedOutcomes.push(OUTCOME_NOT_FOUND);
    } catch (error) {
      if (!isApolloNotFoundError(error)) {
        return buildUnresolvedIdentity(OUTCOME_UNREACHABLE);
      }
      attemptedOutcomes.push(OUTCOME_NOT_FOUND);
    }
  }

  if (linkedinUrl) {
    const linkedinResult = await resolveMatchIdentity({
      apolloClient,
      matchInput: { prospect: { profileUrl: linkedinUrl } },
      source: SOURCE_PEOPLE_MATCH_LINKEDIN,
      confidence: HIGH_CONFIDENCE
    });
    if (linkedinResult.outcome === OUTCOME_RESOLVED) {
      return linkedinResult;
    }
    if (linkedinResult.outcome === OUTCOME_UNREACHABLE) {
      return linkedinResult;
    }
    attemptedOutcomes.push(linkedinResult.outcome);
  }

  if (email) {
    const emailResult = await resolveMatchIdentity({
      apolloClient,
      matchInput: { prospect: { email } },
      source: SOURCE_PEOPLE_MATCH_EMAIL,
      confidence: MEDIUM_CONFIDENCE
    });
    if (emailResult.outcome === OUTCOME_RESOLVED) {
      return emailResult;
    }
    if (emailResult.outcome === OUTCOME_UNREACHABLE) {
      return emailResult;
    }
    attemptedOutcomes.push(emailResult.outcome);
  }

  if (!storedContactId && !linkedinUrl && !email) {
    return buildUnresolvedIdentity(OUTCOME_INVALID_INPUT);
  }

  if (attemptedOutcomes.includes(OUTCOME_AMBIGUOUS)) {
    return buildUnresolvedIdentity(OUTCOME_AMBIGUOUS);
  }
  if (attemptedOutcomes.includes(OUTCOME_NOT_FOUND)) {
    return buildUnresolvedIdentity(OUTCOME_NOT_FOUND);
  }
  return buildUnresolvedIdentity(OUTCOME_INVALID_INPUT);
}

async function resolveMatchIdentity({ apolloClient, matchInput, source, confidence }) {
  if (typeof apolloClient.matchPerson !== 'function') {
    throw new Error('Apollo client must implement matchPerson(input) for deterministic identity resolution');
  }

  try {
    const matchedPerson = await apolloClient.matchPerson(matchInput);
    const normalized = normalizeMatchedIdentity(matchedPerson);
    if (normalized.outcome === OUTCOME_AMBIGUOUS) {
      return buildUnresolvedIdentity(OUTCOME_AMBIGUOUS);
    }
    if (!normalized.contactId) {
      return buildUnresolvedIdentity(OUTCOME_NOT_FOUND);
    }
    return buildResolvedIdentity({
      contactId: normalized.contactId,
      source,
      confidence,
      personId: normalized.personId,
      matchedPerson: normalized.matchedPerson
    });
  } catch (error) {
    if (isApolloNotFoundError(error)) {
      return buildUnresolvedIdentity(OUTCOME_NOT_FOUND);
    }
    return buildUnresolvedIdentity(OUTCOME_UNREACHABLE);
  }
}

function normalizeMatchedIdentity(value) {
  if (!value) {
    return { outcome: OUTCOME_NOT_FOUND, contactId: null, personId: null, matchedPerson: null };
  }
  if (value.ambiguous === true) {
    return { outcome: OUTCOME_AMBIGUOUS, contactId: null, personId: null, matchedPerson: null };
  }
  const candidates = Array.isArray(value.candidates)
    ? value.candidates
    : Array.isArray(value.matches)
      ? value.matches
      : null;
  if (candidates && candidates.length > 1) {
    return { outcome: OUTCOME_AMBIGUOUS, contactId: null, personId: null, matchedPerson: null };
  }

  const contactId = cleanString(
    value.contactId
    || value.contact_id
    || value.contact?.id
    || value.raw?.contact_id
    || value.raw?.contact?.id,
    160
  ) || null;
  const personId = cleanString(value.id || value.personId || value.person_id, 160) || null;
  return {
    outcome: contactId ? OUTCOME_RESOLVED : OUTCOME_NOT_FOUND,
    contactId,
    personId,
    matchedPerson: value
  };
}

function buildResolvedIdentity({ contactId, source, confidence, contact = null, matchedPerson = null, personId = null }) {
  return {
    contactId: cleanString(contactId, 160) || null,
    source,
    confidence,
    outcome: OUTCOME_RESOLVED,
    holdCause: null,
    personId: cleanString(personId, 160) || null,
    contact,
    matchedPerson
  };
}

function buildUnresolvedIdentity(outcome) {
  return {
    contactId: null,
    source: SOURCE_NO_MATCH,
    confidence: NO_CONFIDENCE,
    outcome,
    holdCause: outcome === OUTCOME_UNREACHABLE ? 'unreachable' : 'freshness_unknown',
    personId: null,
    contact: null,
    matchedPerson: null
  };
}

function isApolloNotFoundError(error) {
  const message = cleanString(error?.message || error, 600).toLowerCase();
  return message.includes('apollo api error (404)');
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  resolveApolloIdentity,
  APOLLO_IDENTITY_SOURCES: {
    STORED_CONTACT_ID: SOURCE_STORED_CONTACT_ID,
    PEOPLE_MATCH_LINKEDIN: SOURCE_PEOPLE_MATCH_LINKEDIN,
    PEOPLE_MATCH_EMAIL: SOURCE_PEOPLE_MATCH_EMAIL,
    NO_MATCH: SOURCE_NO_MATCH
  },
  APOLLO_IDENTITY_CONFIDENCE: {
    HIGH: HIGH_CONFIDENCE,
    MEDIUM: MEDIUM_CONFIDENCE,
    NONE: NO_CONFIDENCE
  },
  APOLLO_IDENTITY_OUTCOMES: {
    RESOLVED: OUTCOME_RESOLVED,
    NOT_FOUND: OUTCOME_NOT_FOUND,
    AMBIGUOUS: OUTCOME_AMBIGUOUS,
    UNREACHABLE: OUTCOME_UNREACHABLE,
    INVALID_INPUT: OUTCOME_INVALID_INPUT
  }
};
