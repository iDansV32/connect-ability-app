const LINKEDIN_POST_PUBLISH_MAX_ATTEMPTS = 3;
const LINKEDIN_POST_PUBLISH_BASE_RETRY_DELAY_MS = 4000;
const LINKEDIN_POST_PUBLISH_MAX_RETRY_DELAY_MS = 15000;

const NON_RETRIABLE_LINKEDIN_POST_ERROR_PATTERNS = [
  /linkedin credentials are missing/i,
  /no linkedin credentials found/i,
  /post content is required/i,
  /scheduled date and time are required/i,
  /image file not found/i,
  /unsupported scheduled post status/i
];

const RETRIABLE_LINKEDIN_POST_ERROR_PATTERNS = [
  /could not open linkedin post composer/i,
  /post editor could not be located/i,
  /linkedin schedule controls were not found/i,
  /publish action timed out/i,
  /schedule action timed out/i,
  /execution context was destroyed/i,
  /target closed/i,
  /session closed/i,
  /navigation.*timed out/i,
  /navigation.*failed/i,
  /network/i,
  /econnreset/i,
  /enetdown/i,
  /enetunreach/i,
  /eai_again/i
];

function normalizeErrorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error.trim();
  return String(error.message || error).trim();
}

function isRetriableLinkedInPostPublishError(error) {
  const message = normalizeErrorMessage(error);
  if (!message) return false;

  if (NON_RETRIABLE_LINKEDIN_POST_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }

  return RETRIABLE_LINKEDIN_POST_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function getLinkedInPostPublishRetryDelayMs(attemptNumber) {
  const normalizedAttempt = Math.max(1, Number.parseInt(attemptNumber, 10) || 1);
  const delay = LINKEDIN_POST_PUBLISH_BASE_RETRY_DELAY_MS * (2 ** (normalizedAttempt - 1));
  return Math.min(LINKEDIN_POST_PUBLISH_MAX_RETRY_DELAY_MS, delay);
}

module.exports = {
  LINKEDIN_POST_PUBLISH_MAX_ATTEMPTS,
  getLinkedInPostPublishRetryDelayMs,
  isRetriableLinkedInPostPublishError
};
