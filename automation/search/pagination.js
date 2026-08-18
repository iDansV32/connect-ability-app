// search/pagination.js
const { randomDelay } = require('../human/delay');
const { humanScroll } = require('../human/scroll');
const { logAction, logError } = require('../util/log');
const { extractProfileUrls, humanLikeSearch } = require('./search');
const { directSearchTyping } = require('./advanced');
const { hasProfileBeenProcessed, markProfileAsProcessed } = require('../profile/process');
const { backupProfileData } = require('../profile/storage');
const { isPageOnAuthRedirect } = require('../core/session-state');
const path = require('path');
const fs = require('fs');

/**
 * Enhanced search function with pagination support
 * @param {Page} page - Playwright page object
 * @param {string} searchQuery - The search query to type
 * @param {number} maxPages - Maximum number of pages to process (default: 3)
 * @returns {Promise<string[]>} - Array of profile URLs
 */
async function searchForProfilesWithPagination(page, searchQuery, maxPages = 3) {
  logAction(`Starting enhanced search for: "${searchQuery}" with pagination support (max ${maxPages} pages)`);

  let allProfileUrls = [];
  let currentPage = 1;
  let hasMorePages = true;

  try {
    await backupProfileData();

    // Use human-like search for the initial query
    const searchSuccess = await humanLikeSearch(page, searchQuery);
    let isOnSearchResults = await page.evaluate(() => {
      return (
        window.location.href.includes('/search/results/') ||
        (document.title && document.title.toLowerCase().includes('search'))
      );
    }).catch(() => false);

    if (!searchSuccess || !isOnSearchResults) {
      logAction('Primary search flow did not land on results, trying advanced search fallback');
      const advancedSearchSuccess = await directSearchTyping(page, searchQuery);
      isOnSearchResults = advancedSearchSuccess && await page.evaluate(() => {
        return window.location.href.includes('/search/results/');
      }).catch(() => false);
    }

    if (!isOnSearchResults) {
      logAction('Search typing failed, falling back to direct URL navigation');
      await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    } else {
      const currentUrl = await page.url();
      if (!currentUrl.includes('/search/results/people/')) {
        await directSearchTyping(page, searchQuery);
      }
    }

    // Guard: if LinkedIn redirected to a login/checkpoint page, the session
    // is expired and search results will be empty.  Abort early with a clear
    // error rather than silently returning 0 profiles.
    if (await isPageOnAuthRedirect(page)) {
      const authUrl = page.url();
      logError(`Session expired during search — redirected to ${authUrl}. Search cannot proceed.`);
      throw new Error(
        `LinkedIn session expired during search (redirected to login page). ` +
        `Please re-authenticate the account and try again.`
      );
    }

    await randomDelay(2000, 3000);
    await humanScroll(page);

    // Process pages until we hit maxPages or run out of results
    while (hasMorePages && currentPage <= maxPages) {
      logAction(`Processing search results page ${currentPage} for "${searchQuery}"`);

      // Take a screenshot for debugging
      try {
        const userHome = process.env.HOME || process.env.USERPROFILE;
        const screenshotPath = path.join(
          userHome,
          'Documents',
          'Connect-Ability',
          `search-page-${currentPage}-${Date.now()}.png`
        );
        await page.screenshot({ path: screenshotPath });
        logAction(`Saved search page screenshot to ${screenshotPath}`);
      } catch (e) {
        // Continue even if screenshot fails
      }

      // Extract profile URLs from the current page
      const profileUrls = await extractProfileUrls(page);
      logAction(`Found ${profileUrls.length} profiles on page ${currentPage}`);

      // Filter out already processed profiles
      const newProfileUrls = [];
      let alreadyProcessedCount = 0;

      for (const url of profileUrls) {
        const processed = await hasProfileBeenProcessed(url);
        if (processed) {
          alreadyProcessedCount++;
        } else {
          newProfileUrls.push(url);
        }
      }

      logAction(
        `Found ${newProfileUrls.length} new profiles on page ${currentPage} (filtered ${alreadyProcessedCount} previously processed profiles)`
      );

      // Add new URLs to our collection
      allProfileUrls = [...allProfileUrls, ...newProfileUrls];

      // Check if we have a "Next" button to click
      const hasNextPage = await checkForNextPage(page);

      // If we have more pages and we're under the max, go to the next page
      if (hasNextPage && currentPage < maxPages) {
        const navigated = await goToNextPage(page, currentPage);

        if (navigated) {
          currentPage++;
          await humanScroll(page);
        } else {
          logAction(`Could not navigate to next page, ending search at page ${currentPage}`);
          hasMorePages = false;
        }
      } else {
        logAction(`No more pages available or reached max page limit (${maxPages})`);
        hasMorePages = false;
      }
    }

    await backupProfileData();

    logAction(`Search completed. Found ${allProfileUrls.length} new profiles across ${currentPage} pages`);
    return allProfileUrls;
  } catch (error) {
    logError(`Error in enhanced search: ${error.message}`, error);
    return allProfileUrls; // Return whatever we've collected so far
  }
}

/**
 * Check if there's a next page available
 * @param {Page} page - Playwright page object
 * @returns {Promise<boolean>} - Whether next page exists
 */
async function checkForNextPage(page) {
  return await page.evaluate(() => {
    // Try to find the next page button with multiple approaches

    // Method 1: Look for buttons with "Next" text
    const nextButtons = Array.from(document.querySelectorAll('button, a')).filter(el => {
      const text = (el.textContent || '').trim().toLowerCase();
      return (text === 'next' || text.includes('next')) && !el.disabled;
    });

    if (nextButtons.length > 0) {
      return true;
    }

    // Method 2: Look for aria-label attributes
    const ariaButtons = Array.from(document.querySelectorAll('[aria-label*="Next"]')).filter(el => !el.disabled);
    if (ariaButtons.length > 0) {
      return true;
    }

    // Method 3: Look for pagination elements with arrow icons
    const paginationElements = document.querySelectorAll('.artdeco-pagination__button--next');
    if (paginationElements.length > 0) {
      const isDisabled =
        paginationElements[0].hasAttribute('disabled') ||
        paginationElements[0].classList.contains('artdeco-button--disabled');

      if (!isDisabled) {
        return true;
      }
    }

    return false;
  });
}

/**
 * Navigate to the next page of search results
 * @param {Page} page - Playwright page object
 * @param {number} currentPage - Current page number
 * @returns {Promise<boolean>} - Whether navigation succeeded
 */
async function goToNextPage(page, currentPage) {
  try {
    logAction(`Navigating to search results page ${currentPage + 1}`);

    // Click the next button
    const clicked = await page.evaluate(() => {
      // Try text-based buttons first
      const nextButtons = Array.from(document.querySelectorAll('button, a')).filter(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return (text === 'next' || text.includes('next')) && !el.disabled;
      });

      if (nextButtons.length > 0) {
        nextButtons[0].click();
        return true;
      }

      // Then try aria-label
      const ariaButtons = Array.from(document.querySelectorAll('[aria-label*="Next"]')).filter(el => !el.disabled);
      if (ariaButtons.length > 0) {
        ariaButtons[0].click();
        return true;
      }

      // Try pagination class
      const paginationNext = document.querySelector('.artdeco-pagination__button--next:not([disabled])');
      if (paginationNext) {
        paginationNext.click();
        return true;
      }

      return false;
    });

    if (!clicked) {
      return false;
    }

    // Wait for new page to load
    await randomDelay(3000, 5000);

    // Verify page actually changed
    const pageChanged = await page.evaluate(currentPg => {
      // Check current URL for page number
      const currentUrl = window.location.href;
      const pageParam = currentUrl.match(/page=(\d+)/);

      if (pageParam && pageParam[1] && parseInt(pageParam[1]) > currentPg) {
        return true;
      }

      // Check pagination indicators
      const paginationTexts = Array.from(
        document.querySelectorAll('.artdeco-pagination__indicator--number, [data-test-pagination-page-btn]')
      ).map(el => (el.textContent || '').trim());

      return paginationTexts.some(text => parseInt(text) > currentPg);
    }, currentPage);

    return pageChanged;
  } catch (error) {
    logError(`Error navigating to next page: ${error.message}`, error);
    return false;
  }
}

module.exports = {
  searchForProfilesWithPagination,
  checkForNextPage,
  goToNextPage
};
