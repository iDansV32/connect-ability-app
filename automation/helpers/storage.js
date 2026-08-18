// ============================================
// helpers/storage.js - NEW FILE
// ============================================
const { logAction, logError } = require('../util/log');

async function storeEmailInLocalStorage(page, email, profileUrl) {
  if (!email || email === 'Not Available') {
    return false;
  }
  
  try {
    await page.evaluate((email, profileUrl) => {
      let storedEmails = JSON.parse(localStorage.getItem('linkedInEmails') || '{}');
      storedEmails[profileUrl] = email;
      localStorage.setItem('linkedInEmails', JSON.stringify(storedEmails));
      return true;
    }, email, profileUrl);
    
    logAction(`Stored email for ${profileUrl} in local storage`);
    return true;
  } catch (error) {
    logError('Error storing email in local storage', error);
    return false;
  }
}

async function getStoredEmails(page) {
  try {
    return await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('linkedInEmails') || '{}');
    });
  } catch (error) {
    logError('Error retrieving emails from local storage', error);
    return {};
  }
}

module.exports = {
  storeEmailInLocalStorage,
  getStoredEmails
};

// ============================================
// profile/index.js - NEW FILE with missing functions
// ============================================
const fs = require('fs');
const path = require('path');
const { logAction, logError } = require('../util/log');

const processedProfilesCache = new Set();

async function buildProfileIndex() {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const profilesPath = path.join(userHome, 'Documents', 'Connect-Ability', 'profiles.json');
    
    if (!fs.existsSync(profilesPath)) {
      return {};
    }
    
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const index = {};
    
    profiles.forEach(profile => {
      const normalizedUrl = profile.url.toLowerCase();
      index[normalizedUrl] = true;
      processedProfilesCache.add(normalizedUrl);
    });
    
    logAction(`Built profile index with ${Object.keys(index).length} entries`);
    return index;
  } catch (error) {
    logError(`Error building profile index: ${error.message}`, error);
    return {};
  }
}

async function recordProfileView(page, profileUrl) {
  try {
    const { extractProfileDetails } = require('./extract');
    const { storeProfileAction } = require('./storage');
    
    const profileDetails = await extractProfileDetails(page, profileUrl);
    
    storeProfileAction(
      profileUrl,
      profileDetails,
      'Profile Viewed',
      `Viewed profile at ${new Date().toLocaleString()}`
    );
    
    return profileDetails;
  } catch (error) {
    logError(`Failed to record profile view: ${error.message}`, error);
    return null;
  }
}

async function getStoredProfileDetails(profileUrl) {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const profilesPath = path.join(userHome, 'Documents', 'Connect-Ability', 'profiles.json');
    
    if (!fs.existsSync(profilesPath)) {
      return null;
    }
    
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const normalizedUrl = profileUrl.toLowerCase().split('?')[0].split('/recent-activity')[0];
    
    return profiles.find(p => {
      const pUrl = p.url.toLowerCase().split('?')[0].split('/recent-activity')[0];
      return pUrl === normalizedUrl;
    });
    
  } catch (error) {
    logError('Error getting stored profile details:', error);
    return null;
  }
}

module.exports = {
  buildProfileIndex,
  recordProfileView,
  getStoredProfileDetails,
  processedProfilesCache
};
