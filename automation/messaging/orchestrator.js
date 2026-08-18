// messaging/orchestrator.js
const { logAction, logError } = require('../util/log');
const { randomDelay } = require('../human/delay');
const { navigateToProfile, openMessageInterface, openDrawerConversation } = require('./navigator');
const { personalizeMessage } = require('./composer');
const { sendMessage, closeMessageWindow } = require('./sender');
const { extractProfileDetails } = require('../profile/extract');
const { storeProfileAction, getStoredProfileDetails } = require('../profile/storage');
const { hasRecentMessage } = require('./history');
const { canConsumeMessageQuota, updateMessageQuota } = require('./quota');
const { traceAction } = require('../network/tracer');
const { verifyDmSent } = require('../runtime/verification');
const { getWarmUpMultiplier } = require('../safety/warmup-schedule');

function isMeaningfulValue(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  const blocked = new Set([
    'not available',
    'n/a',
    'na',
    'unknown',
    'your company',
    'your role'
  ]);
  return !blocked.has(text);
}

function getTemplatePlaceholders(template = '') {
  const tokens = new Set();
  const braces = String(template).match(/\{([a-zA-Z]+)\}/g) || [];
  const mustache = String(template).match(/\{\{\s*([a-zA-Z]+)\s*\}\}/g) || [];

  const normalize = (raw) =>
    String(raw)
      .replace(/[{}]/g, '')
      .trim()
      .toLowerCase();

  braces.forEach((match) => tokens.add(normalize(match)));
  mustache.forEach((match) => tokens.add(normalize(match)));
  return tokens;
}

function getMissingTemplateFields(template, profileDetails) {
  const placeholders = getTemplatePlaceholders(template);
  if (!placeholders.size) return [];

  const checks = {
    firstname: () => isMeaningfulValue(profileDetails?.firstName),
    lastname: () => isMeaningfulValue(profileDetails?.lastName),
    fullname: () =>
      isMeaningfulValue(profileDetails?.fullName) ||
      isMeaningfulValue(`${profileDetails?.firstName || ''} ${profileDetails?.lastName || ''}`),
    name: () =>
      isMeaningfulValue(profileDetails?.fullName) ||
      isMeaningfulValue(profileDetails?.firstName),
    company: () => isMeaningfulValue(profileDetails?.company),
    title: () => isMeaningfulValue(profileDetails?.title || profileDetails?.position),
    position: () => isMeaningfulValue(profileDetails?.position || profileDetails?.title)
  };

  const missing = [];
  for (const field of placeholders) {
    const check = checks[field];
    if (check && !check()) {
      missing.push(field);
    }
  }
  return missing;
}

function recordSuccessfulSendQuota(count = 1, options = {}) {
  try {
    updateMessageQuota(count, options);
  } catch (error) {
    logError(`Failed to persist message quota usage: ${error.message}`, error);
  }
}

function buildMessageQuotaOptions(options = {}) {
  return {
    accountId: options.accountId || null,
    accountEmail: options.accountEmail || null,
    accountName: options.accountName || null,
    warmUpMultiplier: getWarmUpMultiplier({ warmUpStartedAt: options.warmUpStartedAt || null })
  };
}

/**
 * Send message to a LinkedIn profile (complete flow)
 * @param {Page} page - Playwright page object
 * @param {string} profileUrl - LinkedIn profile URL
 * @param {string} messageTemplate - Message template
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} - Result object
 */
async function sendLinkedInMessage(page, profileUrl, messageTemplate, options = {}) {
  const useDrawerFlow = resolveUseMessagingDrawer(profileUrl, options);
  return traceAction(
    page,
    'send_message',
    {
      profileUrl,
      useMessagingDrawer: useDrawerFlow,
      hasTemplate: Boolean(messageTemplate && String(messageTemplate).trim())
    },
    async () => {
      try {
        logAction(`Starting message send flow for: ${profileUrl}`);

        const quotaOptions = buildMessageQuotaOptions(options);
        const quotaState = canConsumeMessageQuota(1, quotaOptions);
        if (!quotaState.allowed) {
          const exceededText = quotaState.exceeded.join(', ');
          logError(
            `Message quota exceeded (${exceededText}): daily ${quotaState.quota.daily.used}/${quotaState.quota.daily.limit}, weekly ${quotaState.quota.weekly.used}/${quotaState.quota.weekly.limit}`
          );
          return {
            success: false,
            reason: 'quota_exceeded',
            exceeded: quotaState.exceeded,
            quota: quotaState.quota,
            profileUrl
          };
        }
        
        if (options.checkHistory) {
          const hasRecent = await hasRecentMessage(profileUrl, options.daysBetweenMessages || 7);
          if (hasRecent) {
            logAction(`Skipping - recent message sent within ${options.daysBetweenMessages || 7} days`);
            return { 
              success: false, 
              reason: 'recent_message_exists',
              profileUrl 
            };
          }
        }
        
        let profileDetails = null;

        if (useDrawerFlow) {
          const recipientName = String(options.recipientName || '').trim();
          if (!recipientName) {
            return {
              success: false,
              reason: 'missing_recipient_name',
              profileUrl
            };
          }

          const conversationOpened = await openDrawerConversation(page, recipientName, options);
          if (!conversationOpened) {
            return {
              success: false,
              reason: 'conversation_not_found',
              profileUrl
            };
          }

          const parts = recipientName.split(/\s+/).filter(Boolean);
          const storedProfile = profileUrl && profileUrl.includes('/in/')
            ? getStoredProfileDetails(profileUrl)
            : null;
          profileDetails = {
            firstName: parts[0] || 'there',
            lastName: parts.length > 1 ? parts.slice(1).join(' ') : '',
            fullName: recipientName,
            position: storedProfile?.title || storedProfile?.position || 'Not Available',
            title: storedProfile?.title || storedProfile?.position || 'Not Available',
            company: storedProfile?.company || 'Not Available',
            profileUrl
          };
        } else {
          const navigated = await navigateToProfile(page, profileUrl);
          if (!navigated) {
            return {
              success: false,
              reason: 'navigation_failed',
              profileUrl
            };
          }

          profileDetails = await extractProfileDetails(page, profileUrl);
          if (!profileDetails) {
            logError('Could not extract profile details');
            return {
              success: false,
              reason: 'profile_extraction_failed',
              profileUrl
            };
          }

          const interfaceOpened = await openMessageInterface(page, options);
          if (!interfaceOpened) {
            const fallbackRecipientName =
              profileDetails?.fullName ||
              [profileDetails?.firstName, profileDetails?.lastName].filter(Boolean).join(' ');
            if (!fallbackRecipientName) {
              return {
                success: false,
                reason: 'message_interface_failed',
                profileUrl,
                profileDetails
              };
            }

            const drawerOpened = await openDrawerConversation(page, fallbackRecipientName, options);
            if (!drawerOpened) {
              return {
                success: false,
                reason: 'message_interface_failed',
                profileUrl,
                profileDetails
              };
            }

            logAction(`Fell back to messaging drawer for ${fallbackRecipientName}`);
          }
        }

        await randomDelay(800, 1800);

        const missingFields = getMissingTemplateFields(messageTemplate, profileDetails);
        if (missingFields.length) {
          const displayName =
            profileDetails?.fullName ||
            [profileDetails?.firstName, profileDetails?.lastName].filter(Boolean).join(' ') ||
            profileUrl;
          logError(
            `Message blocked for ${displayName}: missing required template fields (${missingFields.join(', ')})`
          );
          return {
            success: false,
            reason: 'missing_template_fields',
            missingFields,
            profileUrl,
            profileDetails
          };
        }
        
        const personalizedMessage = personalizeMessage(messageTemplate, profileDetails);
        logAction(`Personalized message for ${profileDetails.firstName}`);

        const sent = await sendMessage(page, personalizedMessage, options);
        if (!sent) {
          return { 
            success: false, 
            reason: 'send_failed',
            profileUrl,
            profileDetails 
          };
        }

        recordSuccessfulSendQuota(1, quotaOptions);
        
        storeProfileAction(
          profileUrl,
          profileDetails,
          'Message Sent',
          `Message: ${personalizedMessage.substring(0, 100)}...`,
          options.searchQuery
        );
        
        if (!useDrawerFlow) {
          await closeMessageWindow(page);
        }
        
        return {
          success: true,
          profileUrl,
          profileDetails,
          message: personalizedMessage,
          timestamp: new Date().toISOString(),
          transport: 'dom',
          verificationResult: await verifyDmSent(page, {
            transport: 'dom',
            action: 'send_dm',
            accountEmail: quotaOptions.accountEmail || null,
            transportHealthStore: options.transportHealthStore || null
          })
        };
        
      } catch (error) {
        logError(`Error in sendLinkedInMessage: ${error.message}`, error);
        return {
          success: false,
          reason: 'exception',
          error: error.message,
          profileUrl
        };
      }
    }
  );
}

function resolveUseMessagingDrawer(profileUrl, options = {}) {
  if (options.useMessagingDrawer === true) return true;
  if (options.useMessagingDrawer === false) return false;

  // A canonical profile URL is the strongest target identifier available.
  // Navigate to it and use that profile's Message action instead of turning
  // its public slug (including LinkedIn's suffix) into a drawer search term.
  const hasProfileUrl = /linkedin\.com\/in\//i.test(String(profileUrl || '').trim());
  return !hasProfileUrl && Boolean(String(options.recipientName || '').trim());
}

/**
 * Send messages to multiple profiles
 * @param {Page} page - Playwright page object
 * @param {Array} profiles - Array of profile URLs or objects
 * @param {string} messageTemplate - Message template
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} - Results summary
 */
async function sendBulkMessages(page, profiles, messageTemplate, options = {}) {
  try {
    logAction(`Starting bulk message send to ${profiles.length} profiles`);
    
    const results = {
      total: profiles.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      details: []
    };
    
    for (let i = 0; i < profiles.length; i++) {
      const profile = typeof profiles[i] === 'string' ? profiles[i] : profiles[i].url;
      
      logAction(`Processing profile ${i + 1}/${profiles.length}`);
      
      const result = await sendLinkedInMessage(page, profile, messageTemplate, options);
      
      if (result.success) {
        results.sent++;
      } else if (result.reason === 'recent_message_exists') {
        results.skipped++;
      } else if (result.reason === 'quota_exceeded') {
        results.skipped++;
      } else {
        results.failed++;
      }
      
      results.details.push(result);

      if (result.reason === 'quota_exceeded') {
        const remainingProfiles = profiles.slice(i + 1).map((entry) => {
          const profileUrl = typeof entry === 'string' ? entry : entry?.url || '';
          return {
            success: false,
            reason: 'quota_exceeded',
            profileUrl
          };
        });
        results.skipped += remainingProfiles.length;
        results.details.push(...remainingProfiles);
        logAction('Stopping bulk messaging because the message quota has been reached');
        break;
      }
      
      // Delay between messages
      if (i < profiles.length - 1) {
        const delay = options.delayBetweenMessages || 30000;
        logAction(`Waiting ${delay / 1000} seconds before next message`);
        await randomDelay(delay, delay * 1.5);
      }
    }
    
    logAction(`Bulk messaging complete: ${results.sent} sent, ${results.failed} failed, ${results.skipped} skipped`);
    return results;
    
  } catch (error) {
    logError(`Error in sendBulkMessages: ${error.message}`, error);
    throw error;
  }
}

/**
 * Process message sending workflow
 * @param {Page} page - Playwright page object
 * @param {Array} profiles - Profiles to message
 * @param {string} template - Message template
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} - Results
 */
async function processMessageSending(page, profiles, template, config = {}) {
  return sendBulkMessages(page, profiles, template, {
    checkHistory: config.checkHistory !== false,
    daysBetweenMessages: config.daysBetweenMessages || 7,
    delayBetweenMessages: config.messageDelay || 30000,
    searchQuery: config.searchQuery
  });
}

module.exports = {
  sendLinkedInMessage,
  sendBulkMessages,
  processMessageSending
};
