// ============================================
// workflow/steps.js - NEW FILE
// ============================================
const { logAction, logError } = require('../util/log');

async function processMessageStep(step, page, profileUrl) {
  try {
    if (step.type !== 'send_message') {
      return false;
    }
    
    logAction(`Processing message step for ${profileUrl}`);
    
    const { extractProfileDetails } = require('../profile/extract');
    const profileDetails = await extractProfileDetails(page, profileUrl);
    
    if (!profileDetails) {
      logError(`Could not get profile details for ${profileUrl}`);
      return false;
    }
    
    const { personalizeMessage, sendLinkedInMessage } = require('../messaging/send');
    const personalizedMessage = personalizeMessage(step.message, profileDetails);
    
    const sent = await sendLinkedInMessage(page, profileUrl, personalizedMessage);
    
    if (sent) {
      const { storeProfileAction } = require('../profile/storage');
      storeProfileAction(
        profileUrl,
        profileDetails,
        'Message Sent',
        `Sent workflow message: ${personalizedMessage.substring(0, 50)}...`
      );
    }
    
    return sent;
    
  } catch (error) {
    logError(`Error processing message step: ${error.message}`, error);
    return false;
  }
}

module.exports = {
  processMessageStep
};