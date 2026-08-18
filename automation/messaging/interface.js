// messaging/interface.js
const { logAction } = require('../util/log');

async function handleMessagingInterface(page) {
  const isOpen = await page.$('.msg-overlay-conversation-bubble, .msg-conversations-container');
  if (!isOpen) {
    const btn = await page.$('a[href*="/messaging"]');
    if (btn) await btn.click();
  }
}

async function verifyMessageSent(page) {
  const toast = await page.$('.artdeco-toast-item, .msg-s-message-list__event');
  return !!toast;
}

module.exports = { handleMessagingInterface, verifyMessageSent };
