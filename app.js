const electronAPIBridge = Object.assign({}, window.electronAPI || {});
Object.assign(electronAPIBridge, {
  startAutomation: (config) => window.electronAPI.startAutomation(config),
  startNameListAutomation: (config) => window.electronAPI.startNameListAutomation(config),
  stopAutomation: (payload) => window.electronAPI.stopAutomation(payload),
  saveCredentials: (credentials) => window.electronAPI.saveCredentials(credentials),
  loadCredentials: () => window.electronAPI.loadCredentials(),
  getAllProfiles: () => window.electronAPI.getAllProfiles(),
  getProfileData: (profileId) => window.electronAPI.getProfileData(profileId),
  exportLogs: (logs) => window.electronAPI.exportLogs(logs),
  exportEmails: () => window.electronAPI.exportEmails(),
  exportActivityReport: (filters) => window.electronAPI.exportActivityReport(filters),
  exportDiagnosticsReport: (filters) => window.electronAPI.exportDiagnosticsReport(filters),
  getApolloIntegration: () => window.electronAPI.getApolloIntegration(),
  getApolloSyncStatus: (filters) => window.electronAPI.getApolloSyncStatus(filters),
  listApolloBindings: (filters) => window.electronAPI.listApolloBindings(filters),
  onLog: (callback) => window.electronAPI.onAutomationLog(callback),
  onProgress: (callback) => window.electronAPI.onAutomationProgress(callback),
  onAutomationCompleted: (callback) => window.electronAPI.onAutomationCompleted(callback),
  onCredentialsSaved: (callback) => window.electronAPI.onCredentialsSaved(callback),
  onCredentialsLoaded: (callback) => window.electronAPI.onCredentialsLoaded(callback),
  onShowProfileDetail: (callback) => window.electronAPI.onShowProfileDetail(callback),
  publishLinkedInPost: (payload) => window.electronAPI.publishLinkedInPost(payload),
  onPostPublished: (callback) => window.electronAPI.onPostPublished(callback),
  send: (channel, data) => window.electronAPI.send(channel, data)
});

  // ─────────── NEW: Step Builder Helpers ───────────
  const STEP_TYPES = ['view_profile', 'like_posts', 'send_connection', 'send_dm', 'delay'];
  const STEP_LABELS = {
    view_profile: 'Open Profile',
    like_posts: 'Like Recent Posts',
    send_connection: 'Send Connection Request',
    send_dm: 'Send Direct Message',
    delay: 'Wait Only (Delay)'
  };

  function resolveStepContainer(containerOrId) {
    if (!containerOrId) return document.getElementById('workflow-steps-container');
    if (typeof containerOrId === 'string') return document.getElementById(containerOrId);
    return containerOrId;
  }

  function renderStepNumbers(containerOrId) {
    const container = resolveStepContainer(containerOrId);
    if (!container) return;
    const rows = container.querySelectorAll('.step-item');
    rows.forEach((row, index) => {
      const badge = row.querySelector('.step-number');
      if (badge) badge.textContent = String(index + 1);
    });
  }

  function addStepRow(initial = {}, containerOrId) {
    const container = resolveStepContainer(containerOrId);
    if (!container) return null;
    const initialDelayValue = Number(initial.delayValue || initial.delayAmount || 1);
    const initialDelayUnit = initial.delayUnit || 'hours';
    const isHelpOpen = Boolean(initial.helpOpen);
    const row = document.createElement('div');
    row.className = 'step-item';
    row.innerHTML = `
      <div class="step-number">1</div>
      <div class="step-content">
        <select class="step-type-select">
          ${STEP_TYPES.map((t) => `<option value="${t}" ${t === initial.type ? 'selected' : ''}>${STEP_LABELS[t] || t}</option>`).join('')}
        </select>
        <button type="button" class="step-help-btn ${isHelpOpen ? 'is-open' : ''}" title="Show step help" aria-label="Toggle step help">?</button>
        <span class="step-help-text ${isHelpOpen ? 'is-open' : ''}" aria-live="polite"></span>
        <div class="step-delay-fields">
          <span class="step-delay-label">Delay</span>
          <input class="step-delay-input step-delay-value" type="number" min="1" max="365" value="${initialDelayValue}" title="Delay amount" />
          <select class="step-delay-unit" title="Delay unit">
            <option value="hours" ${initialDelayUnit === 'hours' ? 'selected' : ''}>Hour(s)</option>
            <option value="days" ${initialDelayUnit === 'days' ? 'selected' : ''}>Day(s)</option>
            <option value="weeks" ${initialDelayUnit === 'weeks' ? 'selected' : ''}>Week(s)</option>
            <option value="months" ${initialDelayUnit === 'months' ? 'selected' : ''}>Month(s)</option>
          </select>
        </div>
        <input class="step-message-input step-message-template" placeholder="Template used for this message step" value="${initial.messageTemplate || ''}">
      </div>
      <button class="step-remove-btn">Remove</button>
    `;
    container.appendChild(row);
    wireRow(row, container);
    renderStepNumbers(container);
    return row;
  }

  function wireRow(row, containerOrId){
    const container = resolveStepContainer(containerOrId) || row.closest('.step-list');
    const typeSel = row.querySelector('.step-type-select');
    const helpBtn = row.querySelector('.step-help-btn');
    const helpText = row.querySelector('.step-help-text');
    const delayWrap = row.querySelector('.step-delay-fields');
    const noteIn  = row.querySelector('.step-message-template');
    const delayValueInput = row.querySelector('.step-delay-value');
    const refresh = ()=>{
      const isDelay = typeSel.value === 'delay';
      const needsMessage = typeSel.value === 'send_connection' || typeSel.value === 'send_dm';
      delayWrap.style.display = isDelay ? '' : 'none';
      noteIn.style.display = needsMessage ? '' : 'none';
      noteIn.placeholder = typeSel.value === 'send_dm'
        ? 'DM template (example: Hi {firstName}, ...)'
        : 'Connection note template (example: Hi {firstName}, ...)';
      if (isDelay && !noteIn.value) {
        noteIn.value = '';
      }
      if (delayValueInput) {
        delayValueInput.value = String(Math.max(1, parseInt(delayValueInput.value || '1', 10)));
      }

      const helpMap = {
        view_profile: 'Opens profile and gathers context before next actions.',
        like_posts: 'Likes recent posts to warm up engagement.',
        send_connection: 'Sends connection request using your optional note template.',
        send_dm: 'Opens DM drawer, finds recipient, personalizes, and sends message.',
        delay: 'Waits for a fixed duration (for example 3 days or 12 hours) before the next step.'
      };
      const help = helpMap[typeSel.value] || 'Configure this workflow step.';
      helpText.textContent = help;
      helpBtn.setAttribute('title', help);
      if (!helpText.classList.contains('is-open')) {
        helpBtn.setAttribute('aria-expanded', 'false');
      }
    };
    helpBtn.addEventListener('click', () => {
      const isOpen = helpText.classList.toggle('is-open');
      helpBtn.classList.toggle('is-open', isOpen);
      helpBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      helpBtn.setAttribute('title', isOpen ? 'Hide step help' : 'Show step help');
    });
    typeSel.onchange = refresh; refresh();
    row.querySelector('.step-remove-btn').onclick = ()=>{
      row.remove();
      renderStepNumbers(container);
      if (container && !container.querySelector('.step-item')) {
        container.innerHTML = '<div class="empty-steps">Click "Add Step" to define your workflow</div>';
      }
    };
  }

  window.AutomationStepBuilder = {
    STEP_TYPES,
    STEP_LABELS,
    resolveStepContainer,
    renderStepNumbers,
    addStepRow,
    wireRow
  };

// Add this script to your app.html file or app.js
// Legacy direct-login UI controls (e.g. "Start Automation", "Send Now") are
// hidden by default. The server-side guard at assertLegacyDirectLoginAllowed
// already refuses execution; this is the matching UI side. To surface the
// controls, set CONNECT_ALLOW_LEGACY_DIRECT_LOGIN=renderer-ui before launching
// the app. Telemetry on the server side will show whether the legacy IPCs
// are ever exercised in practice.
async function applyAppModeToBody() {
  try {
    const mode = window.electronAPI && typeof window.electronAPI.getAppMode === 'function'
      ? await window.electronAPI.getAppMode()
      : { legacyDirectLoginEnabled: false };
    if (mode && mode.legacyDirectLoginEnabled) {
      document.body.classList.add('legacy-direct-login-enabled');
    } else {
      document.body.classList.remove('legacy-direct-login-enabled');
    }
  } catch (err) {
    // Default closed: if the IPC fails, leave the class off so legacy controls
    // stay hidden. The server-side guard is still the binding decision.
    console.warn('[app-mode] Failed to resolve app mode; legacy UI stays hidden:', err);
    document.body.classList.remove('legacy-direct-login-enabled');
  }
}

document.addEventListener('DOMContentLoaded', function() {

  applyAppModeToBody();

  // Initialize existing features
  initializeNameListFeature();
  enhanceAutomationForm();


  // ────────────────────────────────────────────────────

  // Use event delegation to handle clicks on group action buttons
  document.addEventListener('click', function(event) {
    // Handle View Details button clicks
    if (event.target.classList.contains('view-group-btn') || 
        event.target.classList.contains('view-details')) {
      const groupCard = event.target.closest('.group-card');
      if (groupCard) {
        const groupId = groupCard.getAttribute('data-group-id');
        viewGroupDetails(groupId);
      }
    }

    // Handle Edit button clicks
    if (event.target.classList.contains('edit-group-btn') || 
        event.target.classList.contains('edit')) {
      const groupCard = event.target.closest('.group-card');
      if (groupCard) {
        const groupId = groupCard.getAttribute('data-group-id');
        editGroup(groupId);
      }
    }

    // Handle Delete button clicks
    if (event.target.classList.contains('delete-group-btn') || 
        event.target.classList.contains('delete')) {
      const groupCard = event.target.closest('.group-card');
      if (groupCard) {
        const groupId = groupCard.getAttribute('data-group-id');
        deleteGroup(groupId);
      }
    }
  });

  // Function to view group details
  function viewGroupDetails(groupId) {
    console.log('Viewing details for group:', groupId);
    
    // Get group data from localStorage
    const groups = JSON.parse(localStorage.getItem('standalone-groups') || '[]');
    const group = groups.find(g => g.id === groupId);
    
    if (!group) {
      console.error('Group not found:', groupId);
      return;
    }
    
    // Show group details in modal or other UI
    const groupModal = document.getElementById('group-edit-modal');
    if (groupModal) {
      const modalTitle = groupModal.querySelector('.modal-title');
      if (modalTitle) modalTitle.textContent = `Group: ${group.name}`;
      
      // Populate group details
      const modalBody = groupModal.querySelector('.modal-body');
      if (modalBody) {
        // Create read-only view
        modalBody.innerHTML = `
          <div class="form-group">
            <label>Group Name</label>
            <p>${escapeHtml(group.name)}</p>
          </div>
          <div class="form-group">
            <label>Description</label>
            <p>${escapeHtml(group.description || 'No description')}</p>
          </div>
          <div class="form-group">
            <label>Members (${group.members ? group.members.length : 0})</label>
            <div class="members-list">
              ${group.members && group.members.length > 0 
                ? group.members.map(member => `<div class="group-member">${escapeHtml(member)}</div>`).join('')
                : '<p>No members in this group</p>'
              }
            </div>
          </div>
        `;
      }
      
      // Change footer buttons
      const footer = groupModal.querySelector('.modal-footer');
      if (footer) {
        footer.innerHTML = `<button class="btn btn-secondary close-modal">Close</button>`;
        footer.querySelector('.close-modal')
              .addEventListener('click', ()=>groupModal.classList.remove('active'));
      }
      
      // Show modal
      groupModal.classList.add('active');
    }
  }

  // Function to edit a group
  function editGroup(groupId) {
    console.log('Editing group:', groupId);
    
    // Get group data
    const groups = JSON.parse(localStorage.getItem('standalone-groups') || '[]');
    const group = groups.find(g => g.id === groupId);
    
    if (!group) {
      console.error('Group not found:', groupId);
      return;
    }
    
    // Show edit modal
    const groupModal = document.getElementById('group-edit-modal');
    if (groupModal) {
      // Update modal title
      const modalTitle = groupModal.querySelector('.modal-title');
      if (modalTitle) modalTitle.textContent = `Edit Group: ${group.name}`;
      
      // Populate form fields
      const nameInput = groupModal.querySelector('#edit-group-name');
      const descInput = groupModal.querySelector('#edit-group-description');
      if (nameInput) nameInput.value = group.name;
      if (descInput) descInput.value = group.description || '';
      
      // Set selected color
      groupModal.querySelectorAll('.color-option').forEach(option=>{
        option.classList.toggle('selected', option.dataset.color===group.color);
      });
      
      // Populate members list
      const membersList = groupModal.querySelector('#group-members-list');
      if (membersList) {
        membersList.innerHTML = '';
        if (!group.members || group.members.length===0) {
          membersList.innerHTML = '<p>No members in this group</p>';
        } else {
          group.members.forEach(member=>{
            const el = document.createElement('div');
            el.className = 'group-member';
            el.innerHTML = `
              <span>${escapeHtml(member)}</span>
              <button class="btn btn-sm btn-danger remove-member" data-member="${member}">Remove</button>
            `;
            membersList.appendChild(el);
          });
          membersList.querySelectorAll('.remove-member').forEach(btn=>{
            btn.addEventListener('click', function(){
              const m = this.dataset.member;
              this.parentElement.remove();
              group.members = group.members.filter(x=>x!==m);
            });
          });
        }
      }
      
      // Attach save handler
      const saveBtn = groupModal.querySelector('#save-group-edit');
      if (saveBtn) {
        const newBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newBtn, saveBtn);
        newBtn.addEventListener('click', ()=>saveGroupChanges(groupId));
      }
      
      // Show modal
      groupModal.classList.add('active');
    }
  }

  // Function to save group changes
  function saveGroupChanges(groupId) {
    const groupModal = document.getElementById('group-edit-modal');
    if (!groupModal) return;
    
    const nameInput  = groupModal.querySelector('#edit-group-name');
    const descInput  = groupModal.querySelector('#edit-group-description');
    const colorOpt   = groupModal.querySelector('.color-option.selected');
    if (!nameInput.value.trim()) { alert('Please enter a group name'); return; }
    
    const groups = JSON.parse(localStorage.getItem('standalone-groups')||'[]');
    const idx = groups.findIndex(g=>g.id===groupId);
    if (idx===-1) { console.error('Group not found:',groupId); return; }
    groups[idx].name = nameInput.value.trim();
    groups[idx].description = descInput.value.trim();
    if (colorOpt) groups[idx].color = colorOpt.dataset.color;
    localStorage.setItem('standalone-groups', JSON.stringify(groups));
    
    groupModal.classList.remove('active');
    if (typeof renderStandaloneGroups==='function') renderStandaloneGroups(groups);
    else location.reload();
  }

  // Function to delete a group
  function deleteGroup(groupId) {
    if (!confirm('Are you sure you want to delete this group?')) return;
    const groups = JSON.parse(localStorage.getItem('standalone-groups')||'[]')
                     .filter(g=>g.id!==groupId);
    localStorage.setItem('standalone-groups', JSON.stringify(groups));
    if (typeof renderStandaloneGroups==='function') renderStandaloneGroups(groups);
    else location.reload();
  }

  // Helper function to escape HTML
  function escapeHtml(unsafe) {
    return String(unsafe||'')
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#039;");
  }

});


  // Focus specifically on fixing the edit functionality
document.addEventListener('DOMContentLoaded', function() {
    console.log('Debugging edit button functionality...');
    
    // Direct event listener for edit buttons
    document.body.addEventListener('click', function(event) {
      // Check if the clicked element or its parent is an edit button
      const editButton = event.target.closest('.edit, .edit-group-btn, [data-action="edit"]');
      if (!editButton) return;
      
      console.log('Edit button clicked:', editButton);
      
      // Find the containing group card and get the group ID
      const groupCard = editButton.closest('.group-card') || editButton.closest('[data-group-id]');
      
      if (!groupCard) {
        console.error('Could not find parent group card');
        return;
      }
      
      const groupId = groupCard.getAttribute('data-group-id');
      if (!groupId) {
        console.error('No group ID found on parent element');
        return;
      }
      
      console.log('Found group ID:', groupId);
      
      // Call function to open edit modal with this group ID
      openEditModal(groupId);
      
      // Prevent default action and stop event propagation
      event.preventDefault();
      event.stopPropagation();
    });
    
    // Function to open the edit modal
    function openEditModal(groupId) {
      console.log('Opening edit modal for group:', groupId);
      
      // Get group data from localStorage
      try {
        const groups = JSON.parse(localStorage.getItem('standalone-groups') || '[]');
        const group = groups.find(g => g.id === groupId);
        
        if (!group) {
          console.error('Group not found in localStorage:', groupId);
          alert('Group not found');
          return;
        }
        
        console.log('Found group data:', group);
        
        // Find the edit modal
        const modal = document.getElementById('group-edit-modal');
        if (!modal) {
          console.error('Group edit modal not found in the DOM');
          alert('Edit modal not found');
          return;
        }
        
        console.log('Found edit modal:', modal);
        
        // Update modal title
        const titleElement = modal.querySelector('.modal-title') || modal.querySelector('h2') || modal.querySelector('h3');
        if (titleElement) {
          titleElement.textContent = `Edit Group: ${group.name}`;
        }
        
        // Group name field in the title area if it exists
        const nameSpan = modal.querySelector('#group-edit-name');
        if (nameSpan) {
          nameSpan.textContent = group.name;
        }
        
        // Set form values
        const nameInput = modal.querySelector('#edit-group-name');
        if (nameInput) {
          nameInput.value = group.name;
          console.log('Set name input value:', group.name);
        } else {
          console.error('Name input field not found in modal');
        }
        
        const descInput = modal.querySelector('#edit-group-description');
        if (descInput) {
          descInput.value = group.description || '';
          console.log('Set description input value:', group.description);
        }
        
        // Set color selection
        const colorOptions = modal.querySelectorAll('.color-option');
        if (colorOptions.length > 0) {
          colorOptions.forEach(option => {
            option.classList.remove('selected');
            if (option.getAttribute('data-color') === group.color) {
              option.classList.add('selected');
              console.log('Selected color option:', group.color);
            }
          });
          
          // If no color was selected, select the first one
          if (!modal.querySelector('.color-option.selected')) {
            colorOptions[0].classList.add('selected');
            console.log('No matching color found, selected first option');
          }
        }
        
        // Store the group ID on the modal for later use
        modal.setAttribute('data-group-id', groupId);
        console.log('Set data-group-id on modal:', groupId);
        
        // Make sure the save button has an event listener
        const saveButton = modal.querySelector('#save-group-edit');
        if (saveButton) {
          // Remove existing listeners
          const newButton = saveButton.cloneNode(true);
          saveButton.parentNode.replaceChild(newButton, saveButton);
          
          // Add new listener
          newButton.addEventListener('click', function() {
            saveEditedGroup(groupId);
          });
          console.log('Set up save button event listener');
        } else {
          console.error('Save button not found in modal');
        }
        
        // Show the modal - try multiple approaches
        modal.classList.add('active');
        modal.classList.add('visible');
        modal.style.display = 'flex';
        console.log('Modal display set to:', modal.style.display);
        
      } catch (error) {
        console.error('Error opening edit modal:', error);
        alert('Error opening edit modal: ' + error.message);
      }
    }
    
    // Function to save edited group
    function saveEditedGroup(groupId) {
      console.log('Saving edited group:', groupId);
      
      const modal = document.getElementById('group-edit-modal');
      if (!modal) {
        console.error('Modal not found when saving');
        return;
      }
      
      // Get form values
      const nameInput = modal.querySelector('#edit-group-name');
      const descInput = modal.querySelector('#edit-group-description');
      
      if (!nameInput || !nameInput.value.trim()) {
        alert('Please enter a group name');
        return;
      }
      
      const name = nameInput.value.trim();
      const description = descInput ? descInput.value.trim() : '';
      
      // Get selected color
      const selectedColor = modal.querySelector('.color-option.selected');
      const color = selectedColor ? selectedColor.getAttribute('data-color') : '#4285F4';
      
      try {
        // Get groups from localStorage
        const groups = JSON.parse(localStorage.getItem('standalone-groups') || '[]');
        const groupIndex = groups.findIndex(g => g.id === groupId);
        
        if (groupIndex === -1) {
          console.error('Group not found when saving:', groupId);
          alert('Group not found');
          return;
        }
        
        // Update group
        groups[groupIndex].name = name;
        groups[groupIndex].description = description;
        groups[groupIndex].color = color;
        
        // Save back to localStorage
        localStorage.setItem('standalone-groups', JSON.stringify(groups));
        console.log('Saved updated group data to localStorage');
        
        // Hide the modal
        modal.classList.remove('active');
        modal.classList.remove('visible');
        modal.style.display = 'none';
        
        // Reload the page to reflect changes
        location.reload();
        
      } catch (error) {
        console.error('Error saving group:', error);
        alert('Error saving group: ' + error.message);
      }
    }
    
    // Set up event listeners for color options
    document.querySelectorAll('.color-option').forEach(option => {
      option.addEventListener('click', function() {
        const options = this.parentElement.querySelectorAll('.color-option');
        options.forEach(opt => opt.classList.remove('selected'));
        this.classList.add('selected');
        console.log('Selected color:', this.getAttribute('data-color'));
      });
    });
  });



// Enhance profile cards with email display
function enhanceProfilesWithEmailDisplay() {
  console.log("Starting email enhancement process");

  // Remove all existing email elements so that the enhancement runs fresh
  const existingEmails = document.querySelectorAll('.profile-email');
  existingEmails.forEach(el => el.remove());

  // Clear the cache so all cards are re‑processed
  processedCards.clear();

  // Look for profile cards with multiple possible class names
  const profileCards = document.querySelectorAll('.profile-item, .profile-card, [data-profile-id], .contact-item');
  console.log(`Found ${profileCards.length} potential profile cards to enhance with emails`);

  if (profileCards.length === 0) {
    console.log("No profile cards found to enhance - will retry in 2 seconds");
    setTimeout(enhanceProfilesWithEmailDisplay, 2000);
    return;
  }

  // Add styles for email display if they don't exist
  if (!document.getElementById('email-display-styles')) {
    const styleElement = document.createElement('style');
    styleElement.id = 'email-display-styles';
    styleElement.textContent = `
      .profile-email {
        margin-top: 5px;
        padding: 4px 8px;
        font-size: 14px;
        display: block;
        border-radius: 4px;
      }
      .profile-email.has-email {
        background-color: rgba(10, 102, 194, 0.1);
        color: #0a66c2;
        font-weight: 500;
      }
      .profile-email.no-email {
        color: #888;
        font-style: italic;
      }
      .profile-email.loading {
        background-color: #f3f6f8;
        color: #666;
      }
      .copy-email-btn {
        margin-left: 8px;
        background: transparent;
        border: none;
        color: #0a66c2;
        cursor: pointer;
        font-size: 12px;
        padding: 2px 4px;
        border-radius: 3px;
      }
      .copy-email-btn:hover {
        background: rgba(10, 102, 194, 0.1);
      }
      .export-emails-btn {
        background: #0a66c2;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 16px;
        cursor: pointer;
        margin-top: 15px;
        font-weight: 500;
        font-size: 14px;
        display: block;
        width: 100%;
        text-align: center;
      }
    `;
    document.head.appendChild(styleElement);
    console.log("Added email display styles to document");
  }

  // Process each profile card
  profileCards.forEach((card, index) => {
    // Generate a unique ID for the card if it doesn't have one
    const cardId = card.getAttribute('data-card-id') || `profile-card-${index}`;
    card.setAttribute('data-card-id', cardId);

    console.log(`Processing card #${index + 1} with ID ${cardId}`);
    processedCards.add(cardId);

    // Try multiple ways to get the profile ID
    const profileId =
      card.getAttribute('data-profile-id') ||
      card.getAttribute('data-id') ||
      card.querySelector('[data-profile-id]')?.getAttribute('data-profile-id') ||
      card.querySelector('a[href*="linkedin.com/in/"]')?.href;

    if (!profileId) {
      console.log(`Card #${index + 1} missing profile ID, skipping`);
      return;
    }

    console.log(`Found profile ID for card #${index + 1}: ${profileId}`);

    // Create email element
    const emailElement = document.createElement('div');
    emailElement.className = 'profile-email loading';
    emailElement.textContent = 'Loading email...';

    // Find the best place to insert the email element
    const insertAfter =
      card.querySelector('.profile-title') ||
      card.querySelector('.profile-company') ||
      card.querySelector('.profile-name') ||
      card.querySelector('h3') ||
      card.querySelector('h4') ||
      card.querySelector('p');

    if (insertAfter && insertAfter.parentNode) {
      console.log(`Inserting email after ${insertAfter.className || insertAfter.tagName}`);
      insertAfter.parentNode.insertBefore(emailElement, insertAfter.nextSibling);
    } else {
      console.log(`Appending email to card directly`);
      card.appendChild(emailElement);
    }

    // Fetch profile data and update email display
    electronAPIBridge.getProfileData(profileId)
      .then(profileData => {
        console.log(`Got profile data for ${profileId}:`, profileData ? 'Data found' : 'No data');

        if (!profileData) {
          emailElement.textContent = 'Profile data not found';
          emailElement.className = 'profile-email no-email';
          return;
        }

        // Check multiple possible email field names
        const email =
          profileData.email ||
          profileData.emailAddress ||
          profileData.email_address;

        if (email && email !== 'Not Available' && email !== 'Not available') {
          // Create a container for email and copy button
          const emailContainer = document.createElement('div');
          emailContainer.style.display = 'flex';
          emailContainer.style.alignItems = 'center';

          // Email text
          const emailText = document.createElement('span');
          emailText.textContent = email;
          emailContainer.appendChild(emailText);

          // Copy button
          const copyButton = document.createElement('button');
          copyButton.className = 'copy-email-btn';
          copyButton.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          `;
          copyButton.title = "Copy email";
          copyButton.addEventListener('click', () => {
            navigator.clipboard.writeText(email).then(() => {
              const originalHTML = copyButton.innerHTML;
              copyButton.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="green" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              `;
              setTimeout(() => {
                copyButton.innerHTML = originalHTML;
              }, 2000);
            });
          });
          emailContainer.appendChild(copyButton);

          // Update the email element
          emailElement.className = 'profile-email has-email';
          emailElement.innerHTML = '';
          emailElement.appendChild(emailContainer);

          console.log(`Valid email found: ${email}`);
        } else {
          const company = profileData.company || profileData.companyName || '';
          if (company && profileData.firstName && profileData.lastName) {
            emailElement.innerHTML = `
              <div style="font-style: italic; margin-bottom: 4px;">No email found, possible formats:</div>
              <div style="font-size: 12px; color: #666;">
                ${profileData.firstName.toLowerCase()}.${profileData.lastName.toLowerCase()}@${company.toLowerCase().replace(/\s+/g, '')}.com
              </div>
            `;
            emailElement.className = 'profile-email no-email';
          } else {
            emailElement.textContent = 'No email available';
            emailElement.className = 'profile-email no-email';
          }
          console.log('No valid email found for profile');
        }
      })
      .catch(err => {
        console.error(`Error fetching profile data for ${profileId}:`, err);
        emailElement.textContent = 'Error loading email';
        emailElement.className = 'profile-email no-email';
      });
  });

  console.log("Email enhancement process complete");
}


// Add export emails button to the filter panel
function addExportEmailsButton() {
  if (document.getElementById('export-emails-btn')) {
    return; // Button already exists
  }

  const filterPanel = document.querySelector('.filter-panel') ||
                      document.getElementById('profile-filter-panel');

  if (filterPanel) {
    const exportButton = document.createElement('button');
    exportButton.id = 'export-emails-btn';
    exportButton.className = 'export-emails-btn';
    exportButton.textContent = 'Export All Emails';

    exportButton.addEventListener('click', () => {
      console.log('Export emails button clicked');
      electronAPIBridge.exportEmails();
    });

    filterPanel.appendChild(exportButton);
    console.log("Added export emails button to filter panel");
  } else {
    console.log("No filter panel found for export button, will try again later");
    // Create a floating export button if no filter panel exists
    const floatingBtn = document.createElement('div');
    floatingBtn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9999;
    `;

    const exportButton = document.createElement('button');
    exportButton.id = 'export-emails-btn';
    exportButton.className = 'export-emails-btn';
    exportButton.textContent = 'Export All Emails';
    exportButton.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';

    exportButton.addEventListener('click', () => {
      console.log('Export emails button clicked');
      electronAPIBridge.exportEmails();
    });

    floatingBtn.appendChild(exportButton);
    document.body.appendChild(floatingBtn);
    console.log("Added floating export emails button");
  }
}

// Setup retry mechanism for when the page might not be fully loaded
function setupEmailDisplayRetries() {
  console.log("Setting up email display with retries");

  // Try immediately
  enhanceProfilesWithEmailDisplay();

  // Then try several times with increasing delays
  setTimeout(enhanceProfilesWithEmailDisplay, 1000);
  setTimeout(enhanceProfilesWithEmailDisplay, 3000);
  setTimeout(enhanceProfilesWithEmailDisplay, 7000);

  // Set up a mutation observer to detect when new profile cards are added
  const observer = new MutationObserver((mutations) => {
    let shouldEnhance = false;

    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // Check if any of the added nodes look like profile cards
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList?.contains('profile-item') ||
                node.classList?.contains('profile-card') ||
                node.querySelector?.('.profile-item, .profile-card, [data-profile-id]')) {
              shouldEnhance = true;
              break;
            }
          }
        }
        if (shouldEnhance) break;
      }
    }

    if (shouldEnhance) {
      console.log("DOM changed - new profile cards detected");
      enhanceProfilesWithEmailDisplay();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log("Email display enhancement setup complete with mutation observer");
}

// New reset function that clears the cache and re-runs the enhancement
function resetEmailEnhancements() {
  console.log("Resetting email enhancements...");
  processedCards.clear();
  enhanceProfilesWithEmailDisplay();
}

// Initialize email display when DOM is loaded
document.addEventListener('DOMContentLoaded', setupEmailDisplayRetries);

// Export functions for external use
window.EmailDisplay = {
  enhance: enhanceProfilesWithEmailDisplay,
  addExportButton: addExportEmailsButton,
  reset: resetEmailEnhancements
};


// ====================================
// Automation & App UI Functionality
// ====================================

document.addEventListener('DOMContentLoaded', function() {
    addAntiFlickerStyles();
  // Elements
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const navLinks = document.querySelectorAll('.nav-link');
  const sections = document.querySelectorAll('.app-section');
  const pageTitle = document.querySelector('.page-title');
  
  // Automation elements
  const startButton = document.getElementById('start-button');
  const stopButton = document.getElementById('stop-button');
  const clearButton = document.getElementById('clear-button');
  const exportButton = document.getElementById('export-button');
  const exportActivityReportButton = document.getElementById('export-activity-report-btn');
  const exportDiagnosticsReportButton = document.getElementById('export-diagnostics-report-btn');
  const terminalContent = document.getElementById('terminal-content');
  const progressContainer = document.getElementById('progress-container');
  const progressFill = document.getElementById('progress-fill');
  const profilesProcessed = document.getElementById('profiles-processed');
  const timeElapsed = document.getElementById('time-elapsed');
  
  // Form elements
  const automationForm = document.getElementById('automation-form');
  const searchQuery = document.getElementById('search-query');
  const profileLimit = document.getElementById('profile-limit');
  const visitProfile = document.getElementById('visit-profile');
  const likePosts = document.getElementById('like-posts');
  const sendConnection = document.getElementById('send-connection');
  const connectMessage = document.getElementById('connect-message');
  const headlessMode = document.getElementById('headless-mode');
  
  // Variables
  let isRunning = false;
  let startTime;
  let timerInterval;
  let currentProfileIndex = 0;
  let totalProfiles = 0;
  let logs = [];
  let profilesData = [];
  let linkedInAccounts = [];
  let activeLinkedInAccountId = null;
  let selectedLinkedInAccountId = null;
  let linkedInRuntimeJobs = [];
  let linkedInAccountHealth = {};
  let sdrAgents = [];
  let currentSearchAgentPresets = [];
  let currentSearchPresetAgentId = null;
  let inboxConversations = [];
  let selectedInboxConversationUrn = null;
  let selectedInboxConversation = null;
  let isInboxConversationLoading = false;
  let isInboxReplySending = false;
  let inboxReplyDraft = '';
  let openInboxConversationCount = 0;
  let isReplyNotificationPanelOpen = false;
  let appInitialized = false;
  
  // Log types
  const LOG_TYPES = {
      NORMAL: 'normal',
      INFO: 'info',
      ERROR: 'error',
      WARNING: 'warning',
      SUCCESS: 'success'
  };

  if (window.AutomationGroupSelector) {
    window.AutomationGroupSelector.initializeUI();
  }

  function buildLinkedInAccountName(email) {
      const localPart = String(email || '').split('@')[0] || '';
      const normalized = localPart.replace(/[._-]+/g, ' ').trim();
      if (!normalized) return 'LinkedIn Profile';
      return normalized.split(/\s+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  }

  function getLinkedInAccountById(accountId) {
      return linkedInAccounts.find((account) => account.id === accountId) || null;
  }

  function getActiveLinkedInAccount() {
      return getLinkedInAccountById(activeLinkedInAccountId);
  }

  function getLinkedInAccountHealth(accountId) {
      return accountId ? linkedInAccountHealth?.[accountId] || null : null;
  }

  function hasActiveLinkedInChallenge(session) {
      return Boolean(session?.challengeActive);
  }

  function hasActiveLinkedInAuthFailure(session) {
      return Boolean(session?.authFailureActive);
  }

  function formatLinkedInHealthCooldownLabel(cooldownUntil) {
      const timestamp = new Date(cooldownUntil || '').getTime();
      if (!Number.isFinite(timestamp)) {
          return 'Cooldown';
      }

      const remainingMs = Math.max(0, timestamp - Date.now());
      const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
      if (remainingMinutes >= 120) {
          return `${Math.ceil(remainingMinutes / 60)}h`;
      }
      return `${remainingMinutes}m`;
  }

  function formatLinkedInChallengeDetail(challenged, session) {
      const challengeType = String(challenged?.type || '').trim().toLowerCase();

      if (challengeType === 'captcha') {
          return 'LinkedIn presented a CAPTCHA. Resolve it in LinkedIn, then clear the challenge to resume automation.';
      }

      if (challengeType === 'device_verification') {
          return 'LinkedIn requested device verification. Complete the verification in LinkedIn, then clear the challenge to resume automation.';
      }

      if (challenged?.at) {
          return 'LinkedIn requires verification before automation can continue. Resolve it manually, then clear the challenge to resume.';
      }

      if (hasActiveLinkedInChallenge(session)) {
          return 'A recent LinkedIn challenge still needs verification before automation can continue.';
      }

      return 'LinkedIn requires verification before automation can continue.';
  }

  function resolveLinkedInAccountHealthState(accountId) {
      const health = getLinkedInAccountHealth(accountId);
      const workflow = health?.workflow || null;
      const replyMonitor = health?.replyMonitor || null;
      const challenged = health?.challenged || null;
      const session = health?.session || null;
      const workflowCooldown = workflow?.status === 'cooldown';
      const replyCooldown = replyMonitor?.status === 'cooldown';
      const workflowWarning = workflow?.status === 'warning';
      const replyWarning = replyMonitor?.status === 'warning';

      if (challenged || hasActiveLinkedInChallenge(session)) {
          return {
              kind: 'challenge',
              label: 'Challenge detected',
              detail: formatLinkedInChallengeDetail(challenged, session),
              canClear: true
          };
      }

      if (workflowCooldown && replyCooldown) {
          return {
              kind: 'cooldown',
              label: `Workflow + reply cooldown`,
              detail: `Workflow ${formatLinkedInHealthCooldownLabel(workflow?.cooldownUntil)} • Reply ${formatLinkedInHealthCooldownLabel(replyMonitor?.cooldownUntil)}`
          };
      }

      if (workflowCooldown) {
          return {
              kind: 'cooldown',
              label: `Workflow cooldown ${formatLinkedInHealthCooldownLabel(workflow?.cooldownUntil)}`,
              detail: workflow?.lastError || 'Workflow runtime temporarily paused'
          };
      }

      if (replyCooldown) {
          return {
              kind: 'cooldown',
              label: `Reply monitor cooldown ${formatLinkedInHealthCooldownLabel(replyMonitor?.cooldownUntil)}`,
              detail: replyMonitor?.lastError || 'Reply polling temporarily paused'
          };
      }

      if (workflowWarning || replyWarning) {
          return {
              kind: 'warning',
              label: 'Degraded',
              detail: workflow?.lastError || replyMonitor?.lastError || 'Recent runtime errors detected'
          };
      }

      if (hasActiveLinkedInAuthFailure(session)) {
          return {
              kind: 'warning',
              label: 'Re-auth needed',
              detail: 'LinkedIn session verification failed and needs a fresh login'
          };
      }

      return {
          kind: 'healthy',
          label: 'Healthy',
          detail: 'No recent LinkedIn account issues detected',
          canClear: false
      };
  }

  function normalizeInboxConversation(payload = {}) {
      const participantNames = Array.isArray(payload.participantNames)
          ? payload.participantNames.map((value) => String(value || '').trim()).filter(Boolean)
          : [];
      const status = String(payload.status || 'active').trim().toLowerCase();
      const messages = Array.isArray(payload.messages)
          ? payload.messages
              .map((message) => normalizeInboxConversationMessage(message))
              .filter(Boolean)
              .sort((left, right) => left.deliveredAt - right.deliveredAt)
          : [];
      return {
          conversationUrn: String(payload.conversationUrn || '').trim(),
          accountId: String(payload.accountId || '').trim() || null,
          accountName: String(payload.accountName || '').trim() || null,
          mailboxUrn: String(payload.mailboxUrn || '').trim() || null,
          participantProfileUrn: String(payload.participantProfileUrn || '').trim() || null,
          participantNames,
          workflowId: String(payload.workflowId || '').trim() || null,
          workflowName: String(payload.workflowName || '').trim() || null,
          runId: String(payload.runId || '').trim() || null,
          agentId: String(payload.agentId || '').trim() || null,
          agentName: String(payload.agentName || '').trim() || null,
          lastInboundAt: Number(payload.lastInboundAt || 0) || 0,
          lastOutboundAt: Number(payload.lastOutboundAt || 0) || 0,
          status: ['active', 'replied', 'paused', 'suppressed', 'resolved'].includes(status) ? status : 'active',
          intentLabel: String(payload.intentLabel || '').trim().toLowerCase() || null,
          lastMessagePreview: String(payload.lastMessagePreview || '').trim() || 'No message preview available yet.',
          messages
      };
  }

  function normalizeInboxConversationMessage(payload = {}) {
      const messageKey = String(payload.messageKey || '').trim();
      if (!messageKey) {
          return null;
      }

      const direction = String(payload.direction || 'inbound').trim().toLowerCase();
      return {
          messageKey,
          deliveredAt: Number(payload.deliveredAt || 0) || 0,
          senderName: String(payload.senderName || '').trim() || null,
          senderProfileUrn: String(payload.senderProfileUrn || '').trim() || null,
          text: String(payload.text || '').trim(),
          direction: direction === 'outbound' ? 'outbound' : 'inbound'
      };
  }

  function getInboxConversationTitle(conversation) {
      if (conversation.participantNames.length > 0) {
          return conversation.participantNames.join(', ');
      }
      return conversation.accountName || 'LinkedIn conversation';
  }

  function getInboxStatusLabel(status) {
      switch (status) {
          case 'paused':
              return 'Paused';
          case 'suppressed':
              return 'Do not contact';
          case 'replied':
              return 'Replied';
          case 'resolved':
              return 'Archived';
          default:
              return 'Active';
      }
  }

  function getInboxIntentLabel(intentLabel) {
      switch (intentLabel) {
          case 'interested':
              return 'Interested';
          case 'question':
              return 'Question';
          case 'unsubscribe':
              return 'Unsubscribe';
          case 'not_interested':
              return 'Not interested';
          default:
              return null;
      }
  }

  function getInboxSuggestedAction(intentLabel) {
      switch (intentLabel) {
          case 'interested':
          case 'question':
              return 'Suggested next step: Reply manually';
          case 'unsubscribe':
              return 'Suggested next step: Do not contact';
          case 'not_interested':
              return 'Suggested next step: Keep sequence paused';
          default:
              return null;
      }
  }

  function getInboxPanelMeta(items) {
      const total = Array.isArray(items) ? items.length : 0;
      if (!total) {
          return 'No reply conversations yet';
      }

      const paused = items.filter((item) => item.status === 'paused').length;
      const suppressed = items.filter((item) => item.status === 'suppressed').length;
      const replied = items.filter((item) => item.status === 'replied').length;
      const parts = [`${total} conversation${total === 1 ? '' : 's'}`];
      if (paused) {
          parts.push(`${paused} paused`);
      }
      if (suppressed) {
          parts.push(`${suppressed} suppressed`);
      }
      if (replied) {
          parts.push(`${replied} awaiting review`);
      }
      return parts.join(' • ');
  }

  function buildInboxConversationMeta(conversation) {
      const parts = [
          conversation.accountName,
          conversation.workflowName || conversation.workflowId,
          conversation.agentName
      ].filter(Boolean);
      return parts.join(' • ');
  }

  function applyInboxConversationUpdate(payload) {
      const normalized = normalizeInboxConversation(payload);
      if (!normalized.conversationUrn) {
          return null;
      }

      const nextConversations = inboxConversations.slice();
      const index = nextConversations.findIndex((conversation) => conversation.conversationUrn === normalized.conversationUrn);
      if (index >= 0) {
          nextConversations[index] = normalized;
      } else {
          nextConversations.unshift(normalized);
      }

      nextConversations.sort((left, right) => {
          const leftTimestamp = left.lastInboundAt || left.lastOutboundAt || 0;
          const rightTimestamp = right.lastInboundAt || right.lastOutboundAt || 0;
          return rightTimestamp - leftTimestamp;
      });

      inboxConversations = nextConversations.filter((conversation) => ['active', 'replied', 'paused', 'suppressed'].includes(conversation.status));
      openInboxConversationCount = inboxConversations.length;
      syncSelectedInboxConversation();
      return normalized;
  }

  function syncSelectedInboxConversation() {
      if (!selectedInboxConversationUrn) {
          selectedInboxConversation = null;
          return;
      }

      const matchedConversation = inboxConversations.find((conversation) => conversation.conversationUrn === selectedInboxConversationUrn) || null;
      if (!matchedConversation) {
          selectedInboxConversation = null;
          selectedInboxConversationUrn = null;
          inboxReplyDraft = '';
          return;
      }

      selectedInboxConversation = matchedConversation;
  }

  function closeInboxConversationDetail() {
      selectedInboxConversationUrn = null;
      selectedInboxConversation = null;
      inboxReplyDraft = '';
      isInboxConversationLoading = false;
      isInboxReplySending = false;
      renderReplyNotificationCenter();
  }

  async function openInboxConversationDetail(conversationUrn) {
      const normalizedConversationUrn = String(conversationUrn || '').trim();
      if (!normalizedConversationUrn || !window.electronAPI?.getInboxConversation) {
          return;
      }

      selectedInboxConversationUrn = normalizedConversationUrn;
      selectedInboxConversation = inboxConversations.find((conversation) => conversation.conversationUrn === normalizedConversationUrn) || null;
      isInboxConversationLoading = true;
      renderReplyNotificationCenter();

      try {
          const result = await window.electronAPI.getInboxConversation(normalizedConversationUrn, { refresh: true });
          if (!result?.success || !result.conversation) {
              throw new Error(result?.error || 'Conversation not found');
          }
          selectedInboxConversation = applyInboxConversationUpdate(result.conversation) || selectedInboxConversation;
      } catch (error) {
          console.warn('Failed to load inbox conversation detail:', error.message || error);
      } finally {
          isInboxConversationLoading = false;
          syncSelectedInboxConversation();
          renderReplyNotificationCenter();
      }
  }

  async function sendInboxConversationReply() {
      const conversationUrn = selectedInboxConversationUrn;
      const text = String(inboxReplyDraft || '').trim();
      if (!conversationUrn || !text || !window.electronAPI?.sendInboxReply || isInboxReplySending) {
          return;
      }

      isInboxReplySending = true;
      renderReplyNotificationCenter();

      try {
          const result = await window.electronAPI.sendInboxReply({
              conversationUrn,
              text
          });
          if (!result?.success || !result.conversation) {
              throw new Error(result?.error || 'Reply failed');
          }
          inboxReplyDraft = '';
          selectedInboxConversation = applyInboxConversationUpdate(result.conversation) || selectedInboxConversation;
      } catch (error) {
          console.warn('Failed to send inbox reply:', error.message || error);
          showNotification(error.message || 'Failed to send inbox reply', 'warning');
      } finally {
          isInboxReplySending = false;
          syncSelectedInboxConversation();
          renderReplyNotificationCenter();
      }
  }

  function renderInboxConversationDetail(conversation) {
      if (!conversation) {
          return `
              <div class="reply-notification-detail-empty">
                  Select a conversation to view the full thread.
              </div>
          `;
      }

      const metadata = buildInboxConversationMeta(conversation);
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const isComposerDisabled = conversation.status === 'suppressed' || conversation.status === 'resolved';
      const suggestedAction = getInboxSuggestedAction(conversation.intentLabel);
      const messagesMarkup = messages.length
          ? messages.map((message) => {
              const deliveredLabel = message.deliveredAt
                  ? formatTimeAgo(new Date(message.deliveredAt).toISOString())
                  : '';
              const isOutbound = message.direction === 'outbound';
              return `
                  <div class="${isOutbound ? 'inbox-msg-outbound' : 'inbox-msg-inbound'} reply-thread-message ${isOutbound ? 'is-outbound' : 'is-inbound'}">
                      <div class="inbox-msg-bubble reply-thread-message-body">
                          <p>${escapeHtml(message.text || '') || '&nbsp;'}</p>
                      </div>
                      <div class="inbox-msg-time">${deliveredLabel ? escapeHtml(deliveredLabel) : ''}</div>
                  </div>
              `;
          }).join('')
          : '<div class="inbox-empty"><p>No message history available yet.</p></div>';

      return `
          <div class="reply-notification-detail-card">
              <div class="reply-notification-detail-header">
                  <div>
                      <div class="reply-notification-detail-title">${escapeHtml(getInboxConversationTitle(conversation))}</div>
                      <div class="reply-notification-detail-meta">${escapeHtml(metadata || 'LinkedIn inbox thread')}</div>
                  </div>
                  <button type="button" class="btn btn-secondary btn-sm" data-reply-inbox-detail-action="close">Close</button>
              </div>
              <div class="reply-notification-detail-status">
                  <span class="reply-inbox-status-badge status-${escapeHtml(conversation.status)}">${escapeHtml(getInboxStatusLabel(conversation.status))}</span>
                  ${conversation.intentLabel ? `<span class="reply-inbox-intent-badge intent-${escapeHtml(conversation.intentLabel)}">${escapeHtml(getInboxIntentLabel(conversation.intentLabel) || conversation.intentLabel)}</span>` : ''}
              </div>
              ${suggestedAction ? `<div class="reply-inbox-suggestion">${escapeHtml(suggestedAction)}</div>` : ''}
              <div class="reply-thread-history">
                  ${isInboxConversationLoading ? '<div class="reply-notification-empty">Loading conversation...</div>' : messagesMarkup}
              </div>
              <div class="reply-thread-composer">
                  <label class="reply-thread-composer-label" for="reply-thread-composer-input">Manual reply</label>
                  <textarea id="reply-thread-composer-input" class="form-control reply-thread-composer-input" placeholder="${escapeHtml(isComposerDisabled ? 'Manual replies are disabled for this conversation.' : 'Write a manual reply...')}" ${isComposerDisabled ? 'disabled' : ''}>${escapeHtml(inboxReplyDraft)}</textarea>
                  <div class="reply-thread-composer-actions">
                      <div class="reply-thread-composer-hint">${escapeHtml(isComposerDisabled ? 'Suppressed and archived conversations cannot be replied to from the inbox.' : 'This sends a manual LinkedIn reply without resuming the paused workflow.')}</div>
                      <button type="button" class="btn btn-primary btn-sm" data-reply-inbox-detail-action="send" ${isComposerDisabled || isInboxReplySending || !String(inboxReplyDraft || '').trim() ? 'disabled' : ''}>
                          ${isInboxReplySending ? 'Sending...' : 'Send reply'}
                      </button>
                  </div>
              </div>
          </div>
      `;
  }

  function renderReplyNotificationCenter() {
      const badge = document.getElementById('reply-notification-badge');
      const panel = document.getElementById('reply-notification-panel');
      const list = document.getElementById('reply-notification-list');
      const detail = document.getElementById('reply-notification-detail');
      const meta = document.getElementById('reply-notification-panel-meta');
      const refreshButton = document.getElementById('reply-notification-mark-all');
      const toggle = document.getElementById('reply-notification-toggle');
      if (!badge || !panel || !list || !detail || !meta || !toggle) {
          return;
      }

      const countLabel = openInboxConversationCount > 99 ? '99+' : String(openInboxConversationCount);
      badge.textContent = countLabel;
      badge.classList.toggle('is-hidden', openInboxConversationCount <= 0);
      meta.textContent = getInboxPanelMeta(inboxConversations);
      toggle.setAttribute('aria-expanded', isReplyNotificationPanelOpen ? 'true' : 'false');
      panel.hidden = !isReplyNotificationPanelOpen;
      panel.classList.toggle('has-detail', Boolean(selectedInboxConversationUrn));

      if (refreshButton) {
          refreshButton.disabled = false;
      }

      if (!inboxConversations.length) {
          list.innerHTML = '<div class="reply-notification-empty">No reply conversations yet.</div>';
      } else {
          list.innerHTML = inboxConversations.map((conversation) => {
              const metadata = buildInboxConversationMeta(conversation);
              const timeLabel = conversation.lastInboundAt
                  ? formatTimeAgo(new Date(conversation.lastInboundAt).toISOString())
                  : 'Unknown time';
              const canPause = Boolean(conversation.runId) && conversation.status !== 'paused' && conversation.status !== 'suppressed';
              const canResume = Boolean(conversation.runId) && conversation.status === 'paused';
              const intentLabel = getInboxIntentLabel(conversation.intentLabel);
              const suggestedAction = getInboxSuggestedAction(conversation.intentLabel);
              const isSelected = conversation.conversationUrn === selectedInboxConversationUrn;
              return `
                  <div class="reply-notification-item ${conversation.status === 'paused' ? 'is-unread' : ''} ${isSelected ? 'is-selected' : ''}" data-reply-inbox-conversation-urn="${escapeHtml(conversation.conversationUrn)}">
                      <div class="reply-notification-item-header">
                          <div>
                              <div class="reply-notification-item-title">${escapeHtml(getInboxConversationTitle(conversation))}</div>
                              <div class="reply-notification-item-meta">${escapeHtml(metadata || 'LinkedIn reply inbox')}</div>
                          </div>
                          <span class="reply-inbox-status-badge status-${escapeHtml(conversation.status)}">${escapeHtml(getInboxStatusLabel(conversation.status))}</span>
                      </div>
                      ${intentLabel ? `<div class="reply-inbox-intent-row"><span class="reply-inbox-intent-badge intent-${escapeHtml(conversation.intentLabel)}">${escapeHtml(intentLabel)}</span></div>` : ''}
                      <div class="reply-notification-item-body">${escapeHtml(conversation.lastMessagePreview)}</div>
                      ${suggestedAction ? `<div class="reply-inbox-suggestion">${escapeHtml(suggestedAction)}</div>` : ''}
                      <div class="reply-notification-item-actions">
                          <div class="reply-notification-item-time">${escapeHtml(timeLabel)}</div>
                          <div class="reply-inbox-action-group">
                              <button type="button" class="btn btn-secondary btn-sm" data-reply-inbox-action="open" data-reply-inbox-conversation-urn="${escapeHtml(conversation.conversationUrn)}">${isSelected ? 'Viewing' : 'Open'}</button>
                              ${canPause ? `<button type="button" class="btn btn-secondary btn-sm" data-reply-inbox-action="pause" data-reply-inbox-run-id="${escapeHtml(conversation.runId)}">Pause</button>` : ''}
                              ${canResume ? `<button type="button" class="btn btn-secondary btn-sm" data-reply-inbox-action="resume" data-reply-inbox-run-id="${escapeHtml(conversation.runId)}">Resume</button>` : ''}
                              <button type="button" class="btn btn-secondary btn-sm" data-reply-inbox-action="archive" data-reply-inbox-conversation-urn="${escapeHtml(conversation.conversationUrn)}">Archive</button>
                          </div>
                      </div>
                  </div>
              `;
          }).join('');
      }
      detail.innerHTML = renderInboxConversationDetail(selectedInboxConversation);

      // Also render into full-page inbox section if it exists
      renderFullPageInbox();
  }

  // Render only the message bubbles (no header, no composer) for the full-page inbox thread area
  function renderInboxMessageBubbles(conversation) {
      if (!conversation) return '';
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      if (!messages.length) {
          return isInboxConversationLoading
              ? '<div class="inbox-empty"><p>Loading conversation...</p></div>'
              : '<div class="inbox-empty"><p>No message history available yet.</p></div>';
      }
      return messages.map((message) => {
          const deliveredLabel = message.deliveredAt
              ? formatTimeAgo(new Date(message.deliveredAt).toISOString())
              : '';
          const isOutbound = message.direction === 'outbound';
          return `
              <div class="${isOutbound ? 'inbox-msg-outbound' : 'inbox-msg-inbound'}">
                  <div class="inbox-msg-bubble">
                      <p>${escapeHtml(message.text || '') || '&nbsp;'}</p>
                  </div>
                  <div class="inbox-msg-time">${deliveredLabel ? escapeHtml(deliveredLabel) : ''}</div>
              </div>
          `;
      }).join('');
  }

  function renderFullPageInbox() {
      const fullList = document.getElementById('inbox-conversation-list');
      if (!fullList) return;

      if (!inboxConversations.length) {
          fullList.innerHTML = '<div class="inbox-empty">No conversations yet. Replies will appear here as prospects respond.</div>';
          return;
      }

      fullList.innerHTML = inboxConversations.map((conversation) => {
          const timeLabel = conversation.lastInboundAt
              ? formatTimeAgo(new Date(conversation.lastInboundAt).toISOString())
              : '';
          const intentLabel = getInboxIntentLabel(conversation.intentLabel);
          const isSelected = conversation.conversationUrn === selectedInboxConversationUrn;
          const isUnread = conversation.status === 'paused' || conversation.status === 'active';
          return `
              <div class="inbox-conversation-row ${isSelected ? 'active' : ''}" data-reply-inbox-conversation-urn="${escapeHtml(conversation.conversationUrn)}" data-reply-inbox-action="open">
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
                      <div class="inbox-conversation-name">${escapeHtml(getInboxConversationTitle(conversation))}</div>
                      <span class="inbox-conversation-time">${escapeHtml(timeLabel)}</span>
                  </div>
                  ${intentLabel ? `<div style="font-size:11px;font-weight:700;color:var(--primary);margin-bottom:2px">${escapeHtml(intentLabel)}</div>` : ''}
                  <div style="display:flex;align-items:center;gap:6px">
                      <div class="inbox-conversation-preview" style="flex:1">${escapeHtml(conversation.lastMessagePreview || '')}</div>
                      ${isUnread ? '<div class="inbox-conversation-unread-dot"></div>' : ''}
                  </div>
              </div>
          `;
      }).join('');

      // --- CENTER: Thread header + messages only (no old detail-card) ---
      const threadHeader = document.getElementById('inbox-thread-header');
      const threadMessages = document.getElementById('inbox-thread-messages');
      const composer = document.getElementById('inbox-composer');
      const replyTextarea = document.getElementById('inbox-reply-text');
      const sendBtn = document.getElementById('inbox-send-reply');

      if (threadHeader && threadMessages && selectedInboxConversation) {
          const conv = selectedInboxConversation;
          const metadata = buildInboxConversationMeta(conv);
          const isComposerDisabled = conv.status === 'suppressed' || conv.status === 'resolved';

          // Thread header
          threadHeader.innerHTML = `
              <div style="display:flex;align-items:center;gap:12px">
                  <div>
                      <div style="font-size:14px;font-weight:700">${escapeHtml(getInboxConversationTitle(conv))}</div>
                      <div style="font-size:11px;color:var(--on-surface-variant)">${escapeHtml(metadata || '')}</div>
                  </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px">
                  ${conv.runId ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:var(--radius-full);background:var(--status-active-bg);color:var(--status-active-text);font-size:10px;font-weight:700"><span style="width:6px;height:6px;border-radius:50%;background:var(--status-active-dot)"></span>ACTIVE WORKFLOW</span>' : ''}
              </div>
          `;

          // Messages — only bubbles, no wrapper card
          threadMessages.innerHTML = renderInboxMessageBubbles(conv);

          // Composer state — use the full-page HTML composer, not the old embedded one
          if (composer) composer.style.display = isComposerDisabled ? 'none' : '';
          if (replyTextarea) {
              replyTextarea.disabled = isComposerDisabled;
              replyTextarea.placeholder = isComposerDisabled
                  ? 'Replies are disabled for this conversation.'
                  : 'Write a reply...';
              replyTextarea.value = inboxReplyDraft || '';
          }
          if (sendBtn) {
              sendBtn.disabled = isComposerDisabled || isInboxReplySending || !String(inboxReplyDraft || '').trim();
              sendBtn.innerHTML = isInboxReplySending
                  ? 'Sending...'
                  : 'Send <span class="material-symbols-outlined" style="font-size:16px">send</span>';
          }

          // --- RIGHT PANEL: Operator Intelligence ---
          const prospectInfo = document.getElementById('inbox-prospect-info');
          if (prospectInfo) {
              prospectInfo.innerHTML = `
                  <div class="inbox-intel-label">Account</div>
                  <div class="inbox-intel-value">${escapeHtml(getInboxConversationTitle(conv))}</div>
                  <div style="font-size:10px;color:var(--on-surface-variant);margin-top:4px">${escapeHtml(metadata || '')}</div>
              `;
          }

          const linkedWorkflow = document.getElementById('inbox-linked-workflow');
          if (linkedWorkflow) {
              const wfName = conv.workflowName || 'No linked workflow';
              const statusLabel = getInboxStatusLabel(conv.status);
              linkedWorkflow.innerHTML = `
                  <div class="inbox-intel-label">Linked Workflow</div>
                  <div class="inbox-intel-value">${escapeHtml(wfName)}</div>
                  <div style="font-size:10px;color:var(--on-surface-variant);margin-top:4px">
                      <span class="reply-inbox-status-badge status-${escapeHtml(conv.status)}" style="font-size:9px;padding:2px 6px;border-radius:var(--radius-full)">${escapeHtml(statusLabel)}</span>
                      ${conv.intentLabel ? `<span class="reply-inbox-intent-badge intent-${escapeHtml(conv.intentLabel)}" style="font-size:9px;padding:2px 6px;border-radius:var(--radius-full);margin-left:4px">${escapeHtml(getInboxIntentLabel(conv.intentLabel) || conv.intentLabel)}</span>` : ''}
                  </div>
              `;
          }

          // Pause/Resume button state
          const pauseBtn = document.getElementById('inbox-pause-workflow');
          if (pauseBtn) {
              const canPause = Boolean(conv.runId) && conv.status !== 'paused' && conv.status !== 'suppressed';
              const canResume = Boolean(conv.runId) && conv.status === 'paused';
              if (canResume) {
                  pauseBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px">play_circle</span> Resume Workflow';
                  pauseBtn.setAttribute('data-reply-inbox-action', 'resume');
                  pauseBtn.setAttribute('data-reply-inbox-run-id', conv.runId || '');
                  pauseBtn.disabled = false;
              } else if (canPause) {
                  pauseBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px">pause_circle</span> Pause Workflow';
                  pauseBtn.setAttribute('data-reply-inbox-action', 'pause');
                  pauseBtn.setAttribute('data-reply-inbox-run-id', conv.runId || '');
                  pauseBtn.disabled = false;
              } else {
                  pauseBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px">pause_circle</span> Pause Workflow';
                  pauseBtn.disabled = true;
              }
          }

          const archiveBtn = document.getElementById('inbox-archive');
          if (archiveBtn) {
              archiveBtn.setAttribute('data-reply-inbox-action', 'archive');
              archiveBtn.setAttribute('data-reply-inbox-conversation-urn', conv.conversationUrn || '');
          }

      } else if (threadHeader && threadMessages) {
          threadHeader.innerHTML = '<div class="inbox-thread-meta">Select a conversation to view the thread</div>';
          threadMessages.innerHTML = '';
          if (composer) composer.style.display = 'none';
      }
  }

  async function refreshInboxConversations() {
      if (!window.electronAPI?.getInbox) {
          return;
      }

      try {
          const result = await window.electronAPI.getInbox({
              statuses: ['active', 'replied', 'paused', 'suppressed']
          });
          inboxConversations = Array.isArray(result)
              ? result.map((item) => normalizeInboxConversation(item))
              : [];
          openInboxConversationCount = inboxConversations.length;
          syncSelectedInboxConversation();
      } catch (error) {
          console.warn('Failed to load inbox conversations:', error.message || error);
          inboxConversations = [];
          openInboxConversationCount = 0;
          syncSelectedInboxConversation();
      }

      renderReplyNotificationCenter();
  }

  async function pauseWorkflowRunFromInbox(runId) {
      const normalizedRunId = String(runId || '').trim();
      if (!normalizedRunId || !window.electronAPI?.pauseWorkflowRun) {
          return;
      }

      try {
          const result = await window.electronAPI.pauseWorkflowRun(normalizedRunId);
          if (!result?.success) {
              return;
          }
          await refreshInboxConversations();
      } catch (error) {
          console.warn('Failed to pause workflow run from inbox:', error.message || error);
      }
  }

  async function resumeWorkflowRunFromInbox(runId) {
      const normalizedRunId = String(runId || '').trim();
      if (!normalizedRunId || !window.electronAPI?.resumeWorkflowRun) {
          return;
      }

      try {
          const result = await window.electronAPI.resumeWorkflowRun(normalizedRunId);
          if (!result?.success) {
              return;
          }
          await refreshInboxConversations();
      } catch (error) {
          console.warn('Failed to resume workflow run from inbox:', error.message || error);
      }
  }

  async function archiveInboxConversation(conversationUrn) {
      const normalizedConversationUrn = String(conversationUrn || '').trim();
      if (!normalizedConversationUrn || !window.electronAPI?.archiveInboxConversation) {
          return;
      }

      try {
          const result = await window.electronAPI.archiveInboxConversation(normalizedConversationUrn);
          if (!result?.success) {
              return;
          }
          await refreshInboxConversations();
      } catch (error) {
          console.warn('Failed to archive inbox conversation:', error.message || error);
      }
  }

  function setReplyNotificationPanelOpen(isOpen) {
      isReplyNotificationPanelOpen = !!isOpen;
      renderReplyNotificationCenter();
  }

  function bindReplyNotificationCenter() {
      const center = document.getElementById('reply-notification-center');
      const toggle = document.getElementById('reply-notification-toggle');
      const list = document.getElementById('reply-notification-list');
      const detail = document.getElementById('reply-notification-detail');
      const refreshButton = document.getElementById('reply-notification-mark-all');

      if (!center || !toggle || !list || !detail) {
          return;
      }

      toggle.addEventListener('click', async (event) => {
          event.stopPropagation();
          const nextOpen = !isReplyNotificationPanelOpen;
          setReplyNotificationPanelOpen(nextOpen);
          if (nextOpen) {
              await refreshInboxConversations();
          }
      });

      refreshButton?.addEventListener('click', async (event) => {
          event.stopPropagation();
          await refreshInboxConversations();
      });

      list.addEventListener('click', async (event) => {
          const actionButton = event.target.closest('[data-reply-inbox-action]');
          if (actionButton) {
              event.stopPropagation();
              const action = actionButton.getAttribute('data-reply-inbox-action');
              if (action === 'open') {
                  await openInboxConversationDetail(actionButton.getAttribute('data-reply-inbox-conversation-urn'));
              } else if (action === 'pause') {
                  await pauseWorkflowRunFromInbox(actionButton.getAttribute('data-reply-inbox-run-id'));
              } else if (action === 'resume') {
                  await resumeWorkflowRunFromInbox(actionButton.getAttribute('data-reply-inbox-run-id'));
              } else if (action === 'archive') {
                  await archiveInboxConversation(actionButton.getAttribute('data-reply-inbox-conversation-urn'));
              }
              return;
          }
      });

      detail.addEventListener('click', async (event) => {
          const actionButton = event.target.closest('[data-reply-inbox-detail-action]');
          if (!actionButton) {
              return;
          }
          event.stopPropagation();
          const action = actionButton.getAttribute('data-reply-inbox-detail-action');
          if (action === 'close') {
              closeInboxConversationDetail();
          } else if (action === 'send') {
              await sendInboxConversationReply();
          }
      });

      detail.addEventListener('input', (event) => {
          if (event.target?.id !== 'reply-thread-composer-input') {
              return;
          }
          inboxReplyDraft = String(event.target.value || '');
          const sendButton = detail.querySelector('[data-reply-inbox-detail-action="send"]');
          if (sendButton) {
              const isComposerDisabled = selectedInboxConversation?.status === 'suppressed' || selectedInboxConversation?.status === 'resolved';
              sendButton.disabled = isComposerDisabled || isInboxReplySending || !String(inboxReplyDraft || '').trim();
          }
      });

      document.addEventListener('click', (event) => {
          if (!isReplyNotificationPanelOpen) return;
          if (center.contains(event.target)) return;
          setReplyNotificationPanelOpen(false);
      });

      document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && isReplyNotificationPanelOpen) {
              setReplyNotificationPanelOpen(false);
          }
      });

      // --- Full-page inbox composer wiring ---
      const fullPageReplyTextarea = document.getElementById('inbox-reply-text');
      const fullPageSendBtn = document.getElementById('inbox-send-reply');

      if (fullPageReplyTextarea) {
          fullPageReplyTextarea.addEventListener('input', () => {
              inboxReplyDraft = String(fullPageReplyTextarea.value || '');
              if (fullPageSendBtn) {
                  const isComposerDisabled = selectedInboxConversation?.status === 'suppressed' || selectedInboxConversation?.status === 'resolved';
                  fullPageSendBtn.disabled = isComposerDisabled || isInboxReplySending || !String(inboxReplyDraft || '').trim();
              }
              // Also sync old composer if visible
              const oldTextarea = document.getElementById('reply-thread-composer-input');
              if (oldTextarea && oldTextarea !== fullPageReplyTextarea) {
                  oldTextarea.value = inboxReplyDraft;
              }
          });
      }

      if (fullPageSendBtn) {
          fullPageSendBtn.addEventListener('click', async () => {
              await sendInboxConversationReply();
              if (fullPageReplyTextarea) fullPageReplyTextarea.value = '';
          });
      }
  }

  function updateLinkedInPasswordField(account = null) {
      const passwordInput = document.getElementById('linkedin-password');
      if (!passwordInput) return;

      const hasStoredPassword = Boolean(account?.hasPassword);
      passwordInput.value = '';
      passwordInput.dataset.hasStoredPassword = hasStoredPassword ? 'true' : 'false';
      passwordInput.placeholder = hasStoredPassword
          ? 'Stored securely. Enter a new password to replace it.'
          : 'Your password';
  }

  function fillLinkedInAccountForm(account) {
      const accountIdInput = document.getElementById('linkedin-account-id');
      const accountNameInput = document.getElementById('linkedin-account-name');
      const emailInput = document.getElementById('linkedin-email');

      if (accountIdInput) accountIdInput.value = account?.id || '';
      if (accountNameInput) accountNameInput.value = account?.name || '';
      if (emailInput) emailInput.value = account?.email || '';
      updateLinkedInPasswordField(account || null);
      selectedLinkedInAccountId = account?.id || null;
  }

  function updateLinkedInProfileSummary(account) {
      const activeStatus = document.getElementById('topbar-linkedin-account-status');
      const userNameElement = document.querySelector('.user-name');
      const userEmailElement = document.querySelector('.user-email');
      const avatarElement = document.querySelector('.avatar');
      const healthState = resolveLinkedInAccountHealthState(account?.id || null);

      if (activeStatus) {
          activeStatus.textContent = account?.email
              ? `${account.name || buildLinkedInAccountName(account.email)} • ${account.email} • ${healthState.label}`
              : 'No profile selected';
          activeStatus.dataset.healthState = account?.id ? healthState.kind : 'unknown';
          activeStatus.title = account?.id ? healthState.detail : '';
      }

      if (userNameElement) {
          userNameElement.textContent = account?.name || 'No LinkedIn Profile';
      }
      if (userEmailElement) {
          userEmailElement.textContent = account?.email || 'Save a profile in Credentials';
      }
      if (avatarElement) {
          const source = account?.name || account?.email || 'L';
          avatarElement.textContent = source.charAt(0).toUpperCase();
      }
  }

  function populateLinkedInAccountSelect(selectElement, activeId) {
      if (!selectElement) return;

      if (!linkedInAccounts.length) {
          selectElement.innerHTML = '<option value="">No saved profiles</option>';
          selectElement.value = '';
          return;
      }

      selectElement.innerHTML = linkedInAccounts.map((account) => {
          const label = `${account.name || buildLinkedInAccountName(account.email)} (${account.email})`;
          return `<option value="${account.id}">${label}</option>`;
      }).join('');
      selectElement.value = activeId || linkedInAccounts[0].id;
  }

  function getAccountRuntimeJobs(accountId) {
      return linkedInRuntimeJobs.filter((job) => job.accountId === accountId);
  }

  function renderLinkedInRuntimeTabs() {
      const runtimeTabs = document.getElementById('linkedin-runtime-tabs');
      if (!runtimeTabs) return;

      if (!linkedInAccounts.length) {
          runtimeTabs.innerHTML = '';
          return;
      }

      runtimeTabs.innerHTML = linkedInAccounts.map((account) => {
          const jobs = getAccountRuntimeJobs(account.id);
          const isActive = account.id === activeLinkedInAccountId;
          const isRunning = jobs.length > 0;
          const healthState = resolveLinkedInAccountHealthState(account.id);
          const jobLabel = isRunning
              ? `${jobs.length} running job${jobs.length === 1 ? '' : 's'}`
              : 'Ready';

          return `
              <button type="button" class="linkedin-runtime-tab ${isActive ? 'is-active' : ''} ${isRunning ? 'is-running' : ''} ${healthState.kind === 'cooldown' ? 'is-cooldown' : ''} ${healthState.kind === 'warning' ? 'is-warning' : ''} ${healthState.kind === 'challenge' ? 'is-challenge' : ''}" data-runtime-account-id="${account.id}" title="${escapeHtml(healthState.detail)}">
                  <span class="linkedin-runtime-tab-title">${escapeHtml(account.name || buildLinkedInAccountName(account.email))}</span>
                  <span class="linkedin-runtime-tab-meta">${escapeHtml(account.email || '')}</span>
                  <span class="linkedin-runtime-tab-meta">${escapeHtml(jobLabel)}</span>
                  <span class="linkedin-runtime-tab-meta linkedin-account-health ${healthState.kind === 'cooldown' ? 'is-cooldown' : ''} ${healthState.kind === 'warning' ? 'is-warning' : ''} ${healthState.kind === 'challenge' ? 'is-challenge' : ''}">${escapeHtml(healthState.label)}</span>
              </button>
          `;
      }).join('');

      runtimeTabs.querySelectorAll('[data-runtime-account-id]').forEach((button) => {
          button.addEventListener('click', () => {
              switchActiveLinkedInAccount(button.getAttribute('data-runtime-account-id'), {
                  preferredAccountId: button.getAttribute('data-runtime-account-id'),
                  silent: true
              });
          });
      });
  }

  function setLinkedInRuntimeJobs(jobs) {
      linkedInRuntimeJobs = Array.isArray(jobs) ? jobs : [];
      renderLinkedInRuntimeTabs();
      renderLinkedInAccountList();
  }

  function renderLinkedInAccountList() {
      const accountList = document.getElementById('linkedin-account-list');
      if (!accountList) return;

      if (!linkedInAccounts.length) {
          accountList.innerHTML = '<div class="inbox-empty"><p>No LinkedIn profiles saved.</p></div>';
          return;
      }

      accountList.innerHTML = linkedInAccounts.map((account) => {
          const isActive = account.id === activeLinkedInAccountId;
          const healthState = resolveLinkedInAccountHealthState(account.id);
          const dotColor = healthState.kind === 'challenge' ? 'var(--error)' : healthState.kind === 'cooldown' ? 'var(--status-warning-dot)' : healthState.kind === 'warning' ? 'var(--status-warning-dot)' : 'var(--status-active-dot)';
          return `
              <div class="linkedin-account-card ${isActive ? 'is-active' : ''} ${healthState.kind === 'cooldown' ? 'is-cooldown' : ''} ${healthState.kind === 'warning' ? 'is-warning' : ''} ${healthState.kind === 'challenge' ? 'is-challenge' : ''}" style="padding:12px 16px;cursor:pointer;transition:background 0.15s;${isActive ? 'background:var(--surface-container-lowest);border-left:4px solid var(--primary);' : ''}">
                  <div class="linkedin-account-card-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                      <div class="linkedin-account-card-name" style="font-size:12px;font-weight:700">${escapeHtml(account.name || buildLinkedInAccountName(account.email))}</div>
                      <div style="width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0"></div>
                  </div>
                  <div class="linkedin-account-card-email" style="font-size:10px;color:var(--on-surface-variant)">Status: ${escapeHtml(healthState.label)}</div>
                  <div class="linkedin-account-card-actions" style="display:flex;gap:4px;margin-top:8px">
                      ${healthState.canClear ? `<button type="button" class="btn btn-primary btn-sm" style="font-size:10px;padding:2px 8px" data-linkedin-account-action="clear-challenge" data-linkedin-account-id="${account.id}">Verify</button>` : ''}
                      <button type="button" class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 8px" data-linkedin-account-action="edit" data-linkedin-account-id="${account.id}">Open</button>
                      <button type="button" class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 8px" data-linkedin-account-action="activate" data-linkedin-account-id="${account.id}">Use</button>
                      <button type="button" class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 8px" data-linkedin-account-action="delete" data-linkedin-account-id="${account.id}">Del</button>
                  </div>
              </div>
          `;
      }).join('');
  }

  async function refreshLinkedInAccountState(preferredAccountId = null) {
      try {
          const [accounts, activeAccount, health] = await Promise.all([
              window.electronAPI?.getLinkedInAccounts?.() || [],
              window.electronAPI?.getActiveLinkedInAccount?.() || null,
              window.electronAPI?.getLinkedInAccountHealth?.() || {}
          ]);

          linkedInAccounts = Array.isArray(accounts) ? accounts : [];
          linkedInAccountHealth = health && typeof health === 'object' ? health : {};
          activeLinkedInAccountId = activeAccount?.id || linkedInAccounts[0]?.id || null;

          populateLinkedInAccountSelect(document.getElementById('topbar-linkedin-account-select'), activeLinkedInAccountId);
          populateLinkedInAccountSelect(document.getElementById('credentials-account-select'), activeLinkedInAccountId);
          renderLinkedInRuntimeTabs();
          renderLinkedInAccountList();

          const formAccount = getLinkedInAccountById(preferredAccountId)
              || getLinkedInAccountById(selectedLinkedInAccountId)
              || getLinkedInAccountById(activeLinkedInAccountId)
              || null;
          fillLinkedInAccountForm(formAccount);
          updateLinkedInProfileSummary(activeAccount || formAccount);
          updateLoginState(Boolean(activeAccount?.email && activeAccount?.hasPassword));
          await refreshSearchAgentState();

          document.dispatchEvent(new CustomEvent('connect-ability:active-linkedin-account-changed', {
              detail: {
                  accountId: activeLinkedInAccountId,
                  account: activeAccount || formAccount || null
              }
          }));

          if (document.getElementById('dashboard-section')?.classList.contains('active')) {
              loadDashboardData();
          }
          if (document.getElementById('profiles-section')?.classList.contains('active')) {
              loadProfilesData();
          }
          if (document.getElementById('credentials-section')?.classList.contains('active')) {
              loadApolloStatusCard();
          }
      } catch (error) {
          addLogEntry(`Failed to load LinkedIn profiles: ${error.message || error}`, LOG_TYPES.ERROR);
      }
  }

  async function switchActiveLinkedInAccount(accountId, options = {}) {
      const targetAccountId = String(accountId || '').trim();
      if (!targetAccountId) return;

      const result = await window.electronAPI?.setActiveLinkedInAccount?.(targetAccountId);
      if (!result?.success) {
          addLogEntry(result?.error || 'Failed to switch LinkedIn profile.', LOG_TYPES.ERROR);
          return;
      }

      await refreshLinkedInAccountState(options.preferredAccountId || targetAccountId);
      if (!options.silent) {
          const label = result.activeAccount?.name || result.activeAccount?.email || 'LinkedIn profile';
          addLogEntry(`Active LinkedIn profile set to "${label}".`, LOG_TYPES.SUCCESS);
      }
  }

  function getSdrAgentById(agentId) {
      return sdrAgents.find((agent) => agent.id === agentId) || null;
  }

  function getSelectedSearchAgent() {
      const agentId = document.getElementById('search-agent-select')?.value || '';
      return getSdrAgentById(agentId);
  }

  function getSelectedSearchPreset() {
      const presetId = document.getElementById('search-agent-preset')?.value || '';
      return currentSearchAgentPresets.find((preset) => preset.id === presetId) || null;
  }

  function markManagedTemplateInputTouched(input) {
      if (!input) return;
      input.dataset.agentTemplateTouched = 'true';
      input.dataset.agentTemplateManaged = 'false';
      input.dataset.agentTemplateSlot = '';
      input.dataset.agentTemplateAgentId = '';
  }

  function applyManagedTemplateToInput(input, templateInfo, agent, options = {}) {
      if (!input) return false;

      const nextTemplate = String(templateInfo?.template || '').trim();
      const nextSlot = String(templateInfo?.slot || '').trim();
      const currentValue = String(input.value || '');
      const wasManaged = input.dataset.agentTemplateManaged === 'true';
      const wasTouched = input.dataset.agentTemplateTouched === 'true';
      const shouldApply = options.force === true || wasManaged || !wasTouched;

      if (!nextTemplate) {
          if (wasManaged && options.clearManaged !== false) {
              input.value = '';
          }
          input.dataset.agentTemplateManaged = 'false';
          input.dataset.agentTemplateSlot = '';
          input.dataset.agentTemplateAgentId = '';
          return false;
      }

      if (!shouldApply && currentValue.trim()) {
          return false;
      }

      input.value = nextTemplate;
      input.dataset.agentTemplateManaged = 'true';
      input.dataset.agentTemplateTouched = 'false';
      input.dataset.agentTemplateSlot = nextSlot;
      input.dataset.agentTemplateAgentId = agent?.id || '';
      return true;
  }

  function applySearchAgentConnectionTemplate(agent, options = {}) {
      if (!connectMessage || !window.AgentMessageDefaults?.resolveAgentStepTemplate) {
          return false;
      }

      const templateInfo = window.AgentMessageDefaults.resolveAgentStepTemplate(agent, 'send_connection', { occurrence: 1 });
      return applyManagedTemplateToInput(connectMessage, templateInfo, agent, options);
  }

  function populateSearchAgentOptions(selectedAgentId = document.getElementById('search-agent-select')?.value || '') {
      const select = document.getElementById('search-agent-select');
      if (!select) return;

      select.innerHTML = '<option value="">No SDR agent preset</option>';
      sdrAgents.forEach((agent) => {
          const option = document.createElement('option');
          option.value = agent.id;
          option.textContent = `${agent.name}${agent.accountName ? ` (${agent.accountName})` : ''}`;
          select.appendChild(option);
      });

      if (selectedAgentId && sdrAgents.some((agent) => agent.id === selectedAgentId)) {
          select.value = selectedAgentId;
      }
  }

  function renderSearchPresetSummary() {
      const summary = document.getElementById('search-agent-preset-summary');
      if (!summary) return;

      const agent = getSelectedSearchAgent();
      const preset = getSelectedSearchPreset();

      if (!agent) {
          summary.textContent = 'Choose an SDR agent to load generated search presets.';
          return;
      }

      if (!preset) {
          const count = currentSearchAgentPresets.length;
          summary.textContent = count
              ? `${count} generated preset${count === 1 ? '' : 's'} available for ${agent.name}.`
              : `No generated search presets available for ${agent.name} yet.`;
          return;
      }

      const accountLabel = agent.accountName || agent.accountId || 'assigned LinkedIn account';
      summary.textContent = `${preset.query} • Uses ${accountLabel}.`;
  }

  async function loadSearchAgentPresets(agentId, preferredPresetId = '') {
      const normalizedAgentId = String(agentId || '').trim();
      const presetSelect = document.getElementById('search-agent-preset');
      currentSearchAgentPresets = [];
      currentSearchPresetAgentId = normalizedAgentId || null;

      if (!presetSelect) return [];

      presetSelect.innerHTML = '<option value="">Select a saved search...</option>';
      if (!normalizedAgentId || !window.electronAPI?.getSdrAgentSearchPresets) {
          renderSearchPresetSummary();
          return [];
      }

      try {
          const presets = await window.electronAPI.getSdrAgentSearchPresets(normalizedAgentId);
          currentSearchAgentPresets = Array.isArray(presets) ? presets : [];
      } catch (error) {
          currentSearchAgentPresets = [];
          addLogEntry(`Failed to load SDR agent search presets: ${error.message || error}`, LOG_TYPES.ERROR);
      }

      currentSearchAgentPresets.forEach((preset) => {
          const option = document.createElement('option');
          option.value = preset.id;
          option.textContent = preset.label || preset.query;
          presetSelect.appendChild(option);
      });

      const presetToSelect = preferredPresetId && currentSearchAgentPresets.some((preset) => preset.id === preferredPresetId)
          ? preferredPresetId
          : '';
      presetSelect.value = presetToSelect;
      renderSearchPresetSummary();
      return currentSearchAgentPresets;
  }

  async function refreshSearchAgentState(preferredAgentId = '') {
      try {
          sdrAgents = await (window.electronAPI?.getSdrAgents?.() || []);
      } catch (error) {
          sdrAgents = [];
          addLogEntry(`Failed to load SDR agents for search presets: ${error.message || error}`, LOG_TYPES.ERROR);
      }

      const selectedAgentId = preferredAgentId || document.getElementById('search-agent-select')?.value || '';
      populateSearchAgentOptions(selectedAgentId);
      await loadSearchAgentPresets(selectedAgentId, document.getElementById('search-agent-preset')?.value || '');
      document.dispatchEvent(new CustomEvent('sdr-agents-changed', {
          detail: { agents: sdrAgents.slice() }
      }));
  }

  async function applySearchAgentPreset(agentId, presetId, options = {}) {
      const openSection = options.openSection !== false;
      const runNow = options.runNow === true;
      const focusQuery = options.focusQuery !== false;
      const normalizedAgentId = String(agentId || '').trim();
      if (!normalizedAgentId) {
          return false;
      }

      if (openSection) {
          document.querySelector('.nav-link[data-section="automation"]')?.click();
      }

      const searchTypeQuery = document.getElementById('search-type-query');
      if (searchTypeQuery && !searchTypeQuery.checked) {
          searchTypeQuery.checked = true;
          searchTypeQuery.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const agentSelect = document.getElementById('search-agent-select');
      if (agentSelect?.value !== normalizedAgentId) {
          agentSelect.value = normalizedAgentId;
      }

      const presets = currentSearchAgentPresets.length && agentSelect?.value === normalizedAgentId
          && currentSearchPresetAgentId === normalizedAgentId
          ? currentSearchAgentPresets
          : await loadSearchAgentPresets(normalizedAgentId, presetId);
      const preset = presets.find((entry) => entry.id === presetId) || null;
      if (!preset) {
          return false;
      }
      const agent = getSdrAgentById(normalizedAgentId);

      const presetSelect = document.getElementById('search-agent-preset');
      if (presetSelect) {
          presetSelect.value = preset.id;
      }

      const searchQueryInput = document.getElementById('search-query');
      if (searchQueryInput) {
          searchQueryInput.value = preset.query || '';
          if (focusQuery) {
              searchQueryInput.focus();
              searchQueryInput.select?.();
          }
      }

      applySearchAgentConnectionTemplate(agent);

      const profileLimitInput = document.getElementById('profile-limit');
      if (profileLimitInput && preset.defaultProfileLimit) {
          profileLimitInput.value = String(preset.defaultProfileLimit);
      }

      if (agent?.accountId && agent.accountId !== activeLinkedInAccountId) {
          await switchActiveLinkedInAccount(agent.accountId, {
              preferredAccountId: agent.accountId,
              silent: true
          });
      }

      renderSearchPresetSummary();
      addLogEntry(`Loaded SDR search preset "${preset.label || preset.query}" from "${agent?.name || 'SDR agent'}".`, LOG_TYPES.INFO);

      if (runNow) {
          await startAutomation();
      }
      return true;
  }

  function createNewLinkedInProfileDraft() {
      fillLinkedInAccountForm(null);
      const accountNameInput = document.getElementById('linkedin-account-name');
      accountNameInput?.focus();
  }

  async function saveCredentials() {
      const accountIdInput = document.getElementById('linkedin-account-id');
      const accountNameInput = document.getElementById('linkedin-account-name');
      const emailInput = document.getElementById('linkedin-email');
      const passwordInput = document.getElementById('linkedin-password');
      
      if (!emailInput || !passwordInput) return;

      const existingAccount = accountIdInput?.value
          ? getLinkedInAccountById(accountIdInput.value)
          : null;
      const hasStoredPassword = Boolean(existingAccount?.hasPassword || passwordInput.dataset.hasStoredPassword === 'true');
      
      if (!emailInput.value.trim()) {
          addLogEntry('Please enter a LinkedIn email to save.', LOG_TYPES.ERROR);
          return;
      }

      if (!passwordInput.value && !hasStoredPassword) {
          addLogEntry('Please enter a LinkedIn password to save.', LOG_TYPES.ERROR);
          return;
      }
      
      try {
          const result = await window.electronAPI?.saveLinkedInAccount?.({
              id: accountIdInput?.value || null,
              name: accountNameInput?.value?.trim() || buildLinkedInAccountName(emailInput.value),
              email: emailInput.value.trim(),
              password: passwordInput.value || undefined,
              makeActive: true
          });

          if (!result?.success) {
              addLogEntry(result?.error || 'Failed to save LinkedIn profile.', LOG_TYPES.ERROR);
              return;
          }

          await refreshLinkedInAccountState(result.account?.id || result.activeAccountId || null);
          addLogEntry(`Saved LinkedIn profile "${result.account?.name || result.account?.email}".`, LOG_TYPES.SUCCESS);
      } catch (error) {
          addLogEntry(`Error saving LinkedIn profile: ${error.message || error}`, LOG_TYPES.ERROR);
      }
  }
  
  async function clearCredentials() {
      const targetAccountId = selectedLinkedInAccountId || activeLinkedInAccountId || document.getElementById('linkedin-account-id')?.value;
      const targetAccount = getLinkedInAccountById(targetAccountId);
      if (!targetAccountId || !targetAccount) {
          fillLinkedInAccountForm(null);
          updateLoginState(false);
          return;
      }

      if (!window.confirm(`Delete LinkedIn profile "${targetAccount.name || targetAccount.email}"?`)) {
          return;
      }

      try {
          const result = await window.electronAPI?.deleteLinkedInAccount?.(targetAccountId);
          if (!result?.success) {
              addLogEntry(result?.error || 'Failed to delete LinkedIn profile.', LOG_TYPES.ERROR);
              return;
          }

          await refreshLinkedInAccountState(result.activeAccountId || null);
          addLogEntry(`Deleted LinkedIn profile "${targetAccount.name || targetAccount.email}".`, LOG_TYPES.INFO);
      } catch (error) {
          addLogEntry(`Error deleting LinkedIn profile: ${error.message || error}`, LOG_TYPES.ERROR);
      }
  }
  
  // Update login state UI
  function updateLoginState(isLoggedIn) {
      const loginButton = document.getElementById('login-button');
      const logoutButton = document.getElementById('logout-button');
      const loginStatus = document.getElementById('login-status');
      
      if (loginButton) loginButton.style.display = isLoggedIn ? 'none' : 'block';
      if (logoutButton) logoutButton.style.display = isLoggedIn ? 'block' : 'none';
      
      if (loginStatus) {
          loginStatus.textContent = isLoggedIn ? 'Logged In' : 'Not Logged In';
          loginStatus.className = isLoggedIn ? 'status-success' : 'status-error';
      }
  }
  
  // Initialize the app
  function initApp() {
      if (appInitialized) {
          return;
      }
      appInitialized = true;
    
      // Sidebar toggle
      sidebarToggle.addEventListener('click', toggleSidebar);
      
      // Navigation
      navLinks.forEach(link => {
          link.addEventListener('click', handleNavigation);
      });
      
      // Load user data if available
      loadUserData();
      
      // Initialize automation controls
      if (startButton) startButton.addEventListener('click', startAutomation);
      if (stopButton) stopButton.addEventListener('click', stopAutomation);
      if (clearButton) clearButton.addEventListener('click', clearTerminal);
      if (exportButton) exportButton.addEventListener('click', exportLogs);
      if (exportActivityReportButton) exportActivityReportButton.addEventListener('click', exportActivityReport);
      if (exportDiagnosticsReportButton) exportDiagnosticsReportButton.addEventListener('click', exportDiagnosticsReport);
      
      // Load LinkedIn credentials
      refreshLinkedInAccountState();
      if (window.electronAPI?.getLinkedInRuntimeJobs) {
          window.electronAPI.getLinkedInRuntimeJobs().then((jobs) => {
              setLinkedInRuntimeJobs(jobs);
          }).catch(() => {});
      }
      
      // Initialize credentials form events
      initCredentialsForm();
      bindReplyNotificationCenter();
      
      // Show/hide connection message textarea based on checkbox
      if (sendConnection) {
          sendConnection.addEventListener('change', toggleConnectionMessage);
          toggleConnectionMessage();
      }
      
      // Load dashboard data
      if (document.getElementById('dashboard-section')) {
          loadDashboardData();
      }
      refreshInboxConversations().catch(() => {});
      
      // Initialize search in profiles
      const profileSearch = document.querySelector('.search-box input');
      if (profileSearch) {
          profileSearch.addEventListener('input', filterProfiles);
      }
      
      // Add IPC event listeners
      setupIPCListeners();

      // Initialize workflow-builder interactions in Automation tab
      initAutomationWorkflowBuilder();
  }

  function initAutomationWorkflowBuilder() {
    const modeTabs = document.querySelectorAll('#automation-section .mode-tab');
    const modePanels = {
      search: document.getElementById('search-mode'),
      group: document.getElementById('group-mode')
    };
    modeTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-mode');
        modeTabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        Object.entries(modePanels).forEach(([key, panel]) => {
          if (!panel) return;
          panel.classList.toggle('active', key === mode);
        });
      });
    });

    const searchTypeQuery = document.getElementById('search-type-query');
    const searchTypeNames = document.getElementById('search-type-names');
    const keywordSearchSection = document.getElementById('keyword-search-section');
    const nameSearchSection = document.getElementById('name-search-section');
    const searchAgentSelect = document.getElementById('search-agent-select');
    const searchAgentPresetSelect = document.getElementById('search-agent-preset');
    connectMessage?.addEventListener('input', () => {
      markManagedTemplateInputTouched(connectMessage);
    });
    const syncSearchType = () => {
      const useNames = !!searchTypeNames?.checked;
      if (keywordSearchSection) keywordSearchSection.style.display = useNames ? 'none' : 'block';
      if (nameSearchSection) nameSearchSection.style.display = useNames ? 'block' : 'none';
    };
    if (searchTypeQuery) searchTypeQuery.addEventListener('change', syncSearchType);
    if (searchTypeNames) searchTypeNames.addEventListener('change', syncSearchType);
    syncSearchType();

    searchAgentSelect?.addEventListener('change', async () => {
      applySearchAgentConnectionTemplate(getSelectedSearchAgent());
      await loadSearchAgentPresets(searchAgentSelect.value);
    });

    searchAgentPresetSelect?.addEventListener('change', async () => {
      const preset = getSelectedSearchPreset();
      if (!preset) {
        renderSearchPresetSummary();
        return;
      }
      await applySearchAgentPreset(searchAgentSelect?.value || '', preset.id, {
        openSection: false,
        runNow: false,
        focusQuery: false
      });
    });

    document.addEventListener('sdr-agents-changed', async (event) => {
      sdrAgents = Array.isArray(event.detail?.agents) ? event.detail.agents : [];
      const selectedAgentId = searchAgentSelect?.value || '';
      populateSearchAgentOptions(selectedAgentId);
      applySearchAgentConnectionTemplate(getSelectedSearchAgent());
      await loadSearchAgentPresets(selectedAgentId, searchAgentPresetSelect?.value || '');
    });

    const actionCards = document.querySelectorAll('#automation-section .workflow-action-card');
    const summaryRoot = document.getElementById('workflow-action-summary');
    const labelByAction = {
      'visit-profile': 'Visit Profile',
      'like-posts': 'Like Posts',
      'send-connection': 'Send Connection'
    };

    const renderActionSummary = () => {
      if (!summaryRoot) return;
      const selectedCards = Array.from(actionCards).filter(
        (card) => !card.classList.contains('is-hidden')
      );
      if (!selectedCards.length) {
        summaryRoot.innerHTML = `
          <div class="workflow-summary-title">Selected Workflow</div>
          <div class="workflow-summary-empty">No actions selected yet.</div>
        `;
        return;
      }

      const items = selectedCards
        .map((card, index) => {
          const key = card.getAttribute('data-action');
          const checkbox = card.querySelector('input[type="checkbox"]');
          const enabled = checkbox?.checked ? 'Enabled' : 'Disabled';
          return `<span class="workflow-summary-item">${index + 1}. ${labelByAction[key] || key} · ${enabled}</span>`;
        })
        .join('');

      summaryRoot.innerHTML = `
        <div class="workflow-summary-title">Selected Workflow</div>
        <div class="workflow-summary-list">${items}</div>
      `;
    };

    document.querySelectorAll('#automation-section .workflow-action-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const action = chip.getAttribute('data-action-card');
        const card = document.querySelector(`#automation-section .workflow-action-card[data-action="${action}"]`);
        if (!card) return;
        card.classList.remove('is-hidden');
        card.classList.remove('is-collapsed');
        const checkbox = card.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = true;
        renderActionSummary();
      });
    });

    document.querySelectorAll('#automation-section .workflow-card-toggle').forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const action = toggle.getAttribute('data-target-action');
        const card = document.querySelector(`#automation-section .workflow-action-card[data-action="${action}"]`);
        if (!card) return;
        card.classList.toggle('is-collapsed');
      });
    });

    document.querySelectorAll('#automation-section .workflow-card-remove').forEach((removeBtn) => {
      removeBtn.addEventListener('click', () => {
        const action = removeBtn.getAttribute('data-remove-action');
        const card = document.querySelector(`#automation-section .workflow-action-card[data-action="${action}"]`);
        if (!card) return;
        const checkbox = card.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = false;
        card.classList.add('is-hidden');
        renderActionSummary();
      });
    });

    actionCards.forEach((card) => {
      const action = card.getAttribute('data-action');
      if (!action) return;
      const checkbox = card.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.addEventListener('change', renderActionSummary);
      }
      // Start compact: keep cards visible but collapsed for cleaner UI.
      card.classList.add('is-collapsed');
    });

    renderActionSummary();

    initGroupWorkflowControls();
  }

  async function initGroupWorkflowControls() {
    const groupSelect = document.getElementById('workflow-group-select');
    const groupInfo = document.getElementById('selected-group-info');
    const groupName = document.getElementById('group-info-name');
    const groupMembers = document.getElementById('group-info-members');
    const groupDescription = document.getElementById('group-info-description');
    const addStepBtn = document.getElementById('add-step');
    const runBtn = document.getElementById('group-workflow-run');
    const stopBtn = document.getElementById('group-workflow-stop');
    const statusNode = document.getElementById('group-workflow-status');
    const stepsContainer = document.getElementById('workflow-steps-container');

    if (!groupSelect || !addStepBtn || !stepsContainer) return;

    const groups = await loadWorkflowGroups();
    groupSelect.innerHTML = '<option value="">Choose a Group</option>';
    groups.forEach((group) => {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = `${group.name} (${(group.members || []).length} profiles)`;
      groupSelect.appendChild(option);
    });

    groupSelect.addEventListener('change', () => {
      const selected = groups.find((g) => String(g.id) === String(groupSelect.value));
      if (!selected) {
        if (groupInfo) groupInfo.style.display = 'none';
        return;
      }
      if (groupInfo) groupInfo.style.display = 'block';
      if (groupName) groupName.textContent = selected.name || 'Unnamed Group';
      if (groupMembers) groupMembers.textContent = String((selected.members || []).length);
      if (groupDescription) groupDescription.textContent = selected.description || 'No description';
    });

    addStepBtn.addEventListener('click', () => {
      const empty = stepsContainer.querySelector('.empty-steps');
      if (empty) empty.remove();
      addStepRow({
        type: 'view_profile'
      });
    });

    if (!stepsContainer.querySelector('.step-item')) {
      addStepBtn.click();
      addStepBtn.click();
      const rows = stepsContainer.querySelectorAll('.step-item');
      if (rows[0]) rows[0].querySelector('.step-type-select').value = 'view_profile';
      if (rows[1]) rows[1].querySelector('.step-type-select').value = 'delay';
      rows.forEach((row) => wireRow(row));
      renderStepNumbers();
    }

    if (runBtn) {
      runBtn.addEventListener('click', async () => {
        const groupId = groupSelect.value;
        if (!groupId) {
          addLogEntry('Please select a group before running workflow.', 'error');
          return;
        }

        const steps = collectGroupWorkflowSteps();
        if (!steps.length) {
          addLogEntry('Add at least one step to the group workflow.', 'error');
          return;
        }

        const payload = {
          groupId,
          steps,
          browserProfile: 'random',
          headless: document.getElementById('headless-mode')?.checked || false,
          slowMo: 100
        };

        try {
          runBtn.disabled = true;
          if (stopBtn) stopBtn.disabled = false;
          if (statusNode) statusNode.textContent = `Running workflow with ${steps.length} steps...`;
          addLogEntry(`Starting group workflow (${steps.length} steps)...`, 'info');
          await window.electronAPI.runGroupWorkflow(payload);
        } catch (error) {
          addLogEntry(`Failed to start group workflow: ${error.message}`, 'error');
          if (statusNode) statusNode.textContent = 'Failed to start workflow.';
          runBtn.disabled = false;
          if (stopBtn) stopBtn.disabled = true;
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        window.electronAPI.send('stop-group-workflow');
        if (statusNode) statusNode.textContent = 'Stopping group workflow...';
      });
    }

    if (window.electronAPI?.on) {
      window.electronAPI.on('workflow-log', (entry) => {
        if (entry?.message) addLogEntry(entry.message, entry.type || 'info');
      });
      window.electronAPI.on('workflow-done', ({ code }) => {
        if (runBtn) runBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        if (statusNode) statusNode.textContent = code === 0 ? 'Workflow completed.' : `Workflow stopped (code ${code}).`;
      });
    }
  }

  async function loadWorkflowGroups() {
    try {
      if (window.electronAPI?.getGroupsData) {
        const data = await window.electronAPI.getGroupsData();
        if (Array.isArray(data) && data.length) return data;
      }
    } catch (error) {
      console.warn('Failed loading groups from backend:', error.message);
    }
    try {
      const local = JSON.parse(localStorage.getItem('standalone-groups') || '[]');
      return Array.isArray(local) ? local : [];
    } catch (_) {
      return [];
    }
  }

  function collectGroupWorkflowSteps() {
    const rows = Array.from(document.querySelectorAll('#workflow-steps-container .step-item'));
    const steps = [];
    const delayUnitMsMap = {
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
      months: 30 * 24 * 60 * 60 * 1000
    };
    rows.forEach((row, index) => {
      const type = row.querySelector('.step-type-select')?.value;
      if (!type) return;
      const delayValueRaw = parseInt(row.querySelector('.step-delay-value')?.value || '1', 10);
      const delayValue = Math.max(1, Number.isFinite(delayValueRaw) ? delayValueRaw : 1);
      const delayUnit = row.querySelector('.step-delay-unit')?.value || 'hours';
      const delayMs = delayValue * (delayUnitMsMap[delayUnit] || delayUnitMsMap.hours);
      const messageTemplate = (row.querySelector('.step-message-template')?.value || '').trim();
      const minDelayMs = type === 'delay' ? delayMs : 8 * 1000;
      const maxDelayMs = type === 'delay' ? delayMs : 18 * 1000;
      steps.push({
        order: index + 1,
        type,
        minDelayMs,
        maxDelayMs,
        delayUnit,
        delayValue,
        messageTemplate
      });
    });
    return steps;
  }
  
  // Toggle sidebar
  function toggleSidebar() {
      sidebar.classList.toggle('sidebar-collapsed');
      
      // Change toggle icon direction
      const icon = this.querySelector('svg');
      if (sidebar.classList.contains('sidebar-collapsed')) {
          icon.innerHTML = '<polyline points="9 18 15 12 9 6"></polyline>';
      } else {
          icon.innerHTML = '<polyline points="15 18 9 12 15 6"></polyline>';
      }
  }
  
  // Handle navigation
  function handleNavigation(e) {
    e.preventDefault();
    const currentNavLinks = document.querySelectorAll('.nav-link');
    const currentSections = document.querySelectorAll('.app-section');
    
    // Remove active class from all links
    currentNavLinks.forEach(navLink => navLink.classList.remove('active'));
    
    // Add active class to clicked link
    this.classList.add('active');
    
    // Get section to show
    const sectionId = this.getAttribute('data-section') + '-section';
    
    // Hide all sections
    currentSections.forEach(section => section.classList.remove('active'));
    
    // Show selected section
    const selectedSection = document.getElementById(sectionId);
    if (selectedSection) {
      selectedSection.classList.add('active');
      pageTitle.textContent = this.querySelector('.nav-text').textContent;
      
      // Show loading state first if needed
      if (sectionId === 'profiles-section') {
        selectedSection.innerHTML = `
          <div class="card">
            <div class="card-header">
              <h2 class="card-title">Profile Management</h2>
              <div class="loading-indicator">Loading profiles...</div>
            </div>
          </div>
        `;
      }
      
      // Load section-specific data with proper async handling
      if (sectionId === 'dashboard-section') {
        loadDashboardData();
      } else if (sectionId === 'credentials-section') {
        loadApolloStatusCard();
      } else if (sectionId === 'profiles-section') {
        // Use setTimeout with 0ms to ensure the loading state is rendered first
        setTimeout(() => loadProfilesData(), 0);
      }
    }
  }
  
  // Load user data
  function loadUserData() {
      const savedUser = localStorage.getItem('user');
      if (savedUser) {
          try {
              const user = JSON.parse(savedUser);
              const userNameElement = document.querySelector('.user-name');
              const userEmailElement = document.querySelector('.user-email');
              const avatarElement = document.querySelector('.avatar');
              if (userNameElement && user.name) userNameElement.textContent = user.name;
              if (userEmailElement && user.email) userEmailElement.textContent = user.email;
              if (avatarElement && user.name) avatarElement.textContent = user.name.charAt(0);
          } catch (error) {
              console.error('Error loading user data:', error);
          }
      }
  }
  
  // Add log entry to terminal
  function addLogEntry(message, type = LOG_TYPES.NORMAL) {
      if (!terminalContent) return;
      
      const logEntry = document.createElement('div');
      logEntry.className = 'log-entry';
      const timestamp = new Date().toLocaleTimeString();
      const logTime = document.createElement('span');
      logTime.className = 'log-time';
      logTime.textContent = `[${timestamp}]`;
      const logMessage = document.createElement('span');
      logMessage.className = `log-message ${type}`;
      logMessage.textContent = message;
      
      logEntry.appendChild(logTime);
      logEntry.appendChild(logMessage);
      terminalContent.appendChild(logEntry);
      terminalContent.scrollTop = terminalContent.scrollHeight;
      
      logs.push({
          time: timestamp,
          message: message,
          type: type
      });
  }

  function addAntiFlickerStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .loading-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        color: var(--gray-600);
      }
      
      .profiles-list {
        min-height: 200px;
      }
      
      .card {
        min-height: 100px;
      }
      
      /* Prevent content jump during loading */
      #profiles-section {
        min-height: 400px;
      }
      
      /* Smooth transitions */
      .profile-item, .profiles-list, .card {
        transition: opacity 0.2s ease;
      }
    `;
    document.head.appendChild(style);
  }
  
  // Update progress bar
  function updateProgress(current, total) {
      if (!progressFill || !profilesProcessed) return;
      const percentage = (current / total) * 100;
      progressFill.style.width = `${percentage}%`;
      profilesProcessed.textContent = `${current}/${total} profiles`;
  }
  
  // Update timer
  function updateTimer() {
      if (!timeElapsed) return;
      const now = new Date();
      const elapsedSeconds = Math.floor((now - startTime) / 1000);
      const minutes = Math.floor(elapsedSeconds / 60);
      const seconds = elapsedSeconds % 60;
      timeElapsed.textContent = `Time: ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  
// Define startAutomation function globally
async function startAutomation() {
  const activeMode = document.querySelector('#automation-section .mode-tab.active')?.getAttribute('data-mode');
  if (activeMode === 'group') {
    const groupRunBtn = document.getElementById('group-workflow-run');
    if (groupRunBtn) {
      groupRunBtn.click();
    } else {
      addLogEntry('Group workflow controls are unavailable.', 'error');
    }
    return;
  }

  const searchType = document.querySelector('input[name="search-type"]:checked')?.value;
  const visitProfile = document.getElementById('visit-profile');
  const likePosts = document.getElementById('like-posts');
  const sendConnection = document.getElementById('send-connection');
  const selectedSearchAgent = getSelectedSearchAgent();
  const selectedSearchPreset = getSelectedSearchPreset();
  
  if (!searchType) {
    addLogEntry('Please select a search type.', 'error');
    return;
  }
  
  if (!visitProfile?.checked && !likePosts?.checked && !sendConnection?.checked) {
    addLogEntry('Please select at least one engagement option.', 'error');
    return;
  }
  
  let config = {
    accountId: selectedSearchAgent?.accountId || activeLinkedInAccountId || null,
    accountName: selectedSearchAgent?.accountName || getActiveLinkedInAccount()?.name || null,
    agentId: selectedSearchAgent?.id || null,
    agentName: selectedSearchAgent?.name || null,
    visitProfile: visitProfile?.checked || false,
    likePosts: likePosts?.checked || false,
    sendConnection: sendConnection?.checked || false,
    sendWithNote: document.getElementById('with-note')?.checked || false,
    connectMessage: document.getElementById('connect-message')?.value || '',
    browserProfile: 'random',
    headless: document.getElementById('headless-mode')?.checked || false,
    slowMo: 100,
    searchType: searchType
  };
  
  if (searchType === 'query') {
    const searchQuery = document.getElementById('search-query');
    const profileLimit = document.getElementById('profile-limit');
    const resolvedSearchQuery = (searchQuery?.value || '').trim() || selectedSearchPreset?.query || '';
    
    if (!resolvedSearchQuery) {
      addLogEntry('Please enter a search query.', 'error');
      return;
    }

    if (selectedSearchAgent?.accountId && selectedSearchAgent.accountId !== activeLinkedInAccountId) {
      await switchActiveLinkedInAccount(selectedSearchAgent.accountId, {
        preferredAccountId: selectedSearchAgent.accountId,
        silent: true
      });
      config.accountId = selectedSearchAgent.accountId;
      config.accountName = selectedSearchAgent.accountName || getLinkedInAccountById(selectedSearchAgent.accountId)?.name || null;
    }
    
    config.searchQuery = resolvedSearchQuery;
    config.profileLimit = parseInt(profileLimit.value);
    config.searchPresetId = selectedSearchPreset?.id || null;
    config.searchPresetLabel = selectedSearchPreset?.label || null;
    config.searchPresetKind = selectedSearchPreset?.kind || null;
    
    electronAPIBridge.startAutomation(config);
  } else if (searchType === 'names') {
    const nameListTextarea = document.getElementById('name-list');
    
    if (!nameListTextarea?.value?.trim()) {
      addLogEntry('Please enter a list of names.', 'error');
      return;
    }
    
    const nameList = parseNameList(nameListTextarea.value);
    config.nameList = nameList;
    
    electronAPIBridge.startNameListAutomation(config);
  }
}

// Make it globally available
window.startAutomation = startAutomation;
  
  // Stop automation
  function stopAutomation() {
      window.electronAPI?.stopAutomation?.({ accountId: activeLinkedInAccountId || null });
  }
  
  // Clear terminal
  function clearTerminal() {
      if (!terminalContent) return;
      terminalContent.innerHTML = '';
      addLogEntry('Terminal cleared.', LOG_TYPES.INFO);
      logs = [];
  }
  
  // Export logs
  function exportLogs() {
      if (logs.length === 0) {
          addLogEntry('No logs to export.', LOG_TYPES.WARNING);
          return;
      }
      electronAPIBridge.exportLogs(logs);
  }

  async function exportActivityReport() {
      if (!electronAPIBridge.exportActivityReport) {
          addLogEntry('Analytics export is unavailable in this build.', LOG_TYPES.ERROR);
          return;
      }

      if (exportActivityReportButton) {
          exportActivityReportButton.disabled = true;
          exportActivityReportButton.textContent = 'Exporting...';
      }

      try {
          const result = await electronAPIBridge.exportActivityReport({
              accountId: activeLinkedInAccountId || null
          });

          if (result?.cancelled) {
              addLogEntry('Analytics export cancelled.', LOG_TYPES.INFO);
              return;
          }

          if (!result?.success) {
              addLogEntry(result?.error || 'Failed to export analytics report.', LOG_TYPES.ERROR);
              return;
          }

          addLogEntry(
              `Exported analytics bundle to ${result.path} (${result.summary?.workflowRuns || 0} runs, ${result.summary?.prospects || 0} prospects, ${result.summary?.dmReplies || 0} replies).`,
              LOG_TYPES.SUCCESS
          );
      } catch (error) {
          addLogEntry(`Failed to export analytics report: ${error.message || error}`, LOG_TYPES.ERROR);
      } finally {
          if (exportActivityReportButton) {
              exportActivityReportButton.disabled = false;
              exportActivityReportButton.textContent = 'Export Analytics';
          }
      }
  }

  async function exportDiagnosticsReport() {
      if (!electronAPIBridge.exportDiagnosticsReport) {
          addLogEntry('Diagnostics export is unavailable in this build.', LOG_TYPES.ERROR);
          return;
      }

      if (exportDiagnosticsReportButton) {
          exportDiagnosticsReportButton.disabled = true;
          exportDiagnosticsReportButton.textContent = 'Exporting...';
      }

      try {
          const result = await electronAPIBridge.exportDiagnosticsReport({
              accountId: activeLinkedInAccountId || null
          });

          if (result?.cancelled) {
              addLogEntry('Diagnostics export cancelled.', LOG_TYPES.INFO);
              return;
          }

          if (!result?.success) {
              addLogEntry(result?.error || 'Failed to export diagnostics report.', LOG_TYPES.ERROR);
              return;
          }

          addLogEntry(
              `Exported diagnostics bundle to ${result.path} (${result.summary?.workflowRuns || 0} runs, ${result.summary?.activityEvents || 0} events, ${result.summary?.runtimeLogs || 0} runtime logs).`,
              LOG_TYPES.SUCCESS
          );
      } catch (error) {
          addLogEntry(`Failed to export diagnostics report: ${error.message || error}`, LOG_TYPES.ERROR);
      } finally {
          if (exportDiagnosticsReportButton) {
              exportDiagnosticsReportButton.disabled = false;
              exportDiagnosticsReportButton.textContent = 'Export Diagnostics';
          }
      }
  }
  
  // Toggle connection message textarea
  function toggleConnectionMessage() {
      if (!connectMessage) return;
      const messageGroup = connectMessage.closest('.form-group');
      messageGroup.style.display = sendConnection.checked ? 'block' : 'none';
  }
  
  // Format numbers with commas
  function formatNumber(num) {
      return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  
  // Format time ago
  function formatTimeAgo(timestamp) {
      const date = new Date(timestamp);
      const now = new Date();
      const seconds = Math.floor((now - date) / 1000);
      if (seconds < 60) return 'Just now';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
      const days = Math.floor(hours / 24);
      if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
      const weeks = Math.floor(days / 7);
      if (weeks < 4) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
      const months = Math.floor(days / 30);
      if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
      const years = Math.floor(days / 365);
      return `${years} year${years !== 1 ? 's' : ''} ago`;
  }
  
  // Load dashboard data
  async function loadDashboardData() {
      const dashboardSection = document.getElementById('dashboard-section');
      if (!dashboardSection) return;
      try {
          const stats = await getDashboardStats();
          updateMetricCards(stats);
          updateActivityOverview(stats);
          updateActivityFeed(stats.recentActivity);
      } catch (error) {
          console.error('Error loading dashboard data:', error);
          updateMetricCards(getEmptyDashboardStats());
          updateActivityOverview(getEmptyDashboardStats());
          updateActivityFeed([]);
      }
  }

  async function getDashboardStats() {
      const [overview, apolloIntegration, apolloSyncs] = await Promise.all([
          window.electronAPI?.getActivityAnalytics?.({
              accountId: activeLinkedInAccountId || null,
              activityLimit: 12
          }),
          window.electronAPI?.getApolloIntegration?.() || {},
          window.electronAPI?.getApolloSyncStatus?.({
              accountId: activeLinkedInAccountId || null,
              limit: 8
          }) || []
      ]);

      return normalizeDashboardStats(overview, apolloIntegration, apolloSyncs);
  }

  function getEmptyDashboardStats() {
      return normalizeDashboardStats({});
  }

  function normalizeDashboardStats(overview = {}, apolloIntegration = {}, apolloSyncs = []) {
      const totals = overview?.totals || {};
      const rates = overview?.rates || {};
      const recentActivity = Array.isArray(overview?.recentActivity) ? overview.recentActivity : [];
      const recentReplies = Array.isArray(overview?.recentReplies) ? overview.recentReplies : [];
      const byAgent = Array.isArray(overview?.byAgent) ? overview.byAgent : [];
      const byWorkflow = Array.isArray(overview?.byWorkflow) ? overview.byWorkflow : [];
      const apolloStatus = normalizeApolloDesktopStatus(apolloIntegration, apolloSyncs);

      return {
          totalProfiles: Number(totals.profilesViewed || 0),
          totalConnections: Number(totals.connectionRequests || 0),
          totalLikes: Number(totals.postLikes || 0),
          responseRate: Number(rates.dmReplyRate || 0),
          totalAccepted: Number(totals.connectionAcceptances || 0),
          totalDmsSent: Number(totals.dmsSent || 0),
          totalDmReplies: Number(totals.dmReplies || 0),
          totalPostsPublished: Number(totals.postsPublished || 0),
          totalWorkflowStarted: Number(totals.workflowStarted || 0),
          totalWorkflowCompleted: Number(totals.workflowCompleted || 0),
          totalWorkflowFailed: Number(totals.workflowFailed || 0),
          recentActivity,
          recentReplies,
          byAgent,
          byWorkflow,
          apolloStatus,
          hasData: recentActivity.length > 0
              || byAgent.length > 0
              || byWorkflow.length > 0
              || apolloStatus.connected
              || apolloStatus.bindings.length > 0
              || apolloStatus.recentSyncs.length > 0
      };
  }
  
  // Update metric cards — 5-card Operator Cockpit layout
  function updateMetricCards(stats) {
      const metricCards = document.querySelectorAll('#dashboard-section .metric-card');
      if (metricCards.length < 4) return;

      const acceptanceRate = stats.totalConnections > 0 ? Math.round((stats.totalAccepted / stats.totalConnections) * 100) : 0;
      const dash = '—';
      const cards = [
          {
              title: 'Profiles Viewed',
              value: formatNumber(stats.totalProfiles),
              change: stats.totalWorkflowStarted > 0 ? `${formatNumber(stats.totalWorkflowStarted)} runs` : dash,
              tone: stats.totalProfiles > 0 ? 'positive' : 'neutral'
          },
          {
              title: 'Connections Sent',
              value: formatNumber(stats.totalConnections),
              change: stats.totalAccepted > 0 ? `${formatNumber(stats.totalAccepted)} accepted` : dash,
              tone: stats.totalAccepted > 0 ? 'positive' : 'neutral'
          },
          {
              title: 'Acceptance Rate',
              value: `${acceptanceRate}%`,
              change: stats.totalConnections > 0 ? `${formatNumber(stats.totalAccepted)}/${formatNumber(stats.totalConnections)}` : dash,
              tone: acceptanceRate > 25 ? 'positive' : acceptanceRate > 0 ? 'negative' : 'neutral'
          },
          {
              title: 'DM Reply Rate',
              value: `${stats.responseRate}%`,
              change: stats.totalDmsSent > 0 ? `${formatNumber(stats.totalDmReplies)}/${formatNumber(stats.totalDmsSent)}` : dash,
              tone: stats.totalDmReplies > 0 ? 'positive' : 'neutral'
          },
          {
              title: 'Unread Replies',
              value: formatNumber(openInboxConversationCount),
              change: openInboxConversationCount > 0 ? 'open' : dash,
              tone: openInboxConversationCount > 0 ? 'positive' : 'neutral'
          }
      ];

      // Cockpit greeting + status line derivation
      const greetingEl = document.getElementById('cockpit-greeting');
      if (greetingEl) {
          const userNameEl = document.querySelector('.sidebar .user-name');
          const rawName = userNameEl ? (userNameEl.textContent || '').trim() : '';
          const firstName = rawName && rawName !== 'No LinkedIn Profile' && rawName !== 'User'
              ? rawName.split(/\s+/)[0]
              : '';
          const hour = new Date().getHours();
          const g = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
          greetingEl.textContent = firstName ? `${g}, ${firstName}.` : `${g}.`;
      }
      const statusEl = document.getElementById('cockpit-status-line');
      if (statusEl) {
          const running = Number(stats.totalWorkflowStarted || 0) - Number(stats.totalWorkflowCompleted || 0) - Number(stats.totalWorkflowFailed || 0);
          const parts = [];
          if (Number(stats.totalWorkflowStarted || 0) > 0) parts.push(`${Math.max(running, 0)} workflows running`);
          if (stats.totalProfiles > 0) parts.push(`${formatNumber(stats.totalProfiles)} profiles · ${formatNumber(stats.totalDmReplies)} replies · 7d`);
          statusEl.textContent = parts.length ? parts.join(' · ') : 'Ready';
      }

      // Topbar health counters (derived from workflow outcomes)
      const healthOkEl = document.getElementById('top-bar-health-ok');
      const healthWarnEl = document.getElementById('top-bar-health-warn');
      const healthDangerEl = document.getElementById('top-bar-health-danger');
      if (healthOkEl && healthWarnEl && healthDangerEl) {
          const failed = Number(stats.totalWorkflowFailed || 0);
          const completed = Number(stats.totalWorkflowCompleted || 0);
          healthOkEl.textContent = completed > 0 ? formatNumber(completed) : '—';
          healthWarnEl.textContent = '—';
          healthDangerEl.textContent = failed > 0 ? formatNumber(failed) : '—';
      }

      cards.forEach((card, index) => {
          const element = metricCards[index];
          if (!element) return;
          const titleElement = element.querySelector('.metric-title');
          const valueElement = element.querySelector('.metric-value');
          const changeElement = element.querySelector('.metric-change');
          if (titleElement) titleElement.textContent = card.title;
          if (valueElement) valueElement.textContent = card.value;
          if (changeElement) {
              changeElement.textContent = card.change;
              changeElement.className = `metric-change ${card.tone}`;
          }
      });
  }

  function updateActivityOverview(stats) {
      const chartContainer = document.querySelector('#dashboard-section .chart-container');
      if (!chartContainer) return;

      if (!stats.hasData) {
          chartContainer.innerHTML = '<div class="funnel-placeholder">Activity data will appear here as workflows and messaging events are recorded.</div>';
          return;
      }

      // Pipeline funnel — prototype-exact .funnel / .funnel__row markup
      const funnelSteps = [
          { label: 'Viewed', value: stats.totalProfiles },
          { label: 'Connected', value: stats.totalConnections },
          { label: 'Accepted', value: stats.totalAccepted },
          { label: 'DM Sent', value: stats.totalDmsSent },
          { label: 'Replied', value: stats.totalDmReplies }
      ];
      const baseline = Math.max(funnelSteps[0].value, 1);
      chartContainer.innerHTML = `
          <div class="funnel">
              ${funnelSteps.map((step, i) => {
                  const pct = (step.value / baseline) * 100;
                  const wPct = Math.max(pct, 1.5);
                  const isNarrow = wPct < 12;
                  const convFromPrev = i > 0 && funnelSteps[i - 1].value > 0
                      ? ((step.value / funnelSteps[i - 1].value) * 100).toFixed(1) + '%'
                      : '';
                  return `
                      <div class="funnel__row">
                          <div class="funnel__label">
                              <span class="funnel__name">${escapeHtml(step.label)}</span>
                              <span class="funnel__pct mono s-dim">${pct.toFixed(1)}%</span>
                          </div>
                          <div class="funnel__track">
                              <div class="funnel__fill ${isNarrow ? 'funnel__fill--narrow' : ''}" style="width:${wPct}%">
                                  <span class="funnel__val tabular">${formatNumber(step.value)}</span>
                              </div>
                          </div>
                          <div class="funnel__step mono s-dim">${convFromPrev ? '→ ' + convFromPrev : ''}</div>
                      </div>
                  `;
              }).join('')}
          </div>
      `;

      // Update bottom grid panels
      const healthList = document.querySelector('.dashboard-health-list');
      if (healthList) {
          healthList.innerHTML = renderAnalyticsSummaryList(stats.byAgent, 'agents');
      }

      const runsFeed = document.querySelector('.dashboard-runs-card .activity-feed');
      if (runsFeed) {
          runsFeed.innerHTML = renderAnalyticsSummaryList(stats.byWorkflow, 'workflows');
      }

      const inboxList = document.querySelector('.dashboard-inbox-list');
      if (inboxList) {
          inboxList.innerHTML = renderReplyOverview(stats.recentReplies);
      }
  }

  function renderReplyOverview(recentReplies) {
      if (!Array.isArray(recentReplies) || !recentReplies.length) {
          return '<div class="needs"><div class="needs__empty">Inbox quiet — no DM replies yet.</div></div>';
      }

      const rows = recentReplies.slice(0, 6).map((reply) => {
          const name = escapeHtml(reply.name || 'LinkedIn reply');
          const text = escapeHtml(reply.metadata?.text || 'New LinkedIn reply');
          return `
              <div class="needs__row needs__row--info">
                  <span class="needs__icon"><span class="material-symbols-outlined">inbox</span></span>
                  <span class="needs__text"><b>${name}</b> &middot; ${text}</span>
                  <span class="material-symbols-outlined s-dim" style="font-size:14px">chevron_right</span>
              </div>
          `;
      }).join('');
      return '<div class="needs">' + rows + '</div>';
  }

  function renderAnalyticsSummaryList(items, label) {
      // Called for Account health + Active runs panels. Route by label
      // so each panel gets prototype-correct markup (.ahrow / .runrow).
      if (!Array.isArray(items) || !items.length) {
          return `<div class="needs"><div class="needs__empty">No ${escapeHtml(label)} activity yet.</div></div>`;
      }
      if (label === 'agents') {
          return renderAgentHealthRows(items);
      }
      if (label === 'workflows') {
          return renderWorkflowRunRows(items);
      }
      // Fallback — compact list
      const rows = items.slice(0, 6).map((item) => {
          const name = escapeHtml(item.label || 'Unassigned');
          const total = formatNumber(item.totalEvents || 0);
          return `<div class="runrow"><div class="runrow__main"><div class="runrow__name">${name}</div></div><span class="runrow__rate tabular">${total}</span></div>`;
      }).join('');
      return '<div class="runs">' + rows + '</div>';
  }

  function renderAgentHealthRows(items) {
      const rows = items.slice(0, 6).map((item) => {
          const name = escapeHtml(item.label || 'Unassigned');
          const initial = (item.label || 'U').charAt(0).toUpperCase();
          const seed = 220 + ((item.label || '').charCodeAt(0) * 7) % 160;
          const replies = formatNumber(item.replies || 0);
          const conn = formatNumber(item.connections || 0);
          const views = formatNumber(item.views || 0);
          const total = formatNumber(item.totalEvents || 0);
          return `
              <div class="ahrow">
                  <div class="ahrow__who">
                      <div class="ahrow__avatar" style="background:oklch(85% 0.06 ${seed})">${escapeHtml(initial)}</div>
                      <div class="col">
                          <div class="ahrow__name">${name}</div>
                          <div class="mono s-dim" style="font-size:10px">agent</div>
                      </div>
                  </div>
                  <div class="mono tabular">${replies}</div>
                  <div class="mono tabular">${conn}</div>
                  <div class="mono tabular">${views}</div>
                  <div class="mono tabular" style="text-align:right">${total}</div>
              </div>
          `;
      }).join('');
      return rows;
  }

  function renderWorkflowRunRows(items) {
      const rows = items.slice(0, 6).map((item) => {
          const name = escapeHtml(item.label || 'Unnamed workflow');
          const total = formatNumber(item.totalEvents || 0);
          const replies = formatNumber(item.replies || 0);
          const running = (item.totalEvents || 0) > 0;
          const chipCls = running ? 'chip--ok' : 'chip--line';
          const stateLabel = running ? 'Active' : 'Idle';
          const pulse = running ? 'dot--pulse' : '';
          return `
              <div class="runrow">
                  <span class="chip ${chipCls}"><span class="dot ${pulse}"></span>${stateLabel}</span>
                  <div class="runrow__main">
                      <div class="runrow__name">${name}</div>
                      <div class="runrow__sub">${replies} replies</div>
                  </div>
                  <div class="runrow__stats">
                      <span class="runrow__rate tabular">${total}<small>/wk</small></span>
                  </div>
              </div>
          `;
      }).join('');
      return '<div class="runs">' + rows + '</div>';
  }

  function normalizeApolloDesktopStatus(integration = {}, syncs = []) {
      const bindings = Array.isArray(integration?.bindings) ? integration.bindings : [];
      const recentSyncs = Array.isArray(syncs) ? syncs : [];
      const summary = integration?.summary && typeof integration.summary === 'object'
          ? integration.summary
          : summarizeApolloSyncs(recentSyncs);
      return {
          enabled: integration?.enabled !== false,
          hasApiKey: Boolean(integration?.hasApiKey),
          connected: Boolean(integration?.hasApiKey),
          defaultSequenceId: integration?.defaultSequenceId || null,
          defaultSequenceName: integration?.defaultSequenceName || null,
          defaultEmailAccountId: integration?.defaultEmailAccountId || null,
          bindings,
          recentSyncs,
          summary,
          error: integration?.error || null
      };
  }

  function summarizeApolloSyncs(syncs = []) {
      return syncs.reduce((summary, sync) => {
          summary.total += 1;
          if (sync.status === 'enrolled') {
              summary.enrolled += 1;
          } else if (sync.status === 'failed') {
              summary.failed += 1;
          } else if (sync.status === 'dry_run') {
              summary.dryRun += 1;
          } else {
              summary.skipped += 1;
          }
          return summary;
      }, {
          total: 0,
          enrolled: 0,
          skipped: 0,
          failed: 0,
          dryRun: 0
      });
  }

  function renderApolloOverview(status) {
      if (!status || (!status.connected && !status.bindings.length && !status.recentSyncs.length)) {
          return '<div class="dashboard-overview-empty">Apollo is not configured yet. Configure it through MCP to see sync status here.</div>';
      }

      return `
          <div class="dashboard-summary-list">
              <div class="dashboard-summary-item">
                  <div class="dashboard-summary-title">Connection</div>
                  <div class="dashboard-summary-meta">${status.connected ? 'Configured in keychain' : 'Missing API key'}</div>
              </div>
              <div class="dashboard-summary-item">
                  <div class="dashboard-summary-title">Default Sequence</div>
                  <div class="dashboard-summary-meta">${escapeHtml(status.defaultSequenceName || status.defaultSequenceId || 'None configured')}</div>
              </div>
              <div class="dashboard-summary-item">
                  <div class="dashboard-summary-title">Recent Syncs</div>
                  <div class="dashboard-summary-meta">${formatNumber(status.summary.enrolled || 0)} enrolled • ${formatNumber(status.summary.skipped || 0)} skipped • ${formatNumber(status.summary.failed || 0)} failed</div>
              </div>
              <div class="dashboard-summary-item">
                  <div class="dashboard-summary-title">Bindings</div>
                  <div class="dashboard-summary-meta">${formatNumber(status.bindings.length)} saved sequence binding${status.bindings.length === 1 ? '' : 's'}</div>
              </div>
          </div>
      `;
  }

  async function loadApolloStatusCard() {
      const container = document.getElementById('apollo-status-card');
      if (!container) return;

      try {
          const [integration, syncs] = await Promise.all([
              electronAPIBridge.getApolloIntegration?.() || {},
              electronAPIBridge.getApolloSyncStatus?.({
                  accountId: activeLinkedInAccountId || null,
                  limit: 10
              }) || []
          ]);
          const status = normalizeApolloDesktopStatus(integration, syncs);
          renderApolloStatusCard(container, status);
      } catch (error) {
          container.innerHTML = `<div class="dashboard-overview-empty">Failed to load Apollo status: ${escapeHtml(error.message || String(error))}</div>`;
      }
  }

  function renderApolloStatusCard(container, status) {
      if (!container) return;
      if (!status) {
          container.innerHTML = '<div class="dashboard-overview-empty">Apollo integration status is unavailable.</div>';
          return;
      }

      const badgeClass = status.connected ? 'is-connected' : 'is-warning';
      const badgeLabel = status.connected ? 'Configured' : 'Needs API Key';
      const recentSyncItems = status.recentSyncs.slice(0, 5).map((sync) => `
          <div class="dashboard-summary-item">
              <div class="dashboard-summary-title">${escapeHtml(sync.fullName || sync.prospectId || 'Prospect')}</div>
              <div class="dashboard-summary-meta">${escapeHtml(sync.status || 'unknown')} • ${escapeHtml(sync.sequenceName || sync.sequenceId || 'Sequence')}</div>
              <div class="dashboard-summary-meta">${escapeHtml(sync.reason || sync.apolloEmail || 'No additional detail')}</div>
          </div>
      `).join('');
      const bindingItems = status.bindings.slice(0, 5).map((binding) => `
          <div class="dashboard-summary-item">
              <div class="dashboard-summary-title">${escapeHtml(binding.targetName || binding.targetId || 'Binding')}</div>
              <div class="dashboard-summary-meta">${escapeHtml(binding.targetType)} -> ${escapeHtml(binding.sequenceName || binding.sequenceId || 'Apollo sequence')}</div>
          </div>
      `).join('');

      container.innerHTML = `
          <div class="apollo-status-grid">
              <div class="apollo-status-panel">
                  <h3>Integration</h3>
                  <div class="apollo-status-badge ${badgeClass}">${badgeLabel}</div>
                  <div class="dashboard-summary-list" style="margin-top: 12px;">
                      <div class="dashboard-summary-item">
                          <div class="dashboard-summary-title">Default Sequence</div>
                          <div class="dashboard-summary-meta">${escapeHtml(status.defaultSequenceName || status.defaultSequenceId || 'None configured')}</div>
                      </div>
                      <div class="dashboard-summary-item">
                          <div class="dashboard-summary-title">Default Email Account</div>
                          <div class="dashboard-summary-meta">${escapeHtml(status.defaultEmailAccountId || 'None configured')}</div>
                      </div>
                  </div>
              </div>
              <div class="apollo-status-panel">
                  <h3>Recent Sync Summary</h3>
                  <div class="apollo-status-kpis">
                      <div class="apollo-status-kpi">
                          <div class="apollo-status-kpi-label">Enrolled</div>
                          <div class="apollo-status-kpi-value">${formatNumber(status.summary.enrolled || 0)}</div>
                      </div>
                      <div class="apollo-status-kpi">
                          <div class="apollo-status-kpi-label">Skipped</div>
                          <div class="apollo-status-kpi-value">${formatNumber(status.summary.skipped || 0)}</div>
                      </div>
                      <div class="apollo-status-kpi">
                          <div class="apollo-status-kpi-label">Failed</div>
                          <div class="apollo-status-kpi-value">${formatNumber(status.summary.failed || 0)}</div>
                      </div>
                  </div>
              </div>
              <div class="apollo-status-panel">
                  <h3>Bindings</h3>
                  ${bindingItems || '<div class="dashboard-overview-empty">No Apollo bindings saved yet.</div>'}
              </div>
              <div class="apollo-status-panel">
                  <h3>Recent Syncs</h3>
                  ${recentSyncItems || '<div class="dashboard-overview-empty">No Apollo sync attempts recorded yet.</div>'}
              </div>
          </div>
      `;
  }
  
  // Update activity feed
  function updateActivityFeed(activities) {
      const activityFeed = document.querySelector('.activity-feed');
      if (!activityFeed) return;
      activityFeed.innerHTML = '';
      if (!Array.isArray(activities) || activities.length === 0) {
          activityFeed.innerHTML = '<div class="empty-state">No activities found. Start automation to create activity data.</div>';
          return;
      }
      activities.forEach(activity => {
          const activityItem = document.createElement('div');
          const iconType = getActivityIconType(activity.type);
          const profileTarget = activity.profileUrl || activity.profileId || '';
          const isClickable = /linkedin\.com\/in\//i.test(String(profileTarget || ''));
          activityItem.className = `activity-item${isClickable ? ' is-clickable' : ''}`;
          if (isClickable) {
              activityItem.setAttribute('data-profile-id', profileTarget);
          }
          
          activityItem.innerHTML = `
              <div class="activity-icon ${iconType}">
                  ${getActivityIcon(activity.type)}
              </div>
              <div class="activity-content">
                  <div class="activity-title">${getActivityTitle(activity)}</div>
                  <div class="activity-meta">${getActivityMeta(activity)}</div>
              </div>
              <div class="activity-time">${formatTimeAgo(activity.timestamp)}</div>
          `;
          
          activityFeed.appendChild(activityItem);
          if (isClickable) {
              activityItem.addEventListener('click', () => {
                  viewProfileDetail(profileTarget);
              });
          }
      });
  }

  function getActivityIconType(type) {
      switch (type) {
          case 'connection_requested':
          case 'Connection Request Sent':
          case 'connection_accepted':
          case 'Connection Accepted':
              return 'connect';
          case 'post_liked':
          case 'Post Liked':
              return 'like';
          case 'dm_sent':
              return 'message';
          case 'dm_reply_received':
              return 'reply';
          case 'post_published':
              return 'post';
          case 'workflow_started':
          case 'workflow_completed':
          case 'workflow_failed':
              return 'workflow';
          case 'profile_viewed':
          case 'Profile Viewed':
          default:
              return 'view';
      }
  }
  
  // Get activity title
  function getActivityTitle(activity) {
      switch (activity.type) {
          case 'profile_viewed':
          case 'Profile Viewed':
              return `Viewed profile of ${activity.name}`;
          case 'connection_requested':
          case 'Connection Request Sent':
              return `Sent connection to ${activity.name}`;
          case 'post_liked':
          case 'Post Liked':
              return `Liked post from ${activity.name}`;
          case 'connection_accepted':
          case 'Connection Accepted':
              return `Connection accepted by ${activity.name}`;
          case 'dm_sent':
              return `Sent DM to ${activity.name}`;
          case 'dm_reply_received':
              return `${activity.name} replied`;
          case 'post_published':
              return 'Published a LinkedIn post';
          case 'workflow_started':
              return `Started workflow ${activity.workflowName || activity.name}`;
          case 'workflow_completed':
              return `Completed workflow ${activity.workflowName || activity.name}`;
          case 'workflow_failed':
              return `Workflow failed: ${activity.workflowName || activity.name}`;
          default:
              return `${activity.type}: ${activity.name}`;
      }
  }

  function getActivityMeta(activity) {
      if (activity.type === 'dm_reply_received') {
          return activity.metadata?.text || activity.title || '';
      }
      if (activity.type === 'workflow_failed') {
          return activity.metadata?.lastError || activity.metadata?.reason || activity.title || '';
      }
      if (activity.type === 'post_published') {
          return activity.metadata?.contentPreview || activity.title || '';
      }
      return activity.title || activity.workflowName || activity.metadata?.reason || '';
  }
  
  // Get activity icon SVG
  function getActivityIcon(type) {
      switch (type) {
          case 'profile_viewed':
          case 'Profile Viewed':
              return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
              </svg>`;
          case 'connection_requested':
          case 'Connection Request Sent':
              return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path>
              </svg>`;
          case 'post_liked':
          case 'Post Liked':
              return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
              </svg>`;
          case 'connection_accepted':
          case 'Connection Accepted':
              return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                  <polyline points="22 4 12 14.01 9 11.01"></polyline>
              </svg>`;
          case 'dm_sent':
          case 'dm_reply_received':
              return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>`;
          case 'post_published':
              return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 19V5"></path>
                  <path d="m5 12 7-7 7 7"></path>
              </svg>`;
          case 'workflow_started':
          case 'workflow_completed':
          case 'workflow_failed':
              return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 3h6v6H3z"></path>
                  <path d="M15 3h6v6h-6z"></path>
                  <path d="M15 15h6v6h-6z"></path>
                  <path d="M9 6h6"></path>
                  <path d="M18 9v6"></path>
                  <path d="M15 18H9"></path>
              </svg>`;
          default:
              return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>`;
      }
  }
  
  // View profile detail
  function viewProfileDetail(profileId) {
      if (!profileId) return;
      navLinks.forEach(link => {
          if (link.getAttribute('data-section') === 'profiles') {
              link.click();
          }
      });
      loadProfileDetail(profileId);
  }
  
  // Load profile detail (detailed view)
  async function loadProfileDetail(profileId) {
    try {
      const profile = await electronAPIBridge.getProfileData(profileId);
      if (!profile) {
        console.error('Profile not found:', profileId);
        return;
      }
      
      const profilesSection = document.getElementById('profiles-section');
      if (!profilesSection) return;
      
      // Save the current tab state to restore properly when going back
      const activeTab = profilesSection.querySelector('.tab-button.active');
      const activeTabId = activeTab ? activeTab.getAttribute('data-tab') : 'profiles-tab';
      
      profilesSection.innerHTML = `
        <div class="card">
          <div class="card-header">
            <button class="btn btn-secondary btn-sm back-button">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
              Back to Profiles
            </button>
            <h2 class="card-title">Profile Detail</h2>
            <div class="profile-actions">
              <button class="btn btn-primary btn-sm add-to-group-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
                Add to Group
              </button>
            </div>
          </div>
          <div class="card-body">
            <div class="profile-header">
              <h2 class="profile-detail-name">${profile.firstName} ${profile.lastName}</h2>
              <div class="profile-detail-title">${profile.title || 'No title available'}</div>
              <div class="profile-contact">
                ${profile.email && profile.email !== 'Not Available' ? 
                  `<div class="profile-email has-email">
                    <span>${profile.email}</span>
                    <button class="copy-email-btn" title="Copy email">
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                    </button>
                  </div>` : 
                  `<div class="profile-email no-email">No email available</div>`
                }
                <a href="${profile.url}" target="_blank" class="profile-link">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                  </svg>
                  View on LinkedIn
                </a>
              </div>
            </div>
            
            <div class="profile-stats">
              <div class="metric-card">
                <div class="metric-title">First Interaction</div>
                <div class="metric-value small">${formatTimeAgo(profile.firstInteraction)}</div>
              </div>
              <div class="metric-card">
                <div class="metric-title">Last Interaction</div>
                <div class="metric-value small">${formatTimeAgo(profile.lastInteraction)}</div>
              </div>
              <div class="metric-card">
                <div class="metric-title">Total Interactions</div>
                <div class="metric-value">${profile.actions.length}</div>
              </div>
              <div class="metric-card">
                <div class="metric-title">Groups</div>
                <div class="metric-value" id="profile-groups-count">Loading...</div>
              </div>
            </div>
            
            <div class="profile-info-grid">
              <div class="card">
                <div class="card-header">
                  <h3 class="card-title">Activity Timeline</h3>
                </div>
                <div class="card-body">
                  <div class="timeline">
                    ${profile.actions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).map(action => `
                      <div class="timeline-item">
                        <div class="timeline-icon ${getTimelineIconClass(action.type)}">
                          ${getActivityIcon(action.type)}
                        </div>
                        <div class="timeline-content">
                          <div class="timeline-header">
                            <div class="timeline-title">${action.type}</div>
                            <div class="timeline-time">${formatTimeAgo(action.timestamp)}</div>
                          </div>
                          ${action.notes ? `<div class="timeline-notes">${action.notes}</div>` : ''}
                        </div>
                      </div>
                    `).join('')}
                  </div>
                </div>
              </div>
              
              <div class="card">
                <div class="card-header">
                  <h3 class="card-title">Groups</h3>
                  <button class="btn btn-sm btn-secondary refresh-groups-btn">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="23 4 23 10 17 10"></polyline>
                      <polyline points="1 20 1 14 7 14"></polyline>
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                  </button>
                </div>
                <div class="card-body">
                  <div id="profile-groups-list" class="profile-groups-list">
                    <div class="loading">Loading groups...</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
      
      // Add event listener to back button
      const backButton = profilesSection.querySelector('.back-button');
      if (backButton) {
        backButton.addEventListener('click', function() {
          loadProfilesData().then(() => {
            // Restore the previously active tab
            const tabButton = document.querySelector(`.tab-button[data-tab="${activeTabId}"]`);
            if (tabButton) {
              tabButton.click();
            }
          });
        });
      }
      
      // Add event listener to copy email button
      const copyEmailBtn = profilesSection.querySelector('.copy-email-btn');
      if (copyEmailBtn && profile.email) {
        copyEmailBtn.addEventListener('click', function() {
          navigator.clipboard.writeText(profile.email).then(() => {
            const originalHTML = copyEmailBtn.innerHTML;
            copyEmailBtn.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="green" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            `;
            setTimeout(() => {
              copyEmailBtn.innerHTML = originalHTML;
            }, 2000);
          });
        });
      }
      
      // Add event listener to add to group button
      const addToGroupBtn = profilesSection.querySelector('.add-to-group-btn');
      if (addToGroupBtn) {
        addToGroupBtn.addEventListener('click', function() {
          showAddToGroupModal(profileId);
        });
      }
      
      // Load groups for this profile
      loadProfileGroups(profileId);
      
    } catch (error) {
      console.error('Error loading profile detail:', error);
    }
  }
  
  // Function to load groups that contain this profile
  async function loadProfileGroups(profileId) {
    try {
      // Get all groups from localStorage
      const groups = JSON.parse(localStorage.getItem('standalone-groups') || '[]');
      
      // Find groups that contain this profile
      const profileGroups = groups.filter(group => {
        if (!group.members) return false;
        return group.members.some(memberId => {
          return normalizeProfileUrl(memberId) === normalizeProfileUrl(profileId);
        });
      });
      
      // Update groups count
      const groupsCountElement = document.getElementById('profile-groups-count');
      if (groupsCountElement) {
        groupsCountElement.textContent = `${profileGroups.length}`;
      }
      
      // Update groups list
      const groupsListElement = document.getElementById('profile-groups-list');
      if (groupsListElement) {
        if (profileGroups.length === 0) {
          groupsListElement.innerHTML = `
            <div class="empty-state">
              <p>Not added to any groups yet.</p>
            </div>
          `;
        } else {
          groupsListElement.innerHTML = profileGroups.map(group => `
            <div class="profile-group-item" style="border-left: 4px solid ${group.color || '#4285F4'}">
              <div class="profile-group-info">
                <div class="profile-group-name">${escapeHtml(group.name)}</div>
                <div class="profile-group-meta">${group.members.length} profiles</div>
              </div>
              <button class="btn btn-sm btn-danger remove-from-group-btn" data-group-id="${group.id}">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          `).join('');
          
          // Add event listeners to remove buttons
          groupsListElement.querySelectorAll('.remove-from-group-btn').forEach(button => {
            button.addEventListener('click', function() {
              const groupId = this.getAttribute('data-group-id');
              removeProfileFromGroup(profileId, groupId).then(() => {
                // Refresh groups after removal
                loadProfileGroups(profileId);
              });
            });
          });
        }
      }
    } catch (error) {
      console.error('Error loading profile groups:', error);
      
      // Show error in groups list
      const groupsListElement = document.getElementById('profile-groups-list');
      if (groupsListElement) {
        groupsListElement.innerHTML = `
          <div class="error-state">
            <p>Error loading groups. Please try again.</p>
          </div>
        `;
      }
    }
  }
  
  // Function to show add to group modal
  function showAddToGroupModal(profileId) {
    // Get profile data for display
    electronAPIBridge.getProfileData(profileId).then(profile => {
      if (!profile) {
        console.error('Profile not found for add to group:', profileId);
        return;
      }
      
      // Create modal if it doesn't exist
      let modal = document.getElementById('add-to-group-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'add-to-group-modal';
        modal.className = 'modal';
        modal.innerHTML = `
          <div class="modal-content">
            <div class="modal-header">
              <h3 class="modal-title">Add to Group</h3>
              <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
              <div class="profile-selection">
                <div class="selected-profile">
                  <div class="profile-name"></div>
                  <div class="profile-title"></div>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Select Group</label>
                <select id="add-to-group-select" class="form-control">
                  <option value="">Select a group...</option>
                </select>
              </div>
              <div class="form-group">
                <button id="create-new-group-btn" class="btn btn-secondary">Create New Group</button>
              </div>
            </div>
            <div class="modal-footer">
              <button id="cancel-add-to-group" class="btn btn-secondary">Cancel</button>
              <button id="confirm-add-to-group" class="btn btn-primary">Add to Group</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
        
        // Add event listeners
        modal.querySelector('.modal-close').addEventListener('click', function() {
          modal.classList.remove('active');
        });
        
        document.getElementById('cancel-add-to-group').addEventListener('click', function() {
          modal.classList.remove('active');
        });
        
        document.getElementById('create-new-group-btn').addEventListener('click', function() {
          // Hide this modal
          modal.classList.remove('active');
          
          // Show group creation modal
          const groupModal = document.getElementById('group-modal');
          if (groupModal) {
            groupModal.classList.add('active');
            
            // Set profile ID as data attribute for later use
            groupModal.setAttribute('data-profile-id', profileId);
            
            // Check "add profiles now" by default
            const addProfilesNow = document.getElementById('add-profiles-now');
            if (addProfilesNow) {
              addProfilesNow.checked = true;
              const profilesSelection = document.getElementById('group-profiles-selection');
              if (profilesSelection) {
                profilesSelection.style.display = 'block';
              }
            }
          }
        });
      }
      
      // Set modal data
      modal.setAttribute('data-profile-id', profileId);
      modal.querySelector('.profile-name').textContent = `${profile.firstName} ${profile.lastName}`;
      modal.querySelector('.profile-title').textContent = profile.title || 'No title';
      
      // Populate groups dropdown
      const groupSelect = document.getElementById('add-to-group-select');
      if (groupSelect) {
        // Clear existing options except first
        while (groupSelect.options.length > 1) {
          groupSelect.remove(1);
        }
        
        // Get all groups
        const groups = JSON.parse(localStorage.getItem('standalone-groups') || '[]');
        
        if (groups.length === 0) {
          const option = document.createElement('option');
          option.value = "";
          option.textContent = "No groups available";
          groupSelect.appendChild(option);
        } else {
          // Add each group as an option
          groups.forEach(group => {
            const memberCount = group.members ? group.members.length : 0;
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (${memberCount} profiles)`;
            
            // Disable if profile is already in this group
            if (group.members && group.members.some(memberId => 
                normalizeProfileUrl(memberId) === normalizeProfileUrl(profileId))) {
              option.disabled = true;
              option.textContent += ' (already added)';
            }
            
            groupSelect.appendChild(option);
          });
        }
      }
      
      // Update confirm button listener
      const confirmBtn = document.getElementById('confirm-add-to-group');
      if (confirmBtn) {
        // Remove old event listeners
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        
        // Add new event listener
        newConfirmBtn.addEventListener('click', function() {
          const selectedGroupId = document.getElementById('add-to-group-select').value;
          if (!selectedGroupId) {
            alert('Please select a group');
            return;
          }
          
          // Add profile to group
          addProfileToGroup(profileId, selectedGroupId).then(() => {
            // Hide modal
            modal.classList.remove('active');
            
            // Refresh profile groups
            loadProfileGroups(profileId);
          });
        });
      }
      
      // Show modal
      modal.classList.add('active');
    });
  }
  
  // Function to add profile to group
  async function addProfileToGroup(profileId, groupId) {
    try {
      // Get groups from localStorage
      const groups = JSON.parse(localStorage.getItem('standalone-groups') || '[]');
      const groupIndex = groups.findIndex(g => g.id === groupId);
      
      if (groupIndex === -1) {
        throw new Error('Group not found');
      }
      
      // Ensure members array exists
      if (!groups[groupIndex].members) {
        groups[groupIndex].members = [];
      }
      
      // Check if profile is already in the group
      const normalizedProfileId = normalizeProfileUrl(profileId);
      if (groups[groupIndex].members.some(memberId => 
          normalizeProfileUrl(memberId) === normalizedProfileId)) {
        return; // Already in group, no need to add
      }
      
      // Add profile to group
      groups[groupIndex].members.push(profileId);
      
      // Save updated groups
      localStorage.setItem('standalone-groups', JSON.stringify(groups));
      
      // Show success notification
      showNotification(`Added to group: ${groups[groupIndex].name}`, 'success');
      
      return groups[groupIndex];
    } catch (error) {
      console.error('Error adding profile to group:', error);
      showNotification('Error adding to group', 'error');
      throw error;
    }
  }
  
  // Function to remove profile from group
  async function removeProfileFromGroup(profileId, groupId) {
    try {
      const groups = JSON.parse(localStorage.getItem('standalone-groups') || '[]');
      const groupIndex = groups.findIndex(g => g.id === groupId);
      
      if (groupIndex === -1) {
        throw new Error('Group not found');
      }
      
      if (!groups[groupIndex].members) {
        return; // No members to remove
      }
      
      // Get group name for notification
      const groupName = groups[groupIndex].name;
      
      // Filter out the profile
      const normalizedProfileId = normalizeProfileUrl(profileId);
      groups[groupIndex].members = groups[groupIndex].members.filter(memberId => 
        normalizeProfileUrl(memberId) !== normalizedProfileId
      );
      
      // Save updated groups
      localStorage.setItem('standalone-groups', JSON.stringify(groups));
      
      // Show success notification
      showNotification(`Removed from group: ${groupName}`, 'success');
      
      return groups[groupIndex];
    } catch (error) {
      console.error('Error removing profile from group:', error);
      showNotification('Error removing from group', 'error');
      throw error;
    }
  }
  
  // Helper function to normalize profile URLs
  function normalizeProfileUrl(url) {
    if (!url) return '';
    
    try {
      // Remove protocol, query parameters, and trailing slashes
      return url.toLowerCase()
        .replace(/https?:\/\//i, '')
        .replace(/\/+$/, '')
        .split('?')[0]
        .split('#')[0];
    } catch (error) {
      console.error('Error normalizing URL:', error);
      return String(url).toLowerCase();
    }
  }
  
  // Function to show a notification
  function showNotification(message, type = 'info') {
    // Create notification element if it doesn't exist
    let notification = document.getElementById('app-notification');
    if (!notification) {
      notification = document.createElement('div');
      notification.id = 'app-notification';
      notification.className = 'notification';
      document.body.appendChild(notification);
    }
    
    // Update notification
    notification.className = `notification ${type}`;
    notification.textContent = message;
    notification.style.display = 'block';
    
    // Hide after 3 seconds
    setTimeout(() => {
      notification.style.display = 'none';
    }, 3000);
  }
  
  // Helper function to escape HTML
  function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  
  // Get timeline icon class
  function getTimelineIconClass(type) {
      switch (type) {
          case 'Profile Viewed': return 'view';
          case 'Connection Request Sent': return 'connect';
          case 'Post Liked': return 'like';
          case 'Connection Accepted': return 'accept';
          default: return 'default';
      }
  }
  
  // Load profiles data (list view)
  async function loadProfilesData() {
    const profilesSection = document.getElementById('profiles-section');
    if (!profilesSection) return;
    
    // Show loading indicator immediately
    profilesSection.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Profile Management</h2>
          <div class="loading-indicator">Loading profiles...</div>
        </div>
      </div>
    `;
    
    try {
      // Load data once and wait for it to complete
      profilesData = await electronAPIBridge.getAllProfiles() || [];
      profilesData.sort((a, b) => new Date(b.lastInteraction) - new Date(a.lastInteraction));
      
      // Once data is loaded, update the UI in a single operation
      profilesSection.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Profile Management</h2>
            <div class="search-box">
              <input type="text" class="form-control" placeholder="Search profiles...">
            </div>
          </div>
          <div class="card-body">
            <div class="profiles-list">
              ${profilesData.length === 0 ? 
                '<div class="empty-state"><p>No profiles found. Start automation to build your profile database.</p></div>' : 
                profilesData.map(profile => `
                  <div class="profile-item" data-profile-id="${profile.url}">
                    <div class="profile-info">
                      <div class="profile-name">${profile.firstName} ${profile.lastName}</div>
                      <div class="profile-title">${profile.title || 'No title available'}</div>
                      <div class="profile-meta">
                        <div class="profile-last-interaction">Last: ${formatTimeAgo(profile.lastInteraction)}</div>
                        <div class="profile-action-count">${profile.actions.length} interactions</div>
                      </div>
                    </div>
                  </div>
                `).join('')
              }
            </div>
          </div>
        </div>
      `;
      
      // Add event listeners after the DOM is fully updated
      const profileItems = profilesSection.querySelectorAll('.profile-item');
      profileItems.forEach(item => {
        item.addEventListener('click', function() {
          const profileId = this.getAttribute('data-profile-id');
          if (profileId) {
            loadProfileDetail(profileId);
          }
        });
      });
      
      const searchInput = profilesSection.querySelector('.search-box input');
      if (searchInput) {
        searchInput.addEventListener('input', filterProfiles);
      }
      
    } catch (error) {
      console.error('Error loading profiles data:', error);
      profilesSection.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Profile Management</h2>
          </div>
          <div class="card-body">
            <div class="error-state">
              <p>Error loading profiles. Please try again later.</p>
            </div>
          </div>
        </div>
      `;
    }
  }
  
  // Filter profiles
  function filterProfiles() {
      const searchInput = document.querySelector('.search-box input');
      if (!searchInput) return;
      const searchTerm = searchInput.value.toLowerCase();
      const profileItems = document.querySelectorAll('.profile-item');
      profileItems.forEach(item => {
          const profileName = item.querySelector('.profile-name').textContent.toLowerCase();
          const profileTitle = item.querySelector('.profile-title').textContent.toLowerCase();
          if (profileName.includes(searchTerm) || profileTitle.includes(searchTerm)) {
              item.style.display = 'block';
          } else {
              item.style.display = 'none';
          }
      });
  }

  document.addEventListener('DOMContentLoaded', function() {
    if (typeof ProfileGroups !== 'undefined') {
      ProfileGroups.initialize();
    }
  });

  
  

  /**
 * Filters profiles to return only those that have been viewed, liked,
 * or had a connection request sent.
 *
 * @param {Array} profiles - An array of profile objects.
 * @returns {Array} A filtered array of profiles.
 */
function filterEngagedProfiles(profiles) {
    return profiles.filter(profile => 
      profile.viewed === true ||
      profile.liked === true ||
      profile.connectionRequestSent === true
    );
  }
  
  // Example usage:
  const profiles = [
    { id: 1, name: "Alice", viewed: true,  liked: false, connectionRequestSent: false },
    { id: 2, name: "Bob",   viewed: false, liked: true,  connectionRequestSent: false },
    { id: 3, name: "Carol", viewed: false, liked: false, connectionRequestSent: true },
    { id: 4, name: "Dave",  viewed: false, liked: false, connectionRequestSent: false }
  ];
  
  const engagedProfiles = filterEngagedProfiles(profiles);
  console.log(engagedProfiles);
  // Output will include the first three profiles (Alice, Bob, Carol)
  
  // Update dashboard email stats
  function updateDashboardStats() {
      const totalProfiles = profilesData.length;
      const profilesWithEmail = profilesData.filter(profile => 
          profile.email && profile.email !== 'Not Available' && profile.email !== 'Not available'
      ).length;
      
      const emailRate = totalProfiles > 0 ? Math.round((profilesWithEmail / totalProfiles) * 100) : 0;
      
      const metricCardsContainer = document.querySelector('.metrics-grid');
      if (metricCardsContainer) {
          const existingEmailMetric = document.querySelector('.metric-card[data-type="email"]');
          if (!existingEmailMetric) {
              const emailMetricCard = document.createElement('div');
              emailMetricCard.className = 'metric-card';
              emailMetricCard.setAttribute('data-type', 'email');
              emailMetricCard.innerHTML = `
                  <div class="metric-title">Email Collection</div>
                  <div class="metric-value">${profilesWithEmail}/${totalProfiles}</div>
                  <div class="metric-change ${emailRate >= 50 ? 'positive' : 'neutral'}">
                      ${emailRate}% success rate
                  </div>
              `;
              metricCardsContainer.appendChild(emailMetricCard);
          } else {
              existingEmailMetric.querySelector('.metric-value').textContent = `${profilesWithEmail}/${totalProfiles}`;
              existingEmailMetric.querySelector('.metric-change').textContent = `${emailRate}% success rate`;
              existingEmailMetric.querySelector('.metric-change').className = 
                  `metric-change ${emailRate >= 50 ? 'positive' : 'neutral'}`;
          }
      }
  }
  
  // Initialize credentials form events and login
  function initCredentialsForm() {
      const saveCredentialsBtn = document.getElementById('save-credentials-btn');
      const newProfileBtn = document.getElementById('new-linkedin-profile');
      const clearCredentialsBtn = document.getElementById('clear-credentials');
      const topBarAccountSelect = document.getElementById('topbar-linkedin-account-select');
      const credentialsAccountSelect = document.getElementById('credentials-account-select');
      const accountList = document.getElementById('linkedin-account-list');
      const manageAccountsButton = document.getElementById('manage-linkedin-accounts');
      const emailInput = document.getElementById('linkedin-email');
      const passwordInput = document.getElementById('linkedin-password');

      if (saveCredentialsBtn) {
          saveCredentialsBtn.addEventListener('click', function(e) {
              e.preventDefault();
              saveCredentials();
          });
      }

      if (newProfileBtn) {
          newProfileBtn.addEventListener('click', function(e) {
              e.preventDefault();
              createNewLinkedInProfileDraft();
          });
      }

      if (clearCredentialsBtn) {
          clearCredentialsBtn.addEventListener('click', function(e) {
              e.preventDefault();
              clearCredentials();
          });
      }

      if (topBarAccountSelect) {
          topBarAccountSelect.addEventListener('change', function() {
              switchActiveLinkedInAccount(this.value, { preferredAccountId: this.value });
          });
      }

      if (credentialsAccountSelect) {
          credentialsAccountSelect.addEventListener('change', function() {
              switchActiveLinkedInAccount(this.value, { preferredAccountId: this.value });
          });
      }

      if (accountList) {
          accountList.addEventListener('click', async function(event) {
              const button = event.target.closest('[data-linkedin-account-action]');
              if (!button) return;

              const accountId = button.getAttribute('data-linkedin-account-id');
              const action = button.getAttribute('data-linkedin-account-action');
              if (!accountId || !action) return;

              if (action === 'edit') {
                  fillLinkedInAccountForm(getLinkedInAccountById(accountId));
              } else if (action === 'activate') {
                  switchActiveLinkedInAccount(accountId, { preferredAccountId: accountId });
              } else if (action === 'clear-challenge') {
                  const account = getLinkedInAccountById(accountId);
                  const accountLabel = account?.name || account?.email || 'LinkedIn account';
                  const originalText = button.textContent;
                  button.disabled = true;
                  button.textContent = 'Verifying...';
                  try {
                      const result = await window.electronAPI?.clearLinkedInAccountChallenge?.(accountId);
                      if (!result?.success) {
                          throw new Error(result?.error || 'LinkedIn session verification failed');
                      }
                      showNotification(`Challenge cleared for ${accountLabel}.`, 'success');
                      addLogEntry(`LinkedIn challenge cleared for ${accountLabel}.`, LOG_TYPES.SUCCESS);
                      await refreshLinkedInAccountState(accountId);
                  } catch (error) {
                      const message = error?.message || String(error);
                      showNotification(`Could not clear challenge on ${accountLabel}: ${message}`, 'warning');
                      addLogEntry(`Failed to clear LinkedIn challenge on ${accountLabel}: ${message}`, LOG_TYPES.WARNING);
                      await refreshLinkedInAccountState(accountId);
                  } finally {
                      button.disabled = false;
                      button.textContent = originalText;
                  }
              } else if (action === 'delete') {
                  selectedLinkedInAccountId = accountId;
                  clearCredentials();
              }
          });
      }

      if (manageAccountsButton) {
          manageAccountsButton.addEventListener('click', function() {
              document.querySelector('.nav-link[data-section="credentials"]')?.click();
          });
      }

      emailInput?.addEventListener('input', function() {
          const accountNameInput = document.getElementById('linkedin-account-name');
          const accountIdInput = document.getElementById('linkedin-account-id');
          if (!accountNameInput || accountIdInput?.value) return;
          if (!accountNameInput.value.trim()) {
              accountNameInput.value = buildLinkedInAccountName(emailInput.value);
          }
      });
  }
  
  // Setup IPC listeners
  function setupIPCListeners() {
      electronAPIBridge.onLog((data) => {
          addLogEntry(data.message, data.type);
      });
      
      electronAPIBridge.onProgress((data) => {
          currentProfileIndex = data.current;
          totalProfiles = data.total;
          updateProgress(currentProfileIndex, totalProfiles);
      });
      
      electronAPIBridge.onAutomationCompleted(() => {
          isRunning = false;
          clearInterval(timerInterval);
          startButton.disabled = false;
          stopButton.disabled = true;
          loadDashboardData();
      });
      
      electronAPIBridge.onCredentialsSaved((success) => {
          if (success) {
              refreshLinkedInAccountState();
          } else {
              addLogEntry('Failed to save credentials.', LOG_TYPES.ERROR);
          }
      });
      
      electronAPIBridge.onCredentialsLoaded((credentials) => {
          refreshLinkedInAccountState(credentials?.id || null);
      });

      window.electronAPI?.on?.('linkedin-runtime-updated', (jobs) => {
          setLinkedInRuntimeJobs(jobs);
      });

      window.electronAPI?.on?.('linkedin-account-health-updated', (health) => {
          linkedInAccountHealth = health && typeof health === 'object' ? health : {};
          renderLinkedInRuntimeTabs();
          renderLinkedInAccountList();
          updateLinkedInProfileSummary(getActiveLinkedInAccount());
      });

      window.electronAPI?.on?.('activity-analytics-updated', () => {
          if (document.getElementById('dashboard-section')?.classList.contains('active')) {
              loadDashboardData();
          }
      });

      window.electronAPI?.on?.('sdr-workflow-runs-updated', () => {
          refreshInboxConversations().catch(() => {});
      });

      window.electronAPI?.on?.('inbox-updated', () => {
          refreshInboxConversations().catch(() => {});
      });

      window.electronAPI?.on?.('dm-reply-notification', (payload) => {
          const senderName = payload?.senderName || 'LinkedIn contact';
          const accountName = payload?.accountName ? ` on ${payload.accountName}` : '';
          const preview = payload?.text ? `: ${payload.text}` : '';
          showNotification(`${senderName} replied${accountName}${preview}`, 'info');
          addLogEntry(`Reply received from ${senderName}${accountName}.`, LOG_TYPES.INFO);
          refreshInboxConversations().catch(() => {});
          if (document.getElementById('dashboard-section')?.classList.contains('active')) {
              loadDashboardData();
          }
      });

      window.electronAPI?.on?.('linkedin-challenge-detected', (payload) => {
          const accountName = payload?.accountName || payload?.accountEmail || 'LinkedIn account';
          const reason = payload?.reason ? `: ${payload.reason}` : '';
          showNotification(`Challenge detected on ${accountName}${reason}`, 'warning');
          addLogEntry(`LinkedIn challenge detected on ${accountName}${reason}`, LOG_TYPES.WARNING);
          refreshLinkedInAccountState(payload?.accountId || null);
      });
      
      electronAPIBridge.onShowProfileDetail((profileId) => {
          viewProfileDetail(profileId);
      });
  }
  
  // Initialize the app
  initApp();
  refreshSearchAgentState().catch((error) => {
      addLogEntry(`Failed to initialize SDR search presets: ${error.message || error}`, LOG_TYPES.ERROR);
  });

  window.LinkedInAccountContext = {
      getActiveAccountId: () => activeLinkedInAccountId,
      getActiveAccount: () => getActiveLinkedInAccount(),
      getAllAccounts: () => linkedInAccounts.slice(),
      setActiveAccountId: (accountId, options = {}) => switchActiveLinkedInAccount(accountId, options)
  };

  window.AgentSearchContext = {
      getAgents: () => sdrAgents.slice(),
      getPresets: () => currentSearchAgentPresets.slice(),
      applyPreset: ({ agentId, presetId, runNow = false } = {}) => applySearchAgentPreset(agentId, presetId, {
          runNow
      })
  };
});


// =====================
// Extra Styles Function
// =====================

function addExtraStyles() {
  const style = document.createElement('style');
  style.textContent = `
      /* Timeline Styles */
      .timeline {
          position: relative;
          padding-left: 28px;
      }
      
      .timeline-item {
          position: relative;
          margin-bottom: var(--spacing-lg);
      }
      
      .timeline-item:before {
          content: '';
          position: absolute;
          left: -28px;
          top: 20px;
          bottom: -20px;
          width: 2px;
          background-color: var(--gray-200);
          z-index: 1;
      }
      
      .timeline-item:last-child:before {
          display: none;
      }
      
      .timeline-icon {
          position: absolute;
          left: -38px;
          top: 0;
          width: 24px;
          height: 24px;
          border-radius: var(--radius-full);
          background-color: var(--gray-100);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 2;
      }
      
      .timeline-icon.view {
          background-color: var(--gray-100);
          color: var(--gray-700);
      }
      
      .timeline-icon.connect {
          background-color: var(--primary-light);
          color: var(--primary);
      }
      
      .timeline-icon.like {
          background-color: var(--tertiary-light);
          color: var(--tertiary);
      }
      
      .timeline-icon.accept {
          background-color: var(--secondary-light);
          color: var(--secondary);
      }
      
      .timeline-content {
          background-color: var(--gray-50);
          border-radius: var(--radius-md);
          padding: var(--spacing-md);
      }
      
      .timeline-header {
          display: flex;
          justify-content: space-between;
          margin-bottom: var(--spacing-sm);
      }
      
      .timeline-title {
          font-weight: 500;
          color: var(--gray-800);
      }
      
      .timeline-time {
          font-size: 12px;
          color: var(--gray-500);
      }
      
      .timeline-notes {
          font-size: 14px;
          color: var(--gray-700);
          background-color: var(--white);
          padding: var(--spacing-sm);
          border-radius: var(--radius-sm);
          border: 1px solid var(--gray-200);
      }
      
      /* Profile Detail */
      .profile-header {
          margin-bottom: var(--spacing-xl);
      }
      
      .profile-detail-name {
          font-size: 24px;
          font-weight: 600;
          color: var(--gray-900);
          margin-bottom: var(--spacing-xs);
      }
      
      .profile-detail-title {
          font-size: 16px;
          color: var(--gray-600);
          margin-bottom: var(--spacing-md);
      }
      
      .profile-link {
          display: inline-flex;
          align-items: center;
          color: var(--primary);
          font-size: 14px;
          text-decoration: none;
      }
      
      .profile-link:hover {
          text-decoration: underline;
      }
      
      .profile-link svg {
          margin-right: var(--spacing-xs);
      }
      
      .metric-value.small {
          font-size: 16px;
      }
      
      .back-button {
          display: inline-flex;
          align-items: center;
          gap: var(--spacing-xs);
      }
  `;
  document.head.appendChild(style);
}

document.addEventListener('DOMContentLoaded', addExtraStyles);
// Enhanced profile cards with email display - FIXED VERSION
function enhanceProfilesWithEmailDisplay() {
    console.log("Starting email enhancement process");
  
    // Only attempt to enhance profiles once they're fully loaded in the DOM
    const profileCards = document.querySelectorAll('.profile-item, .profile-card, [data-profile-id], .contact-item');
    console.log(`Found ${profileCards.length} potential profile cards to enhance with emails`);
  
    if (profileCards.length === 0) {
      console.log("No profile cards found to enhance - will retry once");
      // Only try once more after a short delay instead of multiple retries
      setTimeout(enhanceProfilesWithEmailDisplay, 1000);
      return;
    }
  
    // Add styles for email display if they don't exist - do this once upfront
    if (!document.getElementById('email-display-styles')) {
      const styleElement = document.createElement('style');
      styleElement.id = 'email-display-styles';
      styleElement.textContent = `
        .profile-email {
          margin-top: 5px;
          padding: 4px 8px;
          font-size: 14px;
          display: block;
          border-radius: 4px;
        }
        .profile-email.has-email {
          background-color: rgba(10, 102, 194, 0.1);
          color: #0a66c2;
          font-weight: 500;
        }
        .profile-email.no-email {
          color: #888;
          font-style: italic;
        }
        .profile-email.loading {
          background-color: #f3f6f8;
          color: #666;
        }
        .copy-email-btn {
          margin-left: 8px;
          background: transparent;
          border: none;
          color: #0a66c2;
          cursor: pointer;
          font-size: 12px;
          padding: 2px 4px;
          border-radius: 3px;
        }
        .copy-email-btn:hover {
          background: rgba(10, 102, 194, 0.1);
        }
        .export-emails-btn {
          background: #0a66c2;
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 16px;
          cursor: pointer;
          margin-top: 15px;
          font-weight: 500;
          font-size: 14px;
          display: block;
          width: 100%;
          text-align: center;
        }
      `;
      document.head.appendChild(styleElement);
      console.log("Added email display styles to document");
    }
  
    // Keep track of processed cards to avoid duplicates
    const processedCards = new Set();
  
    // Process all cards in a single batch to avoid multiple DOM updates
    profileCards.forEach((card, index) => {
      // Generate a unique ID for the card if it doesn't have one
      const cardId = card.getAttribute('data-card-id') || `profile-card-${index}`;
      card.setAttribute('data-card-id', cardId);
  
      // Skip if already processed
      if (card.querySelector('.profile-email')) {
        console.log(`Card #${index + 1} already has email display, skipping`);
        return;
      }
  
      console.log(`Processing card #${index + 1} with ID ${cardId}`);
      processedCards.add(cardId);
  
      // Try multiple ways to get the profile ID
      const profileId =
        card.getAttribute('data-profile-id') ||
        card.getAttribute('data-id') ||
        card.querySelector('[data-profile-id]')?.getAttribute('data-profile-id') ||
        card.querySelector('a[href*="linkedin.com/in/"]')?.href;
  
      if (!profileId) {
        console.log(`Card #${index + 1} missing profile ID, skipping`);
        return;
      }
  
      console.log(`Found profile ID for card #${index + 1}: ${profileId}`);
  
      // Create email element
      const emailElement = document.createElement('div');
      emailElement.className = 'profile-email loading';
      emailElement.textContent = 'Loading email...';
  
      // Find the best place to insert the email element
      const insertAfter =
        card.querySelector('.profile-title') ||
        card.querySelector('.profile-company') ||
        card.querySelector('.profile-name') ||
        card.querySelector('h3') ||
        card.querySelector('h4') ||
        card.querySelector('p');
  
      if (insertAfter && insertAfter.parentNode) {
        console.log(`Inserting email after ${insertAfter.className || insertAfter.tagName}`);
        insertAfter.parentNode.insertBefore(emailElement, insertAfter.nextSibling);
      } else {
        console.log(`Appending email to card directly`);
        card.appendChild(emailElement);
      }
  
      // Fetch profile data and update email display
      electronAPIBridge.getProfileData(profileId)
        .then(profileData => {
          console.log(`Got profile data for ${profileId}:`, profileData ? 'Data found' : 'No data');
  
          if (!profileData) {
            emailElement.textContent = 'Profile data not found';
            emailElement.className = 'profile-email no-email';
            return;
          }
  
          // Check multiple possible email field names
          const email =
            profileData.email ||
            profileData.emailAddress ||
            profileData.email_address;
  
          if (email && email !== 'Not Available' && email !== 'Not available') {
            // Create a container for email and copy button
            const emailContainer = document.createElement('div');
            emailContainer.style.display = 'flex';
            emailContainer.style.alignItems = 'center';
  
            // Email text
            const emailText = document.createElement('span');
            emailText.textContent = email;
            emailContainer.appendChild(emailText);
  
            // Copy button
            const copyButton = document.createElement('button');
            copyButton.className = 'copy-email-btn';
            copyButton.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            `;
            copyButton.title = "Copy email";
            copyButton.addEventListener('click', () => {
              navigator.clipboard.writeText(email).then(() => {
                const originalHTML = copyButton.innerHTML;
                copyButton.innerHTML = `
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="green" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                `;
                setTimeout(() => {
                  copyButton.innerHTML = originalHTML;
                }, 2000);
              });
            });
            emailContainer.appendChild(copyButton);
  
            // Update the email element
            emailElement.className = 'profile-email has-email';
            emailElement.innerHTML = '';
            emailElement.appendChild(emailContainer);
  
            console.log(`Valid email found: ${email}`);
          } else {
            const company = profileData.company || profileData.companyName || '';
            if (company && profileData.firstName && profileData.lastName) {
              emailElement.innerHTML = `
                <div style="font-style: italic; margin-bottom: 4px;">No email found, possible formats:</div>
                <div style="font-size: 12px; color: #666;">
                  ${profileData.firstName.toLowerCase()}.${profileData.lastName.toLowerCase()}@${company.toLowerCase().replace(/\s+/g, '')}.com
                </div>
              `;
              emailElement.className = 'profile-email no-email';
            } else {
              emailElement.textContent = 'No email available';
              emailElement.className = 'profile-email no-email';
            }
            console.log('No valid email found for profile');
          }
        })
        .catch(err => {
          console.error(`Error fetching profile data for ${profileId}:`, err);
          emailElement.textContent = 'Error loading email';
          emailElement.className = 'profile-email no-email';
        });
    });
  
    console.log("Email enhancement process complete");
  }

  function initializeNameListFeature() {
    const searchTypeRadios = document.querySelectorAll('input[name="search-type"]');
    const keywordSection = document.getElementById('keyword-search-section');
    const nameSection = document.getElementById('name-search-section');
    const nameListTextarea = document.getElementById('name-list');
    const nameListPreview = document.getElementById('name-list-preview');
    
    // Handle search type switching
    searchTypeRadios.forEach(radio => {
      radio.addEventListener('change', function() {
        if (this.value === 'query') {
          keywordSection.style.display = 'block';
          nameSection.style.display = 'none';
          nameListPreview.style.display = 'none';
        } else if (this.value === 'names') {
          keywordSection.style.display = 'none';
          nameSection.style.display = 'block';
          
          // Show preview if there's content
          if (nameListTextarea.value.trim()) {
            updateNameListPreview();
          }
        }
      });
    });
    
    // Handle name list input changes
    if (nameListTextarea) {
      let debounceTimer;
      nameListTextarea.addEventListener('input', function() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          updateNameListPreview();
        }, 500); // Debounce for 500ms
      });
      
      // Handle paste events
      nameListTextarea.addEventListener('paste', function() {
        setTimeout(() => {
          updateNameListPreview();
        }, 100);
      });
    }
  }
  
  /**
   * Update the name list preview
   */
  function updateNameListPreview() {
    const nameListTextarea = document.getElementById('name-list');
    const nameListPreview = document.getElementById('name-list-preview');
    const nameListItems = document.getElementById('name-list-items');
    const nameCount = document.getElementById('name-count');
    
    if (!nameListTextarea || !nameListPreview) return;
    
    const inputText = nameListTextarea.value.trim();
    
    if (!inputText) {
      nameListPreview.style.display = 'none';
      return;
    }
    
    // Parse the name list using the same logic as backend
    const names = parseNameList(inputText);
    
    if (names.length === 0) {
      nameListPreview.style.display = 'none';
      return;
    }
    
    // Show preview
    nameListPreview.style.display = 'block';
    
    // Update count
    nameCount.textContent = names.length;
    
    // Update items display
    nameListItems.innerHTML = names.map(name => 
      `<span class="name-list-item">${escapeHtml(name)}</span>`
    ).join('');
    
    // Add warning if too many names
    if (names.length > 50) {
      const warning = document.createElement('div');
      warning.className = 'warning-message';
      warning.style.cssText = 'color: #d97706; font-size: 12px; margin-top: 8px; font-weight: 500;';
      warning.textContent = `⚠️ Large list detected (${names.length} names). Consider breaking into smaller batches for better results.`;
      nameListItems.appendChild(warning);
    }
  }
  
  /**
   * Parse name list from text input (frontend version)
   */
  function parseNameList(nameListText) {
    if (!nameListText || typeof nameListText !== 'string') {
      return [];
    }
    
    // Split by common delimiters and clean up
    const names = nameListText
      .split(/[\n,;|\t]/) // Split by newlines, commas, semicolons, pipes, or tabs
      .map(name => name.trim()) // Remove whitespace
      .filter(name => name.length > 0) // Remove empty entries
      .filter(name => name.length > 2) // Remove very short entries
      .map(name => {
        // Remove common prefixes and suffixes
        return name
          .replace(/^\d+\.?\s*/, '') // Remove numbers at start (like "1. John Doe")
          .replace(/^[-•*]\s*/, '') // Remove bullet points
          .replace(/\s+/g, ' ') // Normalize whitespace
          .trim();
      })
      .filter(name => name.length > 2); // Filter again after cleaning
    
    return [...new Set(names)]; // Remove duplicates
  }
  
  /**
   * Enhance the existing automation form to handle name lists
   */
  function enhanceAutomationForm() {
    const startButton = document.getElementById('start-button');
    
    // Override the existing start automation function
    if (startButton) {
      // Remove existing event listeners
      const newStartButton = startButton.cloneNode(true);
      startButton.parentNode.replaceChild(newStartButton, startButton);
      
      // Add new enhanced event listener - CHANGED: use startAutomation instead of startEnhancedAutomation
      newStartButton.addEventListener('click', startAutomation);
    }
  }
  

  
  /**
   * Enhanced log entry function with name list support
   */
  function addLogEntry(message, type = 'normal') {
    const terminalContent = document.getElementById('terminal-content');
    if (!terminalContent) return;
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    const timestamp = new Date().toLocaleTimeString();
    
    const logTime = document.createElement('span');
    logTime.className = 'log-time';
    logTime.textContent = `[${timestamp}]`;
    
    const logMessage = document.createElement('span');
    logMessage.className = `log-message ${type}`;
    logMessage.textContent = message;
    
    logEntry.appendChild(logTime);
    logEntry.appendChild(logMessage);
    terminalContent.appendChild(logEntry);
    terminalContent.scrollTop = terminalContent.scrollHeight;
  }
  
  /**
   * Enhanced progress update for name list automation
   */
  function updateProgress(current, total, currentName = null) {
    const progressFill = document.getElementById('progress-fill');
    const profilesProcessed = document.getElementById('profiles-processed');
    
    if (!progressFill || !profilesProcessed) return;
    
    const percentage = (current / total) * 100;
    progressFill.style.width = `${percentage}%`;
    
    if (currentName) {
      profilesProcessed.textContent = `${current}/${total} names (Current: ${currentName})`;
    } else {
      profilesProcessed.textContent = `${current}/${total} profiles`;
    }
  }
  
  /**
   * Enhanced API object with name list support
   */
  if (window.electronAPI) {
    // Add name list automation method
    electronAPIBridge.startNameListAutomation = function(config) {
      console.log('Starting name list automation with config:', config);
      
      // Simulate the automation process for demo
      addLogEntry('Initializing name list automation...', 'info');
      addLogEntry(`Processing ${config.nameList.length} names`, 'info');
      
      let currentIndex = 0;
      const processNextName = () => {
        if (currentIndex >= config.nameList.length) {
          // Automation completed
          addLogEntry('Name list automation completed!', 'success');
          
          // Reset UI
          document.getElementById('start-button').disabled = false;
          document.getElementById('stop-button').disabled = true;
          
          if (window.automationTimer) {
            clearInterval(window.automationTimer);
          }
          
          return;
        }
        
        const currentName = config.nameList[currentIndex];
        addLogEntry(`Searching for: ${currentName}`, 'info');
        updateProgress(currentIndex + 1, config.nameList.length, currentName);
        
        // Simulate processing time
        setTimeout(() => {
          addLogEntry(`Processing ${currentName}...`, 'info');
          
          // Simulate actions
          if (config.visitProfile) {
            setTimeout(() => addLogEntry(`✓ Visited profile for ${currentName}`, 'success'), 1000);
          }
          if (config.likePosts) {
            setTimeout(() => addLogEntry(`✓ Liked posts for ${currentName}`, 'success'), 2000);
          }
          if (config.sendConnection) {
            setTimeout(() => addLogEntry(`✓ Sent connection request to ${currentName}`, 'success'), 3000);
          }
          
          currentIndex++;
          setTimeout(processNextName, 5000); // 5 second delay between names
        }, 2000);
      };
      
      // Start processing
      setTimeout(processNextName, 1000);
    };
    
    // Enhanced stop automation
    const originalStopAutomation = electronAPIBridge.stopAutomation;
    electronAPIBridge.stopAutomation = function(...args) {
      addLogEntry('Stopping automation...', 'warning');
      
      // Reset UI
      document.getElementById('start-button').disabled = false;
      document.getElementById('stop-button').disabled = true;
      
      if (window.automationTimer) {
        clearInterval(window.automationTimer);
      }
      
      // Call original stop function if it exists
      if (typeof originalStopAutomation === 'function') {
        originalStopAutomation(...args);
      }
    };
  }
  
  /**
   * Utility function to escape HTML
   */
  function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  
  /**
   * Add sample names functionality
   */
  function addSampleNames() {
    const sampleNames = [
      "John Smith",
      "Jane Doe", 
      "Michael Johnson",
      "Sarah Wilson",
      "David Brown",
      "Lisa Davis",
      "Robert Miller",
      "Emily Clark"
    ];
    
    const nameListTextarea = document.getElementById('name-list');
    if (nameListTextarea) {
      nameListTextarea.value = sampleNames.join('\n');
      updateNameListPreview();
    }
  }
  
  // Add a helper button for sample names (optional)
  document.addEventListener('DOMContentLoaded', function() {
    const nameSection = document.getElementById('name-search-section');
    if (nameSection) {
      const sampleButton = document.createElement('button');
      sampleButton.type = 'button';
      sampleButton.className = 'btn btn-secondary btn-sm';
      sampleButton.textContent = 'Load Sample Names';
      sampleButton.style.marginTop = '8px';
      sampleButton.addEventListener('click', addSampleNames);
      
      const textarea = nameSection.querySelector('textarea');
      if (textarea && textarea.parentNode) {
        textarea.parentNode.appendChild(sampleButton);
      }
    }
  });

  window.NameListAutomation = {
    parseNameList,
    updateNameListPreview,
    addSampleNames
  };

  
  
  // Improved setup for email display to reduce flicker
  function setupEmailDisplayRetries() {
    console.log("Setting up email display with improved handling");
  
    // Create a flag to track if enhancement is in progress
    let enhancementInProgress = false;
  
    // Only enhance once when the DOM is fully loaded
    document.addEventListener('DOMContentLoaded', () => {
      if (!enhancementInProgress) {
        enhancementInProgress = true;
        enhanceProfilesWithEmailDisplay();
      }
    });
  
    // Set up a mutation observer to detect when new profile cards are added
    const observer = new MutationObserver((mutations) => {
      if (enhancementInProgress) return;
      
      let shouldEnhance = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          // Check if any of the added nodes are profile cards or contain profile cards
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.classList?.contains('profile-item') ||
                  node.classList?.contains('profile-card') ||
                  node.querySelector?.('.profile-item, .profile-card, [data-profile-id]')) {
                shouldEnhance = true;
                break;
              }
            }
          }
          if (shouldEnhance) break;
        }
      }
  
      if (shouldEnhance) {
        console.log("DOM changed - new profile cards detected");
        enhancementInProgress = true;
        // Use requestAnimationFrame to ensure DOM is settled before enhancing
        requestAnimationFrame(() => {
          enhanceProfilesWithEmailDisplay();
          enhancementInProgress = false;
        });
      }
    });
  
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  
    console.log("Email display enhancement setup complete with improved observer");
  }
  
  
  // New reset function with better handling
  function resetEmailEnhancements() {
    console.log("Resetting email enhancements...");
    
    // Remove all existing email elements
    const existingEmails = document.querySelectorAll('.profile-email');
    existingEmails.forEach(el => el.remove());
    
    // Wait for next animation frame to ensure DOM is updated
    requestAnimationFrame(() => {
      enhanceProfilesWithEmailDisplay();
    });
  }

  
  
  // Export functions for external use
  window.EmailDisplay = {
    enhance: enhanceProfilesWithEmailDisplay,
    addExportButton: addExportEmailsButton,
    reset: resetEmailEnhancements,
  };


  document.addEventListener('DOMContentLoaded', function() {
    // Initialize features
    if (typeof initializeNameListFeature === 'function') {
      initializeNameListFeature();
    }
    
    if (typeof enhanceAutomationForm === 'function') {
      enhanceAutomationForm();
    }
    
    // Define and call initApp if it exists
    if (typeof initApp === 'function') {
      initApp();
    }
  });
