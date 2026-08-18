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
// DOM selectors for Follow / Following buttons on a LinkedIn profile page.
//
// LinkedIn uses several button variants:
//   - A standalone "Follow" button in the intro card
//   - A "More" dropdown that can contain "Follow"
//   - "Following" button indicates already-followed state
//
// We intentionally avoid the "Connect" and "Message" buttons via filtering.
// ---------------------------------------------------------------------------

const FOLLOW_BUTTON_SELECTORS = [
  'button[aria-label*="Follow" i]:not([aria-label*="Following" i]):not([aria-label*="Unfollow" i])',
  'button.follow:not(.is-following)',
  'button[data-control-name="follow"]'
].join(', ');

const FOLLOWING_INDICATOR_SELECTORS = [
  'button[aria-label*="Following" i]',
  'button.follow.is-following',
  'button[aria-label*="Unfollow" i]'
].join(', ');

/**
 * Read the follow state from the current profile page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ following: boolean, canFollow: boolean }>}
 */
async function readFollowState(page) {
  return page.evaluate((selectors) => {
    const { followSel, followingSel } = selectors;
    const root = document.querySelector('main') || document.body;

    // Check "Following" indicators first
    const followingElements = root.querySelectorAll(followingSel);
    if (followingElements.length > 0) {
      return { following: true, canFollow: false };
    }

    // Check for available "Follow" buttons
    const followButtons = root.querySelectorAll(followSel);
    // Filter out buttons that are actually "Connect" or inside unrelated sections
    const validFollowButtons = Array.from(followButtons).filter((btn) => {
      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
      const combined = `${text} ${aria}`;
      return (
        combined.includes('follow') &&
        !combined.includes('following') &&
        !combined.includes('unfollow') &&
        !combined.includes('connect') &&
        !combined.includes('message')
      );
    });

    return {
      following: false,
      canFollow: validFollowButtons.length > 0
    };
  }, {
    followSel: FOLLOW_BUTTON_SELECTORS,
    followingSel: FOLLOWING_INDICATOR_SELECTORS
  }).catch(() => ({
    following: false,
    canFollow: false
  }));
}

/**
 * Click the Follow button on the current profile page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ clicked: boolean, reason?: string }>}
 */
async function clickFollowButton(page) {
  return page.evaluate((followSel) => {
    const root = document.querySelector('main') || document.body;
    const followButtons = root.querySelectorAll(followSel);

    const validButtons = Array.from(followButtons).filter((btn) => {
      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
      const combined = `${text} ${aria}`;
      return (
        combined.includes('follow') &&
        !combined.includes('following') &&
        !combined.includes('unfollow') &&
        !combined.includes('connect') &&
        !combined.includes('message')
      );
    });

    if (validButtons.length === 0) {
      return { clicked: false, reason: 'no_follow_button' };
    }

    validButtons[0].click();
    return { clicked: true };
  }, FOLLOW_BUTTON_SELECTORS).catch((err) => ({
    clicked: false,
    reason: err.message || 'click_error'
  }));
}

/**
 * Verify the follow action succeeded by re-reading the page state.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ verified: boolean, method: string, at: string, reason?: string }>}
 */
async function verifyFollow(page) {
  const at = new Date().toISOString();
  try {
    await randomDelay(1500, 3000);
    const state = await readFollowState(page);
    if (state.following) {
      return { verified: true, method: 'dom', at };
    }

    // Reload and recheck once
    await page.reload({ waitUntil: 'domcontentloaded' });
    await randomDelay(2000, 4000);
    const afterReload = await readFollowState(page);
    if (afterReload.following) {
      return { verified: true, method: 'dom', at };
    }

    return { verified: false, method: 'dom', at, reason: 'Follow state not confirmed after reload' };
  } catch (err) {
    return { verified: false, method: 'dom', at, reason: err.message || 'verification_error' };
  }
}

/**
 * Execute a follow_profile action on the given page.
 *
 * Expects the page to already be on the target's LinkedIn profile URL,
 * OR `profileUrl` is provided for navigation.
 *
 * @param {import('playwright').Page} page
 * @param {string} profileUrl
 * @param {object} [options]
 * @param {boolean} [options.strictStealth]
 * @param {string}  [options.quotaPath]
 * @param {string}  [options.accountId]
 * @param {string}  [options.accountEmail]
 * @param {number}  [options.warmUpMultiplier]
 * @returns {Promise<import('../../workflow-step-result').WorkflowStepResult>}
 */
async function followProfileDetailed(page, profileUrl, options = {}) {
  return traceAction(
    page,
    'follow_profile',
    { profileUrl },
    async () => {
      try {
        // Quota check
        const quotaState = canConsumeActionQuota('profile_followed', 1, options);
        if (!quotaState.allowed) {
          return createWorkflowStepResult({
            stepType: 'follow_profile',
            outcomeType: 'skipped_quota_exceeded',
            reason: buildQuotaExceededReason('profile_followed', quotaState),
            profileUrl,
            metadata: {
              actionType: 'profile_followed',
              exceeded: quotaState.exceeded,
              quota: quotaState.quota
            }
          });
        }

        // Read current follow state
        const state = await readFollowState(page);

        if (state.following) {
          logAction(`Already following profile: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'follow_profile',
            outcomeType: 'skipped_already_following',
            reason: 'Profile is already being followed',
            profileUrl,
            metadata: { alreadyFollowing: true }
          });
        }

        if (!state.canFollow) {
          logAction(`No follow button available on profile: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'follow_profile',
            outcomeType: 'failed_transient',
            reason: 'Follow button not found on profile page — page state may be ambiguous',
            profileUrl,
            metadata: { canFollow: false, following: false }
          });
        }

        // Click the Follow button
        const clickResult = await clickFollowButton(page);

        if (!clickResult.clicked) {
          logAction(`Failed to click follow button: ${clickResult.reason}`);
          return createWorkflowStepResult({
            stepType: 'follow_profile',
            outcomeType: 'failed_transient',
            reason: `Could not click follow button: ${clickResult.reason}`,
            profileUrl,
            metadata: { clickResult }
          });
        }

        // Verify the follow took effect
        const verification = await verifyFollow(page);

        if (verification.verified) {
          consumeActionQuota('profile_followed', 1, options);
          logAction(`Successfully followed profile: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'follow_profile',
            outcomeType: 'completed',
            profileUrl,
            verificationResult: verification,
            metadata: { followed: true }
          });
        }

        // Click succeeded but verification failed
        logAction(`Follow click succeeded but verification failed: ${verification.reason}`);
        return createWorkflowStepResult({
          stepType: 'follow_profile',
          outcomeType: 'failed_transient',
          reason: `Follow click succeeded but could not verify: ${verification.reason}`,
          profileUrl,
          verificationResult: verification,
          metadata: { clicked: true, verified: false }
        });
      } catch (error) {
        logError('Error during follow_profile', error);
        return createWorkflowStepResult({
          stepType: 'follow_profile',
          outcomeType: 'failed_transient',
          reason: error.message || 'Error during follow_profile',
          profileUrl
        });
      }
    }
  );
}

module.exports = {
  readFollowState,
  clickFollowButton,
  verifyFollow,
  followProfileDetailed
};
