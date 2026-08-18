// profile/process.js
const fs = require('fs');
const path = require('path');
const { logAction, logError } = require('../util/log');
const { randomDelay } = require('../human/delay');
const { humanScroll } = require('../human/scroll');
const { extractProfileDetails } = require('./extract');
const { storeProfileAction, normalizeProfileUrl, processedProfilesCache } = require('./storage');
const { processActivityPage } = require('../activity/like');
const { sendConnectionRequest } = require('../connection/request');
const { displayProfileInformation } = require('../ui/display');
const { isTargetClosedError } = require('../core/process-control');

function throwIfTargetClosed(error) {
  if (isTargetClosedError(error)) {
    throw error;
  }
}

/**
 * Check if profile has been processed before
 * @param {string} profileUrl - Profile URL to check
 * @returns {Promise<boolean>} - Whether profile was processed
 */
async function hasProfileBeenProcessed(profileUrl) {
  const normalizedUrl = normalizeProfileUrl(profileUrl);
  if (processedProfilesCache.has(normalizedUrl)) {
    return true;
  }
  
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const profilesPath = path.join(userHome, 'Documents', 'Connect-Ability', 'profiles.json');
    
    if (!fs.existsSync(profilesPath)) {
      return false;
    }
    
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const found = profiles.some(profile => normalizeProfileUrl(profile.url) === normalizedUrl);
    
    if (found) {
      processedProfilesCache.add(normalizedUrl);
    }
    
    return found;
  } catch (error) {
    logError(`Error checking processed status: ${error.message}`, error);
    return false;
  }
}

/**
 * Check if specific action was performed on profile
 * @param {string} profileUrl - Profile URL
 * @param {string} actionType - Action type to check
 * @returns {Promise<boolean>} - Whether action was performed
 */
async function hasProfileAction(profileUrl, actionType) {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const profilesPath = path.join(userHome, 'Documents', 'Connect-Ability', 'profiles.json');
    
    if (!fs.existsSync(profilesPath)) {
      return false;
    }
    
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const cleanProfileUrl = profileUrl.split('?')[0].split('/recent-activity')[0];
    
    const existingProfile = profiles.find(p => {
      const storedUrl = p.url.split('?')[0].split('/recent-activity')[0];
      return storedUrl === cleanProfileUrl;
    });
    
    if (!existingProfile || !existingProfile.actions) {
      return false;
    }
    
    return existingProfile.actions.some(action => action.type === actionType);
  } catch (error) {
    console.error(`Error checking if profile has action ${actionType}:`, error);
    return false;
  }
}

/**
 * Process a single profile with all configured actions
 * @param {Page} page - Playwright page object
 * @param {string} profileUrl - Profile URL to process
 * @param {Object} config - Configuration object
 * @param {Set} processedProfiles - Set of already processed profiles
 * @returns {Promise<Object>} - Processing results
 */
async function processProfile(page, profileUrl, config, processedProfiles) {
  const cleanProfileUrl = profileUrl.split('?')[0].split('/recent-activity')[0];
  
  if (processedProfiles.has(cleanProfileUrl)) {
    logAction(`Profile already processed, skipping: ${cleanProfileUrl}`);
    return { likeResult: false, connectResult: false, profileDetails: null };
  }

  try {
    await page.goto(cleanProfileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => logAction('Navigation timeout, but continuing...'));
    await randomDelay(2000, 3000);

    let profileDetails;
    try {
      profileDetails = await extractProfileDetails(page, cleanProfileUrl);
      
      if (!profileDetails || (!profileDetails.firstName && !profileDetails.lastName)) {
        logAction('WARNING: Initial extraction failed to get name data, attempting backup extraction');
        
        const backupNameData = await page.evaluate(() => {
          const nameSelectors = [
            'h1.text-heading-xlarge',
            'h1.inline.t-24',
            'h1',
            '.profile-topcard-person-entity__name',
            '.pv-text-details__title h1',
            '.profile-info strong',
            '.identity-name',
            '.pv-top-card--list',
            '[data-field="name"]',
            '.pv-text-details__left-panel h1',
            '.artdeco-entity-lockup__title'
          ];
          
          for (const selector of nameSelectors) {
            try {
              const element = document.querySelector(selector);
              if (element && element.textContent.trim()) {
                const fullName = element.textContent.trim();
                console.log(`Found name with selector ${selector}: ${fullName}`);
                
                const nameParts = fullName.split(/\s+/);
                let firstName = '', lastName = '';
                if (nameParts.length >= 1) {
                  firstName = nameParts[0];
                  lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
                }
                
                return { fullName, firstName, lastName, source: selector };
              }
            } catch (e) {
              // Continue to next selector
            }
          }
          
          return null;
        });
        
        if (backupNameData) {
          logAction(`Backup extraction found name: ${backupNameData.fullName} from ${backupNameData.source}`);
          profileDetails.firstName = backupNameData.firstName;
          profileDetails.lastName = backupNameData.lastName;
          profileDetails.fullName = backupNameData.fullName;
        }
      }
    } catch (extractError) {
      throwIfTargetClosed(extractError);
      logError(`Failed to extract details for ${cleanProfileUrl}`, extractError);
      
      profileDetails = {
        firstName: 'Unknown',
        lastName: 'Profile',
        fullName: 'Unknown Profile',
        position: 'Not Available',
        company: 'Not Available',
        email: 'Not Available',
        profileUrl: cleanProfileUrl
      };
    }

    logAction(`FINAL PROFILE DATA: ${JSON.stringify({
      firstName: profileDetails.firstName,
      lastName: profileDetails.lastName,
      fullName: profileDetails.fullName,
      company: profileDetails.company,
      position: profileDetails.position,
      email: profileDetails.email?.length > 0 ? 'Present' : 'Not Available'
    })}`);

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

    try {
      await displayProfileInformation(page, profileDetails);
    } catch (displayError) {
      throwIfTargetClosed(displayError);
      logError(`Error displaying profile information: ${displayError.message}`, displayError);
    }

    let likeResult = false;
    if (config.likePosts) {
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
        throwIfTargetClosed(likeError);
        logError(`Error liking posts for ${cleanProfileUrl}`, likeError);
      }
    }

    let connectResult = false;
    if (config.sendConnection) {
      try {
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
        throwIfTargetClosed(connectError);
        logError(`Error sending connection request for ${cleanProfileUrl}`, connectError);
      }
    }

    processedProfiles.add(cleanProfileUrl);
    
    return { likeResult, connectResult, profileDetails };
  } catch (error) {
    throwIfTargetClosed(error);
    logError(`Error processing profile ${cleanProfileUrl} - ${error.message}`, error);
    return { likeResult: false, connectResult: false, profileDetails: null };
  }
}

/**
 * Process profile with history checking
 * @param {Page} page - Playwright page object
 * @param {string} profileUrl - Profile URL
 * @param {Object} config - Configuration
 * @param {Set} processedProfiles - Already processed profiles
 * @returns {Promise<Object>} - Processing results
 */
async function processProfileWithHistory(page, profileUrl, config, processedProfiles) {
  const cleanProfileUrl = profileUrl.split('?')[0].split('/recent-activity')[0];
  
  if (processedProfiles.has(cleanProfileUrl)) {
    logAction(`Profile already processed in this session, skipping: ${cleanProfileUrl}`);
    return { likeResult: false, connectResult: false, profileDetails: null };
  }

  try {
    const alreadyProcessed = await hasProfileBeenProcessed(cleanProfileUrl);
    if (alreadyProcessed) {
      logAction(`Profile was previously processed in earlier sessions: ${cleanProfileUrl}`);
      
      let shouldSkipLike = false;
      let shouldSkipConnect = false;
      
      if (config.likePosts) {
        const alreadyLiked = await hasProfileAction(cleanProfileUrl, 'Post Liked');
        if (alreadyLiked) {
          logAction(`Already liked posts from this profile, skipping like action: ${cleanProfileUrl}`);
          shouldSkipLike = true;
        }
      }
      
      if (config.sendConnection) {
        const alreadyConnected = await hasProfileAction(cleanProfileUrl, 'Connection Request Sent');
        if (alreadyConnected) {
          logAction(`Already sent connection request to this profile, skipping connect action: ${cleanProfileUrl}`);
          shouldSkipConnect = true;
        }
      }
      
      if ((shouldSkipLike || !config.likePosts) && 
          (shouldSkipConnect || !config.sendConnection) && 
          (!config.visitProfile)) {
        logAction(`All actions already performed for this profile, skipping completely: ${cleanProfileUrl}`);
        processedProfiles.add(cleanProfileUrl);
        return { likeResult: false, connectResult: false, profileDetails: null };
      }
      
      const modifiedConfig = {...config};
      if (shouldSkipLike) modifiedConfig.likePosts = false;
      if (shouldSkipConnect) modifiedConfig.sendConnection = false;
      
      return await processProfile(page, profileUrl, modifiedConfig, processedProfiles);
    }

    return await processProfile(page, profileUrl, config, processedProfiles);
  } catch (error) {
    throwIfTargetClosed(error);
    logError(`Error processing profile with history ${cleanProfileUrl} - ${error.message}`, error);
    return { likeResult: false, connectResult: false, profileDetails: null };
  }
}

module.exports = {
  hasProfileBeenProcessed,
  hasProfileAction,
  processProfile,
  processProfileWithHistory
};
