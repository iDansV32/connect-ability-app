// messaging/sender.js
const { logAction, logError } = require('../util/log');
const { randomDelay } = require('../human/delay');
const messagingCore = require('./core');
const { findMessageInput, typeMessage } = require('./composer');
const { stealthClick } = require('../mouse/stealth-click');

/**
 * Send message button click
 * @param {Page} page - Playwright page object
 * @returns {Promise<boolean>} - Success status
 */
async function clickSendButton(page, options = {}) {
  try {
    logAction('Looking for send button');
    
    const sendButtonSelectors = [
      'button[type="submit"].msg-form__send-button',
      'button.msg-form__send-button',
      'button[aria-label="Send"]',
      'button:has-text("Send")',
      '.msg-form__send-btn'
    ];
    
    for (const selector of sendButtonSelectors) {
      const button = await page.$(selector);
      if (button) {
        const isEnabled = await button.isEnabled();
        if (isEnabled) {
          if (options.strictStealth === true) {
            await stealthClick(page, button, options);
          } else {
            await button.click();
          }
          logAction('Clicked send button');
          return true;
        }
      }
    }
    
    // Alternative: Press Enter to send
    logAction('Send button not found, trying Enter key');
    await page.keyboard.press('Enter');
    return true;
  } catch (error) {
    logError(`Error clicking send button: ${error.message}`, error);
    return false;
  }
}

/**
 * Verify message was sent
 * @param {Page} page - Playwright page object
 * @returns {Promise<boolean>} - Success status
 */
async function verifyMessageSent(page) {
  try {
    await randomDelay(1000, 2000);
    
    // Check for success indicators
    const successSelectors = [
      '.artdeco-toast-item--success',
      '.msg-s-message-list__event',
      '.msg-s-event-listitem__message-bubble',
      '.msg-s-message-list-container'
    ];
    
    for (const selector of successSelectors) {
      const element = await page.$(selector);
      if (element) {
        logAction('Message sent successfully');
        return true;
      }
    }
    
    // Check if input was cleared
    const input = await findMessageInput(page);
    if (input) {
      const content = await input.textContent();
      if (!content || content.trim() === '') {
        logAction('Message input cleared - likely sent');
        return true;
      }
    }
    
    return false;
  } catch (error) {
    logError(`Error verifying message sent: ${error.message}`, error);
    return false;
  }
}

/**
 * Send a message through the messaging interface
 * @param {Page} page - Playwright page object
 * @param {string} message - Message content
 * @returns {Promise<boolean>} - Success status
 */
async function sendMessage(page, message, options = {}) {
  try {
    if (!messagingCore.canSendMessage()) {
      logError('Daily message limit reached');
      return false;
    }
    
    // Find message input
    const input = await findMessageInput(page);
    if (!input) {
      logError('Could not find message input');
      return false;
    }
    
    // Type message
    const typed = await typeMessage(page, input, message, options);
    if (!typed) {
      return false;
    }
    
    await randomDelay(1000, 2000);
    
    // Send message
    const sent = await clickSendButton(page, options);
    if (!sent) {
      return false;
    }
    
    // Verify sent
    const verified = await verifyMessageSent(page);
    if (verified) {
      messagingCore.incrementCounter();
      return true;
    }
    
    return false;
  } catch (error) {
    logError(`Error sending message: ${error.message}`, error);
    return false;
  }
}

/**
 * Explicit alias for direct DM send in profile messaging UI.
 */
async function sendDirectMessage(page, message) {
  return sendMessage(page, message);
}

/**
 * Close message window
 * @param {Page} page - Playwright page object
 * @returns {Promise<boolean>} - Success status
 */
async function closeMessageWindow(page) {
  try {
    const closeSelectors = [
      'button[aria-label="Close conversation"]',
      'button[aria-label="Close"]',
      '.msg-overlay__close',
      '.msg-close-btn'
    ];
    
    for (const selector of closeSelectors) {
      const button = await page.$(selector);
      if (button) {
        await button.click();
        await randomDelay(500, 1000);
        return true;
      }
    }
    
    // Alternative: Press Escape
    await page.keyboard.press('Escape');
    return true;
  } catch (error) {
    logError(`Error closing message window: ${error.message}`, error);
    return false;
  }
}

module.exports = {
  clickSendButton,
  verifyMessageSent,
  sendMessage,
  sendDirectMessage,
  closeMessageWindow
};
