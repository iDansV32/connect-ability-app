const keytar = require('keytar');
const { SecretReadCache } = require('./automation/runtime/secret-read-cache');

const LINKEDIN_CREDENTIAL_SERVICE = 'Connect Ability LinkedIn';
const LINKEDIN_CREDENTIAL_PREFIX = 'linkedin-account:';
const passwordReadCache = new SecretReadCache();

function normalizeAccountId(accountId = null) {
  return String(accountId || '').trim();
}

function buildCredentialKey(accountId = null) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) {
    throw new Error('LinkedIn credential account id is required');
  }
  return `${LINKEDIN_CREDENTIAL_PREFIX}${normalizedAccountId}`;
}

function normalizeKeychainErrorMessage(error) {
  const message = String(error?.message || error || 'Unknown keychain error').trim();
  if (!message) {
    return 'Unknown keychain error';
  }
  return message;
}

async function setLinkedInAccountPassword(accountId = null, password = null) {
  const normalizedPassword = String(password || '');
  if (!normalizedPassword.trim()) {
    throw new Error('LinkedIn password is required');
  }
  try {
    await keytar.setPassword(
      LINKEDIN_CREDENTIAL_SERVICE,
      buildCredentialKey(accountId),
      normalizedPassword
    );
    passwordReadCache.set(normalizeAccountId(accountId), normalizedPassword);
    return true;
  } catch (error) {
    throw new Error(
      `LinkedIn credentials could not be stored in the system keychain: ${normalizeKeychainErrorMessage(error)}`
    );
  }
}

async function getLinkedInAccountPassword(accountId = null) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) {
    return null;
  }
  try {
    return await passwordReadCache.getOrLoad(
      normalizedAccountId,
      () => keytar.getPassword(
        LINKEDIN_CREDENTIAL_SERVICE,
        buildCredentialKey(normalizedAccountId)
      )
    );
  } catch (error) {
    console.error(
      `Failed to read LinkedIn credentials from the system keychain for ${normalizedAccountId}: ${normalizeKeychainErrorMessage(error)}`
    );
    return null;
  }
}

async function hasLinkedInAccountPassword(accountId = null) {
  return Boolean(await getLinkedInAccountPassword(accountId));
}

async function deleteLinkedInAccountPassword(accountId = null) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) {
    return false;
  }
  // Invalidate first so a failed keychain delete can never leave an old
  // password usable by this process.
  passwordReadCache.delete(normalizedAccountId);
  try {
    return await keytar.deletePassword(
      LINKEDIN_CREDENTIAL_SERVICE,
      buildCredentialKey(normalizedAccountId)
    );
  } catch (error) {
    console.error(
      `Failed to delete LinkedIn credentials from the system keychain for ${normalizedAccountId}: ${normalizeKeychainErrorMessage(error)}`
    );
    return false;
  }
}

async function resolveLinkedInAccountCredentials(account = {}) {
  const normalizedAccountId = normalizeAccountId(account.id || account.accountId);
  const email = String(account.email || account.accountEmail || '').trim();
  if (!normalizedAccountId || !email) {
    return null;
  }

  const password = await getLinkedInAccountPassword(normalizedAccountId);
  if (!password) {
    return null;
  }

  return {
    ...account,
    id: normalizedAccountId,
    accountId: normalizedAccountId,
    email,
    password,
    hasPassword: true
  };
}

module.exports = {
  LINKEDIN_CREDENTIAL_SERVICE,
  deleteLinkedInAccountPassword,
  getLinkedInAccountPassword,
  hasLinkedInAccountPassword,
  resolveLinkedInAccountCredentials,
  setLinkedInAccountPassword
};
