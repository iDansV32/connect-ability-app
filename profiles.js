
(function() {
  console.log("Starting minimal LinkedIn profile filter implementation...");

  // ===== UTILITY FUNCTIONS =====
  function findElementByText(text, selector = '*') {
    const elements = document.querySelectorAll(selector);
    for (let i = 0; i < elements.length; i++) {
      if (elements[i].textContent && elements[i].textContent.includes(text)) {
        return elements[i];
      }
    }
    return null;
  }

  // Function to get profile data from JSON file (via the Electron bridge)
  async function loadProfilesFromJson() {
    try {
      if (window.electronAPI && typeof window.electronAPI.loadProfilesFromJson === 'function') {
        const profiles = await window.electronAPI.loadProfilesFromJson();
        console.log(`Loaded ${profiles.length} profiles from JSON file`);
        return profiles;
      } else {
        console.error("loadProfilesFromJson function not available in window.electronAPI");
        return [];
      }
    } catch (error) {
      console.error("Error loading profiles from JSON:", error);
      return [];
    }
  }

  // Function to normalize LinkedIn profile URL
  function normalizeProfileUrl(url) {
    if (!url) return '';
    
    try {
      // Handle both URLs and profile IDs
      if (!url.includes('linkedin.com')) {
        if (!url.startsWith('http')) {
          return url.toLowerCase().trim();
        }
      }
      
      // Extract just the profile ID part from LinkedIn URLs
      const linkedInMatch = url.match(/linkedin\.com\/in\/([\w-]+)/i);
      if (linkedInMatch && linkedInMatch[1]) {
        return linkedInMatch[1].toLowerCase();
      }
      
      // Remove query parameters, hashes, and trailing slashes
      let normalized = url.split('?')[0].split('#')[0];
      
      // Remove common suffixes
      normalized = normalized.split('/recent-activity')[0];
      normalized = normalized.split('/details')[0];
      normalized = normalized.split('/overlay')[0];
      
      // Remove trailing slash if present
      if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
      }
      
      // Try to extract just the username part from the URL
      const parts = normalized.split('/');
      if (parts.length > 0) {
        normalized = parts[parts.length - 1];
      }
      
      // Convert to lowercase for case-insensitive comparison
      return normalized.toLowerCase().trim();
    } catch (error) {
      console.error('Error normalizing URL:', url, error);
      return String(url).toLowerCase().trim();
    }
  }

  // ===== CREATE UI ELEMENTS =====
  function createFilterUI() {
    // 1. Create necessary styles
    const styleElement = document.createElement('style');
    styleElement.id = 'linkedin-filter-styles';
    styleElement.textContent = `
      /* Main container */
  .profile-filter-container {
    position: relative;
    display: inline-flex;
    align-items: center;
    margin-right: 10px;
  }
  
  /* Filter button */
  .profile-filter-btn {
    display: flex;
    align-items: center;
    background-color: #fff;
    border: 1px solid #0a66c2;
    color: #0a66c2;
    overflow: hidden;
    border-radius: 16px;
    padding: 8px 12px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    gap: 6px;
  }
  
  .profile-filter-btn:hover {
    background-color: rgba(10, 102, 194, 0.05);
  }
  
  .profile-filter-btn.active {
    background-color: #0a66c2 !important;
    color: white !important;
  }
  
  /* Filter icon */
  .profile-filter-icon {
    width: 16px;
    height: 16px;
  }
  
  /* Badge for active filters */
  .profile-filter-badge {
    position: absolute;
    top: -6px;
    right: -6px;
    background-color: #e23737;
    color: white;
    border-radius: 50%;
    width: 18px;
    height: 18px;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
  }
  
  /* Dropdown panel */
.profile-filter-dropdown {
  display: none; /* Change from block to none */
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 360px;
  max-height: 500px;
  overflow-y: auto;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.15);
  background: white;
  z-index: 1000;
  border: 1px solid #e0e0e0;
}

.profile-filter-dropdown.visible {
  display: block !important;
}
  
  /* Dropdown header */
  .profile-filter-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    border-bottom: 1px solid #e0e0e0;
  }
  
  .profile-filter-title {
    font-weight: 600;
    font-size: 16px;
    color: #191919;
  }
  
  .profile-filter-clear {
    background: none;
    border: none;
    color: #0a66c2;
    font-size: 14px;
    cursor: pointer;
    font-weight: 500;
  }
  
  /* Dropdown content */
  .profile-filter-content {
    max-height: 450px;
    overflow-y: auto;
    padding: 8px 0;
  }
  
  /* Filter group */
  .profile-filter-group {
    padding: 12px 16px;
    border-bottom: 1px solid #f3f3f3;
  }
  
  .profile-filter-group:last-child {
    border-bottom: none;
  }
  
  .profile-filter-group-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  
  .profile-filter-group-title {
    font-weight: 600;
    font-size: 14px;
    color: #191919;
  }
  
  .profile-filter-counter {
    font-size: 12px;
    color: #666;
    background-color: #f3f3f3;
    padding: 2px 8px;
    border-radius: 12px;
  }
  
  /* Options */
  .profile-filter-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  
  /* Checkbox */
  .profile-filter-checkbox {
    display: flex;
    align-items: center;
  }
  
  .profile-filter-checkbox input[type="checkbox"] {
    appearance: none;
    width: 18px;
    height: 18px;
    margin-right: 10px;
    background-color: #fff;
    border: 1.5px solid #d0d0d0;
    border-radius: 4px;
    cursor: pointer;
  }
  
  .profile-filter-checkbox input[type="checkbox"]:checked {
    background-color: #0a66c2;
    border-color: #0a66c2;
    position: relative;
  }
  
  .profile-filter-checkbox input[type="checkbox"]:checked::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 6px;
    width: 4px;
    height: 8px;
    border: solid white;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  
  .profile-filter-checkbox label {
    font-size: 14px;
    color: #191919;
    cursor: pointer;
  }
  
  /* Footer */
  .profile-filter-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    gap: 12px;
    border-top: 1px solid #e0e0e0;
  }
  
  .profile-filter-footer button {
    flex: 1;
    padding: 10px;
    border-radius: 8px;
    font-size: 14px;
    transition: all 0.2s;
  }
  
  .profile-filter-cancel {
    background-color: #f5f5f5;
    color: #333;
    border: 1px solid #e0e0e0;
  }
  
  .profile-filter-apply {
    background-color: #0a66c2;
    color: white;
    border: none;
  }
  
  .profile-filter-save {
    background-color: #057642;
    color: white;
    border: none;
  }
  
  /* Active filters display */
  .profile-filter-active {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    padding: 0 16px;
  }
  
  .profile-filter-label {
    display: inline-flex;
    align-items: center;
    background-color: #e6f2ff;
    color: #0a66c2;
    border-radius: 16px;
    padding: 4px 10px;
    font-size: 13px;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .profile-filter-label:hover {
    background-color: #d1e7ff;
  }
  
  .profile-filter-remove {
    margin-left: 6px;
    cursor: pointer;
    background: none;
    border: none;
    color: #0a66c2;
    font-size: 16px;
    line-height: 1;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .profile-filter-remove:hover {
    opacity: 0.7;
  }
  
  /* Remove debug section */
  .profile-filter-debug {
    display: none;
  }
`;
    document.head.appendChild(styleElement);

    // 2. Create container
    const container = document.createElement('div');
    container.className = 'profile-filter-container';

    // 3. Create button
    const button = document.createElement('button');
    button.className = 'profile-filter-btn';
    button.innerHTML = `
      <svg class="profile-filter-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
      </svg>
      <span>Filter Profiles</span>
    `;
    container.appendChild(button);

    // 4. Create dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'profile-filter-dropdown';
    
    // 5. Add header
    const header = document.createElement('div');
    header.className = 'profile-filter-header';
    header.innerHTML = `
      <div class="profile-filter-title">Filter Profiles</div>
      <button class="profile-filter-clear">Clear all</button>
    `;
    dropdown.appendChild(header);
    
    // 6. Add content
    const content = document.createElement('div');
    content.className = 'profile-filter-content';
    
    // >>> Engagement Status group
    const engagementGroup = document.createElement('div');
    engagementGroup.className = 'profile-filter-group';
    engagementGroup.innerHTML = `
      <div class="profile-filter-group-header">
        <div class="profile-filter-group-title">Engagement Status</div>
        <span class="profile-filter-counter">3 options</span>
      </div>
      <div class="profile-filter-options">

        <!-- Match EXACT strings in your data: "Post Liked", "Connection Request Sent", "Profile Viewed" -->

        <div class="profile-filter-checkbox">
          <input type="checkbox" id="pf-liked" name="engagement-status" value="Post Liked">
          <label for="pf-liked">Liked</label>
        </div>
        <div class="profile-filter-checkbox">
          <input type="checkbox" id="pf-connection-request" name="engagement-status" value="Connection Request Sent">
          <label for="pf-connection-request">Sent Connection Request</label>
        </div>
        <div class="profile-filter-checkbox">
          <input type="checkbox" id="pf-viewed-profile" name="engagement-status" value="Profile Viewed">
          <label for="pf-viewed-profile">Viewed Profile</label>
        </div>
      </div>
    `;
    content.appendChild(engagementGroup);
    
    dropdown.appendChild(content);
    
    // 7. Add footer
    const footer = document.createElement('div');
    footer.className = 'profile-filter-footer';
    footer.innerHTML = `
      <button class="profile-filter-cancel">Cancel</button>
      <button class="profile-filter-save">Save All Visible</button>
      <button class="profile-filter-apply">Apply Filters</button>
    `;
    dropdown.appendChild(footer);
    
    // 8. Add debug button
    const debugSection = document.createElement('div');
    debugSection.className = 'profile-filter-debug';

    dropdown.appendChild(debugSection);
    
    container.appendChild(dropdown);
    
    // 9. Add active filters container
    const activeFilters = document.createElement('div');
    activeFilters.className = 'profile-filter-active';
    container.appendChild(activeFilters);
    
    return container;
  }

  // ===== SETUP EVENT HANDLERS =====
  function setupEventHandlers(container) {
  // Elements
  const button = container.querySelector('.profile-filter-btn');
  const dropdown = container.querySelector('.profile-filter-dropdown');
  const clearButton = container.querySelector('.profile-filter-clear');
  const applyButton = container.querySelector('.profile-filter-apply');
  const cancelButton = container.querySelector('.profile-filter-cancel');
  const saveButton = container.querySelector('.profile-filter-save');
  const activeFiltersContainer = container.querySelector('.profile-filter-active');
  
  // Initialize the profile data cache
  dropdown.classList.remove('visible');
  let profilesData = null;
  
  // Load profiles on page load
  loadProfilesFromJson().then(profiles => {
    profilesData = profiles;
    console.log(`Cached ${profiles.length} profiles for filtering`);
  });

  document.addEventListener('connect-ability:active-linkedin-account-changed', async () => {
    profilesData = await loadProfilesFromJson();
    console.log(`Reloaded ${profilesData.length} scoped profiles after account switch`);
    if (filterState.engagementStatus.length > 0) {
      applyFiltersToProfiles(filterState, profilesData);
    }
  });
  
  // Filter state
  const filterState = {
    engagementStatus: []
  };
  
  // Toggle dropdown
  button.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    
    // Toggle dropdown visibility
    const isCurrentlyVisible = dropdown.classList.contains('visible');
    
    // Close all other dropdowns first
    document.querySelectorAll('.profile-filter-dropdown.visible').forEach(el => {
      el.classList.remove('visible');
      el.closest('.profile-filter-container')?.querySelector('.profile-filter-btn')?.classList.remove('active');
    });
    
    // If not currently visible, open this dropdown
    if (!isCurrentlyVisible) {
      dropdown.classList.add('visible');
      button.classList.add('active');
    }
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', function(e) {
    if (!container.contains(e.target)) {
      dropdown.classList.remove('visible');
      button.classList.remove('active');
    }
  });
  
  // Prevent dropdown from closing when clicking inside
  dropdown.addEventListener('click', function(e) {
    e.stopPropagation();
  });
  
  // Clear all filters
  clearButton.addEventListener('click', function() {
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
    });
  });
  
  // Apply filters
  applyButton.addEventListener('click', function() {
    // Get engagement status filters
    const engagementCheckboxes = container.querySelectorAll('input[name="engagement-status"]:checked');
    filterState.engagementStatus = Array.from(engagementCheckboxes).map(cb => cb.value);
    
    // Count total active filters
    const totalFilters = filterState.engagementStatus.length;
    
    // Update badge
    let badge = button.querySelector('.profile-filter-badge');
    if (totalFilters > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'profile-filter-badge';
        button.appendChild(badge);
      }
      badge.textContent = totalFilters;
      updateActiveFiltersDisplay(filterState, activeFiltersContainer);
    } else {
      if (badge) badge.remove();
      activeFiltersContainer.style.display = 'none';
      activeFiltersContainer.innerHTML = '';
    }
    
    // Apply filters to profiles
    applyFiltersToProfiles(filterState, profilesData);
    
    // Close dropdown
    dropdown.classList.remove('visible');
    button.classList.remove('active');
    
    console.log("Applied filters:", filterState);
  });
  
  // Cancel button
  cancelButton.addEventListener('click', function() {
    dropdown.classList.remove('visible');
    button.classList.remove('active');
    resetFilterUIToState(container, filterState);
  });
  
  // Save button - Save all visible profiles to JSON
  saveButton.addEventListener('click', function() {
    saveVisibleProfiles();
  });
}

  // ===== HELPER FUNCTIONS =====
  function updateActiveFiltersDisplay(filterState, container) {
    container.innerHTML = '';
    let hasFilters = false;
    
    // Engagement Status filters
    filterState.engagementStatus.forEach(status => {
      hasFilters = true;
      const label = document.createElement('div');
      label.className = 'profile-filter-label';
      let displayText;
      
      switch(status) {
        case 'Post Liked':
          displayText = 'Liked';
          break;
        case 'Connection Request Sent':
          displayText = 'Sent Connection Request';
          break;
        case 'Profile Viewed':
          displayText = 'Viewed Profile';
          break;
        default:
          displayText = status;
      }
      
      label.innerHTML = `
        ${displayText}
        <span class="profile-filter-remove">×</span>
      `;
      
      label.querySelector('.profile-filter-remove').addEventListener('click', () => {
        // Uncheck the corresponding box
        const inputId = {
          'Post Liked': 'pf-liked',
          'Connection Request Sent': 'pf-connection-request',
          'Profile Viewed': 'pf-viewed-profile'
        }[status];
        
        const checkbox = document.getElementById(inputId);
        if (checkbox) checkbox.checked = false;
        
        filterState.engagementStatus = filterState.engagementStatus.filter(s => s !== status);
        updateActiveFiltersDisplay(filterState, container);
        applyFiltersToProfiles(filterState, null);
      });
      
      container.appendChild(label);
    });
    
    container.style.display = hasFilters ? 'flex' : 'none';
  }

  function resetFilterUIToState(container, state) {
    // Reset engagement status checkboxes
    container.querySelectorAll('input[name="engagement-status"]').forEach(cb => {
      cb.checked = state.engagementStatus.includes(cb.value);
    });
  }

  // Core function that actually applies filters using data from profiles.json
  async function applyFiltersToProfiles(filterState, profilesData) {
    // Reload profiles data if not provided or empty
    if (!profilesData || profilesData.length === 0) {
      profilesData = await loadProfilesFromJson();
    }
    
    // Grab all profile elements
    const profileElements = document.querySelectorAll('.profile-item, [id^="profile-card"], .profile-card, .contact-card, .people-card');
    
    if (profileElements.length === 0) {
      console.log("No profile elements found to filter");
      return;
    }
    
    console.log(`Found ${profileElements.length} profile elements to filter`);
    
    // Create a map of profile IDs to their interactions
    const profileInteractions = new Map();
    
    // Process profile data for quick lookup
    if (profilesData && profilesData.length > 0) {
      console.log(`Processing ${profilesData.length} profiles from JSON`);
      
      profilesData.forEach(profile => {
        if (!profile.url || !profile.actions) return;
        
        // Get interaction types for this profile
        const interactionTypes = new Set(profile.actions.map(action => action.type));
        
        // Clean URL for matching
        const cleanUrl = normalizeProfileUrl(profile.url);
        profileInteractions.set(cleanUrl, interactionTypes);
        
        // Also store with original URL if different
        if (profile.originalUrl && profile.originalUrl !== profile.url) {
          const normalizedOriginal = normalizeProfileUrl(profile.originalUrl);
          if (normalizedOriginal !== cleanUrl) {
            profileInteractions.set(normalizedOriginal, interactionTypes);
          }
        }
      });
    }
    
    console.log(`Processed ${profileInteractions.size} unique profile URLs from JSON`);
    
    // Apply filters to DOM elements
    let visibleCount = 0;
    
    profileElements.forEach(profileElement => {
      // Extract profile URL or ID
      const profileUrl = extractProfileUrl(profileElement);
      
      if (!profileUrl) {
        console.log("Could not find URL for profile, skipping");
        profileElement.style.display = filterState.engagementStatus.length === 0 ? '' : 'none';
        
        if (filterState.engagementStatus.length === 0) {
          visibleCount++;
        }
        return;
      }
      
      // Normalize URL for matching
      const normalizedUrl = normalizeProfileUrl(profileUrl);
      console.log(`Processing profile element: ${normalizedUrl}`);
      
      let shouldShow = true;
      
      // If we have engagement status filters
      if (filterState.engagementStatus.length > 0) {
        // Get interactions for this profile
        const interactions = profileInteractions.get(normalizedUrl);
        
        if (!interactions) {
          // No profile data found in JSON
          console.log(`No interaction data found for profile: ${normalizedUrl}`);
          shouldShow = false;
        } else {
          // Check if this profile has any of the required interactions
          let hasMatchingInteraction = false;
          
          for (const status of filterState.engagementStatus) {
            if (interactions.has(status)) {
              console.log(`Profile ${normalizedUrl} has interaction: ${status}`);
              hasMatchingInteraction = true;
              break;
            }
          }
          
          shouldShow = hasMatchingInteraction;
        }
      }
      
      // Set profile visibility
      profileElement.style.display = shouldShow ? '' : 'none';
      if (shouldShow) {
        visibleCount++;
      }
    });
    
    // Update the count display for user feedback
    updateFilteredCount(visibleCount, profileElements.length);
    console.log(`Showing ${visibleCount} of ${profileElements.length} profiles after filtering`);
    
    return visibleCount;
  }

  // Extract profile URL from a profile element
  function extractProfileUrl(profileElement) {
    // Try data attributes first
    let profileUrl = profileElement.getAttribute('data-profile-id') || 
                     profileElement.getAttribute('data-id') ||
                     profileElement.getAttribute('data-profile-url');
    
    // Try finding links to LinkedIn profiles
    if (!profileUrl) {
      const profileLink = profileElement.querySelector('a[href*="linkedin.com/in/"]');
      if (profileLink) {
        profileUrl = profileLink.href;
      }
    }
    
    // Look for text containing LinkedIn URL
    if (!profileUrl) {
      const text = profileElement.textContent;
      const match = text.match(/linkedin\.com\/in\/([a-zA-Z0-9-]+)/);
      if (match && match[1]) {
        profileUrl = `https://www.linkedin.com/in/${match[1]}`;
      }
    }
    
    return profileUrl;
  }

  // Save visible profiles to JSON
  async function saveVisibleProfiles() {
    try {
      // Find all visible profile elements
      const visibleProfiles = Array.from(document.querySelectorAll('.profile-item, [id^="profile-card"], .profile-card, .contact-card, .people-card')).filter(el => el.style.display !== 'none');
      
      console.log(`Found ${visibleProfiles.length} visible profiles to save`);
      
      if (visibleProfiles.length === 0) {
        alert("No visible profiles to save");
        return;
      }
      
      // Array to store profile data
      const profilesToSave = [];
      
      // Process each visible profile
      visibleProfiles.forEach(profileElement => {
        try {
          // Extract profile URL
          const profileUrl = extractProfileUrl(profileElement);
          
          if (!profileUrl) {
            console.warn("Could not find URL for profile, skipping");
            return;
          }
          
          // Extract name
          const nameElement = profileElement.querySelector('h1, h2, h3, .name, .profile-name, [data-control-name="profile_name"]');
          const name = nameElement ? nameElement.textContent.trim() : 'Unknown';
          
          // Split name into first/last
          const nameParts = name.split(' ');
          const firstName = nameParts[0] || '';
          const lastName = nameParts.slice(1).join(' ') || '';
          
          // Extract title
          const titleElement = profileElement.querySelector('.title, .profile-title, .position, [data-control-name="headline"]');
          const title = titleElement ? titleElement.textContent.trim() : '';
          
          // Extract company
          const companyElement = profileElement.querySelector('.company, .profile-company, [data-control-name="company_name"]');
          const company = companyElement ? companyElement.textContent.trim() : '';
          
          // Create profile object
          const profileData = {
            url: profileUrl,
            firstName,
            lastName,
            fullName: name,
            title,
            company,
            email: 'Not Available'
          };
          
          profilesToSave.push(profileData);
        } catch (error) {
          console.error("Error processing profile element:", error);
        }
      });
      
      // Save profiles via API
      if (window.electronAPI && typeof window.electronAPI.storeProfileBatch === 'function') {
        const result = await window.electronAPI.storeProfileBatch(profilesToSave);
        console.log("Save result:", result);
        alert(`Successfully saved ${result.saved} profiles (${result.updated} updated)`);
        
        // Reload profiles data
        const updatedProfiles = await loadProfilesFromJson();
        console.log(`Reloaded ${updatedProfiles.length} profiles after saving`);
      } else {
        console.error("storeProfileBatch function not available in window.electronAPI");
        alert("Cannot save profiles: API not available");
      }
    } catch (error) {
      console.error("Error saving visible profiles:", error);
      alert(`Error saving profiles: ${error.message}`);
    }
  }

  // Debug function to help diagnose filter issues
  function debugFilters(profilesData) {
    console.log("======= PROFILE FILTERS DEBUG =======");
    
    // Load profiles if not provided
    if (!profilesData || profilesData.length === 0) {
      loadProfilesFromJson().then(profiles => {
        console.log(`Loaded ${profiles.length} profiles for debugging`);
        performDebug(profiles);
      });
    } else {
      performDebug(profilesData);
    }
    
    function performDebug(profiles) {
      // Log some sample profiles
      if (profiles.length > 0) {
        console.log("First 3 profile samples:");
        profiles.slice(0, 3).forEach((profile, index) => {
          console.log(`Profile ${index + 1}:`);
          console.log(`  URL: ${profile.url}`);
          console.log(`  Name: ${profile.firstName} ${profile.lastName}`);
          console.log(`  Actions: ${profile.actions ? profile.actions.map(a => a.type).join(', ') : 'none'}`);
        });
      }
      
      // Test the profile DOM elements
      const profileElements = document.querySelectorAll('.profile-item, [id^="profile-card"], .profile-card, .contact-card, .people-card');
      console.log(`Found ${profileElements.length} profile DOM elements`);
      
      if (profileElements.length > 0) {
        console.log("First 3 DOM elements:");
        Array.from(profileElements).slice(0, 3).forEach((el, index) => {
          const profileUrl = extractProfileUrl(el);
          
          console.log(`Element ${index + 1}:`);
          console.log(`  Profile URL: ${profileUrl || 'Not found'}`);
          
          if (profileUrl) {
            const normalizedUrl = normalizeProfileUrl(profileUrl);
            console.log(`  Normalized: ${normalizedUrl}`);
            
            // Try to find matching profile
            const matchingProfile = profiles.find(p => normalizeProfileUrl(p.url) === normalizedUrl);
            
            if (matchingProfile) {
              console.log(`  MATCH FOUND: ${matchingProfile.firstName} ${matchingProfile.lastName}`);
              console.log(`  Actions: ${matchingProfile.actions ? matchingProfile.actions.map(a => a.type).join(', ') : 'none'}`);
            } else {
              console.log(`  NO MATCH FOUND in profiles.json`);
            }
          }
        });
      }
      
      console.log("======= END DEBUG =======");
      
      alert(`Debug information logged to console. Found ${profiles.length} profiles in JSON and ${profileElements.length} profile elements in DOM.`);
    }
  }
  
  // Simple function to display how many are currently visible
  function updateFilteredCount(visibleCount, totalCount) {
    let countEl = document.querySelector('.filtered-count');
    
    if (!countEl) {
      // Try to find a place to append the count
      const titleEl = document.querySelector(
        'h2.card-title, .card-header h2, h1, h2, .section-title, .page-title, .header-title'
      );
      
      if (titleEl) {
        countEl = document.createElement('span');
        countEl.className = 'filtered-count';
        countEl.style.fontSize = '14px';
        countEl.style.fontWeight = 'normal';
        countEl.style.color = '#666';
        countEl.style.marginLeft = '10px';
        titleEl.appendChild(countEl);
      } else {
        // Fallback floating indicator
        countEl = document.createElement('div');
        countEl.className = 'filtered-count';
        countEl.style.position = 'fixed';
        countEl.style.top = '10px';
        countEl.style.right = '10px';
        countEl.style.backgroundColor = '#f3f6f8';
        countEl.style.padding = '5px 10px';
        countEl.style.borderRadius = '4px';
        countEl.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        countEl.style.zIndex = '9999';
        document.body.appendChild(countEl);
      }
    }
    
    if (visibleCount === totalCount) {
      countEl.textContent = `(${totalCount} profiles)`;
    } else {
      countEl.textContent = `(${visibleCount} of ${totalCount} profiles)`;
    }
    
    console.log(`Showing ${visibleCount} of ${totalCount} profiles`);
  }

  // ===== INITIALIZATION =====
  function injectFilterUI() {
    console.log("Injecting minimal filter UI into the page");
    
    // Remove any existing filters to avoid duplicates
    document.querySelectorAll('.profile-filter-container, #linkedin-filter-styles').forEach(el => el.remove());
    
    // Create new filter UI
    const filterUI = createFilterUI();
    
    // Try to find a place to put the filter
    let targetLocation = null;
    const exportButton = findElementByText('Export Data', 'button');
    if (exportButton && exportButton.parentElement) {
      targetLocation = exportButton.parentElement;
      targetLocation.insertBefore(filterUI, exportButton);
    } else {
      const header = document.querySelector('.card-header, header, .header, .artdeco-card__header');
      if (header) {
        const actionSection = header.querySelector('.actions, .buttons, .controls, div:last-child');
        if (actionSection) {
          actionSection.insertBefore(filterUI, actionSection.firstChild);
        } else {
          const actionContainer = document.createElement('div');
          actionContainer.style.cssText = 'display: flex; gap: 8px; margin-left: auto;';
          actionContainer.appendChild(filterUI);
          header.appendChild(actionContainer);
        }
        targetLocation = header;
      } else {
        // fallback
        filterUI.style.position = 'fixed';
        filterUI.style.top = '70px';
        filterUI.style.right = '20px';
        filterUI.style.zIndex = '9999';
        document.body.appendChild(filterUI);
        targetLocation = document.body;
      }
    }
    
    return filterUI;
  }

  function initialize() {
    console.log("Initializing minimal LinkedIn Profile Filter");
    
    const filterUI = injectFilterUI();
    setupEventHandlers(filterUI);
    
    // Watch for dynamic content to re-apply filters
    setupMutationObserver();
    
    console.log("Minimal profile filter initialized successfully");
    
    // Expose a simple global API
    window.ProfileFilter = {
      // Reset filters and show all profiles
      reset: function() {
        const container = document.querySelector('.profile-filter-container');
        if (!container) return;
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.checked = false;
        });
        
        // Remove badge and active filter labels
        const button = container.querySelector('.profile-filter-btn');
        if (button) {
          const badge = button.querySelector('.profile-filter-badge');
          if (badge) badge.remove();
        }
        const activeFilters = container.querySelector('.profile-filter-active');
        if (activeFilters) {
          activeFilters.style.display = 'none';
          activeFilters.innerHTML = '';
        }
        
        // Show all
        document.querySelectorAll('.profile-item, [id^="profile-card"], .profile-card, .contact-card, .people-card')
          .forEach(profile => { profile.style.display = ''; });
      },
      
      // Save visible profiles to JSON
      saveProfiles: saveVisibleProfiles,
      
      // Debug function
      debug: function() {
        debugFilters(null);
      }
    };
  }

  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      // If new profiles get added, reapply filters
      let newProfilesAdded = false;
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (
              node.classList?.contains('profile-item') ||
              node.classList?.contains('profile-card') ||
              node.querySelector?.('.profile-item, .profile-card')
            ) {
              newProfilesAdded = true;
            }
          }
        });
      });
      
      if (newProfilesAdded) {
        // Get current filter state
        const container = document.querySelector('.profile-filter-container');
        if (!container) return;
        
        const filterState = {
          engagementStatus: Array.from(container.querySelectorAll('input[name="engagement-status"]:checked')).map(cb => cb.value)
        };
        
        // Only reapply if we have active filters
        if (filterState.engagementStatus.length > 0) {
          console.log("New profiles added, reapplying filters");
          applyFiltersToProfiles(filterState, null);
        }
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    console.log("Mutation observer set up for dynamic content");
  }

  // Start everything
  initialize();

  console.log("Minimal LinkedIn Profile Filter loaded!");
})();
