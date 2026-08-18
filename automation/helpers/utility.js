// ============================================
// helpers/utility.js - NEW FILE
// ============================================
const { logAction, logError } = require('../util/log');

async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 2000) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      if (retries >= maxRetries) throw error;
      const delay = initialDelay * Math.pow(2, retries);
      logAction(`Retry ${retries}/${maxRetries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function inferCompanyDomain(companyName) {
  if (!companyName) return '';
  
  const cleanName = companyName
    .replace(/(,?\s+Inc\.?|,?\s+LLC|,?\s+Ltd\.?|,?\s+Corp\.?|,?\s+Limited|,?\s+GmbH)$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[\s&]+/g, '')
    .replace(/[^\w\d-]/g, '');
  
  return cleanName + '.com';
}

async function checkLinkedInLoginStatus(page) {
  try {
    await page.goto('https://www.linkedin.com/feed/', { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return await page.evaluate(() => {
      const loggedInIndicators = [
        document.querySelector('.global-nav__me'),
        document.querySelector('.feed-identity-module'),
        document.querySelector('.profile-rail-card__actor-link'),
        document.querySelector('.share-box-feed-entry__actor')
      ];
      
      const loginForm = document.querySelector('.login__form');
      
      return loggedInIndicators.some(el => el !== null) && !loginForm;
    });
  } catch (error) {
    logAction('Error checking login status: ' + error.message);
    return false;
  }
}

module.exports = {
  retryWithBackoff,
  inferCompanyDomain,
  checkLinkedInLoginStatus
};
