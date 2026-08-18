// activity/like.js
const { randomDelay } = require('../human/delay');
const { logAction, logError } = require('../util/log');
const { humanScroll } = require('../human/scroll');
const { navigateToActivityPage, checkForShowPostsButton } = require('./navigate');
const { traceAction } = require('../network/tracer');
const { createWorkflowStepResult } = require('../../workflow-step-result');
const {
  buildQuotaExceededReason,
  canConsumeActionQuota,
  consumeActionQuota
} = require('../../linkedin-action-quota-store');

/**
 * Verify if a reaction was successfully applied
 * @param {Page} page - Playwright page object
 * @returns {Promise<boolean>} - Whether reaction is verified
 */
async function verifyReaction(page) {
  try {
    const verificationResult = await page.evaluate(() => {
      const indicators = {
        activeButtons: document.querySelectorAll('button[aria-pressed="true"]').length,
        blueIcons: document.querySelectorAll('svg[fill*="blue"][class*="react"]').length,
        activeClasses: document.querySelectorAll('.social-action-button.active, .react-button__trigger.active').length,
        reactionCounts: document.querySelectorAll('.social-details-social-counts__reactions-count').length
      };
      
      const possibleNotifications = Array.from(document.querySelectorAll('.artdeco-toast-item__message'))
        .map(el => el.textContent.trim());
      
      return {
        indicators,
        hasAnyIndicator: Object.values(indicators).some(count => count > 0),
        notifications: possibleNotifications
      };
    });
    
    logAction(`Reaction verification: ${JSON.stringify(verificationResult)}`);
    
    if (verificationResult.hasAnyIndicator) {
      logAction('Reaction appears to be successfully registered');
      return true;
    } else {
      logAction('No visible indicators that reaction was registered');
      
      // Try reloading to check
      logAction('Reloading page to confirm reaction status');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await randomDelay(3000, 5000);
      
      const afterReloadCheck = await page.evaluate(() => {
        return {
          activeButtons: document.querySelectorAll('button[aria-pressed="true"]').length,
          blueIcons: document.querySelectorAll('svg[fill*="blue"][class*="react"]').length,
          activeClasses: document.querySelectorAll('.social-action-button.active, .react-button__trigger.active').length
        };
      });
      
      logAction(`After reload verification: ${JSON.stringify(afterReloadCheck)}`);
      return Object.values(afterReloadCheck).some(count => count > 0);
    }
  } catch (error) {
    logError('Error during reaction verification', error);
    return false;
  }
}

/**
 * Enhanced function to like a post
 * @param {Page} page - Playwright page object
 * @returns {Promise<boolean>} - Success status
 */
async function enhancedLikePost(page) {
  try {
    await humanScroll(page);
    await randomDelay(2000, 3000);
    
    const likeResult = await page.evaluate(async () => {
      const posts = Array.from(document.querySelectorAll(
        '.feed-shared-update-v2, ' +
        '.occludable-update, ' +
        '.update-components-actor, ' +
        '.profile-creator-shared-feed__container, ' +
        '.feed-shared-actor, ' +
        '.social-details-social-activity, ' +
        'article[data-urn]'
      ));
      
      if (posts.length === 0) {
        console.log('No posts found to react to');
        return { success: false, reason: 'no_posts' };
      }
      
      console.log(`Found ${posts.length} potential posts`);
      
      for (let i = 0; i < Math.min(posts.length, 3); i++) {
        const post = posts[i];
        post.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Check if already reacted
        const alreadyReacted = post.querySelector(
          'button[aria-pressed="true"], ' +
          '.social-action-button.active, ' + 
          'button.liked, ' +
          'button.react-button__trigger.active, ' +
          'svg[fill*="blue"][class*="react"], ' +
          '.social-reaction-count.active'
        );
        
        if (alreadyReacted) {
          console.log(`Post ${i+1} already has a reaction, skipping`);
          continue;
        }
        
        // Find like buttons with specific selectors
        const likeButtons = post.querySelectorAll(
          'button[aria-label="Like"], ' + 
          'button[aria-label="React"], ' + 
          'button.social-actions-button[type="button"][aria-label*="like" i], ' +
          '.react-button__trigger:not(.active), ' +
          'button[data-control-name="react_toggle"]'
        );
        
        // Filter out share/forward buttons
        const filteredButtons = Array.from(likeButtons).filter(button => {
          const buttonText = button.textContent.toLowerCase();
          const ariaLabel = button.getAttribute('aria-label') || '';
          
          return !buttonText.includes('share') && 
                 !buttonText.includes('forward') && 
                 !buttonText.includes('repost') &&
                 !ariaLabel.includes('share') &&
                 !ariaLabel.includes('forward') &&
                 !ariaLabel.includes('repost');
        });
        
        if (filteredButtons.length === 0) {
          console.log(`No suitable like button found for post ${i+1}`);
          continue;
        }
        
        const likeButton = filteredButtons[0];
        console.log(`Attempting to like post ${i+1}`);
        
        // Record before state
        const beforeState = {
          ariaPressed: likeButton.getAttribute('aria-pressed'),
          hasActiveClass: likeButton.classList.contains('active'),
          hasLikedClass: likeButton.classList.contains('liked'),
          textContent: likeButton.textContent
        };
        
        // Click the like button
        likeButton.click();
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Check after state
        const afterDirectClick = {
          ariaPressed: likeButton.getAttribute('aria-pressed'),
          hasActiveClass: likeButton.classList.contains('active'),
          hasLikedClass: likeButton.classList.contains('liked')
        };
        
        if (afterDirectClick.ariaPressed === 'true' || 
            afterDirectClick.hasActiveClass || 
            afterDirectClick.hasLikedClass) {
          return { 
            success: true, 
            postIndex: i, 
            reaction: 'Like (direct click)',
            verificationMethod: 'direct_click'
          };
        }
      }
      
      console.log('All like attempts failed');
      return { success: false, reason: 'could_not_like' };
    });
    
    if (likeResult.success) {
      logAction(`Successfully liked post #${likeResult.postIndex + 1}`);
      await randomDelay(3000, 5000);
      return true;
    } else {
      logAction(`Failed to like any posts: ${likeResult.reason}`);
      return false;
    }
  } catch (error) {
    logError('Error during post like', error);
    return false;
  }
}

/**
 * Process the activity page for a profile
 * @param {Page} page - Playwright page object
 * @param {string} profileUrl - LinkedIn profile URL
 * @returns {Promise<boolean>} - Success status
 */
async function processActivityPageDetailed(page, profileUrl, quotaOptions = {}) {
  return traceAction(
    page,
    'like_post',
    { profileUrl },
    async () => {
      try {
        const quotaState = canConsumeActionQuota('post_liked', 1, quotaOptions);
        if (!quotaState.allowed) {
          return createWorkflowStepResult({
            stepType: 'like_posts',
            outcomeType: 'skipped_quota_exceeded',
            reason: buildQuotaExceededReason('post_liked', quotaState),
            profileUrl,
            metadata: {
              actionType: 'post_liked',
              exceeded: quotaState.exceeded,
              quota: quotaState.quota
            }
          });
        }

        const hasActivity = await navigateToActivityPage(page, profileUrl, {
          strictStealth: quotaOptions.strictStealth === true
        });
        
        if (!hasActivity) {
          logAction('Profile has no visible activity to interact with');
          return createWorkflowStepResult({
            stepType: 'like_posts',
            outcomeType: 'skipped_no_post',
            reason: 'Profile has no visible activity to interact with',
            profileUrl
          });
        }
        
        const reactionSuccess = await enhancedLikePost(page);
        
        if (reactionSuccess) {
          const verified = await verifyReaction(page);
          
          if (verified) {
            consumeActionQuota('post_liked', 1, quotaOptions);
            logAction('Reaction successfully verified');
            return createWorkflowStepResult({
              stepType: 'like_posts',
              outcomeType: 'completed',
              profileUrl
            });
          } else {
            logAction('WARNING: Reaction appeared to succeed but could not be verified');
            return createWorkflowStepResult({
              stepType: 'like_posts',
              outcomeType: 'failed_transient',
              reason: 'Reaction appeared to succeed but could not be verified',
              profileUrl
            });
          }
        } else {
          return createWorkflowStepResult({
            stepType: 'like_posts',
            outcomeType: 'skipped_no_post',
            reason: 'No likeable post was found on the activity page',
            profileUrl
          });
        }
      } catch (error) {
        logError('Error processing activity page', error);
        return createWorkflowStepResult({
          stepType: 'like_posts',
          outcomeType: 'failed_transient',
          reason: error.message || 'Error processing activity page',
          profileUrl
        });
      }
    }
  );
}

async function processActivityPage(page, profileUrl, quotaOptions = {}) {
  const result = await processActivityPageDetailed(page, profileUrl, quotaOptions);
  return result?.outcomeType === 'completed';
}

module.exports = {
  verifyReaction,
  enhancedLikePost,
  processActivityPage,
  processActivityPageDetailed
};
