const test = require('node:test');
const assert = require('node:assert/strict');

const ApolloClient = require('../apollo-client');

test('ApolloClient authenticates requests with X-Api-Key only', async () => {
  let capturedHeaders = null;

  const client = new ApolloClient({
    apiKey: 'apollo-test-key',
    fetchImpl: async (_url, options = {}) => {
      capturedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ healthy: true })
      };
    }
  });

  const response = await client.apiRequest({
    method: 'GET',
    path: '/auth/health'
  });

  assert.equal(response.healthy, true);
  assert.equal(capturedHeaders['X-Api-Key'], 'apollo-test-key');
  assert.equal(Object.prototype.hasOwnProperty.call(capturedHeaders, 'Authorization'), false);
});

test('ApolloClient getContact fetches a contact by id', async () => {
  let capturedUrl = null;

  const client = new ApolloClient({
    apiKey: 'apollo-test-key',
    fetchImpl: async (url) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({
          contact: {
            id: 'contact-1',
            name: 'Jane Doe',
            email: 'jane@example.com'
          }
        })
      };
    }
  });

  const contact = await client.getContact('contact-1');

  assert.match(capturedUrl, /\/contacts\/contact-1$/);
  assert.equal(contact.id, 'contact-1');
  assert.equal(contact.email, 'jane@example.com');
});

test('ApolloClient matchPerson normalizes contactId from people match responses', async () => {
  const client = new ApolloClient({
    apiKey: 'apollo-test-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({
        person: {
          id: 'person-1',
          contact_id: 'contact-1',
          linkedin_url: 'https://www.linkedin.com/in/jane-doe/'
        }
      })
    })
  });

  const person = await client.matchPerson({
    prospect: {
      profileUrl: 'https://www.linkedin.com/in/jane-doe/'
    }
  });

  assert.equal(person.id, 'person-1');
  assert.equal(person.contactId, 'contact-1');
  assert.equal(person.linkedinUrl, 'https://www.linkedin.com/in/jane-doe/');
});
