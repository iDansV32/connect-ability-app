// messaging/navigator.js
const { logAction, logError } = require('../util/log');
const { randomDelay, getTypingDelay } = require('../human/delay');
const { humanScroll } = require('../human/scroll');
const { moveMouseNaturally } = require('../mouse/move-naturally');
const { stealthClick } = require('../mouse/stealth-click');

/**
 * Navigate to LinkedIn profile
 * @param {Page} page - Playwright page object
 * @param {string} profileUrl - LinkedIn profile URL
 * @returns {Promise<boolean>} - Success status
 */
async function navigateToProfile(page, profileUrl) {
  try {
    logAction(`Navigating to profile: ${profileUrl}`);
    
    await page.goto(profileUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    
    await randomDelay(2000, 3000);
    await humanScroll(page);
    
    return true;
  } catch (error) {
    logError(`Failed to navigate to profile: ${error.message}`, error);
    return false;
  }
}

/**
 * Open messaging interface for current profile
 * @param {Page} page - Playwright page object
 * @returns {Promise<boolean>} - Success status
 */
async function openMessageInterface(page, options = {}) {
  try {
    logAction('Opening message interface');
    
    // Check if already in messaging
    const isOpen = await page.$('.msg-overlay-conversation-bubble, .msg-conversations-container');
    if (isOpen) {
      logAction('Message interface already open');
      return true;
    }
    
    // Find and click message button
    const messageButtonSelectors = [
      'button[aria-label*="Message"]',
      'a[aria-label*="Message"]',
      'button:has-text("Message")',
      '.pvs-profile-actions button[aria-label*="Message"]',
      '.pv-top-card-v2-ctas button[aria-label*="Message"]'
    ];
    
    for (const selector of messageButtonSelectors) {
      const button = await page.$(selector);
      if (button) {
        await clickMessageButtonWithoutPopup(page, button, options);
        logAction('Clicked message button');
        return true;
      }
    }
    
    logError('Could not find message button');
    return false;
  } catch (error) {
    logError(`Failed to open message interface: ${error.message}`, error);
    return false;
  }
}

/**
 * LinkedIn occasionally opens /messaging/ in a browser tab while also opening
 * the profile-page composer. A DM action should stay on its profile page, so
 * close only popups spawned by this page during the Message-button click.
 * Existing tabs and pages created by other worker features are left alone.
 */
async function clickMessageButtonWithoutPopup(page, button, options = {}) {
  const popupClosePromises = [];
  const closePopup = (popup) => {
    if (!popup || popup === page || typeof popup.close !== 'function') return;
    popupClosePromises.push(
      popup.close()
        .then(() => logAction('Closed unexpected messaging popup tab'))
        .catch((error) => logError(`Failed closing unexpected messaging popup tab: ${error.message}`, error))
    );
  };

  const canWatchPopups = page && typeof page.on === 'function' && typeof page.off === 'function';
  if (canWatchPopups) {
    page.on('popup', closePopup);
  }

  try {
    if (options.strictStealth === true) {
      await stealthClick(page, button);
    } else {
      await button.click();
    }
    await randomDelay(1500, 2500);
    await Promise.allSettled(popupClosePromises);
  } finally {
    if (canWatchPopups) {
      page.off('popup', closePopup);
    }
  }
}

/**
 * Explicit alias for opening DM UI on a profile.
 * Kept for clarity where flows refer to "DM tab".
 */
async function openDMTab(page) {
  return openMessageInterface(page);
}

/**
 * Navigate to messaging center
 * @param {Page} page - Playwright page object
 * @returns {Promise<boolean>} - Success status
 */
async function navigateToMessagingCenter(page) {
  try {
    logAction('Navigating to messaging center');
    
    const messagingUrl = 'https://www.linkedin.com/messaging/';
    await page.goto(messagingUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    
    await randomDelay(2000, 3000);
    return true;
  } catch (error) {
    logError(`Failed to navigate to messaging center: ${error.message}`, error);
    return false;
  }
}

/**
 * Search for conversation by profile name
 * @param {Page} page - Playwright page object
 * @param {string} profileName - Name to search for
 * @returns {Promise<boolean>} - Success status
 */
async function searchForConversation(page, profileName, options = {}) {
  try {
    logAction(`Searching for conversation with: ${profileName}`);
    
    // Find search input
    const searchSelectors = [
      'input[placeholder*="Search messages"]',
      '.msg-search-form__input',
      'input[type="search"]'
    ];
    
    for (const selector of searchSelectors) {
      const searchInput = await page.$(selector);
      if (searchInput) {
        if (options.strictStealth === true) {
          await stealthClick(page, searchInput, options);
        } else {
          await searchInput.click();
        }
        await searchInput.fill('');
        await searchInput.type(profileName, { delay: 50 });
        await randomDelay(1000, 2000);
        
        // Click on first result
        const firstResult = await page.$('.msg-conversation-listitem:first-child');
        if (firstResult) {
          if (options.strictStealth === true) {
            await stealthClick(page, firstResult, options);
          } else {
            await firstResult.click();
          }
          await randomDelay(1000, 2000);
          return true;
        }
      }
    }
    
    return false;
  } catch (error) {
    logError(`Failed to search for conversation: ${error.message}`, error);
    return false;
  }
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function clickHandleHumanized(page, handle, label, options = {}) {
  if (!handle) return false;
  try {
    if (options.strictStealth === true) {
      await stealthClick(page, handle, options);
    } else {
      await moveMouseNaturally(page, handle);
      await randomDelay(140, 420);
      await handle.click({ delay: 30 + Math.floor(Math.random() * 90) });
    }
    await randomDelay(300, 900);
    if (label) {
      logAction(`Clicked ${label}`);
    }
    return true;
  } catch (error) {
    logError(`Failed clicking ${label || 'element'}: ${error.message}`, error);
    return false;
  }
}

async function findVisibleHandle(page, selectors = []) {
  for (const selector of selectors) {
    const handles = await page.$$(selector);
    for (const handle of handles) {
      try {
        if (await handle.isVisible()) {
          return { handle, selector };
        }
      } catch (_) {}
    }
  }
  return null;
}

async function openMessagingDrawer(page, options = {}) {
  try {
    if (!String(await page.url()).includes('linkedin.com')) {
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await randomDelay(1800, 2600);
    }

    const drawerSearchSelectors = [
      '.msg-overlay-list-bubble input[placeholder*="Search messages"]',
      '.msg-overlay-list-bubble input[aria-label*="Search messages"]',
      '.msg-overlay-list-bubble input.msg-search-form__input',
      '.msg-overlay-list-bubble input[type="text"]',
      'input[placeholder*="Search messages"]',
      'input[aria-label*="Search messages"]',
      'input.msg-search-form__input'
    ];

    const existingSearch = await findVisibleHandle(page, drawerSearchSelectors);
    if (existingSearch) {
      return true;
    }

    const openDrawerSelectors = [
      'section.msg-overlay-list-bubble',
      '.msg-overlay-list-bubble',
      '.msg-overlay-list-bubble-header',
      '.msg-overlay-bubble-header',
      'button.msg-overlay-bubble-header__control',
      'button.msg-overlay-bubble-header__dropdown-trigger',
      'header.msg-overlay-bubble-header',
      'div.msg-overlay-bubble-header',
      'button[aria-label*="Open messaging"]',
      'button[aria-label*="Messaging"]',
      'button[aria-label="Messaging"]'
    ];

    // Wait/poll a bit because LinkedIn injects the drawer after initial paint.
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      const ready = await findVisibleHandle(page, drawerSearchSelectors);
      if (ready) return true;

      const opener = await findVisibleHandle(page, openDrawerSelectors);
      if (opener) {
        const clicked = await clickHandleHumanized(page, opener.handle, 'Messaging drawer');
        if (clicked) {
          await randomDelay(900, 1700);
          const searchReady = await findVisibleHandle(page, drawerSearchSelectors);
          if (searchReady) return true;
        }
      }

      // Heuristic fallback: click any bottom-right "Messaging" launcher.
      if (options.strictStealth !== true) {
        const clickedByHeuristic = await page.evaluate(() => {
          const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const candidates = Array.from(document.querySelectorAll('button, a, div, header, section'));
          const target = candidates.find((el) => {
            const text = norm(el.textContent);
            if (!text || !text.includes('messaging')) return false;
            const rect = el.getBoundingClientRect();
            if (!rect || rect.width < 30 || rect.height < 20) return false;
            const nearBottom = rect.bottom >= window.innerHeight - 260;
            const nearRight = rect.right >= window.innerWidth - 520;
            const style = window.getComputedStyle(el);
            const visible = style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            return nearBottom && nearRight && visible;
          });
          if (target) {
            target.click();
            return true;
          }
          return false;
        });

        if (clickedByHeuristic) {
          logAction('Clicked messaging drawer opener via bottom-right heuristic');
          await randomDelay(900, 1800);
          const searchReady = await findVisibleHandle(page, drawerSearchSelectors);
          if (searchReady) return true;
        }
      }

      await randomDelay(350, 700);
    }
    logError('Could not locate LinkedIn messaging drawer opener');
    return false;
  } catch (error) {
    logError(`Failed to open messaging drawer: ${error.message}`, error);
    return false;
  }
}

async function typeIntoDrawerSearch(page, recipientName, options = {}) {
  const searchSelectors = [
    '.msg-overlay-list-bubble input[placeholder*="Search messages"]',
    '.msg-overlay-list-bubble input[aria-label*="Search messages"]',
    '.msg-overlay-list-bubble input.msg-search-form__input',
    '.msg-overlay-list-bubble input[type="text"]'
  ];

  const searchTarget = await findVisibleHandle(page, searchSelectors);
  if (!searchTarget) {
    return false;
  }

  await clickHandleHumanized(page, searchTarget.handle, 'message search input', options);

  if (process.platform === 'darwin') {
    await page.keyboard.press('Meta+A');
  } else {
    await page.keyboard.press('Control+A');
  }
  await randomDelay(120, 240);
  await page.keyboard.press('Backspace');
  await randomDelay(220, 520);

  for (const char of String(recipientName || '')) {
    await page.keyboard.type(char);
    await page.waitForTimeout(getTypingDelay());
    if (Math.random() < 0.14) {
      await randomDelay(60, 220);
    }
  }

  await randomDelay(900, 1600);
  return true;
}

async function selectConversationFromDrawer(page, recipientName, options = {}) {
  const normalizedTarget = normalizeName(recipientName);
  const conversationSelectors = [
    '.msg-overlay-list-bubble .msg-conversation-listitem',
    '.msg-overlay-list-bubble li.msg-conversations-container__convo-item',
    '.msg-overlay-list-bubble .msg-conversations-container__convo-item-container',
    '.msg-overlay-list-bubble [role="option"]',
    '.msg-overlay-list-bubble .artdeco-typeahead__result',
    '.msg-overlay-list-bubble .msg-conversations-container__message-snippet-listitem'
  ];

  const initialWait = 5000 + Math.floor(Math.random() * 20001);
  logAction(`Waiting ${Math.round(initialWait / 1000)}s for message search results to load`);
  await randomDelay(initialWait, initialWait);

  let conversations = [];
  const startedAt = Date.now();
  const maxWaitMs = 20000;

  while (Date.now() - startedAt < maxWaitMs) {
    conversations = [];
    for (const selector of conversationSelectors) {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        try {
          if (await handle.isVisible()) {
            conversations.push(handle);
          }
        } catch (_) {}
      }
      if (conversations.length) break;
    }
    if (conversations.length) break;
    await randomDelay(500, 1200);
  }

  if (!conversations.length) {
    // Last-resort: use keyboard selection on search suggestions.
    await page.keyboard.press('ArrowDown').catch(() => {});
    await randomDelay(180, 420);
    await page.keyboard.press('Enter').catch(() => {});
    await randomDelay(700, 1400);
    const openedByKeyboard = await page.$(
      '.msg-overlay-conversation-bubble, .msg-s-message-list-container, .msg-form__contenteditable'
    );
    return !!openedByKeyboard;
  }

  let bestMatch = null;
  for (const convo of conversations) {
    try {
      const text = normalizeName(await convo.innerText());
      if (!text) continue;
      if (text.includes(normalizedTarget)) {
        bestMatch = convo;
        break;
      }
    } catch (_) {}
  }

  const chosen = bestMatch || conversations[0];
  return clickHandleHumanized(page, chosen, `conversation for "${recipientName}"`, options);
}

async function openDrawerConversation(page, recipientName, options = {}) {
  try {
    logAction(`Opening drawer conversation for "${recipientName}"`);

    const opened = await openMessagingDrawer(page, options);
    if (!opened) {
      return false;
    }

    const typed = await typeIntoDrawerSearch(page, recipientName, options);
    if (!typed) {
      logError('Could not type recipient name into messaging search');
      return false;
    }

    const selected = await selectConversationFromDrawer(page, recipientName, options);
    if (!selected) {
      logError(`No conversation found for "${recipientName}"`);
      return false;
    }

    await randomDelay(700, 1400);
    return true;
  } catch (error) {
    logError(`Failed to open drawer conversation: ${error.message}`, error);
    return false;
  }
}

module.exports = {
  navigateToProfile,
  openMessageInterface,
  openDMTab,
  navigateToMessagingCenter,
  searchForConversation,
  openMessagingDrawer,
  openDrawerConversation
};
