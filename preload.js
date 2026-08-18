const { contextBridge, ipcRenderer } = require('electron');

const rawInvoke = ipcRenderer.invoke.bind(ipcRenderer);
const VALID_INVOKE_CHANNELS = new Set([
  'save-credentials',
  'load-credentials',
  'clear-credentials',
  'get-linkedin-accounts',
  'get-active-linkedin-account',
  'get-linkedin-runtime-jobs',
  'get-linkedin-account-health',
  'clear-linkedin-account-challenge',
  'save-linkedin-account',
  'delete-linkedin-account',
  'set-active-linkedin-account',
  'get-sdr-agents',
  'save-sdr-agent',
  'delete-sdr-agent',
  'get-agent-persona',
  'write-agent-persona',
  'delete-agent-persona',
  'get-sdr-agent-search-presets',
  'generate-sdr-agent-content-plan',
  'get-sdr-workflow-runs',
  'get-campaign-runs',
  'drain-campaign-run',
  'drain-all-campaign-runs',
  'clear-campaign-apollo-hold',
  'get-sdr-prospects',
  'list-activity-events',
  'read-profile-screenshot',
  'find-linkedin-profiles-by-search',
  'send-new-dm',
  'get-sdr-workflow-jobs',
  'cancel-sdr-workflow-run',
  'delete-sdr-workflow-run',
  'get-activity-analytics',
  'get-apollo-integration',
  'configure-apollo-integration',
  'get-apollo-sync-status',
  'list-apollo-bindings',
  'export-activity-report',
  'export-diagnostics-report',
  'get-reply-monitor-state',
  'get-inbox',
  'get-inbox-conversation',
  'send-inbox-reply',
  'get-reply-notifications',
  'mark-reply-notification-read',
  'mark-all-reply-notifications-read',
  'pause-workflow-run',
  'resume-workflow-run',
  'archive-inbox-conversation',
  'login-linkedin',
  'logout-linkedin',
  'get-login-status',
  'get-all-profiles',
  'get-profile-data',
  'load-profiles-from-json',
  'store-profile-batch',
  'store-profile-action',
  'get-all-workflows',
  'update-workflow',
  'get-automation-workflows',
  'save-automation-workflow',
  'delete-automation-workflow',
  'run-group-workflow',
  'get-groups-data',
  'save-groups-data',
  'publish-linkedin-post',
  'get-scheduled-posts',
  'save-scheduled-posts',
  'schedule-message-invoke',
  'get-scheduled-messages-invoke',
  'get-scheduled-message-invoke',
  'cancel-scheduled-message-invoke',
  'update-scheduled-message-invoke',
  'send-scheduled-now-invoke',
  'get-message-stats',
  'check-message-quota',
  'filter-profiles-by-interaction',
  'add-profiles-to-workflow',
  'get-app-mode'
]);
const VALID_SEND_CHANNELS = new Set([
  'send-messages-now',
  'schedule-message',
  'get-scheduled-messages',
  'cancel-scheduled-message',
  'update-scheduled-message',
  'get-scheduled-message',
  'send-scheduled-now',
  'clear-scheduled-logs',
  'export-logs',
  'export-emails',
  'open-workflow-manager',
  'stop-group-workflow',
  'stop-automation'
]);
const VALID_ON_CHANNELS = new Set([
  'automation-log',
  'automation-progress',
  'automation-completed',
  'credentials-saved',
  'credentials-loaded',
  'scheduled-messages-loaded',
  'scheduled-message-loaded',
  'message-progress',
  'workflow-progress',
  'workflow-completed',
  'workflow-created',
  'workflow-deleted',
  'workflow-paused',
  'workflow-log',
  'workflow-done',
  'linkedin-runtime-updated',
  'linkedin-account-health-updated',
  'linkedin-challenge-detected',
  'inbox-updated',
  'prospects-updated',
  'sdr-agents-updated',
  'sdr-workflow-runs-updated',
  'campaign-runs-updated',
  'activity-analytics-updated',
  'dm-reply-notification',
  'post-published'
]);

function invoke(channel, ...args) {
  if (!VALID_INVOKE_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`Disallowed IPC invoke channel: ${channel}`));
  }
  return rawInvoke(channel, ...args);
}

const electronAPI = {
  // App mode (renderer asks at startup whether to surface legacy direct-login UI)
  getAppMode: () => invoke('get-app-mode'),

  // Automation
  startAutomation: (config) => ipcRenderer.send('start-automation', config),
  startNameListAutomation: (config) => ipcRenderer.send('start-name-list-automation', config),
  stopAutomation: (payload) => ipcRenderer.send('stop-automation', payload),

  // Credentials
  saveCredentials: (credentials) => invoke('save-credentials', credentials),
  loadCredentials: () => invoke('load-credentials'),
  clearCredentials: () => invoke('clear-credentials'),
  getLinkedInAccounts: () => invoke('get-linkedin-accounts'),
  getActiveLinkedInAccount: () => invoke('get-active-linkedin-account'),
  getLinkedInRuntimeJobs: () => invoke('get-linkedin-runtime-jobs'),
  getLinkedInAccountHealth: () => invoke('get-linkedin-account-health'),
  clearLinkedInAccountChallenge: (accountId) => invoke('clear-linkedin-account-challenge', accountId),
  saveLinkedInAccount: (account) => invoke('save-linkedin-account', account),
  deleteLinkedInAccount: (accountId) => invoke('delete-linkedin-account', accountId),
  setActiveLinkedInAccount: (accountId) => invoke('set-active-linkedin-account', accountId),
  getSdrAgents: (filters) => invoke('get-sdr-agents', filters),
  saveSdrAgent: (agent) => invoke('save-sdr-agent', agent),
  deleteSdrAgent: (agentId) => invoke('delete-sdr-agent', agentId),
  getAgentPersona: (agentId) => invoke('get-agent-persona', agentId),
  writeAgentPersona: (payload) => invoke('write-agent-persona', payload),
  deleteAgentPersona: (payload) => invoke('delete-agent-persona', payload),
  getSdrAgentSearchPresets: (agentId) => invoke('get-sdr-agent-search-presets', agentId),
  generateSdrAgentContentPlan: (payload) => invoke('generate-sdr-agent-content-plan', payload),
  getSdrWorkflowRuns: () => invoke('get-sdr-workflow-runs'),
  getCampaignRuns: () => invoke('get-campaign-runs'),
  drainCampaignRun: (campaignRunId) => invoke('drain-campaign-run', campaignRunId),
  drainAllCampaignRuns: () => invoke('drain-all-campaign-runs'),
  clearCampaignApolloHold: (campaignRunId) => invoke('clear-campaign-apollo-hold', campaignRunId),
  getSdrProspects: (filters) => invoke('get-sdr-prospects', filters),
  listActivityEvents: (filters) => invoke('list-activity-events', filters),
  readProfileScreenshot: (payload) => invoke('read-profile-screenshot', payload),
  findLinkedInProfilesBySearch: (payload) => invoke('find-linkedin-profiles-by-search', payload),
  sendNewDm: (payload) => invoke('send-new-dm', payload),
  getSdrWorkflowJobs: (runId) => invoke('get-sdr-workflow-jobs', runId),
  cancelSdrWorkflowRun: (runId) => invoke('cancel-sdr-workflow-run', runId),
  deleteSdrWorkflowRun: (runId) => invoke('delete-sdr-workflow-run', runId),
  getActivityAnalytics: (filters) => invoke('get-activity-analytics', filters),
  getApolloIntegration: () => invoke('get-apollo-integration'),
  configureApolloIntegration: (input) => invoke('configure-apollo-integration', input),
  getApolloSyncStatus: (filters) => invoke('get-apollo-sync-status', filters),
  listApolloBindings: (filters) => invoke('list-apollo-bindings', filters),
  exportActivityReport: (filters) => invoke('export-activity-report', filters),
  exportDiagnosticsReport: (filters) => invoke('export-diagnostics-report', filters),
  getReplyMonitorState: () => invoke('get-reply-monitor-state'),
  getInbox: (filters) => invoke('get-inbox', filters),
  getInboxConversation: (conversationUrn, options) => invoke('get-inbox-conversation', conversationUrn, options),
  sendInboxReply: (payload) => invoke('send-inbox-reply', payload),
  getReplyNotifications: (filters) => invoke('get-reply-notifications', filters),
  markReplyNotificationRead: (notificationId) => invoke('mark-reply-notification-read', notificationId),
  markAllReplyNotificationsRead: (filters) => invoke('mark-all-reply-notifications-read', filters),
  pauseWorkflowRun: (runId) => invoke('pause-workflow-run', runId),
  resumeWorkflowRun: (runId) => invoke('resume-workflow-run', runId),
  archiveInboxConversation: (conversationUrn) => invoke('archive-inbox-conversation', conversationUrn),
  loginLinkedIn: (credentials) => invoke('login-linkedin', credentials),
  logoutLinkedIn: () => invoke('logout-linkedin'),
  getLoginStatus: () => invoke('get-login-status'),

  // Profiles
  getAllProfiles: () => invoke('get-all-profiles'),
  getProfileData: (profileId) => invoke('get-profile-data', profileId),
  loadProfilesFromJson: () => invoke('load-profiles-from-json'),
  storeProfileBatch: (profiles) => invoke('store-profile-batch', profiles),
  storeProfileAction: (url, details, action, notes, query) =>
    invoke('store-profile-action', url, details, action, notes, query),

  // Workflows
  getAllWorkflows: () => invoke('get-all-workflows'),
  updateWorkflow: (workflowId, updates) => invoke('update-workflow', workflowId, updates),
  getAutomationWorkflows: () => invoke('get-automation-workflows'),
  saveAutomationWorkflow: (workflow) => invoke('save-automation-workflow', workflow),
  deleteAutomationWorkflow: (workflowId) => invoke('delete-automation-workflow', workflowId),
  createWorkflow: (workflowData) => ipcRenderer.send('create-workflow', workflowData),
  startWorkflow: (workflowId) => ipcRenderer.send('start-workflow', workflowId),
  deleteWorkflow: (workflowId) => ipcRenderer.send('delete-workflow', workflowId),
  pauseWorkflow: (workflowId) => ipcRenderer.send('pause-workflow', workflowId),
  runGroupWorkflow: (groupIdOrConfig, actions, message) => {
    if (groupIdOrConfig && typeof groupIdOrConfig === 'object' && !Array.isArray(groupIdOrConfig)) {
      return invoke('run-group-workflow', groupIdOrConfig);
    }
    return invoke('run-group-workflow', {
      groupId: groupIdOrConfig,
      actions,
      connectionMessage: message
    });
  },

  // Groups
  getGroupsData: () => invoke('get-groups-data'),
  saveGroupsData: (groups) => invoke('save-groups-data', groups),

  // Messages
  publishLinkedInPost: (payload) => invoke('publish-linkedin-post', payload),
  getScheduledPosts: (filters) => invoke('get-scheduled-posts', filters),
  saveScheduledPosts: (posts, filters) => invoke('save-scheduled-posts', posts, filters),
  exportLogs: (logs) => ipcRenderer.send('export-logs', logs),
  exportEmails: () => ipcRenderer.send('export-emails'),
  scheduleMessage: (payload) => invoke('schedule-message-invoke', payload),
  getScheduledMessages: (filters) => invoke('get-scheduled-messages-invoke', filters),
  getScheduledMessage: (scheduleId, filters) => invoke('get-scheduled-message-invoke', scheduleId, filters),
  cancelScheduledMessage: (scheduleId, filters) => invoke('cancel-scheduled-message-invoke', scheduleId, filters),
  updateScheduledMessage: (scheduleId, updates, filters) =>
    invoke('update-scheduled-message-invoke', scheduleId, updates, filters),
  sendScheduledNow: (scheduleId, filters) => invoke('send-scheduled-now-invoke', scheduleId, filters),
  getMessageStats: () => invoke('get-message-stats'),
  checkMessageQuota: () => invoke('check-message-quota'),
  filterProfilesByInteraction: (interactionType) => invoke('filter-profiles-by-interaction', interactionType),
  addProfilesToWorkflow: (workflowId, profileIds) => invoke('add-profiles-to-workflow', workflowId, profileIds),
  send: (channel, data) => {
    if (VALID_SEND_CHANNELS.has(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  // Event listeners
  on: (channel, callback) => {
    if (VALID_ON_CHANNELS.has(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  // Specific event listeners for backward compatibility
  onAutomationLog: (callback) => ipcRenderer.on('automation-log', (_event, data) => callback(data)),
  onAutomationProgress: (callback) => ipcRenderer.on('automation-progress', (_event, data) => callback(data)),
  onAutomationCompleted: (callback) => ipcRenderer.on('automation-completed', () => callback()),
  onCredentialsSaved: (callback) => ipcRenderer.on('credentials-saved', (_event, success) => callback(success)),
  onCredentialsLoaded: (callback) => ipcRenderer.on('credentials-loaded', (_event, credentials) => callback(credentials)),
  onShowProfileDetail: (callback) => ipcRenderer.on('show-profile-detail', (_event, profileId) => callback(profileId)),
  onLog: (callback) => ipcRenderer.on('workflow-log', (_event, data) => callback(data)),
  onProgress: (callback) => ipcRenderer.on('workflow-progress', (_event, data) => callback(data)),
  onWorkflowProgress: (callback) => ipcRenderer.on('workflow-progress', (_event, data) => callback(data)),
  onWorkflowCompleted: (callback) => ipcRenderer.on('workflow-completed', (_event, data) => callback(data)),
  onDone: (callback) => ipcRenderer.on('workflow-done', (_event, data) => callback(data)),
  onPostPublished: (callback) => ipcRenderer.on('post-published', (_event, data) => callback(data))
};

contextBridge.exposeInMainWorld('electronAPI', Object.freeze(electronAPI));

console.log('Preload script loaded successfully');
console.log('Available APIs: window.electronAPI');
