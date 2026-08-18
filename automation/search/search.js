// ============================================
// FILE: search/search.js - FIXED IMPORTS AND TYPING
// ============================================
const { randomDelay } = require('../human/delay');
const { humanScroll } = require('../human/scroll');
const { logAction, logError } = require('../util/log');
const { humanType } = require('../human/typing');
const { moveMouseNaturally } = require('../mouse/move-naturally');
const { stealthClick } = require('../mouse/stealth-click');
const { buildSearchUrl } = require('../helpers/url');
const { isPageOnAuthRedirect } = require('../core/session-state');

/**
 * Main search function for LinkedIn profiles
 * @param {Page} page - Playwright page object
 * @param {string} searchQuery - The search query
 * @returns {Promise<string[]>} - Array of profile URLs
 */
async function searchForProfiles(page, searchQuery, options = {}) {
  try {
    logAction(`Starting search for profiles with query: "${searchQuery}"`);

    if (options.strictStealth === true) {
      const searchOk = await humanLikeSearch(page, searchQuery, options);
      if (!searchOk) {
        return [];
      }
      await randomDelay(3000, 5000);
      await humanScroll(page);
      await randomDelay(2000, 3000);
      const profileUrls = await extractProfileUrls(page);
      logAction(`Found ${profileUrls.length} profiles from strict-stealth search`);
      return profileUrls;
    }

    const searchUrl = buildSearchUrl(searchQuery, 1);
    logAction(`Navigating to: ${searchUrl}`);

    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await randomDelay(3000, 5000);

    // Check if we need to select "People" tab
    const needsPeopleFilter = await page.evaluate(() => {
      const url = window.location.href;
      return !url.includes('/people/');
    });

    if (needsPeopleFilter) {
      logAction('Filtering for People results');

      const peopleFilterClicked = await page.evaluate(() => {
        const peopleButtons = Array.from(document.querySelectorAll('button')).filter(btn => {
          const text = (btn.textContent || '').trim().toLowerCase();
          return text === 'people' || text.includes('people');
        });

        if (peopleButtons.length > 0) {
          peopleButtons[0].click();
          return true;
        }
        return false;
      });

      if (peopleFilterClicked) {
        await randomDelay(2000, 3000);
      }
    }

    await humanScroll(page);
    await randomDelay(2000, 3000);

    const profileUrls = await extractProfileUrls(page);
    logAction(`Found ${profileUrls.length} profiles from search`);

    return profileUrls;
  } catch (error) {
    logError(`Error searching for profiles: ${error.message}`, error);
    return [];
  }
}

async function findFirstVisibleHandle(page, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const handles = await page.$$(selector).catch(() => []);
      for (const handle of handles) {
        try {
          if (await handle.isVisible()) {
            return handle;
          }
        } catch (_) {}
      }
    }

    await page.waitForTimeout(150).catch(() => {});
  }

  return null;
}

async function findPeopleFilterHandle(page, timeoutMs = 5000) {
  const selectorHandle = await findFirstVisibleHandle(page, [
    'button[aria-label*="People"]',
    'button:has-text("People")',
    'button:has-text("See all people results")',
    'a[href*="/search/results/people/"]',
    'a:has-text("People")'
  ], timeoutMs);

  if (selectorHandle) {
    return selectorHandle;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handles = await page.$$('button, a').catch(() => []);
    for (const button of handles) {
      try {
        if (!(await button.isVisible())) {
          continue;
        }

        const text = String((await button.textContent()) || '').trim().toLowerCase();
        const href = String((await button.getAttribute('href')) || '').trim().toLowerCase();
        if (text === 'people' || text.includes('people') || href.includes('/search/results/people/')) {
          return button;
        }
      } catch (_) {}
    }

    await page.waitForTimeout(150).catch(() => {});
  }

  return null;
}

/**
 * Extract profile URLs from current search page
 * @param {Page} page - Playwright page object
 * @returns {Promise<string[]>} - Array of profile URLs
 */
async function extractProfileUrls(page) {
  try {
    await humanScroll(page);

    const profileUrls = await page.evaluate(() => {
      const urls = [];
      const selectors = [
        'a[href*="/in/"]',
        '.entity-result__title-link',
        '.app-aware-link[href*="/in/"]',
        '.search-result__result-link'
      ];

      const foundElements = new Set();

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => {
          if (element.href && element.href.includes('/in/')) {
            const cleanUrl = element.href.split('?')[0];
            if (!foundElements.has(cleanUrl) && cleanUrl.includes('linkedin.com/in/')) {
              urls.push(cleanUrl);
              foundElements.add(cleanUrl);
            }
          }
        });
      }

      const profileContainers = document.querySelectorAll(
        '.entity-result, .search-result, .reusable-search__result-container'
      );

      profileContainers.forEach(container => {
        const link = container.querySelector('a[href*="/in/"]');
        if (link && link.href) {
          const cleanUrl = link.href.split('?')[0];
          if (!foundElements.has(cleanUrl) && cleanUrl.includes('linkedin.com/in/')) {
            urls.push(cleanUrl);
            foundElements.add(cleanUrl);
          }
        }
      });

      return urls;
    });

    return profileUrls;
  } catch (error) {
    logError('Error extracting profile URLs', error);
    return [];
  }
}

/**
 * Human-like search with typing - FIXED VERSION
 * Now ensures Enter submit and People filter if needed.
 * @param {Page} page - Playwright page object
 * @param {string} searchQuery - The search query
 * @returns {Promise<boolean>} - Success status
 */
async function humanLikeSearch(page, searchQuery, options = {}) {
  try {
    logAction(`Starting human-like search for: "${searchQuery}"`);

    await page
      .goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
      .catch(() => logAction('Navigation timeout, continuing anyway'));

    // If LinkedIn redirected to login, the session is expired.
    // Return false so the caller falls through to the direct URL fallback,
    // which has its own auth-redirect guard.
    if (await isPageOnAuthRedirect(page)) {
      logAction('Could not find search bar on feed — session redirected to login page');
      return false;
    }

    await randomDelay(2000, 4000);

    const searchSelectors = [
      'input[placeholder="Search"]',
      'input[placeholder*="looking"]',
      'input[placeholder*="Looking"]',
      'input[aria-label="Search"]',
      '.search-global-typeahead__input',
      '.global-nav__search-input',
      'input[role="combobox"]',
      '.search-box__input',
      'header input[type="text"]',
      'nav input[type="text"]'
    ];

    let searchInputSelector = null;

    for (const selector of searchSelectors) {
      try {
        const exists = (await page.$(selector)) !== null;
        if (exists) {
          searchInputSelector = selector;
          logAction(`Found search bar using selector: ${selector}`);
          break;
        }
      } catch (_) {
        continue;
      }
    }

    if (!searchInputSelector) {
      if (options.strictStealth === true) {
        logAction('Could not find search bar on feed in strict stealth mode; aborting search instead of URL fallback');
        return false;
      }

      logAction('Could not find search bar on feed, falling back to direct people search URL');
      await page.goto(
        `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`,
        {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        }
      );
      await randomDelay(2500, 4500);
      return true;
    }

    // Get the element to move mouse to it
    const searchInput = await page.$(searchInputSelector);
    await moveMouseNaturally(page, searchInput);
    await randomDelay(500, 1500);

    // Click on the search input
    if (options.strictStealth === true) {
      await stealthClick(page, searchInput, options);
    } else {
      await page.click(searchInputSelector);
    }
    await randomDelay(800, 1500);

    // Clear existing text if any
    const currentValue = await page.$eval(searchInputSelector, el => el.value);
    if (currentValue) {
      logAction('Clearing existing search text');
      if (process.platform === 'darwin') {
        await page.keyboard.press('Meta+A');
      } else {
        await page.keyboard.press('Control+A');
      }
      await randomDelay(300, 600);
      await page.keyboard.press('Backspace');
      await randomDelay(500, 800);
    }

    logAction(`Typing search query: "${searchQuery}"`);
    await humanType(page, searchInputSelector, searchQuery);

    await randomDelay(1200, 2500);

    // Submit and wait
    await page.keyboard.press('Enter');
    logAction('Pressed Enter to submit search');

    await randomDelay(3000, 5000);

    const isOnSearchPage = await page.evaluate(() => {
      return (
        window.location.href.includes('/search/results/') ||
        (document.title && document.title.toLowerCase().includes('search')) ||
        document.querySelector('.search-results-container') !== null
      );
    });

    if (!isOnSearchPage) {
      const urlNow = await page.url();
      logAction('Warning: Not on search results page after search. Current URL: ' + urlNow);
    }

    // Ensure we land on People results
    const currentUrl = await page.url();
    if (!currentUrl.includes('/search/results/people/')) {
      logAction('Not on people search page, filtering for People');

      const peopleFilterHandle = await findPeopleFilterHandle(page, 4000);
      const peopleFilterClicked = Boolean(peopleFilterHandle);

      if (peopleFilterHandle) {
        if (options.strictStealth === true) {
          await stealthClick(page, peopleFilterHandle, options);
        } else {
          await peopleFilterHandle.click({ delay: 60 }).catch(() => peopleFilterHandle.click().catch(() => {}));
        }
      }

      if (peopleFilterClicked) {
        await randomDelay(2000, 3000);
        logAction('Clicked People filter');
      } else {
        if (options.strictStealth === true) {
          logAction('Could not find People filter in strict stealth mode; aborting search instead of URL fallback');
          return false;
        }

        // Fallback: navigate directly to people search URL
        await page.goto(
          `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`,
          { waitUntil: 'domcontentloaded' }
        );
        await randomDelay(2000, 3000);
      }
    }

    return true;
  } catch (error) {
    logError(`Error during human-like search: ${error.message}`, error);
    return false;
  }
}

async function findFirstVisibleProfileResult(page, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  const selectors = [
    '.reusable-search__result-container a[href*="/in/"]',
    '.entity-result a[href*="/in/"]',
    '.search-result__result-link[href*="/in/"]',
    'a.app-aware-link[href*="/in/"]',
    'a[href*="/in/"]'
  ];

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        try {
          if (!(await handle.isVisible())) {
            continue;
          }

          const href = await handle.getAttribute('href');
          const cleanUrl = String(href || '').split('?')[0];
          if (!cleanUrl.includes('/in/')) {
            continue;
          }

          return {
            handle,
            href: cleanUrl.startsWith('http') ? cleanUrl : `https://www.linkedin.com${cleanUrl}`
          };
        } catch (_) {
          continue;
        }
      }
    }

    await page.waitForTimeout(200).catch(() => {});
  }

  return null;
}

async function clickSearchResultHandle(page, resultHandle) {
  if (!resultHandle) {
    return false;
  }

  await stealthClick(page, resultHandle);
  await randomDelay(3200, 5200);
  return true;
}

async function searchAndOpenFirstProfile(page, searchQuery, options = {}) {
  const searchOk = await humanLikeSearch(page, searchQuery, {
    ...options,
    strictStealth: true
  });
  if (!searchOk) {
    return null;
  }

  await randomDelay(2500, 4500);
  await humanScroll(page);
  await randomDelay(1500, 2500);

  const firstResult = await findFirstVisibleProfileResult(page, options.timeoutMs || 7000);
  if (!firstResult?.handle) {
    return null;
  }

  const clicked = await clickSearchResultHandle(page, firstResult.handle);
  if (!clicked) {
    return null;
  }

  const currentUrl = typeof page.url === 'function'
    ? await Promise.resolve().then(() => page.url()).catch(() => '')
    : '';
  const profileUrl = String(currentUrl || '').includes('/in/')
    ? currentUrl.split('?')[0]
    : firstResult.href;

  return {
    profileUrl,
    recipientName: deriveRecipientNameFromUrl(profileUrl)
  };
}

function deriveRecipientNameFromUrl(profileUrl) {
  const match = String(profileUrl || '').match(/\/in\/([^/?#]+)/i);
  if (!match || !match[1]) {
    return '';
  }

  return match[1]
    .split('-')
    .filter((part) => part && !/^\d+$/.test(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

module.exports = {
  searchForProfiles,
  extractProfileUrls,
  humanLikeSearch,
  searchAndOpenFirstProfile,
  _private: {
    findFirstVisibleHandle,
    findPeopleFilterHandle
  }
};
