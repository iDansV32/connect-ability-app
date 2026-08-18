const fs = require('fs');
const path = require('path');
const { randomDelay } = require('../human/delay');
const { humanScroll } = require('../human/scroll');
const { logAction, logError } = require('../util/log');
const {
  ensureDirectoryExists,
  getConnectAbilityDocumentsDir
} = require('../../connect-documents');

const SEARCH_INPUT_SELECTORS = [
  'input[placeholder="Search"]',
  'input[aria-label="Search"]',
  '.search-global-typeahead__input',
  '.global-nav__search-input',
  'input[role="combobox"]',
  '.search-box__input'
];

const SEARCH_TRIGGER_SELECTORS = [
  '.search-global-typeahead',
  '.global-nav__search',
  'button[aria-label="Search"]',
  '.search-box'
];

function getSearchDebugDir() {
  const debugDir = path.join(getConnectAbilityDocumentsDir(), 'debug');
  ensureDirectoryExists(debugDir);
  return debugDir;
}

async function captureDebugScreenshot(page, debugDir, label) {
  try {
    const filePath = path.join(debugDir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: filePath });
    return filePath;
  } catch (error) {
    logAction(`Skipping debug screenshot "${label}": ${error.message}`);
    return null;
  }
}

async function ensurePeopleResultsPage(page, searchQuery) {
  const currentUrl = await page.url();
  if (currentUrl.includes('/search/results/people/')) {
    return true;
  }

  const peopleFilterClicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, a')).filter((element) => {
      const text = (element.textContent || '').trim().toLowerCase();
      return text === 'people' || text === 'see all people results';
    });

    if (candidates.length === 0) {
      return false;
    }

    candidates[0].click();
    return true;
  }).catch(() => false);

  if (peopleFilterClicked) {
    logAction('Filtering for People results');
    await page.waitForTimeout(2000);
  }

  const filteredUrl = await page.url();
  if (filteredUrl.includes('/search/results/people/')) {
    return true;
  }

  await page.goto(
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`,
    {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }
  );
  await page.waitForTimeout(3000);
  return true;
}

async function directSearchTyping(page, searchQuery) {
  try {
    logAction(`Starting direct search for: "${searchQuery}"`);

    const debugDir = getSearchDebugDir();

    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(e => logAction('Navigation timeout, continuing anyway'));

    await page.waitForTimeout(3000);
    await captureDebugScreenshot(page, debugDir, 'before-search');

    let searchSuccess = false;

    for (const selector of SEARCH_INPUT_SELECTORS) {
      try {
        const exists = await page.$(selector) !== null;

        if (exists) {
          await page.click(selector);
          await page.waitForTimeout(1000);
          await page.evaluate((sel) => {
            document.querySelector(sel).value = '';
          }, selector);
          await page.waitForTimeout(500);
          await page.type(selector, searchQuery, { delay: 100 });
          await page.waitForTimeout(1000);
          await page.keyboard.press('Enter');

          logAction(`Typed search query using selector: ${selector}`);
          searchSuccess = true;
          break;
        }
      } catch (e) {
        logAction(`Failed with selector ${selector}: ${e.message}`);
      }
    }

    if (!searchSuccess) {
      logAction('Direct typing failed, trying keyboard shortcut');
      try {
        await page.keyboard.press('/');
        await page.waitForTimeout(1000);
        await captureDebugScreenshot(page, debugDir, 'after-shortcut');
        await page.keyboard.type(searchQuery, { delay: 100 });
        await page.waitForTimeout(1000);
        await page.keyboard.press('Enter');
        searchSuccess = true;
      } catch (error) {
        logAction(`Keyboard shortcut search failed: ${error.message}`);
      }
    }

    if (!searchSuccess) {
      logAction('Trying to click search trigger first');
      for (const selector of SEARCH_TRIGGER_SELECTORS) {
        try {
          const exists = await page.$(selector) !== null;
          if (!exists) continue;

          await page.click(selector);
          await page.waitForTimeout(1000);
          await page.keyboard.type(searchQuery, { delay: 100 });
          await page.waitForTimeout(1000);
          await page.keyboard.press('Enter');
          logAction(`Search via trigger click completed using: ${selector}`);
          searchSuccess = true;
          break;
        } catch (error) {
          logAction(`Search trigger ${selector} failed: ${error.message}`);
        }
      }
    }

    await page.waitForTimeout(3000);
    await captureDebugScreenshot(page, debugDir, 'after-search');

    const isOnSearchPage = await page.evaluate(() => {
      return (
        window.location.href.includes('/search/results/') ||
        (document.title && document.title.toLowerCase().includes('search'))
      );
    }).catch(() => false);

    if (!isOnSearchPage) {
      logAction(`Not on search results page. Current URL: ${await page.url()}`);
      await page.goto(
        `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`,
        {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        }
      );
      await page.waitForTimeout(3000);
      await captureDebugScreenshot(page, debugDir, 'direct-navigation');
    }

    await ensurePeopleResultsPage(page, searchQuery);
    return true;
  } catch (error) {
    logError(`Error in direct search typing: ${error.message}`, error);
    return false;
  }
}

async function debugSearchBar(page, searchQuery = "test search") {
  try {
    logAction('Starting search bar debugging');

    const debugDir = getSearchDebugDir();

    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    await page.waitForTimeout(3000);

    await captureDebugScreenshot(page, debugDir, 'search-debug-initial');

    const searchElements = await page.evaluate((selectors) => {
      const results = [];

      selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          Array.from(elements).forEach((el, index) => {
            results.push({
              selector,
              index,
              visible: el.offsetWidth > 0 && el.offsetHeight > 0,
              disabled: el.disabled,
              readonly: el.readOnly,
              tag: el.tagName,
              type: el.type || 'unknown',
              placeholder: el.placeholder || 'none',
              ariaLabel: el.getAttribute('aria-label') || 'none',
              classes: el.className
            });
          });
        }
      });
      
      const allInputs = document.querySelectorAll('input');
      const inputInfo = Array.from(allInputs).map((el, index) => ({
        index,
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
        disabled: el.disabled,
        readonly: el.readOnly,
        tag: el.tagName,
        type: el.type || 'unknown',
        placeholder: el.placeholder || 'none',
        ariaLabel: el.getAttribute('aria-label') || 'none',
        classes: el.className
      }));
      
      return {
        matchedElements: results,
        allInputs: inputInfo
      };
    }, SEARCH_INPUT_SELECTORS);
    
    fs.writeFileSync(
      path.join(debugDir, 'search-elements.json'),
      JSON.stringify(searchElements, null, 2)
    );

    let focusedElement = null;
    if (searchElements.matchedElements.length === 0) {
      await page.keyboard.press('/');
      await page.waitForTimeout(1000);
      await captureDebugScreenshot(page, debugDir, 'search-after-shortcut');
      focusedElement = await page.evaluate(() => {
        const active = document.activeElement;
        return {
          isFocused: Boolean(active && active.tagName === 'INPUT'),
          tagName: active?.tagName || null,
          type: active?.type || null,
          placeholder: active?.placeholder || null,
          ariaLabel: active?.getAttribute?.('aria-label') || null
        };
      }).catch(() => null);

      fs.writeFileSync(
        path.join(debugDir, 'focused-element.json'),
        JSON.stringify(focusedElement, null, 2)
      );

      if (focusedElement?.isFocused) {
        await page.keyboard.type(searchQuery, { delay: 150 });
        await page.waitForTimeout(1000);
        await captureDebugScreenshot(page, debugDir, 'search-after-typing');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
        await captureDebugScreenshot(page, debugDir, 'search-after-enter');
      }
    } else {
      const selectorUnderTest = searchElements.matchedElements[0].selector;
      await page.click(selectorUnderTest);
      await page.waitForTimeout(1000);
      await captureDebugScreenshot(page, debugDir, 'before-search-click');

      await page.type(selectorUnderTest, searchQuery, { delay: 150 });
      await page.waitForTimeout(1000);
      await captureDebugScreenshot(page, debugDir, 'after-type-method');

      await page.click(selectorUnderTest, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(1000);

      await page.keyboard.type(searchQuery, { delay: 150 });
      await page.waitForTimeout(1000);
      await captureDebugScreenshot(page, debugDir, 'after-keyboard-type');

      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
      await captureDebugScreenshot(page, debugDir, 'search-after-enter');
    }

    logAction(`Found ${searchElements.matchedElements.length} search-specific elements`);

    return {
      elementsFound: searchElements.matchedElements.length > 0,
      finalUrl: await page.url(),
      focusedElement,
      debugDir
    };
  } catch (error) {
    logError(`Search debugging failed: ${error.message}`, error);
    return { error: error.message };
  }
}

async function goToNextSearchPage(page, currentPage) {
  try {
    logAction(`Attempting to navigate to search results page ${currentPage + 1}`);
    
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight * 0.8);
    });
    
    await randomDelay(1000, 2000);
    
    const hasNextPage = await page.evaluate((currentPg) => {
      const paginationArea = document.querySelector('.artdeco-pagination, .search-results__pagination');
      if (!paginationArea) return false;
      
      const nextButtons = Array.from(document.querySelectorAll('button, li, a'))
        .filter(el => {
          const text = el.textContent.trim().toLowerCase();
          return (text === 'next' || text.includes('next')) && 
                 !el.disabled && 
                 !el.parentElement.classList.contains('disabled');
        });
      
      if (nextButtons.length > 0) {
        nextButtons[0].click();
        return true;
      }
      
      const nextPageButton = document.querySelector(`[aria-label="Page ${currentPg + 1}"]`);
      if (nextPageButton) {
        nextPageButton.click();
        return true;
      }
      
      const ariaNextButton = document.querySelector('[aria-label*="Next"], [aria-label*="next"]');
      if (ariaNextButton && !ariaNextButton.disabled) {
        ariaNextButton.click();
        return true;
      }
      
      return false;
    }, currentPage);
    
    if (hasNextPage) {
      await randomDelay(3000, 5000);
      return true;
    }
    
    return false;
  } catch (error) {
    logError(`Error navigating to next search page: ${error.message}`, error);
    return false;
  }
}

async function browseProfilesFromSearchResults(page, searchQuery, maxProfiles = 10, config) {
  try {
    logAction(`Starting human-like profile browsing for: "${searchQuery}"`);
    
    const { humanLikeSearch } = require('./search');
    await humanLikeSearch(page, searchQuery);
    await randomDelay(2000, 4000);
    
    let processedCount = 0;
    const processedProfiles = new Set();
    let currentPage = 1;
    
    while (processedCount < maxProfiles) {
      logAction(`On search results page ${currentPage}, processed ${processedCount}/${maxProfiles} profiles so far`);
      
      const profileLinks = await page.evaluate(() => {
        const profileCards = Array.from(document.querySelectorAll('.reusable-search__result-container, .search-result, [data-chameleon-result-urn]'));
        
        return profileCards.map(card => {
          const link = card.querySelector('a[href*="/in/"]');
          
          if (!link) return null;
          
          const rect = link.getBoundingClientRect();
          const href = link.href;
          
          let name = '';
          const nameElement = card.querySelector('.entity-result__title-text, .actor-name');
          if (nameElement) {
            name = nameElement.textContent.trim();
          }
          
          const isVisible = rect.top >= 0 && 
                           rect.left >= 0 && 
                           rect.bottom <= window.innerHeight &&
                           rect.right <= window.innerWidth;
          
          return {
            href,
            name,
            x: rect.x + rect.width/2,
            y: rect.y + rect.height/2,
            isVisible,
            height: rect.height,
            width: rect.width
          };
        }).filter(link => link !== null);
      });
      
      if (profileLinks.length === 0) {
        logAction(`No profile links found on page ${currentPage}, ending browsing`);
        break;
      }
      
      logAction(`Found ${profileLinks.length} profile links on page ${currentPage}`);
      
      let processedOnThisPage = 0;
      
      if (profileLinks.filter(link => link.isVisible).length < 3) {
        await humanScroll(page);
        await randomDelay(1500, 3000);
      }
      
      for (let i = 0; i < profileLinks.length; i++) {
        if (Math.random() < 0.2 && processedOnThisPage > 0) {
          logAction(`Randomly skipping a profile (human-like behavior)`);
          continue;
        }
        
        const profileLink = profileLinks[i];
        
        if (!profileLink.isVisible) {
          await page.evaluate((y) => {
            window.scrollBy(0, y - 100);
          }, profileLink.y);
          
          await randomDelay(800, 1500);
        }
        
        const { normalizeProfileUrl } = require('../profile/storage');
        const normalizedUrl = normalizeProfileUrl(profileLink.href);
        
        if (processedProfiles.has(normalizedUrl)) {
          logAction(`Skipping already processed profile: ${profileLink.name}`);
          continue;
        }
        
        let useDirectNavigation = Math.random() < 0.5;
        
        if (useDirectNavigation) {
          logAction(`Navigating directly to profile: ${profileLink.name}`);
          const { processProfile } = require('../profile/process');
          const result = await processProfile(page, profileLink.href, config, processedProfiles);
          
          if (result.profileDetails) {
            processedCount++;
            processedOnThisPage++;
          }
        } else {
          try {
            const { moveMouseNaturally } = require('../mouse/move-naturally');
            await moveMouseNaturally(page, {x: profileLink.x, y: profileLink.y});
            await randomDelay(200, 800);
            
            await page.mouse.click(profileLink.x, profileLink.y);
            logAction(`Clicked on profile: ${profileLink.name}`);
            
            await randomDelay(3000, 5000);
            
            const currentUrl = await page.url();
            const result = await processProfileInPlace(page, currentUrl, config, processedProfiles);
            
            if (result.profileDetails) {
              processedCount++;
              processedOnThisPage++;
            }
            
            await randomDelay(1000, 2000);
            logAction('Navigating back to search results');
            await page.goBack();
            await randomDelay(2000, 4000);
            
            if (Math.random() < 0.1) {
              logAction('Randomly refreshing the search page (human behavior)');
              await page.reload();
              await randomDelay(2000, 4000);
            }
          } catch (clickError) {
            logError(`Error with click navigation: ${clickError.message}`, clickError);
            logAction('Falling back to direct navigation');
            
            await page.goto(profileLink.href, { waitUntil: 'domcontentloaded' });
            await randomDelay(2000, 3000);
            
            const result = await processProfileInPlace(page, profileLink.href, config, processedProfiles);
            
            if (result.profileDetails) {
              processedCount++;
              processedOnThisPage++;
            }
            
            await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}&page=${currentPage}`, 
              { waitUntil: 'domcontentloaded' });
            await randomDelay(2000, 4000);
          }
        }
        
        if (processedCount >= maxProfiles) {
          logAction(`Reached target of ${maxProfiles} profiles, stopping`);
          break;
        }
        
        const delay = 8000 + Math.random() * 15000;
        logAction(`Waiting ${Math.round(delay/1000)} seconds before next profile`);
        await randomDelay(delay, delay);
      }
      
      if (processedOnThisPage === 0) {
        logAction('No new profiles processed on this page, moving to next page');
      } else {
        logAction(`Processed ${processedOnThisPage} profiles on page ${currentPage}`);
      }
      
      if (processedCount < maxProfiles) {
        const hasNextPage = await goToNextSearchPage(page, currentPage);
        if (!hasNextPage) {
          logAction('No more search result pages available');
          break;
        }
        currentPage++;
        await randomDelay(2000, 4000);
      }
    }
    
    logAction(`Completed browsing with ${processedCount} profiles processed`);
    return { processedCount, processedProfiles };
    
  } catch (error) {
    logError(`Error in profile browsing workflow: ${error.message}`, error);
    return { processedCount: 0, processedProfiles: new Set() };
  }
}

async function processProfileInPlace(page, profileUrl, config, processedProfiles) {
  const cleanProfileUrl = profileUrl.split('?')[0].split('/recent-activity')[0];
  
  if (processedProfiles.has(cleanProfileUrl)) {
    logAction(`Profile already processed, skipping: ${cleanProfileUrl}`);
    return { likeResult: false, connectResult: false, profileDetails: null };
  }

  try {
    await randomDelay(1000, 2000);
    await humanScroll(page);
    await randomDelay(1000, 2000);
    
    const { extractProfileDetails } = require('../profile/extract');
    const profileDetails = await extractProfileDetails(page, cleanProfileUrl);
    
    const { storeProfileAction } = require('../profile/storage');
    
    let storedProfile;
    try {
      storedProfile = storeProfileAction(
        cleanProfileUrl,
        profileDetails,
        'Profile Viewed',
        `Viewed during search for: ${config.searchQuery || 'unknown'}`,
        config.searchQuery
      );
      
      logAction(`Profile stored successfully: ${storedProfile ? 'Yes' : 'No'}`);
    } catch (storeError) {
      logError(`Failed to store profile action for ${cleanProfileUrl}`, storeError);
    }

    const { displayProfileInformation } = require('../ui/display');
    try {
      await displayProfileInformation(page, profileDetails);
    } catch (displayError) {
      logError(`Error displaying profile information: ${displayError.message}`, displayError);
    }

    let likeResult = false;
    if (config.likePosts) {
      const { processActivityPage } = require('../activity/like');
      try {
        likeResult = await processActivityPage(page, cleanProfileUrl);
        if (likeResult) {
          storeProfileAction(
            cleanProfileUrl,
            profileDetails,
            'Post Liked',
            'Liked post during automation'
          );
        }
      } catch (likeError) {
        logError(`Error liking posts for ${cleanProfileUrl}`, likeError);
      }
    }

    let connectResult = false;
    if (config.sendConnection) {
      const { handleConnectionPopups } = require('../connection/request');
      const { sendConnectionRequest } = require('../connection/request');
      
      try {
        await handleConnectionPopups(page);
        
        let connectionMessage = '';
        if (config.sendWithNote && config.connectMessage?.trim()) {
          connectionMessage = config.connectMessage
            .replace('{firstName}', profileDetails.firstName || '')
            .replace('{lastName}', profileDetails.lastName || '')
            .replace('{company}', profileDetails.company || '');
          
          logAction('Will send connection with personalized note');
        } else {
          logAction('Will send connection without note');
        }

        connectResult = await sendConnectionRequest(page, cleanProfileUrl, connectionMessage, {
          recipientName: profileDetails.fullName || profileDetails.firstName || null
        });
        if (connectResult) {
          storeProfileAction(
            cleanProfileUrl,
            profileDetails,
            'Connection Request Sent',
            connectionMessage
              ? `Sent request with message: ${connectionMessage}`
              : 'Sent connection request without message'
          );
        }
      } catch (connectError) {
        logError(`Error sending connection request for ${cleanProfileUrl}`, connectError);
      }
    }

    processedProfiles.add(cleanProfileUrl);
    
    const { markProfileAsProcessed } = require('../profile/storage');
    markProfileAsProcessed(cleanProfileUrl);

    return { likeResult, connectResult, profileDetails };
  } catch (error) {
    logError(`Error processing profile in place: ${error.message}`, error);
    return { likeResult: false, connectResult: false, profileDetails: null };
  }
}

module.exports = {
  directSearchTyping,
  debugSearchBar,
  goToNextSearchPage,
  browseProfilesFromSearchResults,
  processProfileInPlace
};
