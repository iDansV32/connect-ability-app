(function () {
  const STORAGE_KEY = 'automation-workflows-v2';
  const GROUPS_STORAGE_KEY = 'standalone-groups';
  const DEFAULT_STEP_DELAY = {
    minDelayMs: 8000,
    maxDelayMs: 18000
  };
  const state = {
    workflows: [],
    groups: [],
    profiles: [],
    agents: [],
    activeTargetMode: 'group',
    editingWorkflowId: null,
    runningWorkflowId: null,
    selectedProfiles: new Set(),
    groupDraftProfiles: new Set()
  };
  const elements = {};

  document.addEventListener('DOMContentLoaded', initAutomationWorkflows);

  async function initAutomationWorkflows() {
    elements.root = document.getElementById('automations-section');
    if (!elements.root) return;

    Object.assign(elements, {
      nameInput: document.getElementById('automation-workflow-name'),
      descriptionInput: document.getElementById('automation-workflow-description'),
      agentSelect: document.getElementById('automation-workflow-agent'),
      saveButton: document.getElementById('automation-workflow-save'),
      runButton: document.getElementById('automation-workflow-run'),
      resetButton: document.getElementById('automation-workflow-reset'),
      stopButton: document.getElementById('automation-workflow-stop'),
      groupSelect: document.getElementById('automation-workflow-group'),
      groupRefreshButton: document.getElementById('automation-group-refresh'),
      groupCreateToggle: document.getElementById('automation-group-create-toggle'),
      groupCreatePanel: document.getElementById('automation-group-create-panel'),
      groupCreateCancel: document.getElementById('automation-group-create-cancel'),
      groupSaveButton: document.getElementById('automation-group-save'),
      groupNameInput: document.getElementById('automation-group-name'),
      groupDescriptionInput: document.getElementById('automation-group-description'),
      groupProfileSearch: document.getElementById('automation-group-profile-search'),
      groupProfileList: document.getElementById('automation-group-profile-list'),
      profileSearch: document.getElementById('automation-workflow-profile-search'),
      profileList: document.getElementById('automation-workflow-profile-list'),
      manualNames: document.getElementById('automation-workflow-manual-names'),
      targetSummary: document.getElementById('automation-workflow-target-summary'),
      status: document.getElementById('automation-workflow-status'),
      stepsContainer: document.getElementById('automation-workflow-steps-container'),
      addStepButton: document.getElementById('automation-workflow-add-step'),
      library: document.getElementById('automation-workflow-library'),
      headless: document.getElementById('automation-workflow-headless')
    });

    bindTargetTabs();
    bindToolbarActions();
    bindGroupActions();
    bindStepBuilderActions();
    bindLibraryActions();
    bindWorkflowRunnerEvents();

    state.workflows = await loadStoredWorkflows();

    await loadGroups();
    await loadProfiles();
    await loadAgents();
    state.groups = normalizeGroupsWithProfiles(state.groups);

    populateGroupOptions();
    populateAgentOptions();
    renderProfileList();
    renderGroupProfileList();
    resetBuilder({ keepStatus: true });
    renderWorkflowLibrary();
    updateTargetSummary();
  }

  function bindTargetTabs() {
    elements.root.querySelectorAll('.automation-target-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-target-mode');
        state.activeTargetMode = mode;
        elements.root.querySelectorAll('.automation-target-tab').forEach((item) => {
          item.classList.toggle('active', item === tab);
        });
        elements.root.querySelectorAll('.automation-target-content').forEach((panel) => {
          panel.classList.toggle('active', panel.id === `automation-target-${mode}`);
        });
        updateTargetSummary();
      });
    });

    elements.groupSelect?.addEventListener('change', updateTargetSummary);
    elements.agentSelect?.addEventListener('change', updateTargetSummary);
    elements.agentSelect?.addEventListener('change', () => syncWorkflowStepTemplates());
    elements.manualNames?.addEventListener('input', updateTargetSummary);
    elements.profileSearch?.addEventListener('input', () => renderProfileList(elements.profileSearch.value));
    elements.groupProfileSearch?.addEventListener('input', () => renderGroupProfileList(elements.groupProfileSearch.value));
  }

  function bindToolbarActions() {
    elements.saveButton?.addEventListener('click', async () => {
      await handleSaveWorkflow();
    });
    elements.runButton?.addEventListener('click', async () => {
      await handleRunWorkflow();
    });
    elements.resetButton?.addEventListener('click', () => resetBuilder());
    elements.stopButton?.addEventListener('click', () => {
      window.electronAPI?.send?.('stop-group-workflow', {
        accountId: window.LinkedInAccountContext?.getActiveAccountId?.() || null
      });
      setStatus('Stopping workflow...');
    });
  }

  function bindGroupActions() {
    elements.groupRefreshButton?.addEventListener('click', async () => {
      const selectedGroupId = elements.groupSelect?.value || '';
      await loadGroups();
      populateGroupOptions(selectedGroupId);
      updateTargetSummary();
      setStatus(state.groups.length ? 'Groups refreshed.' : 'No groups found yet.');
    });

    elements.groupCreateToggle?.addEventListener('click', () => {
      toggleGroupCreatePanel(!elements.groupCreatePanel?.classList.contains('is-open'));
    });

    elements.groupCreateCancel?.addEventListener('click', () => {
      toggleGroupCreatePanel(false);
    });

    elements.groupSaveButton?.addEventListener('click', handleSaveGroup);
  }

  function bindStepBuilderActions() {
    elements.root.querySelectorAll('.automation-step-library-item').forEach((button) => {
      button.addEventListener('click', () => {
        appendStep(button.getAttribute('data-step-type'));
      });
    });

    elements.addStepButton?.addEventListener('click', () => {
      appendStep('view_profile');
    });
  }

  function bindLibraryActions() {
    elements.library?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-workflow-action]');
      if (!button) return;

      const workflowId = button.getAttribute('data-workflow-id');
      const workflow = state.workflows.find((item) => item.id === workflowId);
      if (!workflow) return;

      const action = button.getAttribute('data-workflow-action');
      if (action === 'open') {
        loadWorkflowIntoBuilder(workflow);
      } else if (action === 'copy') {
        await duplicateWorkflow(workflow);
      } else if (action === 'run') {
        await runWorkflow(workflow);
      } else if (action === 'delete') {
        await deleteWorkflow(workflowId);
      }
    });
  }

  const OUTCOME_LABELS = {
    completed: 'Completed',
    skipped_already_connected: 'Skipped — already connected',
    skipped_invite_pending: 'Skipped — invite already pending',
    skipped_not_connected: 'Skipped — not connected (can\'t DM without connection)',
    skipped_no_post: 'Skipped — no recent posts to like',
    skipped_thread_exists: 'Skipped — recent message already exists',
    skipped_quota_exceeded: 'Skipped — daily quota reached',
    skipped_do_not_contact: 'Skipped — do not contact',
    skipped_outside_working_hours: 'Skipped — outside working hours',
    skipped_budget_exceeded: 'Skipped — daily activity budget reached',
    skipped_managed_elsewhere: 'Skipped — managed by another workflow',
    skipped_transport_unhealthy: 'Skipped — transport unhealthy',
    skipped_already_following: 'Skipped — already following',
    skipped_no_endorseable_skills: 'Skipped — no endorseable skills found',
    skipped_already_endorsed: 'Skipped — already endorsed',
    skipped_comment_unavailable: 'Skipped — no commentable post found',
    skipped_not_following: 'Skipped — not following this profile',
    failed_transient: 'Failed — will retry',
    failed_permanent: 'Failed — permanent error'
  };

  function bindWorkflowRunnerEvents() {
    if (!window.electronAPI?.on) return;

    window.electronAPI.on('workflow-log', (entry) => {
      if (!state.runningWorkflowId || !entry?.message) return;
      setStatus(entry.message);
    });

    window.electronAPI.on('workflow-done', ({ code }) => {
      // Only act as fallback — if sdr-workflow-runs-updated already cleared
      // runningWorkflowId with a richer summary, this is a no-op.
      if (!state.runningWorkflowId) return;
      // Give sdr-workflow-runs-updated 2s to arrive with per-step details.
      // If it doesn't, fall back to the generic message.
      setTimeout(() => {
        if (!state.runningWorkflowId) return;  // runs-updated already handled it
        state.runningWorkflowId = null;
        if (elements.stopButton) elements.stopButton.disabled = true;
        setStatus(code === 0 ? 'Workflow completed.' : `Workflow stopped (code ${code}).`);
      }, 2000);
    });

    window.electronAPI.on('sdr-workflow-runs-updated', (runs) => {
      if (!state.runningWorkflowId) return;
      if (!Array.isArray(runs)) return;

      const activeRun = runs.find((r) =>
        r.workflowId === state.runningWorkflowId || r.name === state.runningWorkflowId
      );
      if (!activeRun) return;

      const status = activeRun.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        state.runningWorkflowId = null;
        if (elements.stopButton) elements.stopButton.disabled = true;

        const summary = buildRunSummary(activeRun);
        setStatus(summary);
        renderWorkflowLibrary();
      }
    });

    document.addEventListener('sdr-agents-changed', (event) => {
      state.agents = Array.isArray(event.detail?.agents) ? event.detail.agents : [];
      populateAgentOptions(elements.agentSelect?.value || '');
      syncWorkflowStepTemplates();
      updateTargetSummary();
    });

    document.addEventListener('connect-ability:active-linkedin-account-changed', async () => {
      state.selectedProfiles = new Set();
      state.groupDraftProfiles = new Set();
      await loadProfiles();
      await loadAgents();
      state.groups = normalizeGroupsWithProfiles(state.groups);
      populateAgentOptions(elements.agentSelect?.value || '');
      renderProfileList(elements.profileSearch?.value || '');
      renderGroupProfileList(elements.groupProfileSearch?.value || '');
      updateTargetSummary();
    });
  }

  function buildRunSummary(run) {
    if (!run) return 'Workflow finished.';

    const statusLabel = run.status === 'completed' ? '✓ Workflow completed'
      : run.status === 'failed' ? '✗ Workflow failed'
      : run.status === 'cancelled' ? '⊘ Workflow cancelled'
      : 'Workflow finished';

    const targets = Array.isArray(run.targets) ? run.targets : [];
    const jobs = Array.isArray(run.jobs) ? run.jobs : [];

    if (!targets.length && !jobs.length) return `${statusLabel}.`;

    const stepResults = [];
    for (const job of jobs) {
      if (!job.result) continue;
      const outcome = job.result.outcomeType || 'completed';
      const step = job.stepType || job.type || '?';
      const target = job.result.recipientName || job.targetLabel || '';
      const label = OUTCOME_LABELS[outcome] || outcome;
      stepResults.push(`${step}${target ? ' → ' + target : ''}: ${label}`);
    }

    if (!stepResults.length) return `${statusLabel}.`;
    return `${statusLabel}. ${stepResults.join(' · ')}`;
  }

  function getSelectedAgent() {
    const agentId = String(elements.agentSelect?.value || '').trim();
    return state.agents.find((agent) => String(agent.id) === agentId) || null;
  }

  async function loadGroups() {
    let backendGroups = [];
    try {
      if (window.electronAPI?.getGroupsData) {
        const result = await window.electronAPI.getGroupsData();
        if (Array.isArray(result)) {
          backendGroups = result;
        }
      }
    } catch (error) {
      console.warn('Failed to load groups from backend:', error.message);
    }

    state.groups = normalizeGroupsWithProfiles(mergeGroups(backendGroups, loadLocalGroups()));
  }

  async function loadProfiles() {
    try {
      const result = await window.electronAPI.getAllProfiles();
      state.profiles = Array.isArray(result) ? result : [];
    } catch (error) {
      console.warn('Failed to load profiles:', error.message);
      state.profiles = [];
    }
  }

  async function loadAgents() {
    try {
      const result = await window.electronAPI?.getSdrAgents?.();
      state.agents = Array.isArray(result) ? result : [];
    } catch (error) {
      console.warn('Failed to load SDR agents:', error.message);
      state.agents = [];
    }
  }

  function populateGroupOptions(selectedGroupId = elements.groupSelect?.value || '') {
    if (!elements.groupSelect) return;

    elements.groupSelect.innerHTML = '<option value="">Choose a group...</option>';
    state.groups.forEach((group) => {
      const option = document.createElement('option');
      option.value = String(group.id);
      option.textContent = `${group.name} (${(group.members || []).length} members)`;
      elements.groupSelect.appendChild(option);
    });

    if (selectedGroupId && state.groups.some((group) => String(group.id) === String(selectedGroupId))) {
      elements.groupSelect.value = String(selectedGroupId);
    }
  }

  function populateAgentOptions(selectedAgentId = elements.agentSelect?.value || '') {
    if (!elements.agentSelect) return;

    elements.agentSelect.innerHTML = '<option value="">No SDR agent assigned</option>';
    state.agents.forEach((agent) => {
      const option = document.createElement('option');
      option.value = String(agent.id);
      option.textContent = `${agent.name}${agent.accountName ? ` (${agent.accountName})` : ''}`;
      elements.agentSelect.appendChild(option);
    });

    if (selectedAgentId && state.agents.some((agent) => String(agent.id) === String(selectedAgentId))) {
      elements.agentSelect.value = String(selectedAgentId);
    }
  }

  function renderProfileList(filterText = '') {
    if (!elements.profileList) return;

    const query = String(filterText || '').trim().toLowerCase();
    const filteredProfiles = state.profiles.filter((profile) => {
      const target = getProfileWorkflowTarget(profile);
      return target && profileMatchesQuery(profile, query);
    });

    if (!filteredProfiles.length) {
      elements.profileList.innerHTML = '<div class="hint-text">No stored profiles with LinkedIn URLs match your search.</div>';
      return;
    }

    elements.profileList.innerHTML = filteredProfiles.map((profile) => {
      const url = getProfileWorkflowTarget(profile);
      const selected = state.selectedProfiles.has(url);
      const name = escapeHtml(getProfileDisplayName(profile, url));
      const meta = escapeHtml(getProfileMeta(profile));
      return `
        <label class="automation-profile-item ${selected ? 'is-selected' : ''}" data-profile-url="${escapeHtml(url)}">
          <input type="checkbox" class="automation-profile-checkbox" data-profile-url="${escapeHtml(url)}" ${selected ? 'checked' : ''}>
          <div>
            <div class="automation-profile-name">${name}</div>
            <div class="automation-profile-meta">${meta}</div>
          </div>
        </label>
      `;
    }).join('');

    elements.profileList.querySelectorAll('.automation-profile-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const url = checkbox.getAttribute('data-profile-url');
        if (checkbox.checked) {
          state.selectedProfiles.add(url);
        } else {
          state.selectedProfiles.delete(url);
        }
        checkbox.closest('.automation-profile-item')?.classList.toggle('is-selected', checkbox.checked);
        updateTargetSummary();
      });
    });
  }

  function renderGroupProfileList(filterText = '') {
    if (!elements.groupProfileList) return;

    const query = String(filterText || '').trim().toLowerCase();
    const filteredProfiles = state.profiles.filter((profile) => {
      const target = getProfileWorkflowTarget(profile);
      return target && profileMatchesQuery(profile, query);
    });

    if (!filteredProfiles.length) {
      elements.groupProfileList.innerHTML = '<div class="hint-text">No stored profiles with LinkedIn URLs are available to add.</div>';
      return;
    }

    elements.groupProfileList.innerHTML = filteredProfiles.map((profile) => {
      const target = getProfileWorkflowTarget(profile);
      const selected = state.groupDraftProfiles.has(target);
      const name = escapeHtml(getProfileDisplayName(profile, target));
      const meta = escapeHtml(getProfileMeta(profile));
      return `
        <label class="automation-profile-item ${selected ? 'is-selected' : ''}" data-group-profile-target="${escapeHtml(target)}">
          <input type="checkbox" class="automation-profile-checkbox" data-group-profile-target="${escapeHtml(target)}" ${selected ? 'checked' : ''}>
          <div>
            <div class="automation-profile-name">${name}</div>
            <div class="automation-profile-meta">${meta}</div>
          </div>
        </label>
      `;
    }).join('');

    elements.groupProfileList.querySelectorAll('.automation-profile-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const target = checkbox.getAttribute('data-group-profile-target');
        if (checkbox.checked) {
          state.groupDraftProfiles.add(target);
        } else {
          state.groupDraftProfiles.delete(target);
        }
        checkbox.closest('.automation-profile-item')?.classList.toggle('is-selected', checkbox.checked);
      });
    });
  }

  function toggleGroupCreatePanel(isOpen) {
    if (!elements.groupCreatePanel) return;

    const open = !!isOpen;
    elements.groupCreatePanel.classList.toggle('is-open', open);
    if (elements.groupCreateToggle) {
      elements.groupCreateToggle.textContent = open ? 'Close' : 'New Group';
    }

    if (open) {
      renderGroupProfileList(elements.groupProfileSearch?.value || '');
      elements.groupNameInput?.focus();
      return;
    }

    resetGroupDraft();
  }

  function resetGroupDraft() {
    state.groupDraftProfiles.clear();
    if (elements.groupNameInput) elements.groupNameInput.value = '';
    if (elements.groupDescriptionInput) elements.groupDescriptionInput.value = '';
    if (elements.groupProfileSearch) elements.groupProfileSearch.value = '';
    renderGroupProfileList();
  }

  async function handleSaveGroup() {
    const name = String(elements.groupNameInput?.value || '').trim();
    if (!name) {
      setStatus('Enter a name for the new group.');
      elements.groupNameInput?.focus();
      return;
    }

    const now = new Date().toISOString();
    const group = normalizeGroup({
      id: `group-${Date.now()}`,
      name,
      description: String(elements.groupDescriptionInput?.value || '').trim(),
      members: Array.from(state.groupDraftProfiles),
      color: '#0a66c2',
      createdAt: now,
      updatedAt: now
    });

    const mergedGroups = mergeGroups(state.groups, [group]);
    const persisted = await persistGroups(mergedGroups);
    state.groups = mergedGroups;
    populateGroupOptions(group.id);
    if (elements.groupSelect) {
      elements.groupSelect.value = String(group.id);
    }
    setTargetMode('group');
    updateTargetSummary();
    toggleGroupCreatePanel(false);
    setStatus(
      persisted
        ? `Saved group "${group.name}" with ${(group.members || []).length} member${group.members?.length === 1 ? '' : 's'}.`
        : `Saved group "${group.name}" locally, but backend file sync failed.`
    );
  }

  function loadLocalGroups() {
    try {
      const localGroups = JSON.parse(localStorage.getItem(GROUPS_STORAGE_KEY) || '[]');
      return Array.isArray(localGroups) ? localGroups : [];
    } catch (error) {
      console.warn('Failed to parse local groups:', error.message);
      return [];
    }
  }

  function mergeGroups(...groupSets) {
    const merged = new Map();

    groupSets.flat().forEach((rawGroup) => {
      const normalized = normalizeGroup(rawGroup);
      if (!normalized) return;
      merged.set(String(normalized.id), normalized);
    });

    return Array.from(merged.values()).sort((left, right) => {
      return String(left.name || '').localeCompare(String(right.name || ''));
    });
  }

  function normalizeGroup(group) {
    if (!group || typeof group !== 'object') return null;

    const name = String(group.name || '').trim();
    const id = String(group.id || name || `group-${Date.now()}`);
    return {
      ...group,
      id,
      name: name || 'Untitled Group',
      description: String(group.description || '').trim(),
      members: Array.isArray(group.members) ? group.members.map(normalizeGroupMember).filter(Boolean) : [],
      updatedAt: group.updatedAt || group.createdAt || new Date().toISOString()
    };
  }

  function normalizeGroupMember(member) {
    if (typeof member === 'string') {
      return member.trim();
    }

    if (member && typeof member === 'object') {
      return resolveStoredProfileTarget(getProfileWorkflowTarget(member) || String(member.id || '').trim());
    }

    return '';
  }

  function normalizeGroupsWithProfiles(groups) {
    return mergeGroups((groups || []).map((group) => ({
      ...group,
      members: Array.isArray(group?.members)
        ? group.members.map(resolveStoredProfileTarget).filter(Boolean)
        : []
    })));
  }

  async function persistGroups(groups) {
    const normalizedGroups = normalizeGroupsWithProfiles(groups);
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(normalizedGroups));

    if (!window.electronAPI?.saveGroupsData) {
      return true;
    }

    try {
      return await window.electronAPI.saveGroupsData(normalizedGroups);
    } catch (error) {
      console.warn('Failed to persist groups to backend:', error.message);
      return false;
    }
  }

  function profileMatchesQuery(profile, query) {
    if (!query) return true;

    return [
      `${profile.firstName || ''} ${profile.lastName || ''}`.trim(),
      profile.title || '',
      profile.company || ''
    ].join(' ').toLowerCase().includes(query);
  }

  function getProfileWorkflowTarget(profile) {
    const directUrl = String(profile?.url || profile?.profileUrl || '').trim();
    if (directUrl) return directUrl;
    return '';
  }

  function resolveStoredProfileTarget(member) {
    const normalized = String(member || '').trim();
    if (!normalized) return '';
    if (/linkedin\.com\/in\//i.test(normalized)) {
      return normalized;
    }

    const matchingProfile = state.profiles.find((profile) => {
      const url = String(profile?.url || '').trim();
      const profileUrl = String(profile?.profileUrl || '').trim();
      const profileId = String(profile?.id || '').trim();
      return [url, profileUrl, profileId].includes(normalized);
    });

    return getProfileWorkflowTarget(matchingProfile) || normalized;
  }

  function getProfileDisplayName(profile, fallback = '') {
    return `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || fallback || 'Stored profile';
  }

  function getProfileMeta(profile) {
    return [profile.title || '', profile.company || ''].filter(Boolean).join(' at ') || 'Stored profile';
  }

  function markStepTemplateInputTouched(input) {
    if (!input) return;
    input.dataset.agentTemplateTouched = 'true';
    input.dataset.agentTemplateManaged = 'false';
    input.dataset.agentTemplateSlot = '';
    input.dataset.agentTemplateAgentId = '';
  }

  function initializeStepTemplateInputState(row, initial = {}) {
    const input = row?.querySelector('.step-message-template');
    if (!input) return;

    const preserveMessageTemplate = initial.preserveMessageTemplate === true;
    input.dataset.agentTemplateTouched = preserveMessageTemplate ? 'true' : 'false';
    input.dataset.agentTemplateManaged = 'false';
    input.dataset.agentTemplateSlot = '';
    input.dataset.agentTemplateAgentId = '';
  }

  function countStepOccurrencesBefore(row, stepType) {
    const rows = Array.from(elements.stepsContainer?.querySelectorAll('.step-item') || []);
    let count = 0;
    for (const candidate of rows) {
      if (candidate.querySelector('.step-type-select')?.value === stepType) {
        count += 1;
      }
      if (candidate === row) {
        return count;
      }
    }
    return count || 1;
  }

  function applyAgentTemplateToRow(row, options = {}) {
    const input = row?.querySelector('.step-message-template');
    const type = row?.querySelector('.step-type-select')?.value || '';
    if (!input || !type) return false;

    if (type !== 'send_connection' && type !== 'send_dm') {
      input.dataset.agentTemplateManaged = 'false';
      input.dataset.agentTemplateSlot = '';
      input.dataset.agentTemplateAgentId = '';
      return false;
    }

    const agent = getSelectedAgent();
    if (!agent || !window.AgentMessageDefaults?.resolveAgentStepTemplate) {
      input.dataset.agentTemplateManaged = 'false';
      input.dataset.agentTemplateSlot = '';
      input.dataset.agentTemplateAgentId = '';
      return false;
    }

    const occurrence = type === 'send_dm' ? countStepOccurrencesBefore(row, 'send_dm') : 1;
    const templateInfo = window.AgentMessageDefaults.resolveAgentStepTemplate(agent, type, { occurrence });
    const wasManaged = input.dataset.agentTemplateManaged === 'true';
    const wasTouched = input.dataset.agentTemplateTouched === 'true';

    if (!options.force && wasTouched && !wasManaged) {
      return false;
    }

    if (!templateInfo?.template) {
      if (wasManaged && options.clearManaged !== false) {
        input.value = '';
      }
      input.dataset.agentTemplateManaged = 'false';
      input.dataset.agentTemplateSlot = '';
      input.dataset.agentTemplateAgentId = '';
      return false;
    }

    input.value = templateInfo.template;
    input.dataset.agentTemplateTouched = 'false';
    input.dataset.agentTemplateManaged = 'true';
    input.dataset.agentTemplateSlot = templateInfo.slot || '';
    input.dataset.agentTemplateAgentId = agent.id || '';
    return true;
  }

  function syncWorkflowStepTemplates(options = {}) {
    const rows = Array.from(elements.stepsContainer?.querySelectorAll('.step-item') || []);
    rows.forEach((row) => applyAgentTemplateToRow(row, options));
  }

  function attachStepTemplateBehavior(row) {
    const input = row?.querySelector('.step-message-template');
    const typeSelect = row?.querySelector('.step-type-select');
    const removeButton = row?.querySelector('.step-remove-btn');

    input?.addEventListener('input', () => {
      markStepTemplateInputTouched(input);
    });

    typeSelect?.addEventListener('change', () => {
      syncWorkflowStepTemplates();
    });

    removeButton?.addEventListener('click', () => {
      window.setTimeout(() => syncWorkflowStepTemplates(), 0);
    });
  }

  function appendStep(type, initial = {}) {
    const container = elements.stepsContainer;
    if (!container || !window.AutomationStepBuilder) return null;

    const empty = container.querySelector('.empty-steps');
    if (empty) empty.remove();

    const row = window.AutomationStepBuilder.addStepRow({
      type,
      ...initial
    }, container);

    if (row) {
      initializeStepTemplateInputState(row, initial);
      attachStepTemplateBehavior(row);
      const select = row.querySelector('.step-type-select');
      if (select) {
        select.value = type;
        select.dispatchEvent(new Event('change'));
      }
      syncWorkflowStepTemplates();
    }
    return row;
  }

  function clearSteps() {
    if (!elements.stepsContainer) return;
    elements.stepsContainer.innerHTML = '<div class="empty-steps">Use the action library to add your first step.</div>';
  }

  function resetBuilder(options = {}) {
    const keepStatus = !!options.keepStatus;
    state.editingWorkflowId = null;
    elements.nameInput.value = '';
    elements.descriptionInput.value = '';
    if (elements.agentSelect) elements.agentSelect.value = '';
    elements.groupSelect.value = '';
    elements.manualNames.value = '';
    elements.headless.checked = false;
    state.selectedProfiles.clear();
    state.groupDraftProfiles.clear();
    if (elements.profileSearch) elements.profileSearch.value = '';
    if (elements.groupProfileSearch) elements.groupProfileSearch.value = '';
    renderProfileList();
    renderGroupProfileList();
    clearSteps();
    appendStep('view_profile');
    if (elements.stopButton) elements.stopButton.disabled = true;
    setTargetMode('group');
    toggleGroupCreatePanel(false);
    renderWorkflowLibrary();
    updateTargetSummary();
    if (!keepStatus) {
      setStatus('Draft workflow. Select targets, add steps, then save or run it.');
    }
  }

  function setTargetMode(mode) {
    state.activeTargetMode = mode;
    elements.root.querySelectorAll('.automation-target-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-target-mode') === mode);
    });
    elements.root.querySelectorAll('.automation-target-content').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `automation-target-${mode}`);
    });
  }

  function updateTargetSummary() {
    if (!elements.targetSummary) return;

    const target = collectTarget();
    if (!target) {
      elements.targetSummary.textContent = 'No target selected yet.';
      return;
    }

    if (target.type === 'group') {
      elements.targetSummary.textContent = formatTargetSummary(`Group target: ${target.label} • ${(target.members || []).length} members`);
      return;
    }

    if (target.type === 'profiles') {
      elements.targetSummary.textContent = formatTargetSummary(`${target.profileUrls.length} stored profile${target.profileUrls.length === 1 ? '' : 's'} selected`);
      return;
    }

    if (target.type === 'manual') {
      elements.targetSummary.textContent = formatTargetSummary(`${target.names.length} manual name${target.names.length === 1 ? '' : 's'} ready for lookup`);
      return;
    }

    elements.targetSummary.textContent = 'No target selected yet.';
  }

  function formatTargetSummary(summary) {
    const agentId = String(elements.agentSelect?.value || '').trim();
    const agent = state.agents.find((entry) => String(entry.id) === agentId);
    return agent ? `${summary} • Agent: ${agent.name}` : summary;
  }

  function collectTarget() {
    if (state.activeTargetMode === 'group') {
      const selectedGroup = state.groups.find((group) => String(group.id) === String(elements.groupSelect.value));
      if (!selectedGroup) return null;
      return {
        type: 'group',
        groupId: String(selectedGroup.id),
        label: selectedGroup.name || 'Unnamed Group',
        members: Array.isArray(selectedGroup.members) ? selectedGroup.members : []
      };
    }

    if (state.activeTargetMode === 'profiles') {
      const profileUrls = Array.from(state.selectedProfiles).filter(Boolean);
      if (!profileUrls.length) return null;
      return {
        type: 'profiles',
        label: `${profileUrls.length} stored profile${profileUrls.length === 1 ? '' : 's'}`,
        profileUrls
      };
    }

    if (state.activeTargetMode === 'manual') {
      const names = parseNameList(elements.manualNames.value);
      if (!names.length) return null;
      return {
        type: 'manual',
        label: `${names.length} manual name${names.length === 1 ? '' : 's'}`,
        names
      };
    }

    return null;
  }

  function serializeSteps() {
    const rows = Array.from(elements.stepsContainer?.querySelectorAll('.step-item') || []);
    const delayUnitMsMap = {
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
      months: 30 * 24 * 60 * 60 * 1000
    };

    return rows.map((row, index) => {
      const type = row.querySelector('.step-type-select')?.value;
      const delayValueRaw = parseInt(row.querySelector('.step-delay-value')?.value || '1', 10);
      const delayValue = Math.max(1, Number.isFinite(delayValueRaw) ? delayValueRaw : 1);
      const delayUnit = row.querySelector('.step-delay-unit')?.value || 'hours';
      const delayMs = delayValue * (delayUnitMsMap[delayUnit] || delayUnitMsMap.hours);
      const messageTemplate = String(row.querySelector('.step-message-template')?.value || '').trim();

      return {
        order: index + 1,
        type,
        delayValue,
        delayUnit,
        minDelayMs: type === 'delay' ? delayMs : DEFAULT_STEP_DELAY.minDelayMs,
        maxDelayMs: type === 'delay' ? delayMs : DEFAULT_STEP_DELAY.maxDelayMs,
        messageTemplate: type === 'send_connection' || type === 'send_dm' ? messageTemplate : ''
      };
    }).filter((step) => step.type);
  }

  function buildWorkflowFromBuilder() {
    const target = collectTarget();
    const steps = serializeSteps();
    const now = new Date().toISOString();
    const existingWorkflow = state.workflows.find((workflow) => workflow.id === state.editingWorkflowId);

    if (!target) {
      setStatus('Select a group, stored profiles, or manual names before saving.');
      return null;
    }

    if (!steps.length) {
      setStatus('Add at least one workflow step before saving.');
      return null;
    }

    return {
      id: existingWorkflow?.id || `wf_${Date.now()}`,
      name: String(elements.nameInput.value || '').trim() || buildDefaultWorkflowName(target),
      description: String(elements.descriptionInput.value || '').trim(),
      agentId: String(elements.agentSelect?.value || '').trim() || null,
      target,
      steps,
      headless: !!elements.headless.checked,
      createdAt: existingWorkflow?.createdAt || now,
      updatedAt: now,
      lastRunAt: existingWorkflow?.lastRunAt || null
    };
  }

  async function handleSaveWorkflow() {
    const workflow = buildWorkflowFromBuilder();
    if (!workflow) return;

    const savedWorkflow = await persistWorkflow(workflow);
    if (!savedWorkflow) {
      setStatus(`Failed to save workflow "${workflow.name}".`);
      return;
    }

    state.editingWorkflowId = savedWorkflow.id;
    renderWorkflowLibrary();
    setStatus(`Saved workflow "${savedWorkflow.name}".`);
    elements.nameInput.value = savedWorkflow.name;
  }

  async function handleRunWorkflow() {
    const workflow = buildWorkflowFromBuilder();
    if (!workflow) return;

    const savedWorkflow = await persistWorkflow(workflow);
    if (!savedWorkflow) {
      setStatus(`Failed to save workflow "${workflow.name}" before running it.`);
      return;
    }

    state.editingWorkflowId = savedWorkflow.id;
    renderWorkflowLibrary();
    await runWorkflow(savedWorkflow);
  }

  async function runWorkflow(workflow) {
    const payload = buildWorkflowPayload(workflow);
    if (!payload) return;

    try {
      state.runningWorkflowId = workflow.id;
      if (elements.stopButton) elements.stopButton.disabled = false;
      setStatus(`Starting "${workflow.name}"...`);
      const started = await window.electronAPI.runGroupWorkflow(payload);
      if (!started) {
        state.runningWorkflowId = null;
        if (elements.stopButton) elements.stopButton.disabled = true;
        setStatus(`Could not start "${workflow.name}".`);
        return;
      }

      const savedWorkflow = await persistWorkflow({
        ...workflow,
        lastRunAt: new Date().toISOString()
      });
      if (savedWorkflow) {
        workflow.lastRunAt = savedWorkflow.lastRunAt;
        workflow.status = savedWorkflow.status;
      }
      renderWorkflowLibrary();
      setStatus(`Running "${workflow.name}" on ${workflow.target.label}.`);
    } catch (error) {
      state.runningWorkflowId = null;
      if (elements.stopButton) elements.stopButton.disabled = true;
      setStatus(`Failed to start workflow: ${error.message}`);
    }
  }

  function buildWorkflowPayload(workflow) {
    const activeAccountId = window.LinkedInAccountContext?.getActiveAccountId?.() || null;
    const selectedAgent = state.agents.find((agent) => agent.id === workflow.agentId) || null;
    const resolvedAccountId = selectedAgent?.accountId || activeAccountId;
    const base = {
      steps: workflow.steps,
      browserProfile: 'random',
      headless: !!workflow.headless,
      slowMo: 100,
      workflowId: workflow.id,
      workflowName: workflow.name,
      targetType: workflow.target.type,
      accountId: resolvedAccountId,
      agentId: workflow.agentId || null
    };

    if (workflow.target.type === 'group') {
      return {
        ...base,
        groupId: workflow.target.groupId,
        groupName: workflow.target.label,
        groupMembers: Array.isArray(workflow.target.members) ? workflow.target.members : []
      };
    }

    if (workflow.target.type === 'profiles') {
      return {
        ...base,
        groupMembers: workflow.target.profileUrls,
        groupName: workflow.target.label
      };
    }

    if (workflow.target.type === 'manual') {
      return {
        ...base,
        groupMembers: workflow.target.names,
        groupName: workflow.target.label
      };
    }

    setStatus('Select a valid target before running the workflow.');
    return null;
  }

  function loadWorkflowIntoBuilder(workflow) {
    state.editingWorkflowId = workflow.id;
    elements.nameInput.value = workflow.name || '';
    elements.descriptionInput.value = workflow.description || '';
    populateAgentOptions(workflow.agentId || '');
    elements.headless.checked = !!workflow.headless;
    clearSteps();

    workflow.steps.forEach((step) => {
      appendStep(step.type, {
        ...step,
        preserveMessageTemplate: true
      });
    });

    if (!workflow.steps.length) {
      appendStep('view_profile');
    }

    if (workflow.target?.type === 'group') {
      setTargetMode('group');
      elements.groupSelect.value = String(workflow.target.groupId || '');
      state.selectedProfiles.clear();
      elements.manualNames.value = '';
    } else if (workflow.target?.type === 'profiles') {
      setTargetMode('profiles');
      elements.groupSelect.value = '';
      elements.manualNames.value = '';
      state.selectedProfiles = new Set(workflow.target.profileUrls || []);
    } else if (workflow.target?.type === 'manual') {
      setTargetMode('manual');
      elements.groupSelect.value = '';
      state.selectedProfiles.clear();
      elements.manualNames.value = (workflow.target.names || []).join('\n');
    }

    renderProfileList(elements.profileSearch?.value || '');
    renderWorkflowLibrary();
    updateTargetSummary();
    setStatus(`Opened "${workflow.name}" for editing.`);
    elements.nameInput.focus();
  }

  async function duplicateWorkflow(workflow) {
    const copy = {
      ...workflow,
      id: `wf_${Date.now()}`,
      name: `${workflow.name} (Copy)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRunAt: null,
      agentId: workflow.agentId || null,
      target: clone(workflow.target),
      steps: workflow.steps.map((step) => ({ ...step }))
    };
    const savedCopy = await persistWorkflow(copy);
    if (!savedCopy) {
      setStatus(`Failed to copy workflow "${workflow.name}".`);
      return;
    }
    renderWorkflowLibrary();
    setStatus(`Copied workflow "${workflow.name}".`);
  }

  async function deleteWorkflow(workflowId) {
    const workflow = state.workflows.find((item) => item.id === workflowId);
    if (!workflow) return;
    if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return;

    const removed = await removePersistedWorkflow(workflowId);
    if (!removed) {
      setStatus(`Failed to delete workflow "${workflow.name}".`);
      return;
    }
    if (state.editingWorkflowId === workflowId) {
      resetBuilder({ keepStatus: true });
    }
    renderWorkflowLibrary();
    setStatus(`Deleted workflow "${workflow.name}".`);
  }

  function renderWorkflowLibrary() {
    if (!elements.library) return;

    if (!state.workflows.length) {
      elements.library.innerHTML = '<div class="wf-empty-library">No saved workflows yet. Save a workflow to reuse it.</div>';
      return;
    }

    const stepLabels = window.AutomationStepBuilder?.STEP_LABELS || {};
    elements.library.innerHTML = state.workflows.map((workflow) => {
      const isEditing = workflow.id === state.editingWorkflowId;
      const targetLabel = workflow.target?.label || 'No target';
      const updatedAt = formatDateTime(workflow.updatedAt);
      const lastRunAt = workflow.lastRunAt ? formatDateTime(workflow.lastRunAt) : 'Never';

      const stepPreview = workflow.steps.slice(0, 4).map((step) => {
        const label = stepLabels[step.type] || step.type;
        const suffix = step.type === 'delay' ? ` ${step.delayValue}${(step.delayUnit || 'h')[0]}` : '';
        return `<span style="font-size:9px;padding:2px 6px;background:var(--surface-container-high);border-radius:var(--radius-full);font-weight:700;text-transform:uppercase;color:var(--on-surface-variant)">${escapeHtml(label + suffix)}</span>`;
      }).join('');

      return `
        <div class="automation-workflow-record" style="padding:12px;background:var(--surface-container-lowest);border:1px solid rgba(193,198,212,0.1);border-radius:var(--radius-md);margin-bottom:8px;${isEditing ? 'border-color:var(--primary);box-shadow:0 0 0 2px rgba(0,78,153,0.08);' : ''}">
          <div style="font-size:12px;font-weight:700;margin-bottom:4px">${escapeHtml(workflow.name)}</div>
          <div style="font-size:10px;color:var(--on-surface-variant);margin-bottom:6px">${escapeHtml(targetLabel)} &middot; ${escapeHtml(updatedAt)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">${stepPreview}</div>
          <div style="display:flex;gap:4px">
            <button type="button" class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 8px" data-workflow-action="open" data-workflow-id="${workflow.id}">Edit</button>
            <button type="button" class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 8px" data-workflow-action="copy" data-workflow-id="${workflow.id}">Copy</button>
            <button type="button" class="btn btn-primary btn-sm" style="font-size:10px;padding:2px 8px" data-workflow-action="run" data-workflow-id="${workflow.id}">Run</button>
            <button type="button" class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 8px;color:var(--error)" data-workflow-action="delete" data-workflow-id="${workflow.id}">Del</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function buildDefaultWorkflowName(target) {
    if (!target) return 'New Workflow';
    if (target.type === 'group') return `${target.label} Workflow`;
    if (target.type === 'profiles') return `Profile Workflow (${target.profileUrls.length})`;
    if (target.type === 'manual') return `Manual Name Workflow (${target.names.length})`;
    return 'New Workflow';
  }

  async function loadStoredWorkflows() {
    const backendWorkflows = await loadBackendWorkflows();
    const legacyWorkflows = loadLegacyStoredWorkflows();

    if (backendWorkflows.length && !legacyWorkflows.length) {
      return backendWorkflows;
    }

    if (!legacyWorkflows.length) {
      return backendWorkflows;
    }

    if (!window.electronAPI?.saveAutomationWorkflow) {
      return legacyWorkflows;
    }

    let importFailed = false;
    for (const workflow of legacyWorkflows) {
      try {
        await window.electronAPI.saveAutomationWorkflow(workflow);
      } catch (error) {
        importFailed = true;
        console.warn(`Failed to migrate workflow "${workflow.name}" from local storage:`, error.message);
      }
    }

    if (!importFailed) {
      clearLegacyStoredWorkflows();
    }

    const refreshed = await loadBackendWorkflows();
    return refreshed.length ? refreshed : legacyWorkflows;
  }

  function loadLegacyStoredWorkflows() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed)
        ? parsed.map(normalizeStoredWorkflow).filter(Boolean)
        : [];
    } catch (error) {
      console.warn('Failed to parse stored workflows:', error.message);
      return [];
    }
  }

  async function loadBackendWorkflows() {
    if (!window.electronAPI?.getAutomationWorkflows) {
      return [];
    }

    try {
      const workflows = await window.electronAPI.getAutomationWorkflows();
      return Array.isArray(workflows)
        ? workflows.map(normalizeStoredWorkflow).filter(Boolean)
        : [];
    } catch (error) {
      console.warn('Failed to load automation workflows from backend:', error.message);
      return [];
    }
  }

  async function persistWorkflow(workflow) {
    const normalizedWorkflow = normalizeStoredWorkflow(workflow);
    if (!normalizedWorkflow) {
      return null;
    }

    if (!window.electronAPI?.saveAutomationWorkflow) {
      upsertWorkflowState(normalizedWorkflow);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.workflows));
      return normalizedWorkflow;
    }

    try {
      const saved = await window.electronAPI.saveAutomationWorkflow(normalizedWorkflow);
      const nextWorkflow = normalizeStoredWorkflow(saved) || normalizedWorkflow;
      upsertWorkflowState(nextWorkflow);
      clearLegacyStoredWorkflows();
      return nextWorkflow;
    } catch (error) {
      console.warn(`Failed to persist workflow "${normalizedWorkflow.name}" to backend:`, error.message);
      return null;
    }
  }

  async function removePersistedWorkflow(workflowId) {
    if (!window.electronAPI?.deleteAutomationWorkflow) {
      const initialLength = state.workflows.length;
      state.workflows = state.workflows.filter((item) => item.id !== workflowId);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.workflows));
      return state.workflows.length !== initialLength;
    }

    try {
      const deleted = await window.electronAPI.deleteAutomationWorkflow(workflowId);
      state.workflows = state.workflows.filter((item) => item.id !== workflowId);
      clearLegacyStoredWorkflows();
      return Boolean(deleted);
    } catch (error) {
      console.warn(`Failed to delete workflow "${workflowId}" from backend:`, error.message);
      return false;
    }
  }

  function upsertWorkflowState(workflow) {
    const existingIndex = state.workflows.findIndex((item) => item.id === workflow.id);
    if (existingIndex >= 0) {
      state.workflows[existingIndex] = workflow;
    } else {
      state.workflows.unshift(workflow);
    }
    state.workflows.sort((left, right) => {
      return Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0);
    });
  }

  function clearLegacyStoredWorkflows() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn('Failed to clear legacy automation workflow storage:', error.message);
    }
  }

  function normalizeStoredWorkflow(workflow) {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
      return null;
    }

    const target = workflow.target && typeof workflow.target === 'object' && !Array.isArray(workflow.target)
      ? clone(workflow.target)
      : null;
    const steps = Array.isArray(workflow.steps)
      ? workflow.steps.map((step) => ({ ...step }))
      : [];

    if (!target || !steps.length) {
      return null;
    }

    return {
      id: String(workflow.id || `wf_${Date.now()}`).trim(),
      kind: 'automation',
      name: String(workflow.name || '').trim() || buildDefaultWorkflowName(target),
      description: String(workflow.description || '').trim(),
      agentId: String(workflow.agentId || '').trim() || null,
      target,
      steps,
      headless: !!workflow.headless,
      status: String(workflow.status || 'draft').trim() || 'draft',
      createdAt: workflow.createdAt || new Date().toISOString(),
      updatedAt: workflow.updatedAt || new Date().toISOString(),
      lastRunAt: workflow.lastRunAt || null
    };
  }

  function setStatus(message) {
    if (elements.status) {
      elements.status.textContent = message;
    }
  }

  function parseNameList(value) {
    return String(value || '')
      .split(/[\n,]+/)
      .map((name) => name.trim())
      .filter(Boolean);
  }

  function formatDateTime(value) {
    if (!value) return 'unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return date.toLocaleString();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
