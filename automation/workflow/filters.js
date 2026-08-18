// ============================================
// workflow/filters.js - NEW FILE
// ============================================
const fs = require('fs');
const path = require('path');
const { logAction, logError } = require('../util/log');

async function filterProfilesByInteraction(interactionType) {
  try {
    logAction(`Filtering profiles by interaction type: ${interactionType}`);
    
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
    const profilesPath = path.join(documentsDir, 'profiles.json');
    
    if (!fs.existsSync(profilesPath)) {
      logAction('No profiles found in storage');
      return [];
    }
    
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    
    const filteredProfiles = profiles.filter(profile => {
      const hasInteraction = profile.actions.some(action => 
        action.type === interactionType
      );
      return hasInteraction;
    });
    
    logAction(`Found ${filteredProfiles.length} profiles with interaction type: ${interactionType}`);
    return filteredProfiles;
  } catch (error) {
    logError(`Error filtering profiles by interaction: ${error.message}`, error);
    return [];
  }
}

module.exports = {
  filterProfilesByInteraction
};
