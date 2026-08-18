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
// DOM selectors for the Following / Unfollow controls on a LinkedIn profile.
//
// The "Following" button on a profile serves a dual role: it indicates that
// the viewer already follows, and clicking it triggers the unfollow action.
// LinkedIn may also show a confirmation dialog after the click.
// ---------------------------------------------------------------------------

const FOLLOWING_BUTTON_SELECTORS = [
  'button[aria-label*="Following" i]',
  'button.follow.is-following',
  'button[aria-label*="Unfollow" i]',
  'button[data-control-name="unfollow"]'
].join(', ');

const FOLLOW_BUTTON_SELECTORS = [
  'button[aria-label*="Follow" i]:not([aria-label*="Following" i]):not([aria-label*="Unfollow" i])',
  'button.follow:not(.is-following)',
  'button[data-control-name="follow"]'
].join(', ');

const UNFOLLOW_CONFIRM_SELECTORS = [
  'button[data-control-name="unfollow_confirm"]',
  'button[aria-label*="Unfollow" i][class*="confirm"]',
  'div[role="dialog"] button[aria-label*="Unfollow" i]',
  'div[role="dialog"] button[data-test-modal-close-btn]'
].join(', ');

/**
 * Read the follow state from the current profile page.
 * Reuses the same detection logic as the follow module.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ following: boolean, canUnfollow: boolean }>}
 */
async function readUnfollowState(page) {
  return page.evaluate((selectors) => {
    const { followingSel, followSel } = selectors;
    const root = document.querySelector('main') || document.body;

    const followingButtons = root.querySelectorAll(followingSel);
    if (followingButtons.length > 0) {
      return { following: true, canUnfollow: true };
    }

    const followButtons = root.querySelectorAll(followSel);
    const hasFollow = Array.from(followButtons).some((btn) => {
      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
      const combined = `${text} ${aria}`;
      return combined.includes('follow') && !combined.includes('following') && !combined.includes('unfollow');
    });

    return { following: false, canUnfollow: false, hasFollowButton: hasFollow };
  }, {
    followingSel: FOLLOWING_BUTTON_SELECTORS,
    followSel: FOLLOW_BUTTON_SELECTORS
  }).catch(() => ({
    following: false,
    canUnfollow: false
  }));
}

/**
 * Click the Following/Unfollow button on the current profile page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ clicked: boolean, reason?: string }>}
 */
async function clickUnfollowButton(page) {
  return page.evaluate((followingSel) => {
    const root = document.querySelector('main') || document.body;
    const buttons = root.querySelectorAll(followingSel);

    if (buttons.length === 0) {
      return { clicked: false, reason: 'no_following_button' };
    }

    buttons[0].click();
    return { clicked: true };
  }, FOLLOWING_BUTTON_SELECTORS).catch((err) => ({
    clicked: false,
    reason: err.message || 'click_error'
  }));
}

/**
 * Handle an optional confirmation dialog that LinkedIn may show after
 * clicking the Following button.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ confirmed: boolean, dialogFound: boolean }>}
 */
async function handleUnfollowConfirmation(page) {
  return page.evaluate((confirmSel) => {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) {
      return { confirmed: true, dialogFound: false };
    }

    const confirmBtn = dialog.querySelector(confirmSel) || document.querySelector(confirmSel);
    if (!confirmBtn) {
      return { confirmed: true, dialogFound: true };
    }

    confirmBtn.click();
    return { confirmed: true, dialogFound: true };
  }, UNFOLLOW_CONFIRM_SELECTORS).catch(() => ({
    confirmed: false,
    dialogFound: false
  }));
}

/**
 * Verify the unfollow action succeeded by re-reading the page state.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ verified: boolean, method: string, at: string, reason?: string }>}
 */
async function verifyUnfollow(page) {
  const at = new Date().toISOString();
  try {
    await randomDelay(1500, 3000);
    const state = await readUnfollowState(page);
    if (!state.following) {
      return { verified: true, method: 'dom', at };
    }

    return {
      verified: false,
      method: 'dom',
      at,
      reason: 'Profile still shows as followed after unfollow click'
    };
  } catch (err) {
    return { verified: false, method: 'dom', at, reason: err.message || 'verification_error' };
  }
}

/**
 * Execute an unfollow_profile action on the given page.
 *
 * @param {import('playwright').Page} page
 * @param {string} profileUrl
 * @param {object} [options]
 * @param {string}  [options.quotaPath]
 * @param {string}  [options.accountId]
 * @param {string}  [options.accountEmail]
 * @param {number}  [options.warmUpMultiplier]
 * @returns {Promise<import('../../workflow-step-result').WorkflowStepResult>}
 */
async function unfollowProfileDetailed(page, profileUrl, options = {}) {
  return traceAction(
    page,
    'unfollow_profile',
    { profileUrl },
    async () => {
      try {
        // Quota check
        const quotaState = canConsumeActionQuota('profile_unfollowed', 1, options);
        if (!quotaState.allowed) {
          return createWorkflowStepResult({
            stepType: 'unfollow_profile',
            outcomeType: 'skipped_quota_exceeded',
            reason: buildQuotaExceededReason('profile_unfollowed', quotaState),
            profileUrl,
            metadata: {
              actionType: 'profile_unfollowed',
              exceeded: quotaState.exceeded,
              quota: quotaState.quota
            }
          });
        }

        // Read current follow state
        const state = await readUnfollowState(page);

        if (!state.following) {
          logAction(`Not following profile: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'unfollow_profile',
            outcomeType: 'skipped_not_following',
            reason: 'Profile is not currently being followed',
            profileUrl,
            metadata: { following: false }
          });
        }

        if (!state.canUnfollow) {
          logAction(`Unfollow control not available on profile: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'unfollow_profile',
            outcomeType: 'failed_transient',
            reason: 'Unfollow control not found on profile page',
            profileUrl,
            metadata: { canUnfollow: false, following: true }
          });
        }

        // Click the Following/Unfollow button
        const clickResult = await clickUnfollowButton(page);

        if (!clickResult.clicked) {
          logAction(`Failed to click unfollow button: ${clickResult.reason}`);
          return createWorkflowStepResult({
            stepType: 'unfollow_profile',
            outcomeType: 'failed_transient',
            reason: `Could not click unfollow button: ${clickResult.reason}`,
            profileUrl,
            metadata: { clickResult }
          });
        }

        // Handle possible confirmation dialog
        await randomDelay(500, 1000);
        const confirmResult = await handleUnfollowConfirmation(page);

        // Verify the unfollow took effect
        const verification = await verifyUnfollow(page);

        if (verification.verified) {
          consumeActionQuota('profile_unfollowed', 1, options);
          logAction(`Successfully unfollowed profile: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'unfollow_profile',
            outcomeType: 'completed',
            profileUrl,
            verificationResult: verification,
            metadata: {
              unfollowed: true,
              confirmationDialog: confirmResult.dialogFound
            }
          });
        }

        // Click succeeded but verification failed
        logAction(`Unfollow click succeeded but verification failed: ${verification.reason}`);
        return createWorkflowStepResult({
          stepType: 'unfollow_profile',
          outcomeType: 'failed_transient',
          reason: `Unfollow click succeeded but could not verify: ${verification.reason}`,
          profileUrl,
          verificationResult: verification,
          metadata: { clicked: true, verified: false }
        });
      } catch (error) {
        logError('Error during unfollow_profile', error);
        return createWorkflowStepResult({
          stepType: 'unfollow_profile',
          outcomeType: 'failed_transient',
          reason: error.message || 'Error during unfollow_profile',
          profileUrl
        });
      }
    }
  );
}

module.exports = {
  readUnfollowState,
  clickUnfollowButton,
  handleUnfollowConfirmation,
  verifyUnfollow,
  unfollowProfileDetailed
};
