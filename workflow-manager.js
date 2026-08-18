// workflow-manager.js - Complete Name List Workflow Management System

class WorkflowManager {
  constructor() {
    this.workflows = [];
    this.currentWorkflow = null;
    this.isRunning = false;
    this.init();
  }

  init() {
    this.loadWorkflows();
    this.attachEventListeners();
    this.renderWorkflows();
    this.setupRealTimeUpdates();
    document.addEventListener('connect-ability:active-linkedin-account-changed', () => {
      this.updateMetrics();
    });
  }

  // Load workflows from localStorage
  loadWorkflows() {
    const stored = localStorage.getItem('name-list-workflows');
    if (stored) {
      try {
        this.workflows = JSON.parse(stored);
        // Ensure all workflows have the required structure
        this.workflows = this.workflows.map(workflow => this.validateWorkflowStructure(workflow));
      } catch (error) {
        console.error('Error parsing workflows:', error);
        this.workflows = [];
      }
    }
    this.updateMetrics();
  }

  // Validate and ensure workflow has proper structure
  validateWorkflowStructure(workflow) {
    const defaultWorkflow = {
      id: workflow.id || Date.now().toString(),
      name: workflow.name || 'Untitled Workflow',
      description: workflow.description || '',
      names: workflow.names || [],
      created: workflow.created || new Date().toISOString(),
      lastRun: workflow.lastRun || null,
      status: workflow.status || 'active',
      actionHistory: workflow.actionHistory || [],
      metrics: {
        totalNames: workflow.names?.length || 0,
        profilesFound: 0,
        profilesNotFound: 0,
        profilesViewed: 0,
        postsLiked: 0,
        connectionsRequested: 0,
        connectionsSentWithNote: 0,
        connectionsSentWithoutNote: 0,
        messagesSent: 0,
        lastUpdated: new Date().toISOString(),
        ...workflow.metrics
      },
      availableActions: workflow.availableActions || ['view', 'like', 'connect', 'message'],
      completedActions: workflow.completedActions || [],
      settings: {
        pauseBetweenProfiles: 30000,
        maxRetries: 3,
        enableRandomDelays: true,
        ...workflow.settings
      }
    };
    
    return { ...defaultWorkflow, ...workflow };
  }

  // Save workflows to localStorage
  saveWorkflows() {
    try {
      localStorage.setItem('name-list-workflows', JSON.stringify(this.workflows));
      console.log('Workflows saved successfully');
    } catch (error) {
      console.error('Error saving workflows:', error);
      this.showNotification('Error saving workflows', 'error');
    }
  }

  // Update metrics for all workflows based on stored profile data
  async updateMetrics() {
    try {
      // Get all profiles from the backend
      const profiles = window.electronAPI ? await window.electronAPI.getAllProfiles() : [];
      
      this.workflows.forEach(workflow => {
        this.updateWorkflowMetrics(workflow, profiles);
      });

      this.saveWorkflows();
      this.renderWorkflows();
    } catch (error) {
      console.error('Error updating metrics:', error);
    }
  }

  // Update metrics for a specific workflow
  updateWorkflowMetrics(workflow, profiles) {
    // Reset metrics but keep historical data
    const previousMetrics = { ...workflow.metrics };
    workflow.metrics = {
      ...previousMetrics,
      totalNames: workflow.names.length,
      profilesFound: 0,
      profilesNotFound: 0,
      profilesViewed: 0,
      postsLiked: 0,
      connectionsRequested: 0,
      connectionsSentWithNote: 0,
      connectionsSentWithoutNote: 0,
      messagesSent: 0,
      lastUpdated: new Date().toISOString()
    };

    // Match workflow names with profiles
    workflow.names.forEach(name => {
      const normalizedSearchName = this.normalizeName(name);
      
      // Find matching profiles
      const matchingProfiles = profiles.filter(profile => {
        const profileFullName = `${profile.firstName} ${profile.lastName}`.toLowerCase();
        return this.fuzzyMatch(normalizedSearchName, profileFullName);
      });

      if (matchingProfiles.length > 0) {
        workflow.metrics.profilesFound++;
        
        // Check actions for each matching profile
        matchingProfiles.forEach(profile => {
          if (profile.actions) {
            profile.actions.forEach(action => {
              if (action.searchQuery && this.fuzzyMatch(normalizedSearchName, action.searchQuery.toLowerCase())) {
                switch(action.type) {
                  case 'Profile Viewed':
                    workflow.metrics.profilesViewed++;
                    break;
                  case 'Post Liked':
                    workflow.metrics.postsLiked++;
                    break;
                  case 'Connection Request Sent':
                    workflow.metrics.connectionsRequested++;
                    if (action.notes && action.notes.includes('with message:')) {
                      workflow.metrics.connectionsSentWithNote++;
                    } else {
                      workflow.metrics.connectionsSentWithoutNote++;
                    }
                    break;
                  case 'Message Sent':
                    workflow.metrics.messagesSent++;
                    break;
                }
              }
            });
          }
        });
      } else {
        workflow.metrics.profilesNotFound++;
      }
    });
  }

  // Normalize name for comparison
  normalizeName(name) {
    return name.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  // Fuzzy match for name comparison
  fuzzyMatch(search, target) {
    const searchWords = search.split(' ');
    const targetWords = target.split(' ');
    
    return searchWords.every(searchWord => 
      targetWords.some(targetWord => 
        targetWord.includes(searchWord) || searchWord.includes(targetWord)
      )
    );
  }

  // Create a new workflow
  createWorkflow(name, description, nameList, initialAction = null) {
    const workflow = {
      id: Date.now().toString(),
      name: name,
      description: description,
      names: nameList,
      created: new Date().toISOString(),
      lastRun: null,
      status: 'active',
      actionHistory: [],
      completedActions: [],
      availableActions: ['view', 'like', 'connect', 'message'],
      metrics: {
        totalNames: nameList.length,
        profilesFound: 0,
        profilesNotFound: 0,
        profilesViewed: 0,
        postsLiked: 0,
        connectionsRequested: 0,
        connectionsSentWithNote: 0,
        connectionsSentWithoutNote: 0,
        messagesSent: 0,
        lastUpdated: new Date().toISOString()
      },
      settings: {
        pauseBetweenProfiles: 30000,
        maxRetries: 3,
        enableRandomDelays: true
      }
    };

    // Add initial action if specified
    if (initialAction) {
      workflow.actionHistory.push({
        action: initialAction,
        date: new Date().toISOString(),
        status: 'pending',
        config: {}
      });
    }

    this.workflows.push(workflow);
    this.saveWorkflows();
    this.renderWorkflows();
    this.showNotification(`Workflow "${name}" created successfully`, 'success');
    
    return workflow;
  }

  // Get available actions for a workflow (actions not yet completed)
  getAvailableActions(workflow) {
    return workflow.availableActions.filter(action => 
      !workflow.completedActions.includes(action)
    );
  }

  // Get completed actions for a workflow
  getCompletedActions(workflow) {
    return workflow.completedActions || [];
  }

  // Run an action on a workflow
  async runAction(workflowId, action, config = {}) {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) {
      console.error('Workflow not found:', workflowId);
      this.showNotification('Workflow not found', 'error');
      return;
    }

    if (this.isRunning) {
      this.showNotification('Another workflow is already running', 'error');
      return;
    }

    this.isRunning = true;
    this.currentWorkflow = workflow;

    // Record the action in history
    const actionRecord = {
      action: action,
      date: new Date().toISOString(),
      status: 'running',
      config: config,
      progress: {
        completed: 0,
        total: workflow.names.length,
        errors: 0
      }
    };

    workflow.actionHistory.push(actionRecord);
    workflow.lastRun = new Date().toISOString();
    workflow.status = 'running';
    this.saveWorkflows();
    this.renderWorkflows();

    try {
      // Prepare the automation config
      const automationConfig = {
        searchType: 'names',
        nameList: workflow.names,
        visitProfile: action === 'view' || config.visitProfile,
        likePosts: action === 'like' || config.likePosts,
        sendConnection: action === 'connect' || config.sendConnection,
        sendMessage: action === 'message' || config.sendMessage,
        sendWithNote: config.sendWithNote || false,
        connectMessage: config.connectMessage || '',
        messageTemplate: config.messageTemplate || '',
        browserProfile: config.browserProfile || 'random',
        headless: config.headless || false,
        slowMo: config.slowMo || 50,
        workflowId: workflowId,
        pauseBetweenProfiles: workflow.settings.pauseBetweenProfiles || 30000
      };

      // Send to backend for processing
      if (window.electronAPI && window.electronAPI.startNameListAutomation) {
        const result = await window.electronAPI.startNameListAutomation(automationConfig);
        
        // Update action history
        const lastAction = workflow.actionHistory[workflow.actionHistory.length - 1];
        lastAction.status = 'completed';
        lastAction.completedAt = new Date().toISOString();
        lastAction.result = result;

        // Mark action as completed if it was successful
        if (result && result.processed > 0) {
          if (!workflow.completedActions.includes(action)) {
            workflow.completedActions.push(action);
          }
        }

        workflow.status = 'active';
        
        this.showNotification(`Action "${action}" completed successfully`, 'success');
        
      } else {
        throw new Error('Automation API not available');
      }
    } catch (error) {
      console.error('Error running workflow action:', error);
      
      const lastAction = workflow.actionHistory[workflow.actionHistory.length - 1];
      lastAction.status = 'failed';
      lastAction.error = error.message;
      lastAction.completedAt = new Date().toISOString();
      workflow.status = 'error';
      
      this.showNotification(`Action "${action}" failed: ${error.message}`, 'error');
    } finally {
      this.isRunning = false;
      this.currentWorkflow = null;
      this.saveWorkflows();
      this.renderWorkflows();
      await this.updateMetrics();
    }
  }

  // Duplicate a workflow
  duplicateWorkflow(workflowId) {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) return;

    const duplicated = {
      ...workflow,
      id: Date.now().toString(),
      name: workflow.name + ' (Copy)',
      created: new Date().toISOString(),
      actionHistory: [],
      completedActions: [],
      lastRun: null,
      status: 'active'
    };

    // Reset metrics for the duplicate
    duplicated.metrics = {
      ...duplicated.metrics,
      profilesFound: 0,
      profilesNotFound: 0,
      profilesViewed: 0,
      postsLiked: 0,
      connectionsRequested: 0,
      connectionsSentWithNote: 0,
      connectionsSentWithoutNote: 0,
      messagesSent: 0,
      lastUpdated: new Date().toISOString()
    };

    this.workflows.push(duplicated);
    this.saveWorkflows();
    this.renderWorkflows();
    this.showNotification('Workflow duplicated successfully', 'success');
  }

  // Archive a workflow
  archiveWorkflow(workflowId) {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) return;

    workflow.status = 'archived';
    workflow.archivedAt = new Date().toISOString();
    
    this.saveWorkflows();
    this.renderWorkflows();
    this.showNotification('Workflow archived', 'success');
  }

  // Delete a workflow
  deleteWorkflow(workflowId) {
    if (confirm('Are you sure you want to delete this workflow? This action cannot be undone.')) {
      this.workflows = this.workflows.filter(w => w.id !== workflowId);
      this.saveWorkflows();
      this.renderWorkflows();
      this.showNotification('Workflow deleted successfully', 'success');
    }
  }

  // Export workflow
  exportWorkflow(workflowId) {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) return;

    const dataStr = JSON.stringify(workflow, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = `workflow-${workflow.name.replace(/\s+/g, '-')}-${Date.now()}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    
    this.showNotification('Workflow exported successfully', 'success');
  }

  // Import workflow
  importWorkflow(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const workflow = JSON.parse(e.target.result);
        workflow.id = Date.now().toString(); // Generate new ID
        workflow.imported = new Date().toISOString();
        workflow.status = 'active';
        
        // Validate and fix structure
        const validatedWorkflow = this.validateWorkflowStructure(workflow);
        
        this.workflows.push(validatedWorkflow);
        this.saveWorkflows();
        this.renderWorkflows();
        
        this.showNotification('Workflow imported successfully', 'success');
      } catch (error) {
        console.error('Error importing workflow:', error);
        this.showNotification('Error importing workflow: Invalid file format', 'error');
      }
    };
    reader.readAsText(file);
  }

  // Render workflows in the UI
  renderWorkflows() {
    const grid = document.getElementById('workflows-grid');
    const emptyState = document.getElementById('empty-state');
    
    if (!grid) return;
    
    // Filter active workflows (not archived)
    const activeWorkflows = this.workflows.filter(w => w.status !== 'archived');
    
    if (activeWorkflows.length === 0) {
      grid.style.display = 'none';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }
    
    grid.style.display = 'grid';
    if (emptyState) emptyState.style.display = 'none';
    
    grid.innerHTML = activeWorkflows.map(workflow => this.renderWorkflowCard(workflow)).join('');
    
    // Attach event listeners to the newly created elements
    this.attachCardEventListeners();
  }

  // Render a single workflow card
  renderWorkflowCard(workflow) {
    const successRate = workflow.metrics.totalNames > 0 
      ? Math.round((workflow.metrics.profilesFound / workflow.metrics.totalNames) * 100)
      : 0;

    const lastAction = workflow.actionHistory.length > 0 
      ? workflow.actionHistory[workflow.actionHistory.length - 1]
      : null;

    const completedActions = this.getCompletedActions(workflow);
    const availableActions = this.getAvailableActions(workflow);
    const progress = this.calculateWorkflowProgress(workflow);

    return `
      <div class="workflow-card ${workflow.status}" data-workflow-id="${workflow.id}">
        <div class="workflow-card-header">
          <h3 class="workflow-name">${this.escapeHtml(workflow.name)}</h3>
          <span class="workflow-status-badge ${workflow.status}">${workflow.status}</span>
        </div>
        
        ${workflow.description ? `<p class="workflow-description">${this.escapeHtml(workflow.description)}</p>` : ''}
        
        <div class="workflow-progress">
          <div class="progress-text">
            <span>Overall Progress</span>
            <span>${progress.completed}/${progress.total} actions</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progress.percentage}%"></div>
          </div>
        </div>
        
        <div class="workflow-metrics">
          <div class="metric-item">
            <div class="metric-label">Total Names</div>
            <div class="metric-value">${workflow.metrics.totalNames}</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Profiles Found</div>
            <div class="metric-value">
              ${workflow.metrics.profilesFound}
              <span class="metric-percentage">(${successRate}%)</span>
            </div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Profiles Viewed</div>
            <div class="metric-value">${workflow.metrics.profilesViewed}</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Posts Liked</div>
            <div class="metric-value">${workflow.metrics.postsLiked}</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Connections Sent</div>
            <div class="metric-value">${workflow.metrics.connectionsRequested}</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Messages Sent</div>
            <div class="metric-value">${workflow.metrics.messagesSent}</div>
          </div>
        </div>

        <div class="completed-actions">
          <div class="actions-title">Completed Actions</div>
          <div class="actions-list">
            ${completedActions.length > 0 
              ? completedActions.map(action => `<span class="action-tag completed">${this.getActionDisplayName(action)}</span>`).join('')
              : '<span class="no-actions">No actions completed yet</span>'
            }
          </div>
        </div>

        <div class="available-actions">
          <div class="actions-title">Available Actions</div>
          <div class="actions-list">
            ${availableActions.length > 0 
              ? availableActions.map(action => `<span class="action-tag available" data-action="${action}">${this.getActionDisplayName(action)}</span>`).join('')
              : '<span class="no-actions">All actions completed</span>'
            }
          </div>
        </div>
        
        ${this.renderActionHistory(workflow)}
        
        <div class="workflow-actions-container">
          <button class="workflow-btn primary run-workflow" data-id="${workflow.id}" 
                  ${workflow.status === 'running' || availableActions.length === 0 ? 'disabled' : ''}>
            ${workflow.status === 'running' ? 'Running...' : 'Run Action'}
          </button>
          <button class="workflow-btn secondary view-details" data-id="${workflow.id}">
            View Details
          </button>
          <div class="workflow-dropdown">
            <button class="workflow-btn secondary dropdown-toggle" data-id="${workflow.id}">
              ⋯
            </button>
            <div class="dropdown-menu">
              <button class="dropdown-item duplicate-workflow" data-id="${workflow.id}">Duplicate</button>
              <button class="dropdown-item export-workflow" data-id="${workflow.id}">Export</button>
              <button class="dropdown-item archive-workflow" data-id="${workflow.id}">Archive</button>
              <button class="dropdown-item delete-workflow" data-id="${workflow.id}">Delete</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Calculate overall workflow progress
  calculateWorkflowProgress(workflow) {
    const totalActions = workflow.availableActions.length;
    const completedActions = workflow.completedActions.length;
    const percentage = totalActions > 0 ? Math.round((completedActions / totalActions) * 100) : 0;
    
    return {
      completed: completedActions,
      total: totalActions,
      percentage: percentage
    };
  }

  // Render action history section
  renderActionHistory(workflow) {
    if (!workflow.actionHistory || workflow.actionHistory.length === 0) {
      return '<div class="action-history"><div class="action-history-title">No actions performed yet</div></div>';
    }

    const recentActions = workflow.actionHistory.slice(-3).reverse(); // Show last 3 actions
    
    return `
      <div class="action-history">
        <div class="action-history-title">Recent Actions</div>
        ${recentActions.map(action => `
          <div class="action-item ${action.status}">
            <div class="action-icon ${action.action}">
              ${this.getActionIcon(action.action)}
            </div>
            <div class="action-details">
              <div class="action-name">${this.getActionDisplayName(action.action)}</div>
              <div class="action-date">${new Date(action.date).toLocaleDateString()}</div>
            </div>
            <div class="action-status-indicator ${action.status}"></div>
          </div>
        `).join('')}
        ${workflow.actionHistory.length > 3 ? 
          `<div class="action-history-more">+${workflow.actionHistory.length - 3} more actions</div>` : ''
        }
      </div>
    `;
  }

  // Get display name for actions
  getActionDisplayName(action) {
    const displayNames = {
      'view': 'View Profiles',
      'like': 'Like Posts',
      'connect': 'Send Connections',
      'message': 'Send Messages'
    };
    return displayNames[action] || action;
  }

  // Get icon for actions
  getActionIcon(action) {
    const icons = {
      'view': '👁️',
      'like': '❤️',
      'connect': '🤝',
      'message': '💬'
    };
    return icons[action] || '📋';
  }

  // Setup real-time updates
  setupRealTimeUpdates() {
    // Update metrics every 30 seconds when a workflow is running
    setInterval(() => {
      if (this.isRunning) {
        this.updateMetrics();
      }
    }, 30000);

    // Listen for workflow progress updates from the backend
    if (window.electronAPI && window.electronAPI.onWorkflowProgress) {
      window.electronAPI.onWorkflowProgress((data) => {
        this.handleWorkflowProgress(data);
      });
    }
  }

  // Handle workflow progress updates from backend
  handleWorkflowProgress(progressData) {
    const workflow = this.workflows.find(w => w.id === progressData.workflowId);
    if (!workflow) return;

    // Update the current action's progress
    const currentAction = workflow.actionHistory[workflow.actionHistory.length - 1];
    if (currentAction && currentAction.status === 'running') {
      currentAction.progress = progressData.progress;
      this.saveWorkflows();
      this.renderWorkflows();
    }
  }

  // Attach event listeners to workflow cards
  attachCardEventListeners() {
    // Run workflow buttons
    document.querySelectorAll('.run-workflow').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const workflowId = e.target.getAttribute('data-id');
        this.openRunActionModal(workflowId);
      });
    });

    // View details buttons
    document.querySelectorAll('.view-details').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const workflowId = e.target.getAttribute('data-id');
        this.openWorkflowDetails(workflowId);
      });
    });

    // Available action tags (quick run)
    document.querySelectorAll('.action-tag.available').forEach(tag => {
      tag.addEventListener('click', (e) => {
        const action = e.target.getAttribute('data-action');
        const workflowCard = e.target.closest('.workflow-card');
        const workflowId = workflowCard.getAttribute('data-workflow-id');
        this.quickRunAction(workflowId, action);
      });
    });

    // Dropdown toggles
    document.querySelectorAll('.dropdown-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dropdown = e.target.nextElementSibling;
        // Close other dropdowns
        document.querySelectorAll('.dropdown-menu').forEach(menu => {
          if (menu !== dropdown) menu.classList.remove('show');
        });
        dropdown.classList.toggle('show');
      });
    });

    // Dropdown actions
    document.querySelectorAll('.duplicate-workflow').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const workflowId = e.target.getAttribute('data-id');
        this.duplicateWorkflow(workflowId);
      });
    });

    document.querySelectorAll('.export-workflow').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const workflowId = e.target.getAttribute('data-id');
        this.exportWorkflow(workflowId);
      });
    });

    document.querySelectorAll('.archive-workflow').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const workflowId = e.target.getAttribute('data-id');
        this.archiveWorkflow(workflowId);
      });
    });

    document.querySelectorAll('.delete-workflow').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const workflowId = e.target.getAttribute('data-id');
        this.deleteWorkflow(workflowId);
      });
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
      document.querySelectorAll('.dropdown-menu').forEach(menu => {
        menu.classList.remove('show');
      });
    });
  }

  // Quick run an action without configuration
  quickRunAction(workflowId, action) {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) return;

    if (confirm(`Run "${this.getActionDisplayName(action)}" on workflow "${workflow.name}"?`)) {
      this.runAction(workflowId, action);
    }
  }

  // Open run action modal with configuration options
  openRunActionModal(workflowId) {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) return;

    const availableActions = this.getAvailableActions(workflow);
    if (availableActions.length === 0) {
      this.showNotification('All actions completed for this workflow', 'info');
      return;
    }

    // Set current workflow for modal
    this.currentWorkflow = workflow;
    
    // Update modal content
    this.updateRunActionModal(availableActions);
    
    // Show modal
    const modal = document.getElementById('run-action-modal');
    modal.classList.add('active');
  }

  // Update run action modal content
  updateRunActionModal(availableActions) {
    const modalBody = document.querySelector('#run-action-modal .modal-body');
    
    modalBody.innerHTML = `
      <div class="action-selection">
        <h3>Select Action to Run</h3>
        <div class="action-options">
          ${availableActions.map(action => `
            <div class="action-option" data-action="${action}">
              <div class="action-option-icon" style="background: ${this.getActionColor(action)};">
                ${this.getActionIcon(action)}
              </div>
              <div class="action-option-details">
                <div class="action-option-title">${this.getActionDisplayName(action)}</div>
                <div class="action-option-description">${this.getActionDescription(action)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      
      <div id="action-config" style="display: none;">
        <!-- Dynamic configuration will be inserted here -->
      </div>
    `;

    // Add event listeners for action selection
    modalBody.querySelectorAll('.action-option').forEach(option => {
      option.addEventListener('click', (e) => {
        // Remove previous selections
        modalBody.querySelectorAll('.action-option').forEach(opt => opt.classList.remove('selected'));
        
        // Select current option
        option.classList.add('selected');
        
        const action = option.getAttribute('data-action');
        this.showActionConfig(action);
      });
    });
  }

  // Show configuration options for selected action
  showActionConfig(action) {
    const configDiv = document.getElementById('action-config');
    let configHTML = '';

    switch(action) {
      case 'view':
        configHTML = `
          <div class="config-section">
            <h4>Profile Viewing Options</h4>
            <div class="config-option">
              <label>
                <input type="checkbox" id="random-delays" checked>
                Enable random delays between profiles
              </label>
            </div>
            <div class="config-option">
              <label>
                Pause between profiles (seconds):
                <input type="number" id="pause-duration" value="30" min="10" max="120">
              </label>
            </div>
          </div>
        `;
        break;
        
      case 'like':
        configHTML = `
          <div class="config-section">
            <h4>Post Liking Options</h4>
            <div class="config-option">
              <label>
                <input type="checkbox" id="like-recent-only" checked>
                Only like recent posts (last 30 days)
              </label>
            </div>
            <div class="config-option">
              <label>
                Maximum posts to like per profile:
                <input type="number" id="max-likes" value="3" min="1" max="10">
              </label>
            </div>
            <div class="config-option">
              <label>
                <input type="checkbox" id="skip-already-liked" checked>
                Skip profiles where posts were already liked
              </label>
            </div>
          </div>
        `;
        break;
        
      case 'connect':
        configHTML = `
          <div class="config-section">
            <h4>Connection Request Options</h4>
            <div class="config-option">
              <label>
                <input type="radio" name="connect-type" value="without-note" checked>
                Send without personalized message
              </label>
            </div>
            <div class="config-option">
              <label>
                <input type="radio" name="connect-type" value="with-note">
                Send with personalized message
              </label>
            </div>
            <div class="config-option" id="message-config" style="display: none;">
              <label>
                Connection message:
                <textarea id="connect-message" placeholder="Hi {firstName}, I'd love to connect with you!" rows="3"></textarea>
              </label>
              <small>Use {firstName}, {lastName}, {company} for personalization</small>
            </div>
            <div class="config-option">
              <label>
                <input type="checkbox" id="skip-already-connected" checked>
                Skip profiles already sent connection requests
              </label>
            </div>
          </div>
        `;
        break;
        
      case 'message':
        configHTML = `
          <div class="config-section">
            <h4>Messaging Options</h4>
            <div class="config-option">
              <label>
                Message template:
                <textarea id="message-template" placeholder="Hi {firstName}, hope you're doing well!" rows="4" required></textarea>
              </label>
              <small>Use {firstName}, {lastName}, {company} for personalization</small>
            </div>
            <div class="config-option">
              <label>
                <input type="checkbox" id="connections-only" checked>
                Only message existing connections
              </label>
            </div>
            <div class="config-option">
              <label>
                <input type="checkbox" id="skip-recent-messages" checked>
                Skip profiles messaged in last 7 days
              </label>
            </div>
          </div>
        `;
        break;
    }

    configDiv.innerHTML = configHTML;
    configDiv.style.display = 'block';

    // Add event listeners for dynamic options
    if (action === 'connect') {
      const radioButtons = configDiv.querySelectorAll('input[name="connect-type"]');
      const messageConfig = configDiv.querySelector('#message-config');
      
      radioButtons.forEach(radio => {
        radio.addEventListener('change', (e) => {
          if (e.target.value === 'with-note') {
            messageConfig.style.display = 'block';
          } else {
            messageConfig.style.display = 'none';
          }
        });
      });
    }
  }

  // Get action color for UI
  getActionColor(action) {
    const colors = {
      'view': '#e3f2fd',
      'like': '#fce4ec',
      'connect': '#e8f5e8',
      'message': '#fff3e0'
    };
    return colors[action] || '#f5f5f5';
  }

  // Get action description
  getActionDescription(action) {
    const descriptions = {
      'view': 'Visit and view all profiles in this workflow',
      'like': 'Like recent posts from profiles in this workflow',
      'connect': 'Send connection requests to profiles in this workflow',
      'message': 'Send personalized messages to connected profiles'
    };
    return descriptions[action] || 'Perform action on workflow profiles';
  }

  // Open workflow details modal
  openWorkflowDetails(workflowId) {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) return;

    const modal = document.createElement('div');
    modal.className = 'workflow-details-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>Workflow Details: ${this.escapeHtml(workflow.name)}</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          ${this.renderWorkflowDetailsContent(workflow)}
        </div>
      </div>
    `;

    // Add to document
    document.body.appendChild(modal);

    // Add event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => {
      document.body.removeChild(modal);
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal);
      }
    });
  }

  // Render workflow details content
  renderWorkflowDetailsContent(workflow) {
    const progress = this.calculateWorkflowProgress(workflow);
    
    return `
      <div class="workflow-details-content">
        <div class="details-section">
          <h3>Basic Information</h3>
          <div class="details-grid">
            <div class="detail-item">
              <label>Name:</label>
              <span>${this.escapeHtml(workflow.name)}</span>
            </div>
            <div class="detail-item">
              <label>Description:</label>
              <span>${this.escapeHtml(workflow.description || 'No description')}</span>
            </div>
            <div class="detail-item">
              <label>Created:</label>
              <span>${new Date(workflow.created).toLocaleString()}</span>
            </div>
            <div class="detail-item">
              <label>Last Run:</label>
              <span>${workflow.lastRun ? new Date(workflow.lastRun).toLocaleString() : 'Never'}</span>
            </div>
            <div class="detail-item">
              <label>Status:</label>
              <span class="status-badge ${workflow.status}">${workflow.status}</span>
            </div>
          </div>
        </div>

        <div class="details-section">
          <h3>Progress Overview</h3>
          <div class="progress-overview">
            <div class="progress-circle" data-percentage="${progress.percentage}">
              <div class="progress-number">${progress.percentage}%</div>
              <div class="progress-label">Complete</div>
            </div>
            <div class="progress-stats">
              <div class="stat-item">
                <div class="stat-number">${progress.completed}</div>
                <div class="stat-label">Actions Completed</div>
              </div>
              <div class="stat-item">
                <div class="stat-number">${progress.total - progress.completed}</div>
                <div class="stat-label">Actions Remaining</div>
              </div>
            </div>
          </div>
        </div>

        <div class="details-section">
          <h3>Detailed Metrics</h3>
          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-icon">👥</div>
              <div class="metric-info">
                <div class="metric-number">${workflow.metrics.totalNames}</div>
                <div class="metric-label">Total Names</div>
              </div>
            </div>
            <div class="metric-card">
              <div class="metric-icon">✅</div>
              <div class="metric-info">
                <div class="metric-number">${workflow.metrics.profilesFound}</div>
                <div class="metric-label">Profiles Found</div>
              </div>
            </div>
            <div class="metric-card">
              <div class="metric-icon">❌</div>
              <div class="metric-info">
                <div class="metric-number">${workflow.metrics.profilesNotFound}</div>
                <div class="metric-label">Profiles Not Found</div>
              </div>
            </div>
            <div class="metric-card">
              <div class="metric-icon">👁️</div>
              <div class="metric-info">
                <div class="metric-number">${workflow.metrics.profilesViewed}</div>
                <div class="metric-label">Profiles Viewed</div>
              </div>
            </div>
            <div class="metric-card">
              <div class="metric-icon">❤️</div>
              <div class="metric-info">
                <div class="metric-number">${workflow.metrics.postsLiked}</div>
                <div class="metric-label">Posts Liked</div>
              </div>
            </div>
            <div class="metric-card">
              <div class="metric-icon">🤝</div>
              <div class="metric-info">
                <div class="metric-number">${workflow.metrics.connectionsRequested}</div>
                <div class="metric-label">Connection Requests</div>
              </div>
            </div>
            <div class="metric-card">
              <div class="metric-icon">💬</div>
              <div class="metric-info">
                <div class="metric-number">${workflow.metrics.messagesSent}</div>
                <div class="metric-label">Messages Sent</div>
              </div>
            </div>
          </div>
        </div>

        <div class="details-section">
          <h3>Name List (${workflow.names.length} names)</h3>
          <div class="name-list-container">
            ${workflow.names.map((name, index) => `
              <div class="name-item">
                <span class="name-index">${index + 1}.</span>
                <span class="name-text">${this.escapeHtml(name)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="details-section">
          <h3>Action History (${workflow.actionHistory.length} actions)</h3>
          <div class="action-history-detailed">
            ${workflow.actionHistory.length > 0 ? 
              workflow.actionHistory.slice().reverse().map(action => `
                <div class="action-history-item ${action.status}">
                  <div class="action-icon">${this.getActionIcon(action.action)}</div>
                  <div class="action-content">
                    <div class="action-header">
                      <h4>${this.getActionDisplayName(action.action)}</h4>
                      <span class="action-status ${action.status}">${action.status}</span>
                    </div>
                    <div class="action-meta">
                      <span>Started: ${new Date(action.date).toLocaleString()}</span>
                      ${action.completedAt ? `<span>Completed: ${new Date(action.completedAt).toLocaleString()}</span>` : ''}
                    </div>
                    ${action.result ? `
                      <div class="action-results">
                        <span>Processed: ${action.result.processed || 0}</span>
                        <span>Liked: ${action.result.liked || 0}</span>
                        <span>Connected: ${action.result.connected || 0}</span>
                      </div>
                    ` : ''}
                    ${action.error ? `<div class="action-error">${action.error}</div>` : ''}
                  </div>
                </div>
              `).join('') : 
              '<div class="no-history">No actions performed yet</div>'
            }
          </div>
        </div>
      </div>
    `;
  }

  // Attach main event listeners
  attachEventListeners() {
    // Create workflow button
    const createBtn = document.getElementById('create-workflow-btn');
    if (createBtn) {
      createBtn.addEventListener('click', () => this.openCreateWorkflowModal());
    }

    // Import workflow button
    const importBtn = document.getElementById('import-workflow-btn');
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
          if (e.target.files[0]) {
            this.importWorkflow(e.target.files[0]);
          }
        };
        input.click();
      });
    }

    // Create workflow modal events
    const createModal = document.getElementById('create-workflow-modal');
    if (createModal) {
      // Close modal events
      createModal.querySelector('.modal-close').addEventListener('click', () => {
        this.closeCreateWorkflowModal();
      });

      // Name count tracker
      const namesTextarea = document.getElementById('workflow-names');
      if (namesTextarea) {
        namesTextarea.addEventListener('input', () => {
          const nameCount = this.parseNameList(namesTextarea.value).length;
          document.getElementById('name-count').textContent = nameCount;
        });
      }

      // Create workflow button
      const createWorkflowBtn = createModal.querySelector('.btn.btn-primary');
      if (createWorkflowBtn) {
        createWorkflowBtn.addEventListener('click', () => this.createWorkflowFromModal());
      }
    }

    // Run action modal events
    const runModal = document.getElementById('run-action-modal');
    if (runModal) {
      // Close modal events
      runModal.querySelector('.modal-close').addEventListener('click', () => {
        this.closeRunActionModal();
      });

      // Run action button
      const runActionBtn = runModal.querySelector('.btn.btn-primary');
      if (runActionBtn) {
        runActionBtn.addEventListener('click', () => this.runSelectedAction());
      }
    }

    // Click outside modal to close
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('create-workflow-modal') || 
          e.target.classList.contains('run-action-modal')) {
        e.target.classList.remove('active');
      }
    });
  }

  // Open create workflow modal
  openCreateWorkflowModal() {
    const modal = document.getElementById('create-workflow-modal');
    if (modal) {
      modal.classList.add('active');
      
      // Clear form
      document.getElementById('workflow-name').value = '';
      document.getElementById('workflow-description').value = '';
      document.getElementById('workflow-names').value = '';
      document.getElementById('initial-action').value = '';
      document.getElementById('name-count').textContent = '0';
    }
  }

  // Close create workflow modal
  closeCreateWorkflowModal() {
    const modal = document.getElementById('create-workflow-modal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // Close run action modal
  closeRunActionModal() {
    const modal = document.getElementById('run-action-modal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // Create workflow from modal form
  createWorkflowFromModal() {
    const name = document.getElementById('workflow-name').value.trim();
    const description = document.getElementById('workflow-description').value.trim();
    const namesText = document.getElementById('workflow-names').value.trim();
    const initialAction = document.getElementById('initial-action').value;

    // Validation
    if (!name) {
      this.showNotification('Please enter a workflow name', 'error');
      return;
    }

    if (!namesText) {
      this.showNotification('Please enter at least one name', 'error');
      return;
    }

    // Parse names
    const nameList = this.parseNameList(namesText);
    
    if (nameList.length === 0) {
      this.showNotification('No valid names found in the list', 'error');
      return;
    }

    // Create workflow
    this.createWorkflow(name, description, nameList, initialAction);
    this.closeCreateWorkflowModal();
  }

  // Run selected action from modal
  runSelectedAction() {
    if (!this.currentWorkflow) {
      this.showNotification('No workflow selected', 'error');
      return;
    }

    const selectedAction = document.querySelector('.action-option.selected');
    if (!selectedAction) {
      this.showNotification('Please select an action to run', 'error');
      return;
    }

    const action = selectedAction.getAttribute('data-action');
    const config = this.getActionConfigFromModal(action);

    // Validate configuration
    if (!this.validateActionConfig(action, config)) {
      return;
    }

    this.closeRunActionModal();
    this.runAction(this.currentWorkflow.id, action, config);
  }

  // Get action configuration from modal
  getActionConfigFromModal(action) {
    const config = {};

    switch(action) {
      case 'view':
        config.randomDelays = document.getElementById('random-delays')?.checked || false;
        config.pauseDuration = parseInt(document.getElementById('pause-duration')?.value) || 30;
        config.visitProfile = true;
        break;
        
      case 'like':
        config.likeRecentOnly = document.getElementById('like-recent-only')?.checked || false;
        config.maxLikes = parseInt(document.getElementById('max-likes')?.value) || 3;
        config.skipAlreadyLiked = document.getElementById('skip-already-liked')?.checked || false;
        config.likePosts = true;
        break;
        
      case 'connect':
        const connectType = document.querySelector('input[name="connect-type"]:checked')?.value;
        config.sendWithNote = connectType === 'with-note';
        config.connectMessage = document.getElementById('connect-message')?.value.trim() || '';
        config.skipAlreadyConnected = document.getElementById('skip-already-connected')?.checked || false;
        config.sendConnection = true;
        break;
        
      case 'message':
        config.messageTemplate = document.getElementById('message-template')?.value.trim() || '';
        config.connectionsOnly = document.getElementById('connections-only')?.checked || false;
        config.skipRecentMessages = document.getElementById('skip-recent-messages')?.checked || false;
        config.sendMessage = true;
        break;
    }

    return config;
  }

  // Validate action configuration
  validateActionConfig(action, config) {
    switch(action) {
      case 'connect':
        if (config.sendWithNote && !config.connectMessage) {
          this.showNotification('Please enter a connection message', 'error');
          return false;
        }
        break;
        
      case 'message':
        if (!config.messageTemplate) {
          this.showNotification('Please enter a message template', 'error');
          return false;
        }
        break;
    }
    
    return true;
  }

  // Parse name list from text
  parseNameList(nameListText) {
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

  // Show notification
  showNotification(message, type = 'info') {
    const toast = document.getElementById('notification-toast');
    if (!toast) return;

    toast.className = `notification-toast ${type} show`;
    document.getElementById('notification-message').textContent = message;

    // Auto hide after 5 seconds
    setTimeout(() => {
      toast.classList.remove('show');
    }, 5000);
  }

  // Escape HTML to prevent XSS
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Get workflow statistics
  getWorkflowStats() {
    const stats = {
      total: this.workflows.length,
      active: this.workflows.filter(w => w.status === 'active').length,
      running: this.workflows.filter(w => w.status === 'running').length,
      completed: this.workflows.filter(w => w.completedActions.length === w.availableActions.length).length,
      archived: this.workflows.filter(w => w.status === 'archived').length
    };

    return stats;
  }

  // Export all workflows
  exportAllWorkflows() {
    const dataStr = JSON.stringify(this.workflows, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = `all-workflows-${new Date().toISOString().split('T')[0]}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    
    this.showNotification('All workflows exported successfully', 'success');
  }

  // Get workflow by ID
  getWorkflowById(id) {
    return this.workflows.find(w => w.id === id);
  }

  // Reset workflow (clear all completed actions and metrics)
  resetWorkflow(workflowId) {
    if (confirm('Are you sure you want to reset this workflow? All progress will be lost.')) {
      const workflow = this.workflows.find(w => w.id === workflowId);
      if (!workflow) return;

      workflow.completedActions = [];
      workflow.actionHistory = [];
      workflow.lastRun = null;
      workflow.status = 'active';
      
      // Reset metrics
      workflow.metrics = {
        ...workflow.metrics,
        profilesFound: 0,
        profilesNotFound: 0,
        profilesViewed: 0,
        postsLiked: 0,
        connectionsRequested: 0,
        connectionsSentWithNote: 0,
        connectionsSentWithoutNote: 0,
        messagesSent: 0,
        lastUpdated: new Date().toISOString()
      };

      this.saveWorkflows();
      this.renderWorkflows();
      this.showNotification('Workflow reset successfully', 'success');
    }
  }
}



// Initialize the workflow manager when the page loads
document.addEventListener('DOMContentLoaded', () => {
  window.workflowManager = new WorkflowManager();
});

// Global functions for external access
window.openCreateWorkflowModal = () => {
  if (window.workflowManager) {
    window.workflowManager.openCreateWorkflowModal();
  }
};

window.closeCreateWorkflowModal = () => {
  if (window.workflowManager) {
    window.workflowManager.closeCreateWorkflowModal();
  }
};

window.closeRunActionModal = () => {
  if (window.workflowManager) {
    window.workflowManager.closeRunActionModal();
  }
};

window.createWorkflow = () => {
  if (window.workflowManager) {
    window.workflowManager.createWorkflowFromModal();
  }
};

window.runSelectedAction = () => {
  if (window.workflowManager) {
    window.workflowManager.runSelectedAction();
  }
};
