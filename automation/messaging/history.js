// ============================================
// messaging/history.js - NEW FILE
// ============================================
const { logError } = require('../util/log');

async function hasRecentMessage(profileUrl, days = 7) {
  try {
    const { getStoredProfileDetails } = require('../profile');
    const profileDetails = await getStoredProfileDetails(profileUrl);
    
    if (!profileDetails || !profileDetails.actions) {
      return false;
    }
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    return profileDetails.actions.some(action => {
      if (action.type === 'Message Sent') {
        const actionDate = new Date(action.timestamp);
        return actionDate > cutoffDate;
      }
      return false;
    });
    
  } catch (error) {
    logError('Error checking recent messages:', error);
    return false;
  }
}

module.exports = {
  hasRecentMessage
};