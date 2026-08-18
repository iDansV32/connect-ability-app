'use strict';

const { createWorkflowStepResult } = require('../../workflow-step-result');
const {
  buildQuotaExceededReason,
  canConsumeActionQuota,
  consumeActionQuota
} = require('../../linkedin-action-quota-store');
const { traceAction } = require('../network/tracer');
const { logAction, logError } = require('../util/log');
const { randomDelay } = require('../human/delay');

// ---------------------------------------------------------------------------
// DOM selectors for the post feed / recent activity section on a LinkedIn
// profile page.  Comments are entered through the inline comment composer
// that appears below each post.
// ---------------------------------------------------------------------------

const POST_SELECTORS = [
  'div.feed-shared-update-v2',
  'div[data-urn*="urn:li:activity"]',
  'article[data-urn*="urn:li:activity"]',
  'div[class*="feed-shared-update"]'
].join(', ');

const COMMENT_BUTTON_SELECTORS = [
  'button[aria-label*="Comment" i]:not([aria-label*="Comments" i])',
  'button[aria-label*="comment" i]:not([aria-label*="comments" i])',
  'button.comment-button',
  'button[data-control-name="comment"]'
].join(', ');

const COMMENT_INPUT_SELECTORS = [
  'div.ql-editor[data-placeholder*="comment" i]',
  'div[role="textbox"][aria-label*="comment" i]',
  'div.ql-editor[contenteditable="true"]',
  'div[contenteditable="true"][aria-placeholder*="comment" i]'
].join(', ');

const SUBMIT_COMMENT_SELECTORS = [
  'button.comments-comment-box__submit-button',
  'button[data-control-name="comment_submit"]',
  'button[aria-label*="Post comment" i]',
  'button[aria-label*="Submit" i][class*="comment"]',
  'button[type="submit"][class*="comment"]'
].join(', ');

const POSTED_COMMENT_SELECTORS = [
  'div.comments-comment-item',
  'article.comments-comment-entity',
  'div[class*="comments-comment-item"]',
  'div[data-urn*="urn:li:comment"]'
].join(', ');

/**
 * Find the most recent post on the current page that has a visible comment
 * composer entry point.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ found: boolean, postIndex: number, postUrn: string|null }>}
 */
async function findCommentablePost(page) {
  return page.evaluate((selectors) => {
    const { postSel, commentBtnSel } = selectors;
    const root = document.querySelector('main') || document.body;
    const posts = root.querySelectorAll(postSel);

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const btn = post.querySelector(commentBtnSel);
      if (btn) {
        const urn = post.getAttribute('data-urn') || null;
        return { found: true, postIndex: i, postUrn: urn };
      }
    }

    return { found: false, postIndex: -1, postUrn: null };
  }, {
    postSel: POST_SELECTORS,
    commentBtnSel: COMMENT_BUTTON_SELECTORS
  }).catch(() => ({ found: false, postIndex: -1, postUrn: null }));
}

/**
 * Click the comment button on a specific post to open the comment composer
 * (and trigger lazy-loading of existing comments).
 *
 * @param {import('playwright').Page} page
 * @param {number} postIndex - index of the post in the feed
 * @returns {Promise<{ opened: boolean, error?: string }>}
 */
async function openCommentComposer(page, postIndex) {
  return page.evaluate((args) => {
    const { postSel, commentBtnSel, postIdx } = args;
    const root = document.querySelector('main') || document.body;
    const posts = root.querySelectorAll(postSel);
    const post = posts[postIdx];
    if (!post) {
      return { opened: false, error: 'Post element not found at index' };
    }

    const commentBtn = post.querySelector(commentBtnSel);
    if (!commentBtn) {
      return { opened: false, error: 'Comment button not found on post' };
    }
    commentBtn.click();
    return { opened: true };
  }, {
    postSel: POST_SELECTORS,
    commentBtnSel: COMMENT_BUTTON_SELECTORS,
    postIdx: postIndex
  }).catch((err) => ({
    opened: false,
    error: err.message || 'open_error'
  }));
}

/**
 * Type text into an already-open comment composer and click submit.
 *
 * Must be called after `openCommentComposer` has expanded the UI.
 *
 * @param {import('playwright').Page} page
 * @param {number} postIndex - index of the post in the feed
 * @param {string} commentText - the text to enter
 * @returns {Promise<{ submitted: boolean, error?: string }>}
 */
async function submitComment(page, postIndex, commentText) {
  return page.evaluate((args) => {
    const { postSel, inputSel, submitSel, postIdx, text } = args;
    const root = document.querySelector('main') || document.body;
    const posts = root.querySelectorAll(postSel);
    const post = posts[postIdx];
    if (!post) {
      return { submitted: false, error: 'Post element not found at index' };
    }

    // Find the comment input (may be in the post or in a global overlay)
    const input = post.querySelector(inputSel) || document.querySelector(inputSel);
    if (!input) {
      return { submitted: false, error: 'Comment input not found' };
    }

    // Set the comment text
    input.focus();
    input.textContent = text;
    // Dispatch input event so LinkedIn's JS picks up the change
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Find and click the submit button
    const submitBtn = post.querySelector(submitSel) || document.querySelector(submitSel);
    if (!submitBtn) {
      return { submitted: false, error: 'Submit button not found' };
    }
    submitBtn.click();

    return { submitted: true };
  }, {
    postSel: POST_SELECTORS,
    inputSel: COMMENT_INPUT_SELECTORS,
    submitSel: SUBMIT_COMMENT_SELECTORS,
    postIdx: postIndex,
    text: commentText
  }).catch((err) => ({
    submitted: false,
    error: err.message || 'submit_error'
  }));
}

/**
 * Verify that a comment was posted by checking for an increase in comment
 * elements after submission.
 *
 * @param {import('playwright').Page} page
 * @param {number} postIndex
 * @param {number} preCommentCount - count of comment elements before submission
 * @returns {Promise<{ verified: boolean, method: string, at: string, reason?: string, metadata?: object }>}
 */
async function verifyComment(page, postIndex, preCommentCount) {
  const at = new Date().toISOString();
  try {
    await randomDelay(1500, 3000);
    const state = await page.evaluate((args) => {
      const { postSel, commentSel, postIdx } = args;
      const root = document.querySelector('main') || document.body;
      const posts = root.querySelectorAll(postSel);
      const post = posts[postIdx];
      if (!post) {
        return { commentCount: 0 };
      }
      const comments = post.querySelectorAll(commentSel);
      return { commentCount: comments.length };
    }, {
      postSel: POST_SELECTORS,
      commentSel: POSTED_COMMENT_SELECTORS,
      postIdx: postIndex
    }).catch(() => ({ commentCount: 0 }));

    const commentDelta = state.commentCount - preCommentCount;

    if (commentDelta > 0) {
      return {
        verified: true,
        method: 'dom',
        at,
        metadata: {
          commentCount: state.commentCount,
          preCommentCount,
          commentDelta
        }
      };
    }

    return {
      verified: false,
      method: 'dom',
      at,
      reason: 'No new comment element detected after submission',
      metadata: {
        commentCount: state.commentCount,
        preCommentCount
      }
    };
  } catch (err) {
    return {
      verified: false,
      method: 'dom',
      at,
      reason: err.message || 'verification_error'
    };
  }
}

/**
 * Read the current comment count for a specific post.
 *
 * @param {import('playwright').Page} page
 * @param {number} postIndex
 * @returns {Promise<number>}
 */
async function readCommentCount(page, postIndex) {
  return page.evaluate((args) => {
    const { postSel, commentSel, postIdx } = args;
    const root = document.querySelector('main') || document.body;
    const posts = root.querySelectorAll(postSel);
    const post = posts[postIdx];
    if (!post) return 0;
    return post.querySelectorAll(commentSel).length;
  }, {
    postSel: POST_SELECTORS,
    commentSel: POSTED_COMMENT_SELECTORS,
    postIdx: postIndex
  }).catch(() => 0);
}

/**
 * Maximum comment length.  LinkedIn's UI enforces ~1250 chars for comments;
 * we stay well below that.
 */
const MAX_COMMENT_LENGTH = 1200;

/**
 * Execute a comment_on_post action on the given page.
 *
 * @param {import('playwright').Page} page
 * @param {string} profileUrl
 * @param {object} [options]
 * @param {string}  [options.commentTemplate] - the comment text
 * @param {string}  [options.quotaPath]
 * @param {string}  [options.accountId]
 * @param {string}  [options.accountEmail]
 * @param {number}  [options.warmUpMultiplier]
 * @returns {Promise<import('../../workflow-step-result').WorkflowStepResult>}
 */
async function commentOnPostDetailed(page, profileUrl, options = {}) {
  const commentText = String(options.commentTemplate || '').trim().slice(0, MAX_COMMENT_LENGTH);

  if (!commentText) {
    return createWorkflowStepResult({
      stepType: 'comment_on_post',
      outcomeType: 'failed_permanent',
      reason: 'No commentTemplate provided — cannot comment without text',
      profileUrl
    });
  }

  return traceAction(
    page,
    'comment_on_post',
    { profileUrl, commentLength: commentText.length },
    async () => {
      try {
        // Quota check
        const quotaState = canConsumeActionQuota('post_commented', 1, options);
        if (!quotaState.allowed) {
          return createWorkflowStepResult({
            stepType: 'comment_on_post',
            outcomeType: 'skipped_quota_exceeded',
            reason: buildQuotaExceededReason('post_commented', quotaState),
            profileUrl,
            metadata: {
              actionType: 'post_commented',
              exceeded: quotaState.exceeded,
              quota: quotaState.quota
            }
          });
        }

        // Find a commentable post
        const postState = await findCommentablePost(page);

        if (!postState.found) {
          logAction(`No commentable post found on page: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'comment_on_post',
            outcomeType: 'skipped_no_post',
            reason: 'No post with a visible comment button found on the page',
            profileUrl,
            metadata: { postFound: false }
          });
        }

        // Open the comment composer first — this click may lazy-load existing
        // comments into the DOM, so the verification baseline must be captured
        // AFTER the UI is open, not before.
        const openResult = await openCommentComposer(page, postState.postIndex);
        if (!openResult.opened) {
          logAction(`Could not open comment composer: ${openResult.error || 'unknown'}`);
          return createWorkflowStepResult({
            stepType: 'comment_on_post',
            outcomeType: 'skipped_comment_unavailable',
            reason: `Comment UI unavailable: ${openResult.error || 'could not open composer'}`,
            profileUrl,
            metadata: { openResult, postUrn: postState.postUrn }
          });
        }

        // Wait for lazy-loaded comments to settle, then capture the baseline
        await randomDelay(800, 1500);
        const preCommentCount = await readCommentCount(page, postState.postIndex);

        // Type and submit the comment
        await randomDelay(500, 1500);
        const submitResult = await submitComment(page, postState.postIndex, commentText);

        if (!submitResult.submitted) {
          const isTransient = !submitResult.error || !submitResult.error.includes('not found');
          logAction(`Comment submission failed: ${submitResult.error || 'unknown'}`);

          // If the comment input or submit button was not found, it's a UI
          // availability issue — classify as skipped_comment_unavailable.
          if (submitResult.error && (
            submitResult.error.includes('Comment input not found') ||
            submitResult.error.includes('Submit button not found')
          )) {
            return createWorkflowStepResult({
              stepType: 'comment_on_post',
              outcomeType: 'skipped_comment_unavailable',
              reason: `Comment UI unavailable: ${submitResult.error}`,
              profileUrl,
              metadata: { submitResult, postUrn: postState.postUrn }
            });
          }

          return createWorkflowStepResult({
            stepType: 'comment_on_post',
            outcomeType: isTransient ? 'failed_transient' : 'failed_permanent',
            reason: `Could not submit comment: ${submitResult.error || 'unknown'}`,
            profileUrl,
            metadata: { submitResult, postUrn: postState.postUrn }
          });
        }

        // Verify the comment appeared
        const verification = await verifyComment(page, postState.postIndex, preCommentCount);

        if (verification.verified) {
          consumeActionQuota('post_commented', 1, options);
          logAction(`Successfully commented on post at ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'comment_on_post',
            outcomeType: 'completed',
            profileUrl,
            verificationResult: verification,
            metadata: {
              commentText,
              postUrn: postState.postUrn,
              postIndex: postState.postIndex
            }
          });
        }

        // Submit succeeded but verification failed
        logAction(`Comment submitted but verification failed: ${verification.reason}`);
        return createWorkflowStepResult({
          stepType: 'comment_on_post',
          outcomeType: 'failed_transient',
          reason: `Comment submitted but could not verify: ${verification.reason}`,
          profileUrl,
          verificationResult: verification,
          metadata: {
            commentText,
            postUrn: postState.postUrn,
            verified: false
          }
        });
      } catch (error) {
        logError('Error during comment_on_post', error);
        return createWorkflowStepResult({
          stepType: 'comment_on_post',
          outcomeType: 'failed_transient',
          reason: error.message || 'Error during comment_on_post',
          profileUrl
        });
      }
    }
  );
}

module.exports = {
  findCommentablePost,
  openCommentComposer,
  submitComment,
  verifyComment,
  readCommentCount,
  commentOnPostDetailed,
  MAX_COMMENT_LENGTH
};
