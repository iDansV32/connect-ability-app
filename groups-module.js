// groups-module.js
document.addEventListener('DOMContentLoaded', function() {
  console.log("🚀 Groups module loading...");
  
  // Load the groups HTML content
  loadGroupsHTML();
  
  // Add navigation item if not already present
  addGroupsNavItem();
});

// Function to load the Groups HTML using fetch
function loadGroupsHTML() {
  fetch('groups.html')
    .then(response => {
      if (!response.ok) {
        throw new Error(`Failed to load groups.html: ${response.status}`);
      }
      return response.text();
    })
    .then(html => {
      // Find content area to insert the HTML
      const contentArea = document.querySelector('.content-area');
      if (!contentArea) {
        throw new Error("Could not find content-area to insert Groups section");
      }
      
      // Insert the HTML
      contentArea.insertAdjacentHTML('beforeend', html);
      
      // Set up event listeners after the content is loaded
      setupGroupEventListeners();
      
      console.log("Groups HTML content loaded successfully");
    })
    .catch(error => {
      console.error("Error loading groups HTML:", error);
    });
}

// Function to add Groups to the main navigation if not already present
function addGroupsNavItem() {
  // Container
  const navItems = document.querySelector('.nav-items');
  if (!navItems) {
    console.warn('Nav items container not found');
    return;
  }

  // Prevent duplicates
  if (navItems.querySelector('.nav-link[data-section="groups"]')) {
    console.log('Groups navigation item already exists');
    return;
  }

  // Ensure Profiles exists (used as insertion anchor)
  const profilesLink = navItems.querySelector('[data-section="profiles"]');
  const profilesNavItem = profilesLink && profilesLink.parentNode;
  if (!profilesLink || !profilesNavItem) {
    console.warn('Profiles nav item not found');
    return;
  }

  // Create Groups item
  const groupsNavItem = document.createElement('li');
  groupsNavItem.className = 'nav-item';
  groupsNavItem.innerHTML = `
    <a href="#" class="nav-link" data-section="groups">
      <div class="nav-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>
      </div>
      <span class="nav-text">Groups</span>
    </a>
  `;

  // Insert after Profiles, but before Workflows if it exists
  const workflowsLink = navItems.querySelector('[data-section="workflows"]');
  const workflowsNavItem = workflowsLink && workflowsLink.parentNode;

  if (workflowsNavItem && workflowsNavItem.parentNode === navItems) {
    navItems.insertBefore(groupsNavItem, workflowsNavItem);
    console.log('Groups navigation item added before Workflows');
  } else {
    // Insert right after Profiles
    if (profilesNavItem.nextSibling) {
      navItems.insertBefore(groupsNavItem, profilesNavItem.nextSibling);
    } else {
      navItems.appendChild(groupsNavItem);
    }
    console.log('Groups navigation item added after Profiles');
  }

  // Click handler
  const groupsLink = groupsNavItem.querySelector('.nav-link[data-section="groups"]');
  if (typeof setupNavClickHandler === 'function') {
    setupNavClickHandler(groupsLink);
  } else {
    // Fallback: basic preventDefault
    groupsLink.addEventListener('click', (e) => e.preventDefault());
  }
}


// Set up navigation click handler
function setupNavClickHandler(navLink) {
  if (!navLink) return;
  
  navLink.addEventListener('click', function(e) {
    e.preventDefault();
    
    // Update active tab
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.remove('active');
    });
    this.classList.add('active');
    
    // Update visible section
    document.querySelectorAll('.app-section').forEach(section => {
      section.classList.remove('active');
    });
    
    const groupsSection = document.getElementById('groups-section');
    if (groupsSection) {
      groupsSection.classList.add('active');
    }
    
    // Update page title
    const pageTitle = document.querySelector('.page-title');
    if (pageTitle) {
      pageTitle.textContent = 'Groups';
    }
    
    // Load groups data
    loadStandaloneGroups();
  });
}

// Set up event listeners for the Groups section
function setupGroupEventListeners() {
  // Create group button
  const createGroupBtn = document.getElementById('create-standalone-group-btn');
  const groupModal = document.getElementById('standalone-group-modal');
  
  if (createGroupBtn && groupModal) {
    createGroupBtn.addEventListener('click', function() {
      groupModal.classList.add('active');
    });
    
    // Modal close button
    const closeBtn = groupModal.querySelector('.modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        groupModal.classList.remove('active');
      });
    }
    
    // Cancel button
    const cancelBtn = document.getElementById('cancel-standalone-group');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function() {
        groupModal.classList.remove('active');
      });
    }
    
    // Save button
    const saveBtn = document.getElementById('save-standalone-group');
    if (saveBtn) {
      saveBtn.addEventListener('click', function() {
        saveNewGroup();
      });
    }
    
    // Color options
    const colorOptions = groupModal.querySelectorAll('.color-option');
    colorOptions.forEach(option => {
      option.addEventListener('click', function() {
        colorOptions.forEach(opt => opt.classList.remove('selected'));
        this.classList.add('selected');
      });
    });
  }
  
  // Make sure edit buttons work
  setupEditButtonFunctionality();
}

// Function to save a new group
function saveNewGroup() {
  const nameInput = document.getElementById('standalone-group-name');
  const descInput = document.getElementById('standalone-group-description');
  const colorOption = document.querySelector('.color-option.selected');
  
  if (!nameInput || !nameInput.value.trim()) {
    alert('Please enter a group name');
    return;
  }
  
  const name = nameInput.value.trim();
  const description = descInput ? descInput.value.trim() : '';
  const color = colorOption ? colorOption.getAttribute('data-color') : '#4285F4';
  
  // Create group object
  const group = {
    id: 'group-' + Date.now(),
    name: name,
    description: description,
    color: color,
    members: []
  };
  
  // Get existing groups
  let groups = [];
  try {
    const saved = localStorage.getItem('standalone-groups');
    if (saved) {
      groups = JSON.parse(saved);
    }
  } catch (e) {
    console.error("Error loading existing groups:", e);
  }
  
  // Add new group
  groups.push(group);
  
  // Save to localStorage
  try {
    localStorage.setItem('standalone-groups', JSON.stringify(groups));
    
    // Close modal and clear form
    const groupModal = document.getElementById('standalone-group-modal');
    if (groupModal) {
      groupModal.classList.remove('active');
    }
    
    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';
    
    // Show notification
    showNotification(`Group "${name}" created successfully`, 'success');
    
    // Refresh the groups grid
    renderStandaloneGroups(groups);
  } catch (e) {
    console.error("Error saving group:", e);
    showNotification('Error saving group', 'error');
  }
}

// Include all your existing group functions
// loadStandaloneGroups, renderStandaloneGroups, editStandaloneGroup, etc.

function loadStandaloneGroups() {
  console.log("Loading standalone groups");
  let groups = [];
  
  try {
    const saved = localStorage.getItem('standalone-groups');
    if (saved) {
      groups = JSON.parse(saved);
    }
  } catch (e) {
    console.error("Error loading groups", e);
  }
  
  renderStandaloneGroups(groups);
}

function renderStandaloneGroups(groups) {
  const groupsGrid = document.querySelector('#groups-section .groups-grid');
  if (!groupsGrid) return;
  
  // Clear existing content
  groupsGrid.innerHTML = '';
  
  // Show empty state if no groups
  if (!groups || groups.length === 0) {
    groupsGrid.innerHTML = `
      <div class="empty-state">
        <p>No groups created yet. Create a group to organize your profiles.</p>
      </div>
    `;
    return;
  }
  
  // Create group cards
  groups.forEach(group => {
    const memberCount = Array.isArray(group.members) ? group.members.length : 0;
    
    const groupCard = document.createElement('div');
    groupCard.className = 'group-card';
    groupCard.setAttribute('data-group-id', group.id);
    groupCard.style.borderLeft = `4px solid ${group.color || '#4285F4'}`;
    
    groupCard.innerHTML = `
      <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600;">${escapeHtml(group.name)}</h3>
      <p style="margin: 0 0 16px 0; color: #666; font-size: 14px;">${escapeHtml(group.description || '')}</p>
      <div style="display: flex; align-items: center; margin-top: auto;">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
        </svg>
        <span style="margin-left: 8px; font-weight: 500;">${memberCount} ${memberCount === 1 ? 'Member' : 'Members'}</span>
      </div>
      
      <div class="group-actions" style="display: flex; gap: 8px; margin-top: 16px;">
        <button class="btn btn-secondary btn-sm view-group-btn">View Details</button>
        <button class="btn btn-secondary btn-sm edit-group-btn">Edit</button>
        <button class="btn btn-secondary btn-sm delete-group-btn" style="color: #d32f2f;">Delete</button>
      </div>
    `;
    
    // Add event listeners (edit, delete, view details)
    setupGroupCardButtons(groupCard, group);
    
    groupsGrid.appendChild(groupCard);
  });
}

// Setup the buttons on group cards
function setupGroupCardButtons(groupCard, group) {
  // Edit button
  const editButton = groupCard.querySelector('.edit-group-btn');
  if (editButton) {
    editButton.addEventListener('click', (e) => {
      e.stopPropagation();
      editStandaloneGroup(group.id);
    });
  }
  
  // Delete button
  const deleteButton = groupCard.querySelector('.delete-group-btn');
  if (deleteButton) {
    deleteButton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to delete the group "${group.name}"?`)) {
        deleteStandaloneGroup(group.id);
      }
    });
  }
  
  // View details button
  const viewButton = groupCard.querySelector('.view-group-btn');
  if (viewButton) {
    viewButton.addEventListener('click', (e) => {
      e.stopPropagation();
      viewGroupDetails(group.id);
    });
  }
}

// Function to fix the edit button functionality
function setupEditButtonFunctionality() {
  // Global event listener for edit buttons
  document.addEventListener('click', function(event) {
    // Find if this is an edit button or close to one
    let editButton = event.target;
    
    if (!editButton.classList.contains('edit-group-btn') && 
        !editButton.classList.contains('edit') && 
        editButton.textContent !== 'Edit') {
      editButton = editButton.closest('.edit-group-btn, .edit');
      if (!editButton) return;
    }
    
    // Find the group ID
    const groupCard = editButton.closest('[data-group-id]');
    if (!groupCard) return;
    
    const groupId = groupCard.getAttribute('data-group-id');
    if (!groupId) return;
    
    console.log('Edit button clicked for group:', groupId);
    editStandaloneGroup(groupId);
    
    // Prevent further handling
    event.stopPropagation();
  });
}

// Edit group function
function editStandaloneGroup(groupId) {
  try {
    // Get group data
    const savedGroups = localStorage.getItem('standalone-groups');
    if (!savedGroups) {
      showNotification('No groups found', 'error');
      return;
    }
    
    const groups = JSON.parse(savedGroups);
    const group = groups.find(g => g.id === groupId);
    
    if (!group) {
      showNotification('Group not found', 'error');
      return;
    }
    
    // Create edit modal
    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.style.display = 'flex';
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
    modal.style.zIndex = '9999';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';
    
    modal.innerHTML = `
      <div class="modal-content" style="background:white; border-radius:8px; width:500px; max-width:90%; padding:20px; box-shadow:0 4px 20px rgba(0,0,0,0.15);">
        <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; border-bottom:1px solid #eee; padding-bottom:10px;">
          <h3 style="margin:0;">Edit Group: ${escapeHtml(group.name)}</h3>
          <button class="modal-close" style="background:none; border:none; font-size:24px; cursor:pointer;">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group" style="margin-bottom:15px;">
            <label for="edit-name-${groupId}" style="display:block; margin-bottom:5px;">Group Name</label>
            <input type="text" id="edit-name-${groupId}" class="form-control" value="${escapeHtml(group.name)}" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;">
          </div>
          <div class="form-group" style="margin-bottom:15px;">
            <label for="edit-desc-${groupId}" style="display:block; margin-bottom:5px;">Description</label>
            <textarea id="edit-desc-${groupId}" class="form-control" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px; min-height:100px;">${escapeHtml(group.description || '')}</textarea>
          </div>
          <div class="form-group" style="margin-bottom:15px;">
            <label style="display:block; margin-bottom:5px;">Group Color</label>
            <div class="color-options" style="display:flex; gap:10px;">
              ${['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#9C27B0'].map(color => `
                <div class="color-option ${color === group.color ? 'selected' : ''}" 
                     data-color="${color}" 
                     style="width:30px; height:30px; border-radius:50%; background-color:${color}; cursor:pointer; border:2px solid ${color === group.color ? '#000' : 'transparent'};"></div>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="modal-footer" style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px; padding-top:15px; border-top:1px solid #eee;">
          <button class="btn-cancel" style="padding:8px 16px; border-radius:4px; border:1px solid #ddd; background:#f5f5f5; cursor:pointer;">Cancel</button>
          <button class="btn-save" style="padding:8px 16px; border-radius:4px; border:none; background:#4285F4; color:white; cursor:pointer;">Save Changes</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Set up event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    modal.querySelector('.btn-cancel').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    // Color selection
    const colorOptions = modal.querySelectorAll('.color-option');
    colorOptions.forEach(option => {
      option.addEventListener('click', () => {
        colorOptions.forEach(opt => {
          opt.style.border = '2px solid transparent';
          opt.classList.remove('selected');
        });
        option.style.border = '2px solid #000';
        option.classList.add('selected');
      });
    });
    
    // Save changes
    modal.querySelector('.btn-save').addEventListener('click', () => {
      const newName = document.getElementById(`edit-name-${groupId}`).value.trim();
      const newDesc = document.getElementById(`edit-desc-${groupId}`).value.trim();
      const selectedColor = modal.querySelector('.color-option.selected');
      
      if (!newName) {
        alert('Please enter a group name');
        return;
      }
      
      // Update group
      const groupIndex = groups.findIndex(g => g.id === groupId);
      if (groupIndex !== -1) {
        groups[groupIndex].name = newName;
        groups[groupIndex].description = newDesc;
        
        if (selectedColor) {
          groups[groupIndex].color = selectedColor.getAttribute('data-color');
        }
        
        // Save to localStorage
        localStorage.setItem('standalone-groups', JSON.stringify(groups));
        
        // Show success notification
        showNotification('Group updated successfully', 'success');
        
        // Refresh UI
        renderStandaloneGroups(groups);
      }
      
      // Remove modal
      document.body.removeChild(modal);
    });
  } catch (error) {
    console.error('Error handling edit:', error);
    showNotification('An error occurred. Please try again.', 'error');
  }
}

// Delete group function
function deleteStandaloneGroup(groupId) {
  try {
    // Get groups
    const saved = localStorage.getItem('standalone-groups');
    if (!saved) return;
    
    let groups = JSON.parse(saved);
    
    // Remove the specified group
    groups = groups.filter(g => g.id !== groupId);
    
    // Save changes
    localStorage.setItem('standalone-groups', JSON.stringify(groups));
    
    // Re-render groups
    renderStandaloneGroups(groups);
    
    // Show notification
    showNotification("Group deleted successfully", 'success');
  } catch (e) {
    console.error("Error deleting group", e);
    showNotification('Error deleting group', 'error');
  }
}

// View group details (placeholder)
function viewGroupDetails(groupId) {
  // Get group
  const saved = localStorage.getItem('standalone-groups');
  if (!saved) return;
  
  const groups = JSON.parse(saved);
  const group = groups.find(g => g.id === groupId);
  if (!group) return;
  
  // Just a simple alert for now - you can expand this
  alert(`Group Details: ${group.name}\n\nMembers: ${group.members?.length || 0}\nDescription: ${group.description || 'No description'}`);
}

// Helper function for notifications
function showNotification(message, type = 'success') {
  // Remove any existing notifications
  document.querySelectorAll('.notification').forEach(n => n.remove());
  
  // Create notification
  const notification = document.createElement('div');
  notification.className = 'notification ' + type;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background-color: ${type === 'success' ? '#4caf50' : '#f44336'};
    color: white;
    padding: 12px 16px;
    border-radius: 4px;
    z-index: 9999;
    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
  `;
  
  document.body.appendChild(notification);
  
  // Remove after 3 seconds
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

// Utility function to escape HTML
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
// Function to view group details with profile management
function viewGroupDetails(groupId) {
  // Get group data
  const saved = localStorage.getItem('standalone-groups');
  if (!saved) {
    showNotification('No groups found', 'error');
    return;
  }
  
  const groups = JSON.parse(saved);
  const group = groups.find(g => g.id === groupId);
  
  if (!group) {
    showNotification('Group not found', 'error');
    return;
  }
  
  // Create a modal for group details and profile management
  const modal = document.createElement('div');
  modal.className = 'modal active group-details-modal';
  modal.style.display = 'flex';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100%';
  modal.style.height = '100%';
  modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
  modal.style.zIndex = '9999';
  modal.style.justifyContent = 'center';
  modal.style.alignItems = 'center';
  
  // Create modal content
  modal.innerHTML = `
    <div class="modal-content" style="background:white; border-radius:8px; width:800px; max-width:90%; max-height:90vh; display:flex; flex-direction:column; box-shadow:0 4px 20px rgba(0,0,0,0.15);">
      <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:15px 20px; border-bottom:1px solid #eee;">
        <h3 style="margin:0; display:flex; align-items:center;">
          <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background-color:${group.color || '#4285F4'}; margin-right:8px;"></span>
          ${escapeHtml(group.name)} (${group.members?.length || 0} members)
        </h3>
        <button class="modal-close" style="background:none; border:none; font-size:24px; cursor:pointer;">&times;</button>
      </div>
      
      <div class="modal-body" style="padding:15px 20px; overflow-y:auto; flex:1;">
        <p style="color:#666; margin-bottom:20px;">${escapeHtml(group.description || 'No description')}</p>
        
        <div class="profiles-actions" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
          <div class="search-container" style="flex:1; max-width:400px;">
            <input type="text" id="search-group-profiles" placeholder="Search profiles..." style="width:100%; padding:8px 12px; border:1px solid #ddd; border-radius:4px;">
          </div>
          <div class="profiles-controls">
            <button id="select-all-profiles" class="btn btn-secondary btn-sm" style="margin-right:8px;">Select All</button>
            <button id="add-profiles-btn" class="btn btn-primary btn-sm">Add Profiles</button>
          </div>
        </div>
        
        <div class="bulk-actions" style="margin-bottom:15px; display:none;">
          <button id="remove-selected" class="btn btn-danger btn-sm" style="background:#f44336; color:white; border:none;">Remove Selected</button>
        </div>
        
        <div class="profiles-container" style="border:1px solid #eee; border-radius:8px; padding:10px; max-height:400px; overflow-y:auto;">
          <div class="profiles-list" id="group-profiles-list">
            <!-- Profiles will be loaded here -->
            <div class="empty-state" style="text-align:center; padding:40px 20px; color:#666;">
              <p>No profiles in this group yet.</p>
              <p>Click "Add Profiles" to start adding profiles to this group.</p>
            </div>
          </div>
        </div>
      </div>
      
      <div class="modal-footer" style="padding:15px 20px; border-top:1px solid #eee; display:flex; justify-content:flex-end; gap:10px;">
        <button id="close-group-details" class="btn btn-secondary">Close</button>
        <button id="save-group-changes" class="btn btn-primary">Save Changes</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Get DOM elements
  const searchInput = modal.querySelector('#search-group-profiles');
  const selectAllBtn = modal.querySelector('#select-all-profiles');
  const addProfilesBtn = modal.querySelector('#add-profiles-btn');
  const removeSelectedBtn = modal.querySelector('#remove-selected');
  const bulkActions = modal.querySelector('.bulk-actions');
  const profilesList = modal.querySelector('#group-profiles-list');
  const closeBtn = modal.querySelector('.modal-close');
  const cancelBtn = modal.querySelector('#close-group-details');
  const saveBtn = modal.querySelector('#save-group-changes');
  
  // Initialize data
  let selectedProfiles = [];
  let currentMembers = Array.isArray(group.members) ? [...group.members] : [];
  let allProfiles = [];
  
  // Load all profiles
  loadProfilesData().then(profiles => {
    allProfiles = profiles;
    renderGroupProfiles();
  });
  
  // Event listeners
  closeBtn.addEventListener('click', () => document.body.removeChild(modal));
  cancelBtn.addEventListener('click', () => document.body.removeChild(modal));
  
  // Select All button
  selectAllBtn.addEventListener('click', () => {
    const checkboxes = profilesList.querySelectorAll('.profile-checkbox');
    const isAllSelected = selectedProfiles.length === currentMembers.length;
    
    checkboxes.forEach(checkbox => {
      checkbox.checked = !isAllSelected;
    });
    
    if (isAllSelected) {
      selectedProfiles = [];
    } else {
      selectedProfiles = [...currentMembers];
    }
    
    updateBulkActions();
  });
  
  // Search functionality
  searchInput.addEventListener('input', () => {
    renderGroupProfiles();
  });
  
  // Add Profiles button
  addProfilesBtn.addEventListener('click', () => {
    showAddProfilesModal(allProfiles, currentMembers, (newProfiles) => {
      // Add new profiles to current members
      currentMembers = [...currentMembers, ...newProfiles];
      renderGroupProfiles();
    });
  });
  
  // Remove Selected button
  removeSelectedBtn.addEventListener('click', () => {
    if (selectedProfiles.length === 0) return;
    
    const confirmRemove = confirm(`Are you sure you want to remove ${selectedProfiles.length} profile(s) from this group?`);
    if (!confirmRemove) return;
    
    // Remove selected profiles
    currentMembers = currentMembers.filter(id => !selectedProfiles.includes(id));
    selectedProfiles = [];
    renderGroupProfiles();
    updateBulkActions();
  });
  
  // Save Changes button
  saveBtn.addEventListener('click', () => {
    // Update group members
    const groupIndex = groups.findIndex(g => g.id === groupId);
    if (groupIndex !== -1) {
      groups[groupIndex].members = currentMembers;
      localStorage.setItem('standalone-groups', JSON.stringify(groups));
      showNotification('Group changes saved successfully', 'success');
      
      // Refresh the groups list
      renderStandaloneGroups(groups);
    }
    
    document.body.removeChild(modal);
  });
  
  // Function to render profiles in the group
  function renderGroupProfiles() {
    const searchTerm = searchInput.value.toLowerCase().trim();
    
    // If no members, show empty state
    if (currentMembers.length === 0) {
      profilesList.innerHTML = `
        <div class="empty-state" style="text-align:center; padding:40px 20px; color:#666;">
          <p>No profiles in this group yet.</p>
          <p>Click "Add Profiles" to start adding profiles to this group.</p>
        </div>
      `;
      return;
    }
    
    // Filter current members by search term
    const filteredProfiles = allProfiles.filter(profile => {
      // Make sure this profile is in current members
      if (!currentMembers.includes(profile.id) && 
          !currentMembers.includes(profile.url) && 
          !currentMembers.includes(profile.profileUrl)) {
        return false;
      }
      
      // Filter by search term
      if (!searchTerm) return true;
      
      const fullName = `${profile.firstName} ${profile.lastName}`.toLowerCase();
      const company = (profile.company || '').toLowerCase();
      const title = (profile.title || '').toLowerCase();
      
      return fullName.includes(searchTerm) || 
             company.includes(searchTerm) || 
             title.includes(searchTerm);
    });
    
    // Render profiles
    if (filteredProfiles.length === 0) {
      profilesList.innerHTML = `
        <div class="empty-state" style="text-align:center; padding:20px; color:#666;">
          <p>No profiles match your search.</p>
        </div>
      `;
      return;
    }
    
    profilesList.innerHTML = '';
    
    filteredProfiles.forEach(profile => {
      const profileId = profile.id || profile.url || profile.profileUrl;
      const isSelected = selectedProfiles.includes(profileId);
      
      const profileItem = document.createElement('div');
      profileItem.className = 'profile-item';
      profileItem.dataset.id = profileId;
      profileItem.style.cssText = `
        display: flex;
        align-items: center;
        padding: 12px;
        border-bottom: 1px solid #eee;
        background-color: ${isSelected ? '#f0f7ff' : 'white'};
      `;
      
      // Get initials for avatar
      const initials = `${profile.firstName ? profile.firstName.charAt(0) : ''}${profile.lastName ? profile.lastName.charAt(0) : ''}`.toUpperCase();
      
      profileItem.innerHTML = `
        <div class="profile-select" style="margin-right: 12px;">
          <input type="checkbox" class="profile-checkbox" ${isSelected ? 'checked' : ''}>
        </div>
        <div class="profile-avatar" style="width: 40px; height: 40px; border-radius: 50%; background-color: #f0f7ff; color: #0a66c2; display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 12px;">
          ${initials}
        </div>
        <div class="profile-info" style="flex: 1;">
          <div class="profile-name" style="font-weight: bold;">${escapeHtml(profile.firstName || '')} ${escapeHtml(profile.lastName || '')}</div>
          <div class="profile-title" style="font-size: 13px; color: #666;">${escapeHtml(profile.title || '')}</div>
          <div class="profile-company" style="font-size: 13px; color: #666;">${escapeHtml(profile.company || '')}</div>
        </div>
      `;
      
      // Checkbox event listener
      const checkbox = profileItem.querySelector('.profile-checkbox');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedProfiles.push(profileId);
        } else {
          selectedProfiles = selectedProfiles.filter(id => id !== profileId);
        }
        
        profileItem.style.backgroundColor = checkbox.checked ? '#f0f7ff' : 'white';
        updateBulkActions();
      });
      
      // Click on profile item also toggles checkbox
      profileItem.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change'));
        }
      });
      
      profilesList.appendChild(profileItem);
    });
  }
  
  // Update visibility of bulk actions based on selection
  function updateBulkActions() {
    if (selectedProfiles.length > 0) {
      bulkActions.style.display = 'block';
      removeSelectedBtn.textContent = `Remove Selected (${selectedProfiles.length})`;
    } else {
      bulkActions.style.display = 'none';
    }
  }
}

// Function to load all profiles data
function loadProfilesData() {
  return new Promise((resolve) => {
    // If the app has a specific API for loading profiles, use that
    if (window.electronAPI && typeof window.electronAPI.loadProfilesFromJson === 'function') {
      window.electronAPI.loadProfilesFromJson()
        .then(profiles => resolve(profiles))
        .catch(error => {
          console.error('Error loading profiles:', error);
          resolve([]);
        });
    } else {
      // Fallback to sample data or empty array
      console.log('No API available to load profiles, using sample data');
      resolve(getSampleProfiles());
    }
  });
}

// Fallback sample profiles data if API not available
function getSampleProfiles() {
  return [
    {
      id: 'profile-1',
      firstName: 'Sarah',
      lastName: 'Johnson',
      title: 'Marketing Manager',
      company: 'Tech Solutions Inc.',
      email: 'sarah@example.com'
    },
    {
      id: 'profile-2',
      firstName: 'John',
      lastName: 'Smith',
      title: 'Software Engineer',
      company: 'CodeCraft',
      email: 'john@example.com'
    },
    {
      id: 'profile-3',
      firstName: 'Emily',
      lastName: 'Davis',
      title: 'Product Designer',
      company: 'Design Hub',
      email: 'emily@example.com'
    },
    {
      id: 'profile-4',
      firstName: 'Michael',
      lastName: 'Wilson',
      title: 'Sales Director',
      company: 'Growth Partners',
      email: 'michael@example.com'
    },
    {
      id: 'profile-5',
      firstName: 'Jessica',
      lastName: 'Brown',
      title: 'SEO Specialist',
      company: 'Digital Marketing Co.',
      email: 'jessica@example.com'
    }
  ];
}

// Show modal to add profiles to group
function showAddProfilesModal(allProfiles, currentMembers, onAddCallback) {
  // Create modal
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.style.display = 'flex';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100%';
  modal.style.height = '100%';
  modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
  modal.style.zIndex = '10000'; // Higher than the group details modal
  modal.style.justifyContent = 'center';
  modal.style.alignItems = 'center';
  
  // Create modal content
  modal.innerHTML = `
    <div class="modal-content" style="background:white; border-radius:8px; width:700px; max-width:90%; max-height:90vh; display:flex; flex-direction:column; box-shadow:0 4px 20px rgba(0,0,0,0.15);">
      <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:15px 20px; border-bottom:1px solid #eee;">
        <h3 style="margin:0;">Add Profiles to Group</h3>
        <button class="modal-close" style="background:none; border:none; font-size:24px; cursor:pointer;">&times;</button>
      </div>
      
      <div class="modal-body" style="padding:15px 20px; overflow-y:auto; flex:1;">
        <div class="search-container" style="margin-bottom:15px;">
          <input type="text" id="search-add-profiles" placeholder="Search profiles..." style="width:100%; padding:8px 12px; border:1px solid #ddd; border-radius:4px;">
        </div>
        
        <div class="select-all-container" style="margin-bottom:15px;">
          <label style="display:flex; align-items:center; cursor:pointer;">
            <input type="checkbox" id="select-all-add-profiles" style="margin-right:8px;">
            <span>Select All Available Profiles</span>
          </label>
        </div>
        
        <div class="profiles-container" style="border:1px solid #eee; border-radius:8px; padding:10px; max-height:400px; overflow-y:auto;">
          <div class="profiles-list" id="add-profiles-list">
            <!-- Profiles will be loaded here -->
            <div class="loading-state" style="text-align:center; padding:20px; color:#666;">
              <p>Loading profiles...</p>
            </div>
          </div>
        </div>
      </div>
      
      <div class="modal-footer" style="padding:15px 20px; border-top:1px solid #eee; display:flex; justify-content:flex-end; gap:10px;">
        <button id="cancel-add-profiles" class="btn btn-secondary">Cancel</button>
        <button id="confirm-add-profiles" class="btn btn-primary">Add Selected Profiles</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Get DOM elements
  const searchInput = modal.querySelector('#search-add-profiles');
  const selectAllCheckbox = modal.querySelector('#select-all-add-profiles');
  const profilesList = modal.querySelector('#add-profiles-list');
  const closeBtn = modal.querySelector('.modal-close');
  const cancelBtn = modal.querySelector('#cancel-add-profiles');
  const confirmBtn = modal.querySelector('#confirm-add-profiles');
  
  // Variables
  let selectedToAdd = [];
  let filteredProfiles = [];
  
  // Initialize available profiles (exclude current members)
  const availableProfiles = allProfiles.filter(profile => {
    const profileId = profile.id || profile.url || profile.profileUrl;
    return !currentMembers.includes(profileId);
  });
  
  // Render available profiles
  function renderAvailableProfiles() {
    const searchTerm = searchInput.value.toLowerCase().trim();
    
    // Filter profiles by search term
    filteredProfiles = availableProfiles.filter(profile => {
      if (!searchTerm) return true;
      
      const fullName = `${profile.firstName} ${profile.lastName}`.toLowerCase();
      const company = (profile.company || '').toLowerCase();
      const title = (profile.title || '').toLowerCase();
      
      return fullName.includes(searchTerm) || 
             company.includes(searchTerm) || 
             title.includes(searchTerm);
    });
    
    // If no profiles available, show message
    if (filteredProfiles.length === 0) {
      profilesList.innerHTML = `
        <div class="empty-state" style="text-align:center; padding:20px; color:#666;">
          <p>${searchTerm ? 'No profiles match your search.' : 'No profiles available to add.'}</p>
        </div>
      `;
      return;
    }
    
    // Render profiles
    profilesList.innerHTML = '';
    
    filteredProfiles.forEach(profile => {
      const profileId = profile.id || profile.url || profile.profileUrl;
      const isSelected = selectedToAdd.includes(profileId);
      
      const profileItem = document.createElement('div');
      profileItem.className = 'profile-item';
      profileItem.dataset.id = profileId;
      profileItem.style.cssText = `
        display: flex;
        align-items: center;
        padding: 12px;
        border-bottom: 1px solid #eee;
        background-color: ${isSelected ? '#f0f7ff' : 'white'};
      `;
      
      // Get initials for avatar
      const initials = `${profile.firstName ? profile.firstName.charAt(0) : ''}${profile.lastName ? profile.lastName.charAt(0) : ''}`.toUpperCase();
      
      profileItem.innerHTML = `
        <div class="profile-select" style="margin-right: 12px;">
          <input type="checkbox" class="profile-add-checkbox" ${isSelected ? 'checked' : ''}>
        </div>
        <div class="profile-avatar" style="width: 40px; height: 40px; border-radius: 50%; background-color: #f0f7ff; color: #0a66c2; display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 12px;">
          ${initials}
        </div>
        <div class="profile-info" style="flex: 1;">
          <div class="profile-name" style="font-weight: bold;">${escapeHtml(profile.firstName || '')} ${escapeHtml(profile.lastName || '')}</div>
          <div class="profile-title" style="font-size: 13px; color: #666;">${escapeHtml(profile.title || '')}</div>
          <div class="profile-company" style="font-size: 13px; color: #666;">${escapeHtml(profile.company || '')}</div>
        </div>
      `;
      
      // Checkbox event listener
      const checkbox = profileItem.querySelector('.profile-add-checkbox');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedToAdd.push(profileId);
        } else {
          selectedToAdd = selectedToAdd.filter(id => id !== profileId);
        }
        
        profileItem.style.backgroundColor = checkbox.checked ? '#f0f7ff' : 'white';
        updateSelectAllCheckbox();
        updateConfirmButton();
      });
      
      // Click on profile item also toggles checkbox
      profileItem.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change'));
        }
      });
      
      profilesList.appendChild(profileItem);
    });
    
    updateSelectAllCheckbox();
    updateConfirmButton();
  }
  
  // Select all checkbox handling
  selectAllCheckbox.addEventListener('change', () => {
    const isChecked = selectAllCheckbox.checked;
    
    // Update all checkboxes
    const checkboxes = profilesList.querySelectorAll('.profile-add-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.checked = isChecked;
      checkbox.dispatchEvent(new Event('change'));
    });
    
    // Update selected profiles
    if (isChecked) {
      selectedToAdd = filteredProfiles.map(profile => profile.id || profile.url || profile.profileUrl);
    } else {
      selectedToAdd = [];
    }
    
    // Update UI
    renderAvailableProfiles();
  });
  
  // Update Select All checkbox based on current selection
  function updateSelectAllCheckbox() {
    if (filteredProfiles.length === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.disabled = true;
      return;
    }
    
    selectAllCheckbox.disabled = false;
    
    const allSelected = filteredProfiles.every(profile => {
      const profileId = profile.id || profile.url || profile.profileUrl;
      return selectedToAdd.includes(profileId);
    });
    
    selectAllCheckbox.checked = allSelected;
  }
  
  // Update confirm button based on selection
  function updateConfirmButton() {
    confirmBtn.textContent = `Add Selected Profiles (${selectedToAdd.length})`;
    confirmBtn.disabled = selectedToAdd.length === 0;
  }
  
  // Search input handling
  searchInput.addEventListener('input', renderAvailableProfiles);
  
  // Close modal
  function closeModal() {
    document.body.removeChild(modal);
  }
  
  // Event listeners
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  
  // Confirm button
  confirmBtn.addEventListener('click', () => {
    if (selectedToAdd.length === 0) return;
    
    // Call the callback with selected profiles
    onAddCallback(selectedToAdd);
    closeModal();
  });
  
  // Initialize
  renderAvailableProfiles();
}
