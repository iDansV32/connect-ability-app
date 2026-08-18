
// ============================================
// helpers/wait.js - COMPLETE
// ============================================
const { logAction } = require('../util/log');

async function waitForAnySelector(page, selectors, timeout = 30000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (element && await element.isVisible()) {
        logAction(`Found selector: ${selector}`);
        return selector;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  throw new Error(`Timeout waiting for any of: ${selectors.join(', ')}`);
}

async function waitForElementAndClick(page, selector, timeout = 10000) {
  const element = await page.waitForSelector(selector, { 
    state: 'visible', 
    timeout 
  });
  
  if (element) {
    await element.click();
    return true;
  }
  return false;
}

async function waitUntilStable(page, selector, stableTime = 1000) {
  let previousContent = '';
  let stableCount = 0;
  
  while (stableCount < 3) {
    const element = await page.$(selector);
    if (!element) return false;
    
    const currentContent = await element.textContent();
    if (currentContent === previousContent) {
      stableCount++;
    } else {
      stableCount = 0;
      previousContent = currentContent;
    }
    
    await new Promise(resolve => setTimeout(resolve, stableTime / 3));
  }
  
  return true;
}

module.exports = {
  waitForAnySelector,
  waitForElementAndClick,
  waitUntilStable
};