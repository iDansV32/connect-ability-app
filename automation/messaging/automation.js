// messaging/automation.js
const { chromium } = require('playwright');
const { logAction, logError } = require('../util/log');
const { loginToLinkedIn } = require('../core/login');
const { assertLegacyDirectLoginAllowed } = require('../runtime/legacy-direct-login-guard');
const { recordLegacyDirectLoginUsage } = require('../runtime/legacy-direct-login-telemetry');
const { sendLinkedInMessage, sendBulkMessages } = require('./orchestrator');
const scheduler = require('./scheduler');

/**
 * Execute immediate message send
 * @param {Object} config - {
 *   linkedinEmail, linkedinPassword,
 *   profileUrls: string[], message: string,
 *   checkHistory?: boolean, daysBetweenMessages?: number, delayBetweenMessages?: number,
 *   headless?: boolean
 * }
 * @returns {Promise<{sent:number, failed:number, errors?:Array}>}
 */
async function executeSendNow(config) {
  let browser = null;
  let context = null;
  let page = null;

  try {
    assertLegacyDirectLoginAllowed('messaging.executeSendNow', {
      onAllowed: ({ entryPoint }) => recordLegacyDirectLoginUsage({
        entryPoint,
        accountId: config?.accountId || null,
        accountName: config?.accountName || config?.accountEmail || null,
        accountEmail: config?.accountEmail || config?.linkedinEmail || null,
        source: 'messaging.executeSendNow'
      })
    });
    if (config.strictStealth === true) {
      throw new Error('Legacy messaging automation path is not available in strictStealth mode; use the worker-owned runtime path.');
    }

    logAction('Starting immediate message send automation');

    // Launch browser
    browser = await chromium.launch({
      headless: config.headless ?? false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    // Context first; the login flow will open & prepare its own page
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });

    // Login to LinkedIn (returns a logged-in page)
    logAction('Logging into LinkedIn');
    page = await loginToLinkedIn(browser, config.linkedinEmail, config.linkedinPassword);
    if (!page) {
      throw new Error('Failed to login to LinkedIn (no page returned)');
    }

    // Send messages
    const results = await sendBulkMessages(
      page,
      config.profileUrls,
      config.message,
      {
        checkHistory: !!config.checkHistory,
        daysBetweenMessages: config.daysBetweenMessages || 7,
        delayBetweenMessages: config.delayBetweenMessages || 30000
      }
    );

    logAction(`Message automation complete: ${results.sent} sent, ${results.failed} failed`);
    return results;

  } catch (error) {
    logError(`Error in executeSendNow: ${error.message}`, error);
    throw error;
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
}

/**
 * Search for profile and send message
 * @param {Object} config - {
 *   linkedinEmail, linkedinPassword,
 *   searchName: string,
 *   message: string,
 *   headless?: boolean,
 *   options?: object
 * }
 * @returns {Promise<Object>} - Result from sendLinkedInMessage
 */
async function searchAndMessage(config) {
  let browser = null;
  let context = null;
  let page = null;

  try {
    assertLegacyDirectLoginAllowed('messaging.searchAndMessage', {
      onAllowed: ({ entryPoint }) => recordLegacyDirectLoginUsage({
        entryPoint,
        accountId: config?.accountId || null,
        accountName: config?.accountName || config?.accountEmail || null,
        accountEmail: config?.accountEmail || config?.linkedinEmail || null,
        source: 'messaging.searchAndMessage'
      })
    });
    if (config.strictStealth === true) {
      throw new Error('Legacy messaging automation path is not available in strictStealth mode; use the worker-owned runtime path.');
    }

    logAction(`Starting search and message for: ${config.searchName}`);

    // Launch browser
    browser = await chromium.launch({
      headless: config.headless ?? false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });

    // Reuse the hardened login flow for consistency
    page = await loginToLinkedIn(browser, config.linkedinEmail, config.linkedinPassword);

    // Search for profile
    const { searchForProfiles } = require('../search/search');
    const profiles = await searchForProfiles(page, config.searchName);

    if (profiles.length === 0) {
      throw new Error(`No profiles found for: ${config.searchName}`);
    }

    // Take first profile
    const targetProfile = profiles[0];
    logAction(`Found profile: ${targetProfile}`);

    // Send message
    const result = await sendLinkedInMessage(
      page,
      targetProfile,
      config.message,
      config.options
    );

    return result;

  } catch (error) {
    logError(`Error in searchAndMessage: ${error.message}`, error);
    throw error;
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
}

/**
 * Initialize scheduled message processing
 * @param {Object} config - shared config for sending (login creds, delays, etc.)
 */
function initializeScheduledMessaging(config) {
  // Start/init scheduler
  if (typeof scheduler.init === 'function') {
    scheduler.init(); // new API
  } else if (typeof scheduler.start === 'function') {
    scheduler.start(); // legacy wrapper
  }

  // Listen for scheduled messages that are ready
  scheduler.on('schedule-ready', async (schedule) => {
    logAction(`Processing scheduled message ${schedule.id}`);

    try {
      const results = await executeSendNow({
        ...config,
        profileUrls: schedule.profileUrls,
        message: schedule.message,
        ...schedule.options
      });

      logAction(`Scheduled message ${schedule.id} completed: ${results.sent} sent, ${results.failed} failed`);

      // Mark status on success (treat partial success as 'sent' since we attempted the job)
      if (typeof scheduler.markStatus === 'function') {
        scheduler.markStatus(schedule.id, 'sent');
      }
    } catch (error) {
      logError(`Failed to process scheduled message ${schedule.id}: ${error.message}`, error);
      if (typeof scheduler.markStatus === 'function') {
        scheduler.markStatus(schedule.id, 'failed');
      }
    }
  });

  // Clean up old schedules daily
  setInterval(() => {
    try {
      // new API signature: { keepDays }
      if (typeof scheduler.cleanupOldSchedules === 'function') {
        scheduler.cleanupOldSchedules({ keepDays: 30 });
      }
    } catch (e) {
      logError(`cleanupOldSchedules failed: ${e.message}`, e);
    }
  }, 24 * 60 * 60 * 1000);

  logAction('Scheduled messaging initialized');
}

/**
 * Main message automation runner
 * @param {Object} config - see executeSendNow config
 * @returns {Promise<Object>} - results or scheduling info
 */
async function runMessageAutomation(config) {
  try {
    if (config.scheduledTime) {
      // Schedule for later
      const scheduleId =
        typeof scheduler.scheduleMessage === 'function'
          ? scheduler.scheduleMessage(
              {
                profileUrls: config.profileUrls,
                message: config.message,
                scheduledTime: config.scheduledTime,
                options: {
                  checkHistory: config.checkHistory,
                  daysBetweenMessages: config.daysBetweenMessages,
                  delayBetweenMessages: config.delayBetweenMessages
                }
              },
              /* sendNow */ false
            )
          : // Legacy path
            await scheduler.add({
              when: config.scheduledTime,
              profileIds: config.profileUrls,
              message: config.message,
              meta: {
                checkHistory: config.checkHistory,
                daysBetweenMessages: config.daysBetweenMessages,
                delayBetweenMessages: config.delayBetweenMessages
              }
            });

      return {
        success: true,
        scheduled: true,
        scheduleId,
        scheduledTime: config.scheduledTime
      };
    } else {
      // Send now
      return await executeSendNow(config);
    }
  } catch (error) {
    logError(`Error in runMessageAutomation: ${error.message}`, error);
    throw error;
  }
}

module.exports = {
  executeSendNow,
  searchAndMessage,
  initializeScheduledMessaging,
  runMessageAutomation
};
