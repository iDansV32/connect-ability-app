/**
 * Enhanced Automation Group Selector
 * - Improved localStorage handling
 * - Better error handling and debugging
 * - Multiple initialization methods
 * - Support for different storage formats
 */
class EnhancedAutomationGroupSelector {
    constructor() {
      this.groups = [];
      this.initialized = false;
      this.storageKeys = ['standalone-groups', 'groups', 'profile-groups']; // Try multiple possible keys
      this.debug = true; // Set to true for detailed console logs
      
      // Don't initialize immediately to avoid timing issues
      // Instead, we'll call initialize explicitly
    }
    
    // Main initialization method - call this explicitly
    initialize() {
      if (this.initialized) {
        this.log('Already initialized, refreshing instead');
        return this.refresh();
      }
      
      this.log('Initializing group selector');
      const loaded = this.loadGroups();
      
      if (loaded) {
        this.initializeUI();
        this.setupEventListeners();
        this.initialized = true;
        this.log(`Successfully initialized with ${this.groups.length} groups`);
        return true;
      } else {
        this.log('Failed to initialize - no groups found');
        // Create an empty dropdown anyway
        this.initializeUI();
        this.setupEventListeners();
        this.initialized = true;
        return false;
      }
    }
    
    // Load groups from any available storage source
    loadGroups() {
      let groupsLoaded = false;
      
      // Try all possible storage keys
      for (const key of this.storageKeys) {
        try {
          const data = localStorage.getItem(key);
          if (data) {
            const parsedData = JSON.parse(data);
            
            // Check if it's an array
            if (Array.isArray(parsedData) && parsedData.length > 0) {
              this.groups = parsedData;
              this.log(`Successfully loaded ${this.groups.length} groups from '${key}'`);
              groupsLoaded = true;
              break;
            } else if (typeof parsedData === 'object' && parsedData !== null) {
              // Handle case where groups might be stored in a property
              const possibleGroups = Object.values(parsedData).find(val => 
                Array.isArray(val) && val.length > 0 && val[0].hasOwnProperty('name')
              );
              
              if (possibleGroups) {
                this.groups = possibleGroups;
                this.log(`Found ${this.groups.length} groups in object property from '${key}'`);
                groupsLoaded = true;
                break;
              }
            }
          }
        } catch (error) {
          this.log(`Error loading groups from '${key}':`, error, true);
        }
      }
      
      if (!groupsLoaded) {
        this.log('No groups found in any storage location', null, true);
        return false;
      }
      
      // Verify group format
      this.groups = this.groups.filter(group => {
        return group && group.id && group.name;
      });
      
      this.log(`Filtered to ${this.groups.length} valid groups`);
      return this.groups.length > 0;
    }
    
    // Create a custom dropdown for better UX and to fix disappearing issue
    initializeUI() {
      this.log('Initializing UI');
      
      // Get parent container for the dropdown
      let parentContainer = null;
      const formGroup = document.querySelector('.form-group:has(#automation-group-select)');
      const originalSelect = document.getElementById('automation-group-select');
      
      if (originalSelect) {
        parentContainer = originalSelect.parentElement;
        this.log('Found original select element');
      } else if (formGroup) {
        parentContainer = formGroup;
        this.log('Found form group container');
      } else {
        // Look for the closest automation form element that might contain our dropdown
        const automationForm = document.getElementById('automation-form');
        if (automationForm) {
          // Find a good place to insert our dropdown
          const formGroups = automationForm.querySelectorAll('.form-group');
          if (formGroups.length > 1) {
            parentContainer = formGroups[1]; // Usually after search query
            this.log('Using second form group as parent container');
          } else {
            parentContainer = automationForm;
            this.log('Using automation form as parent container');
          }
        } else {
          this.log('Could not find a suitable parent container', null, true);
          return false;
        }
      }
      
      // Remove existing dropdown if present
      const existingDropdown = document.querySelector('.custom-dropdown-container');
      if (existingDropdown) {
        existingDropdown.remove();
        this.log('Removed existing dropdown');
      }
      
      // Remove existing select if present
      if (originalSelect) {
        originalSelect.remove();
        this.log('Removed existing select element');
      }
      
      // Create label if it doesn't exist
      let labelElement = parentContainer.querySelector('.form-label');
      if (!labelElement) {
        labelElement = document.createElement('label');
        labelElement.className = 'form-label';
        labelElement.textContent = 'Filter by Group';
        parentContainer.prepend(labelElement);
        this.log('Created new label element');
      }
      
      // Create container for custom dropdown
      const dropdownContainer = document.createElement('div');
      dropdownContainer.className = 'custom-dropdown-container';
      dropdownContainer.style.cssText = `
        width: 100%;
        position: relative;
        margin-bottom: 15px;
      `;
      
      // Create the dropdown header/selector
      const dropdownSelector = document.createElement('div');
      dropdownSelector.className = 'custom-dropdown-selector';
      dropdownSelector.setAttribute('data-value', '');
      dropdownSelector.style.cssText = `
        padding: 8px 12px;
        border: 1px solid #dce0e6;
        border-radius: 4px;
        background-color: white;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        position: relative;
      `;
      dropdownSelector.innerHTML = `
        <span class="selected-text">All Profiles</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" 
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      `;
      
      // Create dropdown options menu
      const dropdownMenu = document.createElement('div');
      dropdownMenu.className = 'custom-dropdown-menu';
      dropdownMenu.style.cssText = `
        position: absolute;
        top: 100%;
        left: 0;
        width: 100%;
        background: white;
        border: 1px solid #dce0e6;
        border-radius: 0 0 4px 4px;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        z-index: 100;
        max-height: 250px;
        overflow-y: auto;
        display: none;
      `;
      
      // Add "All Profiles" option
      const defaultOption = document.createElement('div');
      defaultOption.className = 'custom-dropdown-option';
      defaultOption.setAttribute('data-value', '');
      defaultOption.textContent = 'All Profiles';
      defaultOption.style.cssText = `
        padding: 8px 12px;
        cursor: pointer;
        transition: background-color 0.2s;
      `;
      dropdownMenu.appendChild(defaultOption);
      
      // Add groups as options
      if (this.groups.length > 0) {
        this.groups.forEach(group => {
          const membersCount = group.members?.length || 0;
          const option = document.createElement('div');
          option.className = 'custom-dropdown-option';
          option.setAttribute('data-value', group.id);
          option.textContent = `${group.name} (${membersCount} profiles)`;
          option.style.cssText = `
            padding: 8px 12px;
            cursor: pointer;
            transition: background-color 0.2s;
          `;
          
          // Add a colored indicator based on group color if available
          if (group.color) {
            option.style.borderLeft = `4px solid ${group.color}`;
            option.style.paddingLeft = '8px';
          }
          
          dropdownMenu.appendChild(option);
        });
      } else {
        // Add a disabled option if no groups
        const noGroupsOption = document.createElement('div');
        noGroupsOption.className = 'custom-dropdown-option disabled';
        noGroupsOption.textContent = 'No groups available';
        noGroupsOption.style.cssText = `
          padding: 8px 12px;
          color: #888;
          font-style: italic;
        `;
        dropdownMenu.appendChild(noGroupsOption);
      }
      
      // Add elements to the container
      dropdownContainer.appendChild(dropdownSelector);
      dropdownContainer.appendChild(dropdownMenu);
      
      // Create a hidden select element to store the value for form submission
      const hiddenSelect = document.createElement('select');
      hiddenSelect.id = 'automation-group-select';
      hiddenSelect.name = 'automation-group-select';
      hiddenSelect.style.display = 'none';
      
      // Add options to hidden select
      const defaultHiddenOption = document.createElement('option');
      defaultHiddenOption.value = '';
      defaultHiddenOption.textContent = 'All Profiles';
      defaultHiddenOption.selected = true;
      hiddenSelect.appendChild(defaultHiddenOption);
      
      this.groups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        hiddenSelect.appendChild(option);
      });
      
      // Add hint text if needed
      const hintText = document.createElement('div');
      hintText.className = 'hint-text';
      hintText.textContent = 'Select a specific group to limit automation to its members. When a group is selected, the profile limit will automatically adjust.';
      hintText.style.fontSize = '12px';
      hintText.style.color = '#666';
      hintText.style.marginTop = '5px';
      
      // Add all elements to parent
      parentContainer.appendChild(dropdownContainer);
      parentContainer.appendChild(hiddenSelect);
      parentContainer.appendChild(hintText);
      
      // Setup dropdown event listeners
      dropdownSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = dropdownMenu.style.display === 'block';
        dropdownMenu.style.display = isVisible ? 'none' : 'block';
        
        // Add active class for styling
        if (!isVisible) {
          dropdownSelector.classList.add('active');
        } else {
          dropdownSelector.classList.remove('active');
        }
      });
      
      // Option selection
      const options = dropdownMenu.querySelectorAll('.custom-dropdown-option:not(.disabled)');
      options.forEach(option => {
        // Add hover effect
        option.addEventListener('mouseover', () => {
          option.style.backgroundColor = '#f3f6f8';
        });
        
        option.addEventListener('mouseout', () => {
          option.style.backgroundColor = 'transparent';
        });
        
        // Handle option selection
        option.addEventListener('click', (e) => {
          e.stopPropagation();
          const value = option.getAttribute('data-value');
          const text = option.textContent;
          
          // Update the displayed value
          dropdownSelector.querySelector('.selected-text').textContent = text;
          dropdownSelector.setAttribute('data-value', value);
          
          // Update the hidden select value
          hiddenSelect.value = value;
          
          // Close the dropdown
          dropdownMenu.style.display = 'none';
          dropdownSelector.classList.remove('active');
          
          // Trigger change event
          const changeEvent = new Event('change', { bubbles: true });
          hiddenSelect.dispatchEvent(changeEvent);
          
          this.log(`Selected group: ${text} with value: ${value}`);
        });
      });
      
      // Close dropdown when clicking outside
      document.addEventListener('click', () => {
        dropdownMenu.style.display = 'none';
        dropdownSelector.classList.remove('active');
      });
      
      this.log('Dropdown UI created successfully');
      return true;
    }
    
    // Setup event listeners
    setupEventListeners() {
      // Listen for changes on the hidden select
      const groupSelect = document.getElementById('automation-group-select');
      if (groupSelect) {
        groupSelect.addEventListener('change', this.handleGroupSelection.bind(this));
        this.log('Set up change listener on select element');
      }
      
      // Re-initialize dropdown when navigation changes sections
      document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
          if (link.getAttribute('data-section') === 'automation') {
            // Short delay to ensure DOM is ready
            setTimeout(() => this.refresh(), 100);
            this.log('Added refresh on navigation to automation section');
          }
        });
      });
      
      // Add a manual refresh button for testing
      if (this.debug) {
        const automationForm = document.getElementById('automation-form');
        if (automationForm) {
          const refreshBtn = document.createElement('button');
          refreshBtn.type = 'button';
          refreshBtn.className = 'btn btn-secondary btn-sm';
          refreshBtn.textContent = 'Refresh Groups';
          refreshBtn.style.marginLeft = '10px';
          refreshBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.refresh();
          });
          
          // Find a good place to add the button
          const actionButtons = automationForm.querySelector('.btn-group');
          if (actionButtons) {
            actionButtons.appendChild(refreshBtn);
            this.log('Added debug refresh button');
          }
        }
      }
    }
    
    // Handle group selection in automation settings
    handleGroupSelection(event) {
      const selectedGroupId = event.target.value;
      const profileLimit = document.getElementById('profile-limit');
      
      if (!profileLimit) {
        this.log('Profile limit element not found', null, true);
        return;
      }
      
      if (selectedGroupId) {
        // If a specific group is selected
        const group = this.groups.find(g => g.id === selectedGroupId);
        const groupProfiles = group ? group.members : null;
        
        if (groupProfiles && groupProfiles.length > 0) {
          // Set profile limit to the number of profiles in the group
          profileLimit.value = groupProfiles.length;
          
          this.log(`Updated profile limit to ${groupProfiles.length} profiles from group: ${group.name}`);
        } else {
          // Reset profile limit if group has no profiles
          profileLimit.value = 10;
          this.log('Group has no profiles, reset limit to 10');
        }
      } else {
        // Reset to default when "All Profiles" is selected
        profileLimit.value = 10;
        this.log('Reset profile limit to 10 (All Profiles selected)');
      }
    }
    
    // Refresh the dropdown
    refresh() {
      this.log('Refreshing group selector');
      this.loadGroups();
      return this.initializeUI();
    }
    
    // Get the currently selected group
    getSelectedGroup() {
      const selector = document.querySelector('.custom-dropdown-selector');
      if (!selector) return null;
      
      const groupId = selector.getAttribute('data-value');
      if (!groupId) return null;
      
      return this.groups.find(g => g.id === groupId);
    }
    
    // Helper function to get profiles for selected group
    getSelectedGroupProfiles() {
      const group = this.getSelectedGroup();
      return group ? group.members : null;
    }
    
    // Modify automation config with group profiles if needed
    modifyAutomationConfig(config) {
      const group = this.getSelectedGroup();
      
      if (group && group.members && group.members.length > 0) {
        config.groupProfiles = group.members;
        config.selectedGroupId = group.id;
        config.selectedGroupName = group.name;
        
        this.log(`Using ${group.members.length} profiles from ${group.name}`);
      }
      
      return config;
    }
    
    // Logging utility
    log(message, data = null, isError = false) {
      if (!this.debug) return;
      
      const prefix = '[GroupSelector]';
      
      if (isError) {
        console.error(`${prefix} ERROR: ${message}`, data || '');
      } else {
        console.log(`${prefix} ${message}`, data || '');
      }
    }
    
    // Manual load for cases where initialization needs to be triggered explicitly
    manualInit() {
      this.initialize();
    }
  }
  
  // Create the instance
  const enhancedGroupSelector = new EnhancedAutomationGroupSelector();
  
  // Initialize on document ready
  document.addEventListener('DOMContentLoaded', () => {
    // Short timeout to ensure everything is loaded
    setTimeout(() => {
      enhancedGroupSelector.initialize();
    }, 500);
  });
  
  // Make it globally available
  window.AutomationGroupSelector = enhancedGroupSelector;
  
  // For compatibility with existing code
  window.automationGroupSelector = enhancedGroupSelector;