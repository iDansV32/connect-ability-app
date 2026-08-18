// app-coordinator.js - Send Now Handler Integration
const { ipcMain } = require('electron');
const { executeSendNow } = require('./automation/messaging/automation');
const { logAction, logError } = require('./automation/util/log');
const { readEnvCredential } = require('./automation/safety/secret-source');
require('dotenv').config();

/**
 * Initialize Send Now handler for IPC communication
 */
function initializeSendNowHandler() {
  
  // Handle Send Now button click from renderer
  ipcMain.handle('send-messages-now', async (event, data) => {
    try {
      logAction('=====================================');
      logAction('Received Send Now request from UI');
      logAction('=====================================');
      
      // Validate input data
      if (!data.profileUrls || data.profileUrls.length === 0) {
        throw new Error('No profile URLs provided');
      }
      
      if (!data.message || data.message.trim() === '') {
        throw new Error('No message content provided');
      }
      
      // Credentials from the renderer payload always win. Env fallback is
      // gated behind CONNECT_ALLOW_ENV_CREDENTIALS — the .env path is dev-only
      // and not relied on in production.
      const email = data.email || process.env.LINKEDIN_EMAIL;
      const envPassword = data.password ? null : readEnvCredential('LINKEDIN_PASSWORD', { name: 'LinkedIn password' });
      const password = data.password || (envPassword ? envPassword.value : null);

      if (!email || !password) {
        throw new Error('LinkedIn credentials not configured. Add them via the keychain (preferred) or set CONNECT_ALLOW_ENV_CREDENTIALS=1 to use env vars.');
      }
      
      logAction(`Profile URLs to message: ${data.profileUrls.length}`);
      data.profileUrls.forEach((url, index) => {
        logAction(`  ${index + 1}. ${url}`);
      });
      
      // Prepare configuration
      const config = {
        profileUrls: data.profileUrls,
        message: data.message,
        email: email,
        password: password,
        headless: false, // Set to false so you can see the browser
        options: {
          checkHistory: data.checkHistory !== false,
          daysBetweenMessages: data.daysBetweenMessages || 7,
          delayBetweenMessages: data.delayBetweenMessages || 30000,
          searchQuery: data.searchQuery || 'Direct message'
        }
      };
      
      // Execute the automation
      logAction('Starting browser automation...');
      const results = await executeSendNow(config);
      
      // Send progress updates to renderer
      event.sender.send('message-progress', {
        status: 'completed',
        results: results
      });
      
      return {
        success: true,
        results: results
      };
      
    } catch (error) {
      logError(`Error in send-messages-now handler: ${error.message}`, error);
      
      // Send error to renderer
      event.sender.send('message-progress', {
        status: 'error',
        error: error.message
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  });
  
  // Handle schedule message request
  ipcMain.handle('schedule-message', async (event, data) => {
    try {
      const { scheduleMessage } = require('./automation/messaging/scheduler');
      
      const scheduleId = scheduleMessage({
        profileUrls: data.profileUrls,
        message: data.message,
        scheduledTime: data.scheduledTime,
        options: {
          checkHistory: data.checkHistory,
          daysBetweenMessages: data.daysBetweenMessages
        }
      });
      
      return {
        success: true,
        scheduleId: scheduleId
      };
      
    } catch (error) {
      logError(`Error scheduling message: ${error.message}`, error);
      return {
        success: false,
        error: error.message
      };
    }
  });
  
  logAction('Send Now handler initialized');
}

// Initialize on module load
initializeSendNowHandler();

module.exports = {
  initializeSendNowHandler
};