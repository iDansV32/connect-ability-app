const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LINKEDIN_POST_PUBLISH_MAX_ATTEMPTS,
  getLinkedInPostPublishRetryDelayMs,
  isRetriableLinkedInPostPublishError
} = require('../post-publish-retry');

test('post publish retry policy retries transient LinkedIn automation failures', () => {
  assert.equal(isRetriableLinkedInPostPublishError(new Error('Could not open LinkedIn post composer')), true);
  assert.equal(isRetriableLinkedInPostPublishError(new Error('Publish action timed out waiting for LinkedIn confirmation')), true);
  assert.equal(isRetriableLinkedInPostPublishError(new Error('Execution context was destroyed, most likely because of a navigation.')), true);
});

test('post publish retry policy does not retry validation and credential failures', () => {
  assert.equal(isRetriableLinkedInPostPublishError(new Error('LinkedIn credentials are missing. Save credentials first.')), false);
  assert.equal(isRetriableLinkedInPostPublishError(new Error('Post content is required')), false);
  assert.equal(isRetriableLinkedInPostPublishError(new Error('Image file not found: /tmp/missing.png')), false);
});

test('post publish retry delays back off and cap', () => {
  assert.equal(LINKEDIN_POST_PUBLISH_MAX_ATTEMPTS, 3);
  assert.equal(getLinkedInPostPublishRetryDelayMs(1), 4000);
  assert.equal(getLinkedInPostPublishRetryDelayMs(2), 8000);
  assert.equal(getLinkedInPostPublishRetryDelayMs(5), 15000);
});
