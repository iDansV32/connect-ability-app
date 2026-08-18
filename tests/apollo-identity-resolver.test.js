const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveApolloIdentity } = require('../apollo-identity-resolver');

test('resolveApolloIdentity resolves via stored apolloContactId with high confidence', async () => {
  const result = await resolveApolloIdentity({
    metadata: {
      integrations: {
        apollo: {
          apolloContactId: 'contact-stored-1'
        }
      }
    }
  }, {
    getContact: async (contactId) => ({ id: contactId, personId: 'person-1' }),
    matchPerson: async () => {
      throw new Error('matchPerson should not be called for stored_contact_id');
    }
  });

  assert.equal(result.contactId, 'contact-stored-1');
  assert.equal(result.source, 'stored_contact_id');
  assert.equal(result.confidence, 'high');
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.holdCause, null);
});

test('resolveApolloIdentity resolves via LinkedIn people match with high confidence', async () => {
  const result = await resolveApolloIdentity({
    profileUrl: 'https://www.linkedin.com/in/jane-doe/'
  }, {
    getContact: async () => null,
    matchPerson: async ({ prospect }) => {
      assert.equal(prospect.profileUrl, 'https://www.linkedin.com/in/jane-doe/');
      return {
        id: 'person-2',
        contactId: 'contact-linkedin-2'
      };
    }
  });

  assert.equal(result.contactId, 'contact-linkedin-2');
  assert.equal(result.source, 'people_match_linkedin');
  assert.equal(result.confidence, 'high');
  assert.equal(result.outcome, 'resolved');
});

test('resolveApolloIdentity resolves via email people match with medium confidence', async () => {
  const calls = [];
  const result = await resolveApolloIdentity({
    email: 'jane@example.com'
  }, {
    getContact: async () => null,
    matchPerson: async ({ prospect }) => {
      calls.push(prospect);
      return {
        id: 'person-3',
        raw: {
          contact_id: 'contact-email-3'
        }
      };
    }
  });

  assert.deepEqual(calls, [{ email: 'jane@example.com' }]);
  assert.equal(result.contactId, 'contact-email-3');
  assert.equal(result.source, 'people_match_email');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.outcome, 'resolved');
});

test('resolveApolloIdentity returns not_found when deterministic inputs produce no contact identity', async () => {
  const result = await resolveApolloIdentity({
    profileUrl: 'https://www.linkedin.com/in/jane-doe/'
  }, {
    getContact: async () => null,
    matchPerson: async () => null
  });

  assert.equal(result.contactId, null);
  assert.equal(result.source, 'no_match');
  assert.equal(result.confidence, 'none');
  assert.equal(result.outcome, 'not_found');
  assert.equal(result.holdCause, 'freshness_unknown');
});

test('resolveApolloIdentity returns ambiguous when Apollo returns multiple candidates', async () => {
  const result = await resolveApolloIdentity({
    profileUrl: 'https://www.linkedin.com/in/jane-doe/'
  }, {
    getContact: async () => null,
    matchPerson: async () => ({
      candidates: [
        { contactId: 'contact-1' },
        { contactId: 'contact-2' }
      ]
    })
  });

  assert.equal(result.contactId, null);
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.holdCause, 'freshness_unknown');
});

test('resolveApolloIdentity returns unreachable when Apollo client errors', async () => {
  const result = await resolveApolloIdentity({
    email: 'jane@example.com'
  }, {
    getContact: async () => null,
    matchPerson: async () => {
      throw new Error('Apollo API error (503): upstream unavailable');
    }
  });

  assert.equal(result.contactId, null);
  assert.equal(result.outcome, 'unreachable');
  assert.equal(result.holdCause, 'unreachable');
});

test('resolveApolloIdentity returns invalid_input when no deterministic identifiers exist', async () => {
  const result = await resolveApolloIdentity({
    fullName: 'Jane Doe'
  }, {
    getContact: async () => null,
    matchPerson: async () => null
  });

  assert.equal(result.contactId, null);
  assert.equal(result.outcome, 'invalid_input');
  assert.equal(result.holdCause, 'freshness_unknown');
});
