const keytar = require('keytar');

const APOLLO_CREDENTIAL_SERVICE = 'Connect Ability Apollo';
const APOLLO_API_KEY_ACCOUNT = 'apollo-api-key:default';

function normalizeApiKey(apiKey = null) {
  return String(apiKey || '').trim();
}

function normalizeKeychainErrorMessage(error) {
  const message = String(error?.message || error || 'Unknown keychain error').trim();
  return message || 'Unknown keychain error';
}

async function setApolloApiKey(apiKey = null) {
  const normalizedApiKey = normalizeApiKey(apiKey);
  if (!normalizedApiKey) {
    throw new Error('Apollo API key is required');
  }
  try {
    await keytar.setPassword(
      APOLLO_CREDENTIAL_SERVICE,
      APOLLO_API_KEY_ACCOUNT,
      normalizedApiKey
    );
    return true;
  } catch (error) {
    throw new Error(
      `Apollo API key could not be stored in the system keychain: ${normalizeKeychainErrorMessage(error)}`
    );
  }
}

async function getApolloApiKey() {
  try {
    return await keytar.getPassword(
      APOLLO_CREDENTIAL_SERVICE,
      APOLLO_API_KEY_ACCOUNT
    );
  } catch (error) {
    console.error(
      `Failed to read Apollo API key from the system keychain: ${normalizeKeychainErrorMessage(error)}`
    );
    return null;
  }
}

async function hasApolloApiKey() {
  return Boolean(await getApolloApiKey());
}

async function deleteApolloApiKey() {
  try {
    return await keytar.deletePassword(
      APOLLO_CREDENTIAL_SERVICE,
      APOLLO_API_KEY_ACCOUNT
    );
  } catch (error) {
    console.error(
      `Failed to delete Apollo API key from the system keychain: ${normalizeKeychainErrorMessage(error)}`
    );
    return false;
  }
}

module.exports = {
  APOLLO_CREDENTIAL_SERVICE,
  deleteApolloApiKey,
  getApolloApiKey,
  hasApolloApiKey,
  setApolloApiKey
};
