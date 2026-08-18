// Workflow Studio — top-level page, topbar, step canvas orchestration

const { useState: useStateWF, useEffect: useEffectWF, useMemo: useMemoWF, useRef: useRefWF } = React;

// ===================================================================
// Real-data hook — loads agents, templates, groups, account health,
// active runs. Falls back to WF.* mocks outside Electron.
// ===================================================================
function useWorkflowData() {
  const [state, setState] = useStateWF({
    agents: [], accounts: [], groups: [], templates: [], runs: [], analytics: null, prospects: [],
    selectedAgentId: null, selectedGroupId: null, selectedTemplateId: null,
    loaded: false,
  });

  const load = async () => {
    if (!window.electronAPI) return;
    try {
      const [agents, health, groups, templates, runs, analytics, prospects] = await Promise.all([
        window.electronAPI.getSdrAgents().catch(() => []),
        window.electronAPI.getLinkedInAccountHealth().catch(() => []),
        window.electronAPI.getGroupsData().catch(() => []),
        window.electronAPI.getAutomationWorkflows().catch(() => []),
        window.electronAPI.getSdrWorkflowRuns().catch(() => []),
        window.electronAPI.getActivityAnalytics({}).catch(() => ({})),
        window.electronAPI.getSdrProspects ? window.electronAPI.getSdrProspects({}).catch(() => []) : Promise.resolve([]),
      ]);
      const agentList = Array.isArray(agents) ? agents : (agents && agents.agents) || [];
      const accList = Array.isArray(health) ? health : (health && health.accounts) || [];
      const groupList = Array.isArray(groups) ? groups : (groups && groups.groups) || [];
      const templateList = Array.isArray(templates) ? templates : (templates && templates.workflows) || [];
      const runList = Array.isArray(runs) ? runs : (runs && runs.runs) || [];
      const prospectList = Array.isArray(prospects) ? prospects : (prospects && prospects.prospects) || [];
      setState(s => ({
        agents: agentList,
        accounts: accList,
        groups: groupList,
        templates: templateList,
        runs: runList,
        analytics: analytics || {},
        prospects: prospectList,
        selectedAgentId: s.selectedAgentId || (agentList[0] && (agentList[0].id || agentList[0].agentId)) || null,
        selectedGroupId: s.selectedGroupId || (groupList[0] && (groupList[0].id || groupList[0].groupId)) || null,
        selectedTemplateId: s.selectedTemplateId,
        loaded: true,
      }));
    } catch (e) { console.warn('Workflow load failed:', e); }
  };

  useEffectWF(() => {
    load();
    if (!window.electronAPI || !window.electronAPI.on) return;
    const refresh = () => load();
    ['sdr-agents-updated', 'sdr-workflow-runs-updated',
     'linkedin-account-health-updated', 'linkedin-challenge-detected',
     'workflow-created', 'workflow-completed', 'workflow-deleted', 'workflow-paused'
    ].forEach(ch => window.electronAPI.on(ch, refresh));
    const poll = setInterval(load, 30000);
    return () => clearInterval(poll);
  }, []);

  const selectAgent = (id) => setState(s => ({ ...s, selectedAgentId: id }));
  const selectGroup = (id) => setState(s => ({ ...s, selectedGroupId: id }));
  const selectTemplate = (id) => setState(s => ({ ...s, selectedTemplateId: id }));
  return { ...state, reload: load, selectAgent, selectGroup, selectTemplate };
}

// Compute workflow math (per-prospect duration, enroll time, daily load,
// estimated replies) from real nodes + account + analytics.
function computeMath(nodes, prospectCount, account, analytics) {
  const delaySteps = nodes.filter(n => n.type === 'delay');
  const actionSteps = nodes.filter(n => n.type !== 'delay');
  const totalDelayHours = delaySteps.reduce((a, n) => a + Number(n.hours || 0), 0);

  const perProspectHours = totalDelayHours + actionSteps.length * 0.25; // ~15min per action
  const perProspect =
    perProspectHours >= 48 ? `${Math.floor(perProspectHours / 24)}d ${Math.round(perProspectHours % 24)}h`
    : perProspectHours > 0 ? `${Math.round(perProspectHours)}h`
    : '—';

  const dailyCeil = Number((account && (account.dailyCeil || account.quotaCeiling || account.dailyLimit)) || 0);
  const dailyUsed = Number((account && (account.dailyUsed || account.quotaUsed)) || 0);
  const headroom = Math.max(dailyCeil - dailyUsed, 0);
  const actionsPerProspect = Math.max(actionSteps.length, 1);
  const effectiveDailyActions = dailyCeil > 0 ? dailyCeil : 60; // fallback assumption
  const dailyProspects = Math.max(Math.floor(effectiveDailyActions / actionsPerProspect), 1);

  const totalProspects = Number(prospectCount || 0);
  const enrollDays = totalProspects > 0 ? Math.ceil(totalProspects / dailyProspects) : 0;
  const campaign = enrollDays > 0 ? `${enrollDays} ${enrollDays === 1 ? 'day' : 'days'}` : '—';
  const campaignDetail = totalProspects > 0 ? `to enroll all ${totalProspects}` : 'no prospects selected';

  const load = totalProspects > 0 ? `~${Math.round(dailyProspects * actionsPerProspect)}/day` : '—';
  const loadDetail = dailyCeil > 0 ? `fits budget · ${headroom} headroom` : 'no account budget set';

  // Historical reply rate from analytics
  const totalDms = Number((analytics && analytics.totalDmsSent) || 0);
  const totalReplies = Number((analytics && analytics.totalDmReplies) || 0);
  const replyRate = totalDms > 0 ? (totalReplies / totalDms) : 0.04; // 4% default
  const estReplies = totalProspects > 0 ? Math.round(totalProspects * replyRate) : 0;
  const replies = estReplies > 0 ? `~${estReplies}` : '—';
  const replyDetail = `${(replyRate * 100).toFixed(1)}% avg reply rate`;

  return {
    perProspect,
    campaign, campaignDetail,
    load, loadDetail,
    replies, replyDetail,
  };
}

// Compute preflight check rows from real data.
function computePreflight(agent, account, activeRun) {
  const out = [];
  const persona = agent && agent.personaStatus ? agent.personaStatus : { hasPersona: false, fileCount: 0 };
  const files = Number(persona.fileCount || persona.completedFiles || 0);
  out.push({
    cat: 'Agent',
    label: 'Persona files complete',
    detail: files >= 4 ? '4 of 4 · soul · personality · writing-style · boundaries' : `${files} of 4 files present`,
    state: files >= 4 ? 'ok' : files > 0 ? 'warn' : 'danger',
  });
  out.push({
    cat: 'Agent',
    label: 'LinkedIn account bound',
    detail: agent && (agent.accountId || agent.linkedinAccount)
      ? `${agent.name} → ${(account && (account.name || account.displayName)) || 'account'}`
      : 'No LinkedIn account bound',
    state: agent && (agent.accountId || agent.linkedinAccount) ? 'ok' : 'danger',
  });
  if (account) {
    const rawStatus = String(account.status || account.state || 'ok').toLowerCase();
    const isChallenge = rawStatus.includes('challenge');
    const isCooldown = rawStatus.includes('cooldown');
    const dayN = Number(account.warmDay || account.warmUpDay || 28);
    const dayTotal = Number(account.warmTotal || account.warmUpTotal || 28);
    const pctWarm = Math.round((dayN / Math.max(dayTotal, 1)) * 100);
    out.push({
      cat: 'Account',
      label: 'Warm-up stage',
      detail: `Day ${dayN} of ${dayTotal} · ${pctWarm}% envelope`,
      state: dayN >= dayTotal ? 'ok' : 'warn',
    });
    const used = Number(account.dailyUsed || account.quotaUsed || 0);
    const ceil = Number(account.dailyCeil || account.quotaCeiling || account.dailyLimit || 0);
    const remaining = Math.max(ceil - used, 0);
    out.push({
      cat: 'Account',
      label: 'Daily budget',
      detail: ceil > 0 ? `${used} / ${ceil} used · ${remaining} remaining` : 'No budget configured',
      state: ceil === 0 ? 'warn' : (used / ceil >= 1) ? 'danger' : (used / ceil >= 0.9) ? 'warn' : 'ok',
    });
    out.push({
      cat: 'Account',
      label: 'Challenge status',
      detail: isChallenge ? 'Active challenge — clear before launch' : isCooldown ? 'Cooldown active' : 'No active challenges',
      state: isChallenge ? 'danger' : isCooldown ? 'warn' : 'ok',
    });
  } else {
    out.push({ cat: 'Account', label: 'Account health', detail: 'No account to check', state: 'warn' });
  }
  if (activeRun) {
    out.push({
      cat: 'Workflow',
      label: 'Existing run',
      detail: `${activeRun.name || 'Active run'} — ${activeRun.state}`,
      state: activeRun.state === 'running' ? 'warn' : 'ok',
    });
  }
  return out;
}

function makeWorkflowNodeId(type, seen) {
  const prefix = type === 'delay' ? 'd' : 'n';
  let id = '';
  do {
    id = prefix + Math.random().toString(36).slice(2, 7);
  } while (seen.has(id));
  return id;
}

function normalizeWorkflowSteps(steps) {
  if (!Array.isArray(steps)) return [];
  const seen = new Set();
  return steps
    .filter(step => step && typeof step === 'object' && step.type)
    .map(step => {
      const next = { ...step };
      const rawId = typeof next.id === 'string' ? next.id.trim() : '';
      next.id = rawId && !seen.has(rawId) ? rawId : makeWorkflowNodeId(next.type, seen);
      seen.add(next.id);

      if (next.type === 'delay') {
        const hours = Number(next.hours);
        next.hours = Number.isFinite(hours) && hours > 0 ? hours : 24;
      }
      if (next.type === 'like_posts') {
        next.count = Number.isFinite(Number(next.count)) && Number(next.count) > 0 ? Number(next.count) : 2;
        next.filter = next.filter || 'recent';
      }
      if (next.type === 'send_connection') {
        next.note = typeof next.note === 'string' ? next.note : '';
        next.withNote = typeof next.withNote === 'boolean' ? next.withNote : !!next.note.trim();
      }
      if (next.type === 'send_dm') {
        next.template = typeof next.template === 'string' ? next.template : '';
      }
      return next;
    });
}

function StatusChip({ state }) {
  if (state === 'running')      return <span className="chip chip--info"><span className="dot dot--pulse s-info"/>Running</span>;
  if (state === 'paused-error') return <span className="chip chip--danger"><span className="dot s-danger"/>Paused</span>;
  if (state === 'ready')        return <span className="chip chip--ok"><span className="dot s-ok"/>Ready</span>;
  if (state === 'empty')        return <span className="chip chip--line"><span className="dot s-dim"/>Unsaved</span>;
  return <span className="chip chip--line"><span className="dot s-warn"/>Draft</span>;
}

function AgentPill({ agent, agents, onSelect }) {
  const [open, setOpen] = useStateWF(false);
  const name = agent ? (agent.name || 'Agent') : 'Select agent';
  const initial = (name[0] || '?').toUpperCase();
  const status = agent && agent.personaStatus
    ? `persona ${Number(agent.personaStatus.fileCount || 0)}/4`
    : 'no persona';
  return (
    <div style={{ position: 'relative' }}>
      <button className="wf-agent" onClick={() => setOpen(o => !o)} type="button">
        <div className="wf-agent__avatar">{initial}</div>
        <div className="wf-agent__meta">
          <div className="wf-agent__name">{name}</div>
          <div className="wf-agent__sub mono">{status}</div>
        </div>
        <Ic.ChevronDown cls="icon icon--sm"/>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 10,
          background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8,
          boxShadow: 'var(--shadow-md)', minWidth: 220, overflow: 'hidden',
        }}>
          {agents.length === 0 && (
            <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>No agents configured yet.</div>
          )}
          {agents.map(a => {
            const id = a.id || a.agentId;
            const nm = a.name || 'Agent';
            const init = (nm[0] || '?').toUpperCase();
            const sub = a.role || a.email || '';
            return (
              <button
                key={id}
                type="button"
                onClick={() => { onSelect && onSelect(id); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  width: '100%', textAlign: 'left', background: 'transparent', cursor: 'pointer',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <div className="wf-agent__avatar" style={{ width: 26, height: 26, fontSize: 11 }}>{init}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 550 }}>{nm}</div>
                  {sub && <div className="mono s-dim" style={{ fontSize: 10 }}>{sub}</div>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StudioTopbar({ mode, state, runName, setRunName, currentLabel, historyCount, simOpen, onToggleSim, onLaunch, onSave,
                       onPause, onResume, onCancel, agent, agents, onSelectAgent, canLaunch, saving, launching, onBack, onSelectMode }) {
  const editorMode = mode === 'editor';
  const historyActive = mode === 'history' || mode === 'run';
  return (
    <div className="wf__bar">
      <button className="btn btn--ghost btn--icon" title="Back to Cockpit" type="button" onClick={onBack}><Ic.ChevronLeft cls="icon"/></button>
      <span className="mono s-dim" style={{ fontSize: 12.5 }}>Workflows</span>
      <Ic.ChevronRight cls="icon--sm s-faint" />
      {editorMode ? (
        <input
          className="wf__name-input"
          value={runName}
          onChange={e => setRunName(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <div className="wf__title-readout">{currentLabel}</div>
      )}
      {editorMode && <StatusChip state={state}/>}

      <span className="flex-1" />

      <div className="seg">
        <button
          className={`seg__btn ${editorMode ? 'seg__btn--active' : ''}`}
          type="button"
          onClick={() => onSelectMode && onSelectMode('editor')}
        >Editor</button>
        <button
          className={`seg__btn ${historyActive ? 'seg__btn--active' : ''}`}
          type="button"
          onClick={() => onSelectMode && onSelectMode('history')}
        >History{historyCount ? ` (${historyCount})` : ''}</button>
      </div>

      <div className="row gap-2" style={{ marginLeft: 4 }}>
        {editorMode && <AgentPill agent={agent} agents={agents} onSelect={onSelectAgent}/>}

        {editorMode && state === 'running' && (
          <>
            <button className="btn btn--warn" type="button" onClick={onPause}>
              <Ic.Pause cls="icon icon--sm"/>Pause
            </button>
            <button className="btn btn--ghost" type="button" onClick={onCancel}>
              <Ic.X cls="icon icon--sm"/>Cancel
            </button>
          </>
        )}

        {editorMode && state === 'paused-error' && (
          <>
            <button className="btn btn--primary" type="button" onClick={onResume}>
              <Ic.Play cls="icon icon--sm"/>Resume
            </button>
            <button className="btn btn--ghost" type="button" onClick={onCancel}>
              <Ic.X cls="icon icon--sm"/>Cancel
            </button>
          </>
        )}

        {editorMode && state !== 'running' && state !== 'paused-error' && (
          <>
            <button className="btn" title="Save draft · ⌘S" type="button" onClick={onSave} disabled={saving}>
              <Ic.Check cls="icon icon--sm"/>{saving ? 'Saving…' : 'Save'}
            </button>
            <button className={`btn ${simOpen ? 'btn--primary' : ''}`} onClick={onToggleSim} type="button" title="Dry-run · ⌘D">
              <Ic.Eye cls="icon icon--sm"/>Dry-run
            </button>
            <button
              className={`btn btn--primary ${!canLaunch ? 'wf-launch--disabled' : ''}`}
              disabled={!canLaunch || launching}
              onClick={canLaunch && !launching ? onLaunch : undefined}
              type="button"
              title={canLaunch ? 'Launch · ⌘↵' : 'Fix preflight warnings first'}
            >
              <Ic.Bolt cls="icon icon--sm"/>{launching ? 'Launching…' : 'Launch'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ===================================================================
// STEP CANVAS — the center column
// ===================================================================
function StepCanvas({ nodes, setNodes, expandedId, setExpandedId, focusedId, setFocusedId, readOnly, state, onPause, onResume, onCancel, activeRun, prospectCount, groupName }) {
  const canvasRef = useRefWS();
  const [pickerOpen, setPickerOpen] = useStateWF(false);
  const [kbOpen, setKbOpen] = useStateWF(false);

  const toggleExpand = (id) => setExpandedId(x => x === id ? null : id);

  const moveStep = (id, dir) => {
    if (readOnly) return;
    setNodes(ns => {
      const idx = ns.findIndex(n => n.id === id);
      if (idx < 0) return ns;
      // Walk past any delays to find the next non-delay step in the chosen direction.
      let target = idx + dir;
      while (target >= 0 && target < ns.length && ns[target].type === 'delay') {
        target += dir;
      }
      if (target < 0 || target >= ns.length) return ns;
      const copy = [...ns];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
  };

  const deleteStep = (id) => {
    if (readOnly) return;
    setNodes(ns => ns.filter(n => n.id !== id));
  };

  const duplicateStep = (id) => {
    if (readOnly) return;
    setNodes(ns => {
      const idx = ns.findIndex(n => n.id === id);
      const copy = [...ns];
      copy.splice(idx + 1, 0, { ...ns[idx], id: 'n' + Math.random().toString(36).slice(2, 7) });
      return copy;
    });
  };

  const insertDelayAfter = (id) => {
    if (readOnly) return;
    setNodes(ns => {
      const idx = ns.findIndex(n => n.id === id);
      const copy = [...ns];
      copy.splice(idx + 1, 0, { id: 'd' + Math.random().toString(36).slice(2,5), type: 'delay', hours: 24 });
      return copy;
    });
  };

  const updateStep = (id, patch) => {
    if (readOnly) return;
    setNodes(ns => ns.map(n => n.id === id ? { ...n, ...patch } : n));
  };

  const buildDefaultStep = (type) => {
    const id = 's' + Math.random().toString(36).slice(2, 7);
    if (type === 'like_posts') return { id, type, count: 2, filter: 'recent' };
    if (type === 'send_connection') return { id, type, withNote: false, note: '' };
    if (type === 'send_dm') return { id, type, template: '' };
    if (type === 'delay') return { id, type, hours: 24 };
    return { id, type };
  };

  const appendStep = (type) => {
    if (readOnly) return;
    setNodes(ns => [...ns, buildDefaultStep(type)]);
    setPickerOpen(false);
  };

  // keyboard nav
  useEffectWS(() => {
    const onKey = (e) => {
      if (readOnly) return;
      const target = e.target;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      const stepNodes = nodes.filter(n => n.type !== 'delay');
      if (stepNodes.length === 0) return;
      const curIdx = stepNodes.findIndex(n => n.id === focusedId);
      const next = (d) => {
        const ni = Math.max(0, Math.min(stepNodes.length - 1, (curIdx === -1 ? 0 : curIdx + d)));
        setFocusedId(stepNodes[ni].id);
      };

      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); next(1); }
      else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); next(-1); }
      else if (e.key === 'Enter' && focusedId) { e.preventDefault(); toggleExpand(focusedId); }
      else if (e.key === 'd' && !e.metaKey && !e.ctrlKey && focusedId) { e.preventDefault(); duplicateStep(focusedId); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && focusedId && !e.metaKey) { e.preventDefault(); deleteStep(focusedId); }
      else if (e.key === 'i' && focusedId) { e.preventDefault(); insertDelayAfter(focusedId); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp' && focusedId) { e.preventDefault(); moveStep(focusedId, -1); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown' && focusedId) { e.preventDefault(); moveStep(focusedId, 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nodes, focusedId, readOnly]);

  const stepCount = nodes.filter(n => n.type !== 'delay').length;
  const totalHours = nodes.filter(n => n.type === 'delay').reduce((a,n) => a + n.hours, 0);

  return (
    <div className="wf-canvas" ref={canvasRef}>
      <div className="wf-canvas__head">
        <div>
          <div className="eyebrow">Sequence</div>
          <h3 className="wf-canvas__title">{stepCount} steps · {totalHours}h total delay</h3>
        </div>
        <div className="wf-canvas__actions">
          {state === 'running' && (
            <div className="wf-banner wf-banner--info">
              <Ic.Play cls="icon icon--sm s-info"/>
              <span><b>Running.</b> Pause to edit{activeRun && activeRun.name ? ` · ${activeRun.name}` : ''}</span>
              <button className="btn btn--sm" onClick={onPause} type="button"><Ic.Pause cls="icon icon--sm"/>Pause</button>
              <button className="btn btn--sm" onClick={onCancel} type="button" style={{ color: 'var(--danger, #c00)' }}>
                <Ic.X cls="icon icon--sm"/>Cancel
              </button>
            </div>
          )}
          {state === 'paused-error' && (
            <div className="wf-banner wf-banner--danger">
              <Ic.Warn cls="icon icon--sm s-danger"/>
              <span><b>Paused.</b> {activeRun && activeRun.pauseReason ? activeRun.pauseReason : 'Resume when blockers clear.'}</span>
              <button className="btn btn--sm" onClick={onResume} type="button"><Ic.Play cls="icon icon--sm"/>Resume</button>
              <button className="btn btn--sm" onClick={onCancel} type="button" style={{ color: 'var(--danger, #c00)' }}>
                <Ic.X cls="icon icon--sm"/>Cancel
              </button>
            </div>
          )}
          {!readOnly && (
            <div style={{ position: 'relative', display: 'flex', gap: 6 }}>
              <button className="btn btn--sm" type="button" onClick={() => { setPickerOpen(o => !o); setKbOpen(false); }}>
                <Ic.Plus cls="icon icon--sm"/>Add step
              </button>
              <button className="btn btn--sm btn--ghost" type="button" onClick={() => { setKbOpen(o => !o); setPickerOpen(false); }}>
                <Ic.Filter cls="icon icon--sm"/>Keyboard
              </button>
              {pickerOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 20,
                  background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8,
                  boxShadow: 'var(--shadow-md)', minWidth: 220, overflow: 'hidden',
                }}>
                  {['view_profile', 'like_posts', 'send_connection', 'send_dm', 'delay'].map(type => {
                    const def = WF.stepTypes[type] || { label: type };
                    const label = type === 'delay' ? 'Wait (delay)' : (def.label || type);
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => appendStep(type)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '8px 12px', fontSize: 12, background: 'transparent',
                          cursor: 'pointer', borderBottom: '1px solid var(--line)',
                        }}
                      >{label}</button>
                    );
                  })}
                </div>
              )}
              {kbOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 20,
                  background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8,
                  boxShadow: 'var(--shadow-md)', minWidth: 280, padding: 10, fontSize: 12,
                }}>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>Keyboard shortcuts</div>
                  {[
                    ['j / k', 'next / previous step'],
                    ['Enter', 'expand / collapse focused step'],
                    ['d', 'duplicate focused step'],
                    ['i', 'insert delay after focused step'],
                    ['Del / ⌫', 'delete focused step'],
                    ['⌘↑ / ⌘↓', 'move focused step up / down'],
                    ['⌘S', 'save draft'],
                    ['⌘↵', 'launch'],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                      <span className="kbd mono">{k}</span>
                      <span className="s-dim">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="wf-canvas__scroll">
        <div className="wf-flow">
          <div className="wf-flow__start">
            <div className="wf-flow__start-dot"/>
            <div className="wf-flow__start-label">
              <span className="eyebrow">Enter</span>
              <span className="wf-flow__start-sub">
                {prospectCount > 0 && groupName
                  ? `${prospectCount} prospect${prospectCount === 1 ? '' : 's'} from "${groupName}"`
                  : 'No targeting selected — pick a group on the left to enroll prospects'}
              </span>
            </div>
          </div>

          {nodes.map((node, i) => {
            if (node.type === 'delay') {
              return (
                <DelayPill
                  key={node.id}
                  node={node}
                  readOnly={readOnly}
                  onUpdate={(patch) => updateStep(node.id, patch)}
                  onDelete={() => deleteStep(node.id)}
                />
              );
            }
            const stepIdx = nodes.slice(0, i + 1).filter(n => n.type !== 'delay').length - 1;
            return (
              <StepNode
                key={node.id}
                node={node}
                index={stepIdx}
                expanded={expandedId === node.id}
                focused={focusedId === node.id}
                readOnly={readOnly}
                onToggle={() => toggleExpand(node.id)}
                onMove={(d) => moveStep(node.id, d)} /* moveStep walks past delays */
                onDelete={() => deleteStep(node.id)}
                onDuplicate={() => duplicateStep(node.id)}
                onInsertDelay={() => insertDelayAfter(node.id)}
                onUpdate={(patch) => updateStep(node.id, patch)}
              />
            );
          })}

          <div className="wf-flow__end">
            <div className="wf-flow__end-dot"/>
            <div className="wf-flow__end-label">
              <span className="eyebrow">Exit</span>
              <span className="wf-flow__end-sub">Replied · accepted without reply · do-not-contact · completed</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===================================================================
// WORKFLOW STUDIO ROOT
// ===================================================================
function WorkflowStudio({ onNav }) {
  const data = useWorkflowData();
  // Sub-view within the Workflows section.
  // 'editor'  – build/edit a workflow (default)
  // 'history' – list of past runs
  // 'run'     – detail page for one selected run
  const [studioView, setStudioView] = useStateWF('editor');
  const [selectedRunId, setSelectedRunId] = useStateWF(null);
  const [runJobs, setRunJobs] = useStateWF([]);
  const [runJobsLoading, setRunJobsLoading] = useStateWF(false);
  const selectedAgent = useMemoWF(
    () => data.agents.find(a => (a.id || a.agentId) === data.selectedAgentId) || null,
    [data.agents, data.selectedAgentId]
  );
  const boundAccount = useMemoWF(() => {
    if (!selectedAgent) return null;
    const accId = selectedAgent.accountId || selectedAgent.linkedinAccountId || selectedAgent.linkedinAccount;
    return data.accounts.find(a => (a.accountId || a.id) === accId) || data.accounts[0] || null;
  }, [selectedAgent, data.accounts]);

  // Derive live state from active runs bound to the selected agent.
  const activeRun = useMemoWF(() => {
    if (!selectedAgent) return null;
    const agentId = selectedAgent.id || selectedAgent.agentId;
    return data.runs.find(r => {
      const rAgentId = r.agentId || (r.agent && r.agent.id);
      const status = String(r.status || r.state || '').toLowerCase();
      return rAgentId === agentId && (status.includes('running') || status.includes('paused') || status.includes('queued'));
    }) || null;
  }, [selectedAgent, data.runs]);

  const liveState = activeRun
    ? (String(activeRun.status || activeRun.state || '').toLowerCase().includes('paused') ? 'paused-error' : 'running')
    : 'authoring';

  const [runName, setRunName] = useStateWF('New campaign');
  const [nodes, setNodes] = useStateWF(() => []);
  const [expandedId, setExpandedId] = useStateWF(null);
  const [focusedId, setFocusedId] = useStateWF(null);
  const [simOpen, setSimOpen] = useStateWF(false);
  const [toastMsg, setToastMsg] = useStateWF(null);
  const [saving, setSaving] = useStateWF(false);
  const [launching, setLaunching] = useStateWF(false);

  // When the selected agent changes, reset run-name default to reflect it.
  useEffectWF(() => {
    if (selectedAgent && runName === 'New campaign') {
      setRunName(`Campaign — ${selectedAgent.name}`);
    }
  }, [selectedAgent]);

  // If no templates loaded yet, use the default sequence. Otherwise, load the
  // first saved template's steps.
  useEffectWF(() => {
    if (!data.loaded) return;
    if (data.templates.length > 0) {
      const t = data.templates[0];
      const steps = normalizeWorkflowSteps(t.steps);
      if (steps.length > 0) {
        setNodes(steps);
        setRunName(t.name || t.label || runName);
      }
    }
  }, [data.loaded]);

  const state = liveState;
  const readOnly = state === 'running' || state === 'paused-error';

  const toast = (msg) => { setToastMsg(msg); setTimeout(() => setToastMsg(null), 3200); };

  const useStarter = () => {
    const seq = WF.defaultSequence.map(n => ({ ...n, id: 'n' + Math.random().toString(36).slice(2, 7) }));
    setNodes(seq);
    setExpandedId(seq[seq.length - 1] ? seq[seq.length - 1].id : null);
  };

  const startBlank = () => {
    const id = 's' + Math.random().toString(36).slice(2, 7);
    setNodes([{ id, type: 'view_profile' }]);
    setExpandedId(id);
  };

  const browseTemplates = () => {
    if (!data.templates || data.templates.length === 0) {
      toast('No saved templates yet — save a draft first.');
      return;
    }
    const t = data.templates[0];
    const steps = normalizeWorkflowSteps(t.steps);
    if (steps.length > 0) {
      setNodes(steps);
      setRunName(t.name || t.label || runName);
      toast(`Loaded "${t.name || t.label || 'template'}"`);
    } else {
      toast('First template has no steps yet.');
    }
  };

  const handleSave = async () => {
    if (!window.electronAPI || !window.electronAPI.saveAutomationWorkflow) {
      toast('Save unavailable — running outside Electron');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: runName,
        steps: nodes,
        agentId: selectedAgent ? (selectedAgent.id || selectedAgent.agentId) : null,
        updatedAt: new Date().toISOString(),
      };
      await window.electronAPI.saveAutomationWorkflow(payload);
      toast('Draft saved');
      data.reload();
    } catch (e) {
      console.error(e);
      toast('Save failed — ' + (e && e.message ? e.message : 'unknown error'));
    } finally {
      setSaving(false);
    }
  };

  // ── Targeting state (lifted from TargetingPanel) ────────────────────────
  const [targetSource, setTargetSource] = useStateWF(
    () => (data.groups && data.groups.length > 0) ? 'group' : 'search'
  );
  const [searchTerm, setSearchTerm] = useStateWF('');
  const [importText, setImportText] = useStateWF('');
  const [maxProfiles, setMaxProfiles] = useStateWF(10);
  // Results from the live LinkedIn search (when user clicks "Find on LinkedIn").
  const [liveSearch, setLiveSearch] = useStateWF({ term: '', urls: [], loading: false, error: null });

  // Runs the stealth LinkedIn search and returns the URL list. Used inside
  // handleLaunch (Search target). Updates liveSearch state so the panel can
  // surface progress / results.
  const runLiveLinkedInSearch = async () => {
    const term = String(searchTerm || '').trim();
    if (!term) return { ok: false, urls: [], error: 'No search term' };
    if (!window.electronAPI || !window.electronAPI.findLinkedInProfilesBySearch) {
      const error = 'Live search unavailable — running outside Electron';
      toast(error);
      return { ok: false, urls: [], error };
    }
    const accountId = selectedAgent ? (selectedAgent.accountId || null) : null;
    setLiveSearch({ term, urls: [], loading: true, error: null });
    try {
      const res = await window.electronAPI.findLinkedInProfilesBySearch({
        searchTerm: term,
        accountId,
        maxResults: Math.max(1, Math.min(50, Number(maxProfiles) || 10)),
        maxPages: 3,
      });
      if (res && res.success) {
        const urls = Array.isArray(res.urls) ? res.urls : [];
        setLiveSearch({ term, urls, loading: false, error: urls.length ? null : 'LinkedIn returned 0 results — try a different term.' });
        const note = res.sessionRefreshed ? ' (re-logged in first)' : '';
        toast(urls.length ? `Found ${urls.length} profiles on LinkedIn${note}` : `LinkedIn returned 0 results${note}`);
        return { ok: urls.length > 0, urls, error: urls.length ? null : 'LinkedIn returned 0 results' };
      }
      const error = (res && res.error) || 'Search failed';
      setLiveSearch({ term, urls: [], loading: false, error });
      toast('Search failed — ' + error);
      return { ok: false, urls: [], error };
    } catch (e) {
      const error = (e && e.message) || 'Search failed';
      setLiveSearch({ term, urls: [], loading: false, error });
      toast('Search failed — ' + error);
      return { ok: false, urls: [], error };
    }
  };

  // When the user edits the search term, invalidate stale live results.
  useEffectWF(() => {
    if (liveSearch.term && liveSearch.term !== (searchTerm || '').trim()) {
      setLiveSearch({ term: '', urls: [], loading: false, error: null });
    }
  }, [searchTerm]);

  // Extract LinkedIn profile URLs from a free-form blob (URLs, separators, etc).
  const parseLinkedInUrls = (raw) => {
    const matches = String(raw || '').match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%\-À-ɏ.]+\/?/gi) || [];
    const seen = new Set();
    const out = [];
    for (const m of matches) {
      const norm = m.replace(/\/+$/, '');
      if (!seen.has(norm)) { seen.add(norm); out.push(norm); }
    }
    return out;
  };

  // Look up prospect count for the selected group
  const selectedGroup = useMemoWF(() => {
    return data.groups.find(g => (g.id || g.groupId) === data.selectedGroupId) || null;
  }, [data.groups, data.selectedGroupId]);

  // Match the user's saved prospects against the search term.
  const searchMatches = useMemoWF(() => {
    const q = String(searchTerm || '').trim().toLowerCase();
    if (!q) return [];
    const prospects = Array.isArray(data.prospects) ? data.prospects : [];
    return prospects
      .filter(p => {
        const blob = [
          p.title, p.headline, p.role, p.company, p.firstName, p.lastName,
          p.fullName, p.name, ...(Array.isArray(p.tags) ? p.tags : []),
        ].filter(Boolean).join(' ').toLowerCase();
        return blob.includes(q);
      })
      .map(p => p.profileUrl || p.url || p.linkedinUrl || '')
      .filter(Boolean);
  }, [data.prospects, searchTerm]);

  const importUrls = useMemoWF(() => parseLinkedInUrls(importText), [importText]);

  // Resolved target: { type, label, members[] }
  const target = useMemoWF(() => {
    if (targetSource === 'group' && selectedGroup) {
      const members = Array.isArray(selectedGroup.members) ? selectedGroup.members
        : Array.isArray(selectedGroup.profiles) ? selectedGroup.profiles : [];
      return { type: 'group', label: selectedGroup.name || selectedGroup.label || 'Group',
               groupId: selectedGroup.id || selectedGroup.groupId, members };
    }
    if (targetSource === 'search') {
      // Prefer live LinkedIn results when present and current.
      const term = (searchTerm || '').trim();
      if (term && liveSearch.term === term && liveSearch.urls.length > 0) {
        return { type: 'profiles', label: `LinkedIn search: "${term}"`, members: liveSearch.urls };
      }
      if (searchMatches.length) {
        return { type: 'profiles', label: `Saved-prospect match: "${term}"`, members: searchMatches };
      }
    }
    if (targetSource === 'import' && importUrls.length) {
      return { type: 'profiles', label: `Pasted (${importUrls.length} URL${importUrls.length === 1 ? '' : 's'})`, members: importUrls };
    }
    return null;
  }, [targetSource, selectedGroup, searchMatches, searchTerm, importUrls]);

  const prospectCount = target ? target.members.length : 0;

  const preflight = useMemoWF(
    () => computePreflight(selectedAgent, boundAccount, activeRun),
    [selectedAgent, boundAccount, activeRun]
  );
  const math = useMemoWF(
    () => computeMath(nodes, prospectCount, boundAccount, data.analytics),
    [nodes, prospectCount, boundAccount, data.analytics]
  );

  // Starter-sequence stats (shown on EmptyCanvas) derived from real analytics
  const starterStats = useMemoWF(() => {
    const a = data.analytics || {};
    const dms = Number(a.totalDmsSent || 0);
    const conn = Number(a.totalConnections || 0);
    const accepted = Number(a.totalAccepted || 0);
    const replies = Number(a.totalDmReplies || 0);
    const starterMath = computeMath(WF.defaultSequence, 0, boundAccount, a);
    return {
      acceptRate: conn > 0 ? `${Math.round((accepted / conn) * 100)}%` : '—',
      replyRate: dms > 0 ? `${((replies / dms) * 100).toFixed(1)}%` : '—',
      duration: starterMath.perProspect,
      basedOn: conn > 0 ? `${conn} sent` : '—',
    };
  }, [data.analytics, boundAccount]);
  const hasRed = preflight.some(c => c.state === 'danger');
  // For Search mode, Launch unlocks as soon as a term is typed — the search itself
  // runs as the first phase of the campaign. For Group/Import we need a resolved
  // target up front because there's no discovery step.
  const searchModeReady = targetSource === 'search' && (searchTerm || '').trim().length > 0;
  const haveTarget = prospectCount > 0 || searchModeReady;
  const canLaunch = !hasRed && !!selectedAgent && !activeRun && haveTarget;

  const handleLaunch = async () => {
    if (!window.electronAPI || !window.electronAPI.runGroupWorkflow) {
      toast('Launch unavailable — running outside Electron');
      return;
    }
    if (!selectedAgent) { toast('Pick an agent first'); return; }

    // Confirm before doing anything expensive (browser launch / real actions).
    const term = (searchTerm || '').trim();
    const sourceLabel = targetSource === 'search'
      ? `LinkedIn search: "${term || '(empty)'}"`
      : targetSource === 'group'
        ? `Group: ${(selectedGroup && (selectedGroup.name || selectedGroup.label)) || '—'}`
        : targetSource === 'import'
          ? `Pasted URLs: ${importUrls.length}`
          : 'No target';
    const confirmed = window.confirm(
      `Launch "${runName}"?\n\nAgent: ${selectedAgent.name}\nTarget: ${sourceLabel}\n\n` +
      (targetSource === 'search'
        ? 'A visible browser will open, run a stealth LinkedIn search for the term, then queue the workflow against the matches.\n\n'
        : '') +
      'This will queue real LinkedIn actions. Continue?'
    );
    if (!confirmed) return;
    setLaunching(true);
    try {
      // Search-mode launch: run a stealth LinkedIn search first to discover URLs,
      // then queue the workflow against those URLs.
      let resolvedTarget = target;
      if (targetSource === 'search') {
        if (!term) {
          toast('Enter a search term first');
          return;
        }
        // If we already have fresh live results for this exact term, reuse them.
        if (!(liveSearch.term === term && liveSearch.urls.length > 0)) {
          toast('Searching LinkedIn… (visible browser will open)');
          const res = await runLiveLinkedInSearch();
          if (!res.ok || !res.urls.length) {
            toast('Cannot launch — ' + (res.error || 'no results'));
            return;
          }
          resolvedTarget = {
            type: 'profiles',
            label: `LinkedIn search: "${term}"`,
            members: res.urls,
          };
        }
      }
      if (!resolvedTarget || !resolvedTarget.members || resolvedTarget.members.length === 0) {
        toast('No targets to launch against');
        return;
      }
      // Hard cap at maxProfiles so the run never exceeds the operator's intent.
      const cap = Math.max(1, Math.min(50, Number(maxProfiles) || 10));
      if (resolvedTarget.members.length > cap) {
        resolvedTarget = { ...resolvedTarget, members: resolvedTarget.members.slice(0, cap) };
      }
      // Save as template first so the sequence persists
      await window.electronAPI.saveAutomationWorkflow({
        name: runName,
        steps: nodes,
        agentId: selectedAgent.id || selectedAgent.agentId,
        target: {
          type: resolvedTarget.type,
          label: resolvedTarget.label,
          groupId: resolvedTarget.groupId || null,
          members: resolvedTarget.members,
          searchTerm: targetSource === 'search' ? searchTerm.trim() : null,
        },
        updatedAt: new Date().toISOString(),
      }).catch(() => {});

      const actions = nodes.filter(n => n.type !== 'delay').map(n => n.type);
      const payload = {
        actions,
        steps: nodes,
        connectionMessage: (nodes.find(n => n.type === 'send_connection') || {}).note || '',
        dmTemplate: (nodes.find(n => n.type === 'send_dm') || {}).template || '',
        agentId: selectedAgent.id || selectedAgent.agentId,
        accountId: selectedAgent.accountId || null,
        workflowName: runName,
        targetType: resolvedTarget.type,
        groupName: resolvedTarget.label,
        groupMembers: resolvedTarget.members,
        // Manual launches from the UI always run immediately, regardless of
        // the account's configured weekday/hour window.
        bypassWorkingHours: true,
      };
      if (resolvedTarget.type === 'group' && resolvedTarget.groupId) {
        payload.groupId = resolvedTarget.groupId;
      }
      await window.electronAPI.runGroupWorkflow(payload);
      toast(`Launched "${runName}" against ${resolvedTarget.members.length} prospect${resolvedTarget.members.length === 1 ? '' : 's'}`);
      data.reload();
    } catch (e) {
      console.error(e);
      toast('Launch failed — ' + (e && e.message ? e.message : 'unknown error'));
    } finally {
      setLaunching(false);
    }
  };

  const handlePause = async () => {
    if (!activeRun || !window.electronAPI) return;
    const runId = activeRun.runId || activeRun.id;
    try {
      await window.electronAPI.pauseWorkflowRun(runId);
      toast('Run paused');
      data.reload();
    } catch (e) { toast('Pause failed'); }
  };

  const handleResume = async () => {
    if (!activeRun || !window.electronAPI) return;
    const runId = activeRun.runId || activeRun.id;
    try {
      await window.electronAPI.resumeWorkflowRun(runId);
      toast('Run resumed');
      data.reload();
    } catch (e) { toast('Resume failed'); }
  };

  // Load per-job data when the user opens a run's detail view.
  const loadRunJobs = async (runId) => {
    if (!runId || !window.electronAPI || !window.electronAPI.getSdrWorkflowJobs) {
      setRunJobs([]); return;
    }
    setRunJobsLoading(true);
    try {
      const res = await window.electronAPI.getSdrWorkflowJobs(runId);
      const list = Array.isArray(res) ? res : (res && res.jobs) || [];
      setRunJobs(list);
    } catch (e) {
      console.warn('Failed to load workflow jobs:', e);
      setRunJobs([]);
    } finally {
      setRunJobsLoading(false);
    }
  };

  const openRun = (runId) => {
    setSelectedRunId(runId);
    setStudioView('run');
    loadRunJobs(runId);
  };

  // Deep-link from the global search (⌘K).
  useEffectWF(() => {
    const onFocus = (e) => {
      if (!e || !e.detail || !e.detail.id) return;
      openRun(e.detail.id);
    };
    window.addEventListener('connect:focus-run', onFocus);
    return () => window.removeEventListener('connect:focus-run', onFocus);
  }, []);

  const selectedRun = useMemoWF(() => {
    if (!selectedRunId) return null;
    return data.runs.find((r) => (r.id || r.runId) === selectedRunId) || null;
  }, [data.runs, selectedRunId]);

  // Hydrate the editor from a completed/cancelled run so the user can
  // tweak steps and relaunch.
  const openRunInEditor = (run) => {
    if (!run) return;
    const steps = Array.isArray(run.steps) ? run.steps.map((s, i) => ({
      id: 'n' + Math.random().toString(36).slice(2, 7),
      type: s.type,
      hours: s.delayValue && s.delayUnit ? (
        s.delayUnit === 'days' ? s.delayValue * 24
        : s.delayUnit === 'weeks' ? s.delayValue * 24 * 7
        : s.delayUnit === 'months' ? s.delayValue * 24 * 30
        : s.delayValue
      ) : undefined,
      template: s.messageTemplate || '',
      note: s.type === 'send_connection' ? (s.messageTemplate || '') : undefined,
      withNote: s.type === 'send_connection' && !!(s.messageTemplate || '').trim(),
      count: s.type === 'like_posts' ? 2 : undefined,
      filter: s.type === 'like_posts' ? 'recent' : undefined,
    })) : [];
    setNodes(steps);
    setRunName(`${run.workflowName || run.name || 'Run'} — re-run`);
    setStudioView('editor');
    toast('Loaded into editor — adjust steps, then click Launch to start a new run');
  };

  // Permanently delete a run from the store. Auto-cancels first if the run
  // is still queued / running / paused so it can be removed in one click.
  const handleDeleteRun = async (run) => {
    if (!run || !window.electronAPI || !window.electronAPI.deleteSdrWorkflowRun) return;
    const status = String(run.status || '').toLowerCase();
    const isActive = status === 'queued' || status === 'running' || status === 'paused';
    const message = isActive
      ? `Delete "${run.workflowName || run.id}"?\n\nThis run is ${status}. It will be cancelled and then deleted permanently.\n\nAlready-completed actions (profiles visited, connections sent) stay logged in the activity feed.`
      : `Delete "${run.workflowName || run.id}"?\n\nThe run and all its job records will be removed permanently. Already-completed LinkedIn actions stay in the activity feed.\n\nThis cannot be undone.`;
    if (!window.confirm(message)) return;
    try {
      if (isActive && window.electronAPI.cancelSdrWorkflowRun) {
        await window.electronAPI.cancelSdrWorkflowRun(run.id);
      }
      const res = await window.electronAPI.deleteSdrWorkflowRun(run.id);
      if (res && res.success) {
        toast(`Deleted "${run.workflowName || run.id}"`);
        if (selectedRunId === run.id) {
          setSelectedRunId(null);
          setStudioView('history');
        }
        data.reload();
      } else {
        toast('Delete failed — ' + ((res && res.error) || 'unknown'));
      }
    } catch (e) {
      toast('Delete failed — ' + ((e && e.message) || 'unknown'));
    }
  };

  // Save a new Group from a selection of profile URLs.
  const saveGroupFromRun = async ({ name, urls }) => {
    if (!window.electronAPI || !window.electronAPI.getGroupsData || !window.electronAPI.saveGroupsData) {
      toast('Group storage unavailable');
      return;
    }
    try {
      const existing = await window.electronAPI.getGroupsData().catch(() => []);
      const list = Array.isArray(existing) ? existing : (existing && existing.groups) || [];
      const now = new Date().toISOString();
      const newGroup = {
        id: 'group-' + Date.now(),
        name,
        description: `Saved from run ${(selectedRun && selectedRun.id) || ''}`,
        members: urls,
        color: '#0a66c2',
        createdAt: now,
        updatedAt: now,
      };
      await window.electronAPI.saveGroupsData([...list, newGroup]);
      data.reload();
      toast(`Saved group "${name}" with ${urls.length} profiles`);
    } catch (e) {
      toast('Save failed — ' + ((e && e.message) || 'unknown'));
    }
  };

  const handleCancel = async () => {
    if (!activeRun || !window.electronAPI || !window.electronAPI.cancelSdrWorkflowRun) return;
    const runId = activeRun.runId || activeRun.id;
    const label = activeRun.workflowName || activeRun.name || runId;
    if (!window.confirm(
      `Cancel "${label}"?\n\n` +
      `All queued steps will stop and the run will end. Already-completed actions (profiles visited, connections sent) stay logged.\n\n` +
      `This cannot be undone — but you can start a fresh campaign right after.`
    )) return;
    try {
      await window.electronAPI.cancelSdrWorkflowRun(runId);
      toast(`Cancelled "${label}"`);
      // Clear out the form so the user can immediately build the next campaign.
      setNodes([]);
      setExpandedId(null);
      setFocusedId(null);
      setRunName('New campaign');
      setSearchTerm('');
      setImportText('');
      setLiveSearch({ term: '', urls: [], loading: false, error: null });
      data.reload();
    } catch (e) { toast('Cancel failed — ' + ((e && e.message) || 'unknown')); }
  };

  const currentLabel = studioView === 'editor'
    ? runName
    : studioView === 'run'
      ? ((selectedRun && (selectedRun.workflowName || selectedRun.name || selectedRun.id)) || 'Run detail')
      : 'Workflow runs';

  // History view: list of runs OR detail page for one run.
  if (studioView === 'history' || studioView === 'run') {
    return (
      <div className="wf" data-wf-state={state} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <StudioTopbar
          mode={studioView}
          state={state}
          runName={runName}
          setRunName={setRunName}
          currentLabel={currentLabel}
          historyCount={data.runs.length}
          simOpen={simOpen}
          onToggleSim={() => setSimOpen(o => !o)}
          onLaunch={handleLaunch}
          onSave={handleSave}
          onPause={handlePause}
          onResume={handleResume}
          onCancel={handleCancel}
          agent={selectedAgent}
          agents={data.agents}
          onSelectAgent={data.selectAgent}
          canLaunch={canLaunch}
          saving={saving}
          launching={launching}
          onBack={() => onNav && onNav('cockpit')}
          onSelectMode={(next) => { setStudioView(next); if (next !== 'run') setSelectedRunId(null); }}
        />
        <div style={{ flex: 1, minHeight: 0 }}>
          {studioView === 'history' && (
            <WorkflowRunsList
              runs={data.runs}
              onSelectRun={openRun}
              onOpenInEditor={openRunInEditor}
              onDeleteRun={handleDeleteRun}
            />
          )}
          {studioView === 'run' && (
            <WorkflowRunDetail
              run={selectedRun}
              jobs={runJobs}
              onBack={() => { setStudioView('history'); setSelectedRunId(null); }}
              onOpenInEditor={() => openRunInEditor(selectedRun)}
              onSaveAsGroup={saveGroupFromRun}
              onReload={() => { data.reload(); loadRunJobs(selectedRunId); }}
              onDelete={() => handleDeleteRun(selectedRun)}
            />
          )}
        </div>
        {toastMsg && (
          <div className="wf-toast">
            <Ic.Bolt cls="icon s-info"/>
            <span>{toastMsg}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wf" data-wf-state={state}>
      <StudioTopbar
        mode={studioView}
        state={state}
        runName={runName} setRunName={setRunName}
        currentLabel={currentLabel}
        historyCount={data.runs.length}
        simOpen={simOpen}
        onToggleSim={() => setSimOpen(o => !o)}
        onLaunch={handleLaunch}
        onSave={handleSave}
        onPause={handlePause}
        onResume={handleResume}
        onCancel={handleCancel}
        agent={selectedAgent}
        agents={data.agents}
        onSelectAgent={data.selectAgent}
        canLaunch={canLaunch}
        saving={saving}
        launching={launching}
        onBack={() => onNav && onNav('cockpit')}
        onSelectMode={(next) => { setStudioView(next); if (next !== 'run') setSelectedRunId(null); }}
      />

      <div className="wf__main">
        <div className="wf__editor">
          <main className="wf__canvas-shell">
          {nodes.length === 0 ? (
            <EmptyCanvas
              onUseStarter={useStarter}
              onStartBlank={startBlank}
              onBrowseTemplates={browseTemplates}
              stats={starterStats}
            />
          ) : (
            <StepCanvas
              nodes={nodes}
              setNodes={setNodes}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
              focusedId={focusedId}
              setFocusedId={setFocusedId}
              readOnly={readOnly}
              state={state}
              onPause={handlePause}
              onResume={handleResume}
              onCancel={handleCancel}
              activeRun={activeRun}
              prospectCount={prospectCount}
              groupName={target ? target.label : ''}
            />
          )}
          </main>

          <WorkflowSetupRail
            groups={data.groups}
            selectedGroupId={data.selectedGroupId}
            onSelectGroup={data.selectGroup}
            prospectCount={prospectCount}
            targetSource={targetSource}
            onSelectSource={setTargetSource}
            searchTerm={searchTerm}
            onSearchTerm={setSearchTerm}
            searchMatchCount={searchMatches.length}
            importText={importText}
            onImportText={setImportText}
            importUrlCount={importUrls.length}
            targetLabel={target ? target.label : ''}
            liveSearch={liveSearch}
            onRunLiveSearch={runLiveLinkedInSearch}
            searchAccountEmail={selectedAgent && selectedAgent.accountId
              ? (data.accounts.find(a => (a.accountId || a.id) === selectedAgent.accountId) || {}).email || null
              : null}
            maxProfiles={maxProfiles}
            onMaxProfiles={setMaxProfiles}
            preflight={preflight}
            math={math}
            simOpen={simOpen}
            onToggleSim={() => setSimOpen(o => !o)}
          />
        </div>
      </div>

      {toastMsg && (
        <div className="wf-toast">
          <Ic.Bolt cls="icon s-info"/>
          <span>{toastMsg}</span>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { WorkflowStudio });
