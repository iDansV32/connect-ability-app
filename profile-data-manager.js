// profile-data-manager.js - Service for managing LinkedIn profile data
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class ProfileDataManager extends EventEmitter {
  constructor() {
    super();
    this.documentsDir = this.getDocumentsDir();
    this.profilesPath = path.join(this.documentsDir, 'profiles.json');
    this.backupsDir = path.join(this.documentsDir, 'backups');
    this.groupsPath = path.join(this.documentsDir, 'groups.json');
    this.nameMappingsPath = path.join(this.documentsDir, 'name-mappings.json');
    
    this.ensureDirectoriesExist();
    this.profileCache = new Map();
    this.loadProfileCache();
  }

  getDocumentsDir() {
    const userHome = process.env.HOME || process.env.USERPROFILE;
    return path.join(userHome, 'Documents', 'Connect-Ability');
  }

  ensureDirectoriesExist() {
    // Create main directory
    if (!fs.existsSync(this.documentsDir)) {
      fs.mkdirSync(this.documentsDir, { recursive: true });
    }
    
    // Create backups directory
    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }
    
    // Create initial files if they don't exist
    if (!fs.existsSync(this.profilesPath)) {
      fs.writeFileSync(this.profilesPath, JSON.stringify([], null, 2));
    }
    
    if (!fs.existsSync(this.groupsPath)) {
      fs.writeFileSync(this.groupsPath, JSON.stringify([], null, 2));
    }
    
    if (!fs.existsSync(this.nameMappingsPath)) {
      fs.writeFileSync(this.nameMappingsPath, JSON.stringify([], null, 2));
    }
  }

  /**
   * Load profile cache from disk
   */
  loadProfileCache() {
    try {
      const profiles = this.getAllProfiles();
      this.profileCache.clear();
      
      profiles.forEach(profile => {
        const normalizedUrl = this.normalizeProfileUrl(profile.url);
        this.profileCache.set(normalizedUrl, profile);
      });
      
      console.log(`Loaded ${this.profileCache.size} profiles into cache`);
    } catch (error) {
      console.error('Error loading profile cache:', error);
    }
  }

  /**
   * Normalize LinkedIn profile URL for consistent comparisons
   * @param {string} url - Profile URL
   * @returns {string} - Normalized URL
   */
  normalizeProfileUrl(url) {
    if (!url) return '';
    
    try {
      // Remove protocol, query parameters, and trailing slashes
      let normalized = url.toLowerCase()
        .replace(/https?:\/\//i, '')
        .replace(/\/+$/, '')
        .split('?')[0]
        .split('#')[0];
      
      // Remove common suffixes
      normalized = normalized
        .replace(/\/recent-activity.*$/, '')
        .replace(/\/details.*$/, '');
      
      return normalized;
    } catch (error) {
      console.error('Error normalizing URL:', error);
      return String(url).toLowerCase();
    }
  }

  mergeProfileActions(existingActions = [], nextActions = []) {
    const seen = new Set();
    const merged = [];

    [...existingActions, ...nextActions].forEach(action => {
      if (!action || typeof action !== 'object') return;

      const normalizedAction = {
        type: action.type || '',
        timestamp: action.timestamp || '',
        notes: action.notes || '',
        metadata: action.metadata || {}
      };
      const actionKey = JSON.stringify([
        normalizedAction.type,
        normalizedAction.timestamp,
        normalizedAction.notes,
        normalizedAction.metadata
      ]);

      if (seen.has(actionKey)) return;
      seen.add(actionKey);
      merged.push(normalizedAction);
    });

    return merged;
  }

  /**
   * Get all profiles
   * @returns {Array} - List of profiles
   */
  getAllProfiles() {
    try {
      const data = fs.readFileSync(this.profilesPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading profiles:', error);
      return [];
    }
  }

  /**
   * Get a specific profile by URL
   * @param {string} profileUrl - Profile URL
   * @returns {Object|null} - Profile data or null
   */
  getProfile(profileUrl) {
    const normalizedUrl = this.normalizeProfileUrl(profileUrl);
    
    // Check cache first
    if (this.profileCache.has(normalizedUrl)) {
      return this.profileCache.get(normalizedUrl);
    }
    
    // Load from disk
    const profiles = this.getAllProfiles();
    return profiles.find(p => this.normalizeProfileUrl(p.url) === normalizedUrl);
  }

  /**
   * Save or update a profile
   * @param {Object} profileData - Profile data to save
   * @returns {Object} - Saved profile
   */
  saveProfile(profileData) {
    try {
      const profiles = this.getAllProfiles();
      const normalizedUrl = this.normalizeProfileUrl(profileData.url);
      
      // Find existing profile
      const existingIndex = profiles.findIndex(p => 
        this.normalizeProfileUrl(p.url) === normalizedUrl
      );
      
      // Prepare profile object
      const profile = {
        url: normalizedUrl,
        originalUrl: profileData.originalUrl || profileData.url,
        firstName: profileData.firstName || '',
        lastName: profileData.lastName || '',
        fullName: profileData.fullName || `${profileData.firstName} ${profileData.lastName}`.trim(),
        title: profileData.title || profileData.position || '',
        company: profileData.company || '',
        location: profileData.location || '',
        email: profileData.email || 'Not Available',
        linkedInUrl: profileData.url,
        firstInteraction: profileData.firstInteraction || new Date().toISOString(),
        lastInteraction: new Date().toISOString(),
        actions: profileData.actions || [],
        suggestedEmails: profileData.suggestedEmails || [],
        companyDomain: profileData.companyDomain || '',
        metadata: profileData.metadata || {}
      };
      
      if (existingIndex !== -1) {
        // Merge with existing profile
        const existing = profiles[existingIndex];
        
        // Preserve certain fields from existing profile
        profile.firstInteraction = existing.firstInteraction;
        profile.actions = this.mergeProfileActions(existing.actions, profile.actions);
        
        // Preserve email if new one is not available
        if (profile.email === 'Not Available' && existing.email !== 'Not Available') {
          profile.email = existing.email;
        }
        
        // Update in array
        profiles[existingIndex] = profile;
      } else {
        // Add new profile
        profiles.push(profile);
      }
      
      // Save to disk
      fs.writeFileSync(this.profilesPath, JSON.stringify(profiles, null, 2));
      
      // Update cache
      this.profileCache.set(normalizedUrl, profile);
      
      // Emit event
      this.emit('profile-saved', profile);
      
      return profile;
    } catch (error) {
      console.error('Error saving profile:', error);
      throw error;
    }
  }

  /**
   * Add an action to a profile
   * @param {string} profileUrl - Profile URL
   * @param {Object} action - Action to add
   * @returns {boolean} - Success status
   */
  addProfileAction(profileUrl, action) {
    try {
      const profile = this.getProfile(profileUrl);
      
      if (!profile) {
        console.error(`Profile not found: ${profileUrl}`);
        return false;
      }
      
      // Add action
      if (!profile.actions) {
        profile.actions = [];
      }
      
      profile.actions.push({
        type: action.type,
        timestamp: action.timestamp || new Date().toISOString(),
        notes: action.notes || '',
        metadata: action.metadata || {}
      });
      
      // Update last interaction
      profile.lastInteraction = new Date().toISOString();
      
      // Save profile
      this.saveProfile(profile);
      
      return true;
    } catch (error) {
      console.error('Error adding profile action:', error);
      return false;
    }
  }

  /**
   * Check if a profile has been processed
   * @param {string} profileUrl - Profile URL
   * @returns {boolean} - Whether profile has been processed
   */
  hasProfileBeenProcessed(profileUrl) {
    const normalizedUrl = this.normalizeProfileUrl(profileUrl);
    return this.profileCache.has(normalizedUrl);
  }

  /**
   * Check if a profile has a specific action
   * @param {string} profileUrl - Profile URL
   * @param {string} actionType - Action type to check
   * @returns {boolean} - Whether profile has the action
   */
  hasProfileAction(profileUrl, actionType) {
    const profile = this.getProfile(profileUrl);
    
    if (!profile || !profile.actions) {
      return false;
    }
    
    return profile.actions.some(action => action.type === actionType);
  }

  /**
   * Filter profiles by criteria
   * @param {Object} criteria - Filter criteria
   * @returns {Array} - Filtered profiles
   */
  filterProfiles(criteria) {
    const profiles = this.getAllProfiles();
    
    return profiles.filter(profile => {
      // Filter by action type
      if (criteria.actionType) {
        if (!profile.actions || !profile.actions.some(a => a.type === criteria.actionType)) {
          return false;
        }
      }
      
      // Filter by email availability
      if (criteria.hasEmail === true) {
        if (!profile.email || profile.email === 'Not Available') {
          return false;
        }
      } else if (criteria.hasEmail === false) {
        if (profile.email && profile.email !== 'Not Available') {
          return false;
        }
      }
      
      // Filter by company
      if (criteria.company) {
        if (!profile.company || !profile.company.toLowerCase().includes(criteria.company.toLowerCase())) {
          return false;
        }
      }
      
      // Filter by date range
      if (criteria.startDate || criteria.endDate) {
        const lastInteraction = new Date(profile.lastInteraction);
        
        if (criteria.startDate && lastInteraction < new Date(criteria.startDate)) {
          return false;
        }
        
        if (criteria.endDate && lastInteraction > new Date(criteria.endDate)) {
          return false;
        }
      }
      
      // Filter by search query
      if (criteria.searchQuery) {
        const query = criteria.searchQuery.toLowerCase();
        const searchableText = `${profile.firstName} ${profile.lastName} ${profile.title} ${profile.company} ${profile.email}`.toLowerCase();
        
        if (!searchableText.includes(query)) {
          return false;
        }
      }
      
      return true;
    });
  }

  /**
   * Get profile statistics
   * @returns {Object} - Statistics
   */
  getStatistics() {
    const profiles = this.getAllProfiles();
    
    const stats = {
      total: profiles.length,
      withEmail: 0,
      withoutEmail: 0,
      viewed: 0,
      connected: 0,
      messaged: 0,
      liked: 0,
      byCompany: {},
      recentActivity: {
        today: 0,
        thisWeek: 0,
        thisMonth: 0
      }
    };
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    profiles.forEach(profile => {
      // Email stats
      if (profile.email && profile.email !== 'Not Available') {
        stats.withEmail++;
      } else {
        stats.withoutEmail++;
      }
      
      // Company stats
      if (profile.company) {
        stats.byCompany[profile.company] = (stats.byCompany[profile.company] || 0) + 1;
      }
      
      // Action stats
      if (profile.actions) {
        profile.actions.forEach(action => {
          if (action.type === 'Profile Viewed') stats.viewed++;
          if (action.type === 'Connection Request Sent') stats.connected++;
          if (action.type === 'Message Sent') stats.messaged++;
          if (action.type === 'Post Liked') stats.liked++;
        });
      }
      
      // Recent activity
      const lastInteraction = new Date(profile.lastInteraction);
      if (lastInteraction >= today) stats.recentActivity.today++;
      if (lastInteraction >= weekAgo) stats.recentActivity.thisWeek++;
      if (lastInteraction >= monthAgo) stats.recentActivity.thisMonth++;
    });
    
    return stats;
  }

  /**
   * Export profiles to CSV
   * @param {string} filePath - Path to save CSV
   * @param {Object} options - Export options
   * @returns {boolean} - Success status
   */
  exportToCSV(filePath, options = {}) {
    try {
      const profiles = options.profiles || this.getAllProfiles();
      
      // CSV headers
      const headers = [
        'First Name',
        'Last Name',
        'Title',
        'Company',
        'Email',
        'LinkedIn URL',
        'First Interaction',
        'Last Interaction',
        'Actions Count',
        'Last Action'
      ];
      
      // Build CSV content
      let csvContent = headers.join(',') + '\n';
      
      profiles.forEach(profile => {
        const lastAction = profile.actions && profile.actions.length > 0
          ? profile.actions[profile.actions.length - 1].type
          : '';
        
        const row = [
          profile.firstName,
          profile.lastName,
          `"${profile.title || ''}"`,
          `"${profile.company || ''}"`,
          profile.email,
          profile.originalUrl || profile.url,
          profile.firstInteraction,
          profile.lastInteraction,
          profile.actions ? profile.actions.length : 0,
          lastAction
        ];
        
        csvContent += row.join(',') + '\n';
      });
      
      // Save file
      fs.writeFileSync(filePath, csvContent);
      
      this.emit('profiles-exported', { count: profiles.length, path: filePath });
      
      return true;
    } catch (error) {
      console.error('Error exporting profiles to CSV:', error);
      return false;
    }
  }

  /**
   * Import profiles from CSV
   * @param {string} filePath - Path to CSV file
   * @returns {Object} - Import results
   */
  importFromCSV(filePath) {
    try {
      const csvContent = fs.readFileSync(filePath, 'utf8');
      const lines = csvContent.split('\n');
      const headers = lines[0].split(',');
      
      let imported = 0;
      let updated = 0;
      let failed = 0;
      
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        
        try {
          const values = lines[i].split(',');
          const profileData = {};
          
          // Map CSV columns to profile fields
          headers.forEach((header, index) => {
            const value = values[index] || '';
            const cleanValue = value.replace(/^"(.*)"$/, '$1').trim();
            
            switch (header.toLowerCase()) {
              case 'first name':
                profileData.firstName = cleanValue;
                break;
              case 'last name':
                profileData.lastName = cleanValue;
                break;
              case 'title':
                profileData.title = cleanValue;
                break;
              case 'company':
                profileData.company = cleanValue;
                break;
              case 'email':
                profileData.email = cleanValue;
                break;
              case 'linkedin url':
              case 'url':
                profileData.url = cleanValue;
                break;
            }
          });
          
          if (profileData.url) {
            const existing = this.getProfile(profileData.url);
            this.saveProfile(profileData);
            
            if (existing) {
              updated++;
            } else {
              imported++;
            }
          }
        } catch (error) {
          console.error(`Error importing line ${i}:`, error);
          failed++;
        }
      }
      
      this.emit('profiles-imported', { imported, updated, failed });
      
      return { imported, updated, failed };
    } catch (error) {
      console.error('Error importing profiles from CSV:', error);
      throw error;
    }
  }

  /**
   * Create a backup of profiles
   * @returns {string} - Backup file path
   */
  createBackup() {
    try {
      const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
      const backupPath = path.join(this.backupsDir, `profiles-backup-${timestamp}.json`);
      
      const profiles = this.getAllProfiles();
      fs.writeFileSync(backupPath, JSON.stringify(profiles, null, 2));
      
      console.log(`Created backup at ${backupPath}`);
      
      // Clean up old backups (keep last 10)
      this.cleanupOldBackups(10);
      
      return backupPath;
    } catch (error) {
      console.error('Error creating backup:', error);
      throw error;
    }
  }

  /**
   * Restore from backup
   * @param {string} backupPath - Path to backup file
   * @returns {boolean} - Success status
   */
  restoreFromBackup(backupPath) {
    try {
      // Create a backup of current data first
      this.createBackup();
      
      // Read backup file
      const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      
      // Validate backup data
      if (!Array.isArray(backupData)) {
        throw new Error('Invalid backup file format');
      }
      
      // Restore data
      fs.writeFileSync(this.profilesPath, JSON.stringify(backupData, null, 2));
      
      // Reload cache
      this.loadProfileCache();
      
      this.emit('backup-restored', { count: backupData.length, path: backupPath });
      
      return true;
    } catch (error) {
      console.error('Error restoring from backup:', error);
      return false;
    }
  }

  /**
   * Clean up old backup files
   * @param {number} keepCount - Number of backups to keep
   */
  cleanupOldBackups(keepCount = 10) {
    try {
      const files = fs.readdirSync(this.backupsDir)
        .filter(f => f.startsWith('profiles-backup-'))
        .sort()
        .reverse();
      
      if (files.length > keepCount) {
        const toDelete = files.slice(keepCount);
        
        toDelete.forEach(file => {
          fs.unlinkSync(path.join(this.backupsDir, file));
        });
        
        console.log(`Deleted ${toDelete.length} old backup files`);
      }
    } catch (error) {
      console.error('Error cleaning up old backups:', error);
    }
  }

  /**
   * Repair and validate profile data
   * @returns {Object} - Repair results
   */
  repairProfileData() {
    try {
      const profiles = this.getAllProfiles();
      let repaired = 0;
      
      profiles.forEach(profile => {
        let modified = false;
        
        // Ensure required fields exist
        if (!profile.firstName && !profile.lastName && profile.fullName) {
          const parts = profile.fullName.split(' ');
          if (parts.length >= 1) {
            profile.firstName = parts[0];
            profile.lastName = parts.slice(1).join(' ');
            modified = true;
          }
        }
        
        // Ensure company field exists
        if (!profile.company && (profile.companyName || profile.organization)) {
          profile.company = profile.companyName || profile.organization;
          modified = true;
        }
        
        // Ensure email field exists
        if (!profile.email && profile.emailAddress) {
          profile.email = profile.emailAddress;
          modified = true;
        }
        
        // Ensure title field exists
        if (!profile.title && (profile.position || profile.headline)) {
          profile.title = profile.position || profile.headline;
          modified = true;
        }
        
        // Ensure actions array exists
        if (!profile.actions) {
          profile.actions = [];
          modified = true;
        }
        
        // Ensure timestamps exist
        if (!profile.firstInteraction) {
          profile.firstInteraction = profile.createdAt || new Date().toISOString();
          modified = true;
        }
        
        if (!profile.lastInteraction) {
          profile.lastInteraction = profile.updatedAt || new Date().toISOString();
          modified = true;
        }
        
        if (modified) {
          repaired++;
        }
      });
      
      if (repaired > 0) {
        fs.writeFileSync(this.profilesPath, JSON.stringify(profiles, null, 2));
        this.loadProfileCache();
        console.log(`Repaired ${repaired} profiles`);
      }
      
      return { repaired, total: profiles.length };
    } catch (error) {
      console.error('Error repairing profile data:', error);
      return { repaired: 0, total: 0, error: error.message };
    }
  }
}

module.exports = ProfileDataManager;
