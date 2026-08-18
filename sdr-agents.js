(function () {
  const state = {
    agents: [],
    accounts: [],
    runs: [],
    prospects: [],
    scheduledPosts: [],
    searchPresets: [],
    selectedAgentId: null,
    prospectSort: 'score'
  };
  const elements = {};

  document.addEventListener('DOMContentLoaded', initSdrAgents);

  async function initSdrAgents() {
    elements.root = document.getElementById('sdr-agents-section');
    if (!elements.root) return;

    Object.assign(elements, {
      list: document.getElementById('sdr-agent-list'),
      form: document.getElementById('sdr-agent-form'),
      feedback: document.getElementById('sdr-agent-feedback'),
      runs: document.getElementById('sdr-workflow-run-list'),
      prospects: document.getElementById('sdr-prospect-list'),
      prospectMeta: document.getElementById('sdr-prospect-list-meta'),
      prospectSort: document.getElementById('sdr-prospect-sort'),
      newButton: document.getElementById('sdr-agent-new'),
      resetButton: document.getElementById('sdr-agent-reset'),
      deleteButton: document.getElementById('sdr-agent-delete'),
      id: document.getElementById('sdr-agent-id'),
      name: document.getElementById('sdr-agent-name'),
      account: document.getElementById('sdr-agent-account'),
      niche: document.getElementById('sdr-agent-niche'),
      status: document.getElementById('sdr-agent-status'),
      personaTitles: document.getElementById('sdr-agent-persona-titles'),
      searchKeywords: document.getElementById('sdr-agent-search-keywords'),
      contentPillars: document.getElementById('sdr-agent-content-pillars'),
      connectionNote: document.getElementById('sdr-agent-connection-note'),
      dmPrimary: document.getElementById('sdr-agent-dm-primary'),
      dmFollowUp: document.getElementById('sdr-agent-dm-follow-up'),
      postCadence: document.getElementById('sdr-agent-post-cadence'),
      timezone: document.getElementById('sdr-agent-timezone'),
      notifyDm: document.getElementById('sdr-agent-notify-dm'),
      notifyFailures: document.getElementById('sdr-agent-notify-failures'),
      searchPresets: document.getElementById('sdr-agent-search-presets'),
      planDays: document.getElementById('sdr-agent-plan-days'),
      planStartDate: document.getElementById('sdr-agent-plan-start-date'),
      planTime: document.getElementById('sdr-agent-plan-time'),
      planReplace: document.getElementById('sdr-agent-plan-replace'),
      planGenerate: document.getElementById('sdr-agent-plan-generate'),
      planSummary: document.getElementById('sdr-agent-content-plan-summary')
    });

    seedPlannerDefaults();
    bindEvents();
    await refreshAll();
    if (!state.agents.length) {
      resetForm();
    }
  }

  function bindEvents() {
    document.addEventListener('connect-ability:active-linkedin-account-changed', async () => {
      await refreshAll();
    });

    elements.newButton?.addEventListener('click', () => {
      resetForm();
      setFeedback('Drafting a new SDR agent.');
    });

    elements.prospectSort?.addEventListener('change', () => {
      state.prospectSort = elements.prospectSort.value || 'score';
      renderProspects();
    });

    elements.resetButton?.addEventListener('click', () => {
      if (state.selectedAgentId) {
        const agent = state.agents.find((entry) => entry.id === state.selectedAgentId);
        fillForm(agent || null);
      } else {
        resetForm();
      }
    });

    elements.deleteButton?.addEventListener('click', async () => {
      const agentId = elements.id?.value || '';
      if (!agentId) {
        setFeedback('Select an SDR agent before deleting.', 'warning');
        return;
      }

      const confirmed = window.confirm('Delete this SDR agent?');
      if (!confirmed) return;

      const result = await window.electronAPI.deleteSdrAgent(agentId);
      if (!result?.success) {
        setFeedback(result?.error || 'Failed to delete SDR agent.', 'error');
        return;
      }

      state.agents = Array.isArray(result.agents) ? result.agents : [];
      state.selectedAgentId = state.agents[0]?.id || null;
      renderAgentList();
      await loadSearchPresets();
      dispatchAgentsChanged();
      if (state.selectedAgentId) {
        fillForm(state.agents.find((agent) => agent.id === state.selectedAgentId) || null);
      } else {
        resetForm();
      }
      setFeedback('SDR agent deleted.', 'success');
    });

    elements.form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const payload = readForm();
        const result = await window.electronAPI.saveSdrAgent(payload);
        if (!result?.success) {
          setFeedback(result?.error || 'Failed to save SDR agent.', 'error');
          return;
        }

        state.agents = Array.isArray(result.agents) ? result.agents : [];
        state.selectedAgentId = result.agent?.id || payload.id || null;
        renderAgentList();
        fillForm(result.agent || null);
        await loadSearchPresets();
        dispatchAgentsChanged();
        setFeedback(`Saved SDR agent "${result.agent?.name || payload.name}".`, 'success');
      } catch (error) {
        setFeedback(error.message || 'Failed to save SDR agent.', 'error');
      }
    });

    elements.list?.addEventListener('click', (event) => {
      const card = event.target.closest('[data-agent-id]');
      if (!card) return;
      const agentId = card.getAttribute('data-agent-id');
      selectAgent(agentId);
    });

    elements.searchPresets?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-search-preset-action]');
      if (!button) return;

      const agentId = button.getAttribute('data-agent-id');
      const presetId = button.getAttribute('data-preset-id');
      const action = button.getAttribute('data-search-preset-action');
      if (!agentId || !presetId || !window.AgentSearchContext?.applyPreset) {
        return;
      }

      const applied = await window.AgentSearchContext.applyPreset({
        agentId,
        presetId,
        runNow: action === 'run'
      });
      if (!applied) {
        setFeedback('Failed to load SDR search preset.', 'error');
        return;
      }

      setFeedback(
        action === 'run'
          ? 'Search preset launched in Search & Engage.'
          : 'Search preset loaded into Search & Engage.',
        action === 'run' ? 'success' : 'info'
      );
    });

    elements.planGenerate?.addEventListener('click', async () => {
      const agent = state.agents.find((entry) => entry.id === state.selectedAgentId) || null;
      if (!agent) {
        setFeedback('Select an SDR agent before generating a content plan.', 'warning');
        return;
      }

      if (!agent.accountId) {
        setFeedback('Assign a LinkedIn account to this SDR agent before generating a content plan.', 'warning');
        return;
      }

      const result = await window.electronAPI?.generateSdrAgentContentPlan?.({
        agentId: agent.id,
        days: elements.planDays?.value || 90,
        startDate: elements.planStartDate?.value || '',
        postingTime: elements.planTime?.value || '09:00',
        replaceExisting: !!elements.planReplace?.checked
      });

      if (!result?.success) {
        setFeedback(result?.error || 'Failed to generate SDR content plan.', 'error');
        return;
      }

      await loadScheduledPosts();
      renderContentPlanSummary();
      setFeedback(
        `Generated ${Number(result.createdPosts || 0)} scheduled posts for "${agent.name}".`,
        'success'
      );
    });

    elements.runs?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-run-cancel]');
      if (!button) return;
      const runId = button.getAttribute('data-run-cancel');
      const confirmed = window.confirm('Cancel this workflow run?');
      if (!confirmed) return;
      const result = await window.electronAPI.cancelSdrWorkflowRun(runId);
      if (!result?.success) {
        setFeedback(result?.error || 'Failed to cancel workflow run.', 'error');
        return;
      }
      setFeedback('Workflow run cancelled.', 'warning');
      await loadRuns();
    });

    if (window.electronAPI?.on) {
      window.electronAPI.on('sdr-agents-updated', (agents) => {
        state.agents = Array.isArray(agents) ? agents : [];
        if (!state.agents.some((agent) => agent.id === state.selectedAgentId)) {
          state.selectedAgentId = state.agents[0]?.id || null;
        }
        renderAgentList();
        if (state.selectedAgentId) {
          fillForm(state.agents.find((agent) => agent.id === state.selectedAgentId) || null);
        }
        loadSearchPresets();
        loadProspects();
        renderContentPlanSummary();
        dispatchAgentsChanged();
      });

      window.electronAPI.on('sdr-workflow-runs-updated', (runs) => {
        state.runs = Array.isArray(runs) ? runs : [];
        renderRuns();
        loadProspects();
      });

      window.electronAPI.on('prospects-updated', () => {
        loadProspects();
      });
    }
  }

  async function refreshAll() {
    await loadAccounts();
    await loadAgents();
    await Promise.all([loadRuns(), loadScheduledPosts()]);
  }

  async function loadAccounts() {
    try {
      state.accounts = await window.electronAPI.getLinkedInAccounts();
    } catch (error) {
      console.warn('Failed to load LinkedIn accounts for SDR agents:', error.message);
      state.accounts = [];
    }
    populateAccountOptions();
  }

  async function loadAgents() {
    try {
      state.agents = await window.electronAPI.getSdrAgents();
    } catch (error) {
      console.warn('Failed to load SDR agents:', error.message);
      state.agents = [];
    }

    if (!state.selectedAgentId || !state.agents.some((agent) => agent.id === state.selectedAgentId)) {
      state.selectedAgentId = state.agents[0]?.id || null;
    }

    renderAgentList();
    await loadSearchPresets();
    await loadProspects();
    dispatchAgentsChanged();

    if (state.selectedAgentId) {
      fillForm(state.agents.find((agent) => agent.id === state.selectedAgentId) || null);
    }
    renderContentPlanSummary();
  }

  async function loadRuns() {
    try {
      state.runs = await window.electronAPI.getSdrWorkflowRuns();
    } catch (error) {
      console.warn('Failed to load SDR workflow runs:', error.message);
      state.runs = [];
    }
    renderRuns();
  }

  async function loadProspects() {
    if (!window.electronAPI?.getSdrProspects) {
      state.prospects = [];
      renderProspects();
      return;
    }

    const filters = {};
    if (state.selectedAgentId) {
      filters.agentId = state.selectedAgentId;
    }

    try {
      const prospects = await window.electronAPI.getSdrProspects(filters);
      state.prospects = Array.isArray(prospects) ? prospects : [];
    } catch (error) {
      console.warn('Failed to load SDR prospects:', error.message);
      state.prospects = [];
    }

    renderProspects();
  }

  async function loadScheduledPosts() {
    try {
      const result = await window.electronAPI?.getScheduledPosts?.({
        accountId: window.LinkedInAccountContext?.getActiveAccountId?.() || null
      });
      state.scheduledPosts = result?.ok && Array.isArray(result.posts) ? result.posts : [];
    } catch (error) {
      console.warn('Failed to load scheduled posts for SDR agents:', error.message);
      state.scheduledPosts = [];
    }
    renderContentPlanSummary();
  }

  function selectAgent(agentId) {
    state.selectedAgentId = agentId || null;
    renderAgentList();
    fillForm(state.agents.find((agent) => agent.id === state.selectedAgentId) || null);
    loadSearchPresets();
    loadProspects();
    renderContentPlanSummary();
  }

  async function loadSearchPresets(agentId = state.selectedAgentId) {
    if (!agentId || !window.electronAPI?.getSdrAgentSearchPresets) {
      state.searchPresets = [];
      renderSearchPresets();
      return;
    }

    try {
      const presets = await window.electronAPI.getSdrAgentSearchPresets(agentId);
      state.searchPresets = Array.isArray(presets) ? presets : [];
    } catch (error) {
      console.warn('Failed to load SDR search presets:', error.message);
      state.searchPresets = [];
    }

    renderSearchPresets();
  }

  function renderAgentList() {
    if (!elements.list) return;

    if (!state.agents.length) {
      elements.list.innerHTML = `
        <div class="inbox-empty">
          <p>No SDR agents yet. Click + to create one.</p>
        </div>
      `;
      return;
    }

    elements.list.innerHTML = state.agents.map((agent) => {
      const isActive = agent.id === state.selectedAgentId;
      const statusClass = agent.status === 'active' ? 'status-active' : agent.status === 'paused' ? 'status-warning' : '';
      const statusBg = agent.status === 'active' ? 'var(--status-active-bg)' : agent.status === 'paused' ? 'var(--status-warning-bg)' : 'var(--surface-container-high)';
      const statusColor = agent.status === 'active' ? 'var(--status-active-text)' : agent.status === 'paused' ? 'var(--status-warning-text)' : 'var(--on-surface-variant)';
      return `
        <button type="button" class="sdr-agent-card ${isActive ? 'active' : ''}" data-agent-id="${escapeHtml(agent.id)}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
            <div class="sdr-agent-card-title">${escapeHtml(agent.name)}</div>
            <span style="font-size:9px;padding:2px 6px;border-radius:9999px;font-weight:700;text-transform:uppercase;background:${statusBg};color:${statusColor}">${escapeHtml(agent.status || 'draft')}</span>
          </div>
          <div class="sdr-agent-card-meta" style="display:flex;align-items:center;gap:4px">
            <span class="material-symbols-outlined" style="font-size:12px">corporate_fare</span>
            ${escapeHtml(agent.accountName || 'No profile assigned')}
          </div>
        </button>
      `;
    }).join('');
  }

  function renderRuns() {
    if (!elements.runs) return;
    if (!state.runs.length) {
      elements.runs.innerHTML = '<div class="inbox-empty"><p>No workflow runs yet.</p></div>';
      return;
    }

    const visibleRuns = state.runs.slice(0, 12);
    elements.runs.innerHTML = `
      <div style="overflow:hidden;border-radius:var(--radius-md);border:1px solid rgba(193,198,212,0.1)">
        <table style="width:100%;text-align:left;font-size:12px;border-collapse:collapse">
          <thead>
            <tr style="background:var(--surface-container-low)">
              <th style="padding:8px 12px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.1em;color:var(--on-surface-variant)">Workflow</th>
              <th style="padding:8px 12px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.1em;color:var(--on-surface-variant)">Stat</th>
            </tr>
          </thead>
          <tbody>
            ${visibleRuns.map((run) => {
              const summary = run.summary || {};
              const canCancel = ['queued', 'running', 'waiting'].includes(run.status);
              const statusDot = run.status === 'running' ? 'var(--status-active-dot)' : run.status === 'completed' ? 'var(--on-surface-variant)' : run.status === 'failed' ? 'var(--error)' : 'var(--status-warning-dot)';
              return `
                <tr style="border-top:1px solid var(--surface-container)">
                  <td style="padding:10px 12px">
                    <div style="font-weight:700;font-size:12px">${escapeHtml(run.workflowName || 'Workflow Run')}</div>
                    <div style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:9px;font-weight:700;text-transform:uppercase;color:${statusDot}">
                      <span style="width:5px;height:5px;border-radius:50%;background:${statusDot};display:inline-block"></span>
                      ${escapeHtml(run.status)}
                    </div>
                  </td>
                  <td style="padding:10px 12px">
                    <div style="font-family:'JetBrains Mono',monospace;font-size:11px">${Number(summary.completedTargets || 0)}/${Number(summary.totalTargets || run.targets?.length || 0)}</div>
                    <div style="font-size:9px;color:var(--on-surface-variant)">${escapeHtml(run.createdAt || '')}</div>
                    ${canCancel ? `<button type="button" class="btn btn-secondary btn-sm" style="margin-top:4px;font-size:10px;padding:2px 8px" data-run-cancel="${escapeHtml(run.id)}">Cancel</button>` : ''}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderProspects() {
    if (!elements.prospects) return;

    const selectedAgent = state.agents.find((entry) => entry.id === state.selectedAgentId) || null;
    if (elements.prospectSort) {
      elements.prospectSort.value = state.prospectSort || 'score';
    }

    if (!selectedAgent) {
      if (elements.prospectMeta) {
        elements.prospectMeta.textContent = 'Select an agent to view scored prospects.';
      }
      elements.prospects.innerHTML = '<div class="inbox-empty"><p>Select an SDR agent to view prospects.</p></div>';
      return;
    }

    const sortedProspects = sortProspectsForView(state.prospects, state.prospectSort);
    if (elements.prospectMeta) {
      const scoredCount = sortedProspects.filter((prospect) => Number.isFinite(Number(prospect.score))).length;
      elements.prospectMeta.textContent = `${sortedProspects.length} prospect${sortedProspects.length === 1 ? '' : 's'} for ${selectedAgent.name} • ${scoredCount} scored`;
    }

    if (!sortedProspects.length) {
      elements.prospects.innerHTML = `<div class="inbox-empty"><p>${escapeHtml(selectedAgent.name)} has no prospects yet.</p></div>`;
      return;
    }

    const visibleProspects = sortedProspects.slice(0, 24);
    elements.prospects.innerHTML = visibleProspects.map((prospect) => {
      const score = Number(prospect.score);
      const hasScore = Number.isFinite(score);
      const summary = buildProspectScoreSummary(prospect);
      const breakdownItems = buildProspectBreakdownItems(prospect);
      const tags = [
        formatProspectState(prospect.state),
        prospect.workflowAssignment?.workflowName || null,
        prospect.sourceLabel || prospect.sourceType || null
      ].filter(Boolean).slice(0, 3);

      return `
        <div class="sdr-prospect-card">
          <div class="sdr-prospect-card-header">
            <div class="sdr-prospect-card-identity">
              <div class="sdr-prospect-card-title">${escapeHtml(prospect.fullName || prospect.profileUrl || prospect.id || 'Prospect')}</div>
              <div class="sdr-prospect-card-meta">${escapeHtml(buildProspectHeadline(prospect))}</div>
            </div>
            <div class="sdr-prospect-score ${hasScore ? '' : 'muted'}">${hasScore ? `${Math.round(score)}/100` : 'N/A'}</div>
          </div>
          <div class="sdr-prospect-tags">
            ${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}
          </div>
          ${breakdownItems.length ? `
            <details class="sdr-prospect-breakdown">
              <summary style="font-size:10px;color:var(--on-surface-variant);cursor:pointer">Score breakdown</summary>
              <div class="sdr-prospect-breakdown-list">
                ${breakdownItems.map((item) => `
                  <div class="sdr-prospect-breakdown-item">
                    <div>
                      <div class="sdr-prospect-breakdown-label">${escapeHtml(item.label)}</div>
                      <div style="font-size:10px;color:var(--on-surface-variant)">${escapeHtml(item.detail)}</div>
                    </div>
                    <div class="sdr-prospect-breakdown-value">${escapeHtml(item.value)}</div>
                  </div>
                `).join('')}
              </div>
            </details>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  function renderSearchPresets() {
    if (!elements.searchPresets) return;

    const agent = state.agents.find((entry) => entry.id === state.selectedAgentId) || null;
    if (!agent) {
      elements.searchPresets.innerHTML = '<div class="hint-text">Select an SDR agent to generate saved persona searches.</div>';
      return;
    }

    if (!state.searchPresets.length) {
      elements.searchPresets.innerHTML = `<div class="hint-text">No generated presets available for ${escapeHtml(agent.name)} yet. Add target titles, keywords, or a niche.</div>`;
      return;
    }

    elements.searchPresets.innerHTML = state.searchPresets.map((preset) => {
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--surface-container-lowest);border:1px solid rgba(193,198,212,0.1);border-radius:var(--radius-md);margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:var(--surface-container-high);border-radius:var(--radius-sm)">
              <span class="material-symbols-outlined" style="font-size:16px;color:var(--on-surface-variant)">filter_list</span>
            </div>
            <div>
              <div style="font-size:12px;font-weight:700">${escapeHtml(preset.label || preset.query)}</div>
              <div style="font-size:10px;color:var(--on-surface-variant);font-family:'JetBrains Mono',monospace">${escapeHtml(preset.id || '')}</div>
            </div>
          </div>
          <div style="display:flex;gap:4px">
            <button type="button" class="btn btn-secondary btn-sm" style="font-size:10px;padding:4px 8px" data-search-preset-action="use" data-agent-id="${escapeHtml(agent.id)}" data-preset-id="${escapeHtml(preset.id)}">Use</button>
            <button type="button" class="btn btn-primary btn-sm" style="font-size:10px;padding:4px 8px" data-search-preset-action="run" data-agent-id="${escapeHtml(agent.id)}" data-preset-id="${escapeHtml(preset.id)}">Run</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderContentPlanSummary() {
    if (!elements.planSummary) return;

    const agent = state.agents.find((entry) => entry.id === state.selectedAgentId) || null;
    if (!agent) {
      elements.planSummary.innerHTML = '<div class="hint-text">Select an SDR agent with a LinkedIn account to build a scheduled 90-day post queue.</div>';
      return;
    }

    if (!agent.accountId) {
      elements.planSummary.innerHTML = `<div class="hint-text">${escapeHtml(agent.name)} needs an assigned LinkedIn account before posts can be scheduled.</div>`;
      return;
    }

    const plannedPosts = state.scheduledPosts
      .filter((post) => post.agentId === agent.id && post.sourceType === 'agent_plan')
      .sort((left, right) => {
        const leftKey = `${left.scheduledDate || ''}T${left.scheduledTime || ''}`;
        const rightKey = `${right.scheduledDate || ''}T${right.scheduledTime || ''}`;
        return leftKey.localeCompare(rightKey);
      });

    if (!plannedPosts.length) {
      elements.planSummary.innerHTML = `<div class="hint-text">No planned posts exist for ${escapeHtml(agent.name)} yet. Generate a plan to seed the next 90 days.</div>`;
      return;
    }

    const pendingCount = plannedPosts.filter((post) => post.status === 'pending' || post.status === 'scheduled').length;
    const publishedCount = plannedPosts.filter((post) => post.status === 'published').length;
    const nextPost = plannedPosts.find((post) => post.status === 'pending' || post.status === 'scheduled') || plannedPosts[0];
    const previewPosts = plannedPosts.slice(0, 4);
    const latestPlanName = nextPost?.planName || `${agent.name} content plan`;

    elements.planSummary.innerHTML = `
      <div class="sdr-agent-plan-summary-card">
        <div class="sdr-agent-plan-summary-header">
          <div>
            <div class="sdr-agent-plan-summary-title">${escapeHtml(latestPlanName)}</div>
            <div class="sdr-agent-plan-summary-meta">
              ${escapeHtml(agent.postCadence || 'daily')} cadence • ${escapeHtml(agent.timezone || 'America/Chicago')}
            </div>
          </div>
          <div class="sdr-agent-tag">${escapeHtml(agent.accountName || 'Assigned account')}</div>
        </div>
        <div class="sdr-agent-plan-summary-stats">
          <span class="sdr-agent-plan-summary-item">${plannedPosts.length} total posts</span>
          <span class="sdr-agent-plan-summary-item">${pendingCount} pending</span>
          <span class="sdr-agent-plan-summary-item">${publishedCount} published</span>
          ${nextPost ? `<span class="sdr-agent-plan-summary-item">Next: ${escapeHtml(formatSchedule(nextPost))}</span>` : ''}
        </div>
        <div class="sdr-agent-plan-preview-list">
          ${previewPosts.map((post) => `
            <div class="sdr-agent-plan-preview-item">
              <div class="sdr-agent-plan-preview-date">${escapeHtml(formatSchedule(post))}</div>
              <div class="sdr-agent-plan-preview-text">${escapeHtml(post.contentBrief || post.contentTheme || truncate(post.content, 140))}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function populateAccountOptions() {
    if (!elements.account) return;
    const currentValue = elements.account.value || '';
    const defaultAccountId = window.LinkedInAccountContext?.getActiveAccountId?.() || '';
    elements.account.innerHTML = '<option value="">Select a LinkedIn profile...</option>';
    state.accounts.forEach((account) => {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.name || account.email || account.id;
      elements.account.appendChild(option);
    });
    if (currentValue && state.accounts.some((account) => account.id === currentValue)) {
      elements.account.value = currentValue;
    } else if (defaultAccountId && state.accounts.some((account) => account.id === defaultAccountId)) {
      elements.account.value = defaultAccountId;
    }
  }

  function fillForm(agent) {
    if (!elements.form) return;
    if (!agent) {
      resetForm();
      return;
    }

    elements.id.value = agent.id || '';
    elements.name.value = agent.name || '';
    elements.account.value = agent.accountId || '';
    elements.niche.value = agent.niche || '';
    elements.status.value = agent.status || 'active';
    elements.personaTitles.value = (agent.personaTitles || []).join('\n');
    elements.searchKeywords.value = (agent.searchKeywords || []).join('\n');
    elements.contentPillars.value = (agent.contentPillars || []).join('\n');
    elements.connectionNote.value = agent.connectionNoteTemplate || '';
    elements.dmPrimary.value = agent.dmTemplatePrimary || '';
    elements.dmFollowUp.value = agent.dmTemplateFollowUp || '';
    elements.postCadence.value = agent.postCadence || 'daily';
    elements.timezone.value = agent.timezone || 'America/Chicago';
    elements.notifyDm.checked = agent.notifications?.dmReplies !== false;
    elements.notifyFailures.checked = agent.notifications?.workflowFailures !== false;
    elements.planTime.value = elements.planTime.value || '09:00';
    setFeedback(`Editing "${agent.name}".`);
  }

  function resetForm() {
    elements.form?.reset();
    elements.id.value = '';
    elements.status.value = 'active';
    elements.postCadence.value = 'daily';
    elements.timezone.value = 'America/Chicago';
    elements.notifyDm.checked = true;
    elements.notifyFailures.checked = true;
    if (elements.account) {
      elements.account.value = window.LinkedInAccountContext?.getActiveAccountId?.() || '';
    }
    state.selectedAgentId = null;
    state.searchPresets = [];
    renderAgentList();
    renderSearchPresets();
    renderContentPlanSummary();
    renderProspects();
  }

  function seedPlannerDefaults() {
    if (elements.planStartDate && !elements.planStartDate.value) {
      const next = new Date();
      next.setDate(next.getDate() + 1);
      elements.planStartDate.value = next.toISOString().split('T')[0];
    }
    if (elements.planTime && !elements.planTime.value) {
      elements.planTime.value = '09:00';
    }
    if (elements.planDays && !elements.planDays.value) {
      elements.planDays.value = '90';
    }
    if (elements.planReplace) {
      elements.planReplace.checked = true;
    }
  }

  function readForm() {
    const account = state.accounts.find((entry) => entry.id === elements.account.value) || null;
    return {
      id: elements.id.value || null,
      name: elements.name.value,
      accountId: elements.account.value || null,
      accountName: account?.name || account?.email || null,
      niche: elements.niche.value,
      status: elements.status.value,
      personaTitles: splitMultiline(elements.personaTitles.value),
      searchKeywords: splitMultiline(elements.searchKeywords.value),
      contentPillars: splitMultiline(elements.contentPillars.value),
      connectionNoteTemplate: elements.connectionNote.value,
      dmTemplatePrimary: elements.dmPrimary.value,
      dmTemplateFollowUp: elements.dmFollowUp.value,
      postCadence: elements.postCadence.value,
      timezone: elements.timezone.value,
      notifications: {
        dmReplies: !!elements.notifyDm.checked,
        workflowFailures: !!elements.notifyFailures.checked
      }
    };
  }

  function setFeedback(message, type = 'info') {
    if (!elements.feedback) return;
    elements.feedback.textContent = message;
    elements.feedback.dataset.state = type;
  }

  function dispatchAgentsChanged() {
    document.dispatchEvent(new CustomEvent('sdr-agents-changed', {
      detail: { agents: state.agents }
    }));
    window.SdrAgentsContext = {
      getAgents: () => state.agents.slice(),
      getAgentById: (agentId) => state.agents.find((agent) => agent.id === agentId) || null
    };
  }

  function splitMultiline(value) {
    return String(value || '')
      .split(/[\n,]/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function formatSchedule(post) {
    return [post.scheduledDate || 'No date', post.scheduledTime || 'No time'].join(' ');
  }

  function sortProspectsForView(prospects, sortKey) {
    const entries = Array.isArray(prospects) ? prospects.slice() : [];
    return entries.sort((left, right) => {
      if (sortKey === 'recent') {
        return compareDateDesc(left.lastActionAt || left.updatedAt, right.lastActionAt || right.updatedAt)
          || compareScoreDesc(left, right);
      }
      if (sortKey === 'reply') {
        return compareDateDesc(left.lastReplyAt, right.lastReplyAt)
          || compareScoreDesc(left, right);
      }
      return compareScoreDesc(left, right)
        || compareDateDesc(left.lastActionAt || left.updatedAt, right.lastActionAt || right.updatedAt);
    });
  }

  function compareScoreDesc(left, right) {
    return (Number(right?.score) || -1) - (Number(left?.score) || -1);
  }

  function compareDateDesc(left, right) {
    const leftTime = left ? new Date(left).getTime() : 0;
    const rightTime = right ? new Date(right).getTime() : 0;
    return rightTime - leftTime;
  }

  function buildProspectHeadline(prospect) {
    const parts = [
      prospect.title || null,
      prospect.company || null
    ].filter(Boolean);
    return parts.length ? parts.join(' • ') : (prospect.profileUrl || 'No title or company yet');
  }

  function buildProspectActivityLine(prospect) {
    const lastAction = formatCompactTimestamp(prospect.lastActionAt || prospect.updatedAt);
    const lastReply = prospect.lastReplyAt ? formatCompactTimestamp(prospect.lastReplyAt) : null;
    if (lastReply) {
      return `Latest reply ${lastReply}`;
    }
    return `Last updated ${lastAction}`;
  }

  function formatCompactTimestamp(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) {
      return 'recently';
    }
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function formatProspectState(stateValue) {
    const value = String(stateValue || '').replace(/_/g, ' ').trim();
    if (!value) {
      return 'unknown';
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function buildProspectScoreSummary(prospect) {
    const breakdown = prospect?.scoreBreakdown;
    const topFactor = resolveTopScoreFactor(breakdown);
    if (!Number.isFinite(Number(prospect?.score))) {
      return 'This prospect has not been scored yet. A score is assigned when the durable workflow scheduler evaluates the queue.';
    }
    if (!topFactor) {
      return `Lead score ${Math.round(Number(prospect.score) || 0)} based on the current agent profile.`;
    }

    const reason = describeScoreFactor(topFactor);
    return `${humanizeScoreFactor(topFactor.key)} was the strongest signal${reason ? `: ${reason}` : ''}.`;
  }

  function buildProspectBreakdownItems(prospect) {
    const breakdown = prospect?.scoreBreakdown?.factors;
    if (!breakdown || typeof breakdown !== 'object') {
      return [];
    }

    return Object.entries(breakdown)
      .map(([key, factor]) => ({
        key,
        weighted: Number(factor?.weighted) || 0,
        label: humanizeScoreFactor(key),
        detail: describeScoreFactor({ key, ...factor }) || 'No additional detail',
        value: `${Math.round((Number(factor?.score) || 0) * 100)} / 100`
      }))
      .sort((left, right) => right.weighted - left.weighted);
  }

  function resolveTopScoreFactor(breakdown) {
    const factors = breakdown?.factors;
    if (!factors || typeof factors !== 'object') {
      return null;
    }

    return Object.entries(factors)
      .map(([key, factor]) => ({ key, ...(factor || {}) }))
      .sort((left, right) => (Number(right.weighted) || 0) - (Number(left.weighted) || 0))[0] || null;
  }

  function humanizeScoreFactor(key) {
    const labels = {
      titleMatch: 'Title match',
      seniority: 'Seniority',
      companySize: 'Company size',
      connectionDegree: 'Connection degree'
    };
    return labels[key] || String(key || 'Factor');
  }

  function describeScoreFactor(factor = {}) {
    if (factor.matchedKeyword) {
      return `matched "${factor.matchedKeyword}"`;
    }
    if (factor.value) {
      return `value ${factor.value}`;
    }
    if (factor.reason) {
      return factor.reason.replace(/_/g, ' ');
    }
    return '';
  }

  function truncate(value, maxLength = 140) {
    const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return '';
    return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
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
