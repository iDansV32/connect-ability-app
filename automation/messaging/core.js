const { logAction, logError } = require('../util/log');
const {
  canConsumeMessageQuota,
  getMessageQuota,
  resetMessageQuotaWindow,
  updateMessageQuota
} = require('./quota');

/**
 * Core messaging configuration and state management
 */
class MessagingCore {
  constructor() {
    this.activeConversations = new Map();
  }

  /**
   * Check if we can send more messages today
   */
  canSendMessage(count = 1) {
    return canConsumeMessageQuota(count).allowed;
  }

  /**
   * Increment message counter
   */
  incrementCounter(count = 1) {
    const used = updateMessageQuota(count);
    const quota = getMessageQuota();
    logAction(`Messages sent today: ${used}/${quota.daily.limit}`);
  }

  /**
   * Reset daily counter
   */
  resetDailyCounter() {
    resetMessageQuotaWindow('daily');
    logAction('Daily message counter reset');
  }
}

module.exports = new MessagingCore();
