// profile/storage.js
const fs = require('fs');
const path = require('path');
const { logAction, logError } = require('../util/log');
const { writeJsonFileAtomic } = require('../../connect-documents');

// Track processed profiles in memory
const processedProfilesCache = new Set();

function getAutomationAccountContext() {
  const context = global.currentLinkedInAccountContext || {};
  const accountId = String(context.accountId || '').trim() || null;
  const accountName = String(context.accountName || context.accountEmail || '').trim() || null;
  return { accountId, accountName };
}

function profileMatchesAccount(profile, accountContext = getAutomationAccountContext()) {
  const profileAccountId = String(profile?.accountId || '').trim() || null;
  if (accountContext.accountId) {
    return profileAccountId === accountContext.accountId;
  }
  // When accountContext has no accountId, refuse to match.
  // This prevents actions from being recorded on the wrong profile when
  // the global account context is not set.  A new profile entry will be
  // created instead, which is safer than silently corrupting an existing one.
  return false;
}

/**
 * Store profile action and data (updated: minimal logging, duplicate suppression, batched write logs)
 * @param {string} profileUrl - LinkedIn profile URL
 * @param {Object} profileDetails - Profile details object
 * @param {string} action - Action type (e.g., 'Profile Viewed')
 * @param {string} notes - Additional notes
 * @param {string|null} searchQuery - Search query used (optional)
 * @returns {Object} - Stored profile data
 */
function storeProfileAction(profileUrl, profileDetails, action, notes, searchQuery = null) {
  // Only log detailed data on first save or when DEBUG=true
  const isDebugMode = process.env.DEBUG === 'true';
  if (isDebugMode) {
    console.log(
      'INCOMING PROFILE DATA:',
      JSON.stringify(
        {
          url: profileUrl,
          firstName: profileDetails?.firstName,
          lastName: profileDetails?.lastName,
          email: profileDetails?.email,
          company: profileDetails?.company,
          position: profileDetails?.position
        },
        null,
        2
      )
    );
  }

  const userHome = process.env.HOME || process.env.USERPROFILE;
  const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
  if (!fs.existsSync(documentsDir)) {
    fs.mkdirSync(documentsDir, { recursive: true });
  }
  const profilesPath = path.join(documentsDir, 'profiles.json');

  // ===== Validation & normalization =====
  // Validate profileDetails exists
  if (!profileDetails) {
    logError('ERROR: profileDetails is null or undefined in storeProfileAction');
    profileDetails = {
      firstName: 'Unknown',
      lastName: 'Unknown',
      fullName: 'Unknown Profile',
      position: 'Not Available',
      company: 'Not Available',
      email: 'Not Available'
    };
  }

  // Attempt to extract name from URL if missing
  if (!profileDetails.firstName || profileDetails.firstName === 'Unknown' || profileDetails.firstName === '') {
    const urlNameMatch = profileUrl && profileUrl.match(/\/in\/([^\/]+)/);
    if (urlNameMatch && urlNameMatch[1]) {
      const { cleanLinkedInSlugName } = require('./url-utils');
      const cleanedName = cleanLinkedInSlugName(urlNameMatch[1]);
      const nameParts = cleanedName.split(' ').filter(Boolean);
      if (nameParts.length >= 1) {
        profileDetails.firstName = nameParts[0];
        profileDetails.lastName = nameParts.slice(1).join(' ');
        profileDetails.fullName = cleanedName;
        logAction(`Extracted name from URL: ${cleanedName}`);
      }
    }
  }

  // Load existing profiles (if any)
  let profiles = [];
  if (fs.existsSync(profilesPath)) {
    try {
      profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    } catch (error) {
      logError('Error parsing profiles.json file', error);
    }
  }

  const accountContext = getAutomationAccountContext();
  const normalizedUrl = normalizeProfileUrl(profileUrl);
  let existingProfileIndex = profiles.findIndex(
    (p) => normalizeProfileUrl(p.url) === normalizedUrl && profileMatchesAccount(p, accountContext)
  );

  // ===== Profile data preparation =====
  const safeFirstName = profileDetails.firstName || '';
  const safeLastName = profileDetails.lastName || '';
  const safeFullName = profileDetails.fullName || `${safeFirstName} ${safeLastName}`.trim() || 'Unknown Profile';

  // Base profile data assembled from incoming details (will be merged with existing if found)
  let profileData = {
    url: normalizedUrl,
    originalUrl: profileUrl,
    firstName: safeFirstName,
    lastName: safeLastName,
    fullName: safeFullName,
    title: profileDetails.position || profileDetails.title || '',
    company: profileDetails.company || '',
    rawHeadline: profileDetails.rawHeadline || '',
    email: profileDetails.email || 'Not available',
    linkedInProfileUrl: profileUrl,
    accountId: accountContext.accountId,
    accountName: accountContext.accountName,
    firstInteraction:
      existingProfileIndex === -1 ? new Date().toISOString() : profiles[existingProfileIndex].firstInteraction,
    lastInteraction: new Date().toISOString(),
    actions: []
  };

  // Optional enrichments retained if provided by upstream extraction
  if (profileDetails.suggestedEmails && profileDetails.suggestedEmails.length > 0) {
    profileData.suggestedEmails = profileDetails.suggestedEmails;
    profileData.companyDomain = profileDetails.companyDomain;
  }

  if (existingProfileIndex !== -1) {
    // ===== Update existing profile: minimal logging =====
    const existingProfile = profiles[existingProfileIndex];

    // Preserve existing data where new data is missing/placeholder
    if ((!profileData.firstName || profileData.firstName.trim() === '') && existingProfile.firstName) {
      profileData.firstName = existingProfile.firstName;
    }
    if ((!profileData.lastName || profileData.lastName.trim() === '') && existingProfile.lastName) {
      profileData.lastName = existingProfile.lastName;
    }
    if (
      (profileData.email === 'Not available' || profileData.email === 'Not Available') &&
      existingProfile.email &&
      existingProfile.email !== 'Not available' &&
      existingProfile.email !== 'Not Available'
    ) {
      profileData.email = existingProfile.email;
    }

    // Preserve any extra fields that may have existed
    if (existingProfile.suggestedEmails && !profileData.suggestedEmails) {
      profileData.suggestedEmails = existingProfile.suggestedEmails;
    }
    if (existingProfile.companyDomain && !profileData.companyDomain) {
      profileData.companyDomain = existingProfile.companyDomain;
    }

    // Actions: avoid recent duplicates (within 60s)
    profileData.actions = existingProfile.actions || [];
    const recentDuplicate = profileData.actions?.some(
      (existingAction) =>
        existingAction.type === action &&
        existingAction.notes === notes &&
        Math.abs(new Date(existingAction.timestamp) - new Date()) < 60000
    );

    if (!recentDuplicate) {
      profileData.actions.push({
        type: action,
        timestamp: new Date().toISOString(),
        notes: notes || '',
        searchQuery
      });
    } else if (isDebugMode) {
      // Only mention duplicates in DEBUG
      logAction(`Duplicate action skipped for ${profileData.firstName} ${profileData.lastName}`);
    }

    profiles[existingProfileIndex] = profileData;

    // Minimal log (no verbose JSON spam)
    logAction(`Added "${action}" action for ${profileData.firstName} ${profileData.lastName}`);
  } else {
    // ===== New profile: full logging =====
    profileData.actions.push({
      type: action,
      timestamp: new Date().toISOString(),
      notes: notes || '',
      searchQuery
    });

    profiles.push(profileData);
    logAction(`Created new profile for ${profileData.firstName} ${profileData.lastName}`);
  }

  // ===== Persist changes (batched write logs) =====
  try {
    // Atomic write (tmp + fsync + rename) so a crash mid-write cannot leave
    // profiles.json in a half-written / unparseable state. See
    // connect-documents.writeJsonFileAtomic + docs/native-module-abi.md
    // history for the senior-review motivation.
    writeJsonFileAtomic(profilesPath, profiles);

    // Only log the write once per ~5 seconds to reduce noise
    if (!global.lastWriteTime || Date.now() - global.lastWriteTime > 5000) {
      logAction(`Profile data updated (${profiles.length} total profiles)`);
      global.lastWriteTime = Date.now();
    }

    // Update CSV silently unless it's a brand new profile
    if (existingProfileIndex === -1) {
      updateCSV(profileData, documentsDir);
    }
  } catch (error) {
    logError('Error in file operations during profile saving:', error);
  }

  markProfileAsProcessed(normalizedUrl);

  return profileData;
}

/**
 * Backup profile data
 * @returns {Promise<boolean>} - Success status
 */
async function backupProfileData() {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const profilesDir = path.join(userHome, 'Documents', 'Connect-Ability');
    const profilesPath = path.join(profilesDir, 'profiles.json');

    if (!fs.existsSync(profilesPath)) {
      return false;
    }

    const backupsDir = path.join(profilesDir, 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const date = new Date().toISOString().split('T')[0];
    const backupPath = path.join(backupsDir, `profiles-backup-${date}.json`);

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(profilesPath, backupPath);
      logAction(`Created profile backup at ${backupPath}`);
    }

    return true;
  } catch (error) {
    logError(`Error backing up profile data: ${error.message}`, error);
    return false;
  }
}

/**
 * Get stored profile details
 * @param {string} profileUrl - LinkedIn profile URL
 * @returns {Object|null} - Profile details or null
 */
function getStoredProfileDetails(profileUrl) {
  try {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const profilesPath = path.join(userHome, 'Documents', 'Connect-Ability', 'profiles.json');

    if (!fs.existsSync(profilesPath)) {
      return null;
    }

    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const normalizedUrl = profileUrl.toLowerCase().split('?')[0].split('/recent-activity')[0];
    const accountContext = getAutomationAccountContext();

    return profiles.find((p) => {
      const pUrl = p.url.toLowerCase().split('?')[0].split('/recent-activity')[0];
      return pUrl === normalizedUrl && profileMatchesAccount(p, accountContext);
    });
  } catch (error) {
    console.error('Error getting stored profile details:', error);
    return null;
  }
}

/**
 * Normalize LinkedIn profile URLs
 * @param {string} url - Profile URL
 * @returns {string} - Normalized URL
 */
function normalizeProfileUrl(url) {
  if (!url) return '';

  try {
    let normalized = url
      .toLowerCase()
      .split('?')[0]
      .split('#')[0]
      .replace(/\/recent-activity.*$/, '')
      .replace(/\/details.*$/, '');

    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // ID-based profiles heuristic
    if (normalized.includes('/in/acoaa')) {
      return `ID_BASED:${normalized}`;
    }

    return normalized;
  } catch (error) {
    logError(`Error normalizing URL: ${error.message}`, error);
    return String(url).toLowerCase();
  }
}

/**
 * Mark profile as processed (in-memory cache)
 * @param {string} profileUrl - Profile URL
 * @returns {boolean} - Success status
 */
function markProfileAsProcessed(profileUrl) {
  try {
    if (!profileUrl) {
      logAction('Invalid profile URL provided to markProfileAsProcessed');
      return false;
    }

    const normalizedUrl = normalizeProfileUrl(profileUrl);
    processedProfilesCache.add(normalizedUrl);

    logAction(`Profile marked as processed: ${normalizedUrl}`);
    return true;
  } catch (error) {
    logError(`Error marking profile as processed: ${error.message}`, error);
    return false;
  }
}

// ===== Separate CSV update function to reduce logging =====
function updateCSV(profileData, documentsDir) {
  const csvPath = path.join(documentsDir, 'profiles.csv');
  let csvContent = '';

  if (!fs.existsSync(csvPath)) {
    csvContent =
      'Profile URL,First Name,Last Name,Position,Company,Email,First Interaction,Last Interaction,Latest Action\n';
  }

  const latestAction = profileData.actions[profileData.actions.length - 1];
  csvContent += `"${profileData.originalUrl || profileData.url}","${profileData.firstName}","${profileData.lastName}","${profileData.title}","${profileData.company}","${profileData.email}","${profileData.firstInteraction}","${profileData.lastInteraction}","${latestAction.type}"\n`;

  fs.appendFileSync(csvPath, csvContent);
}

module.exports = {
  storeProfileAction,
  backupProfileData,
  getStoredProfileDetails,
  normalizeProfileUrl,
  markProfileAsProcessed,
  processedProfilesCache,
  _private: {
    getAutomationAccountContext,
    profileMatchesAccount
  }
};
