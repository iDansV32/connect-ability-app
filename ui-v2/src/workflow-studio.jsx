// Workflow Studio — top-level page, topbar, state switcher, step canvas orchestration

const { useState: useStateWF, useEffect: useEffectWF, useMemo: useMemoWF, useRef: useRefWF } = React;

const WF_STATES = [
  { id: 'empty',        label: 'Empty',         desc: 'First-time · starter suggestion' },
  { id: 'authoring',    label: 'Authoring',     desc: 'Editing DM · step 5 expanded' },
  { id: 'ready',        label: 'Ready',         desc: 'Preflight green · sim open' },
  { id: 'running',      label: 'Running',       desc: 'Read-only · day 2 of 12' },
  { id: 'paused-error', label: 'Paused · error', desc: 'Budget exceeded · resume blocked' },
];

function StatusChip({ state }) {
  if (state === 'running')      return <span className="chip chip--info"><span className="dot dot--pulse s-info"/>Running</span>;
  if (state === 'paused-error') return <span className="chip chip--danger"><span className="dot s-danger"/>Paused</span>;
  if (state === 'ready')        return <span className="chip chip--ok"><span className="dot s-ok"/>Ready</span>;
  if (state === 'empty')        return <span className="chip chip--line"><span className="dot s-dim"/>Unsaved</span>;
  return <span className="chip chip--line"><span className="dot s-warn"/>Draft</span>;
}

function AgentPill({ state }) {
  return (
    <button className="wf-agent">
      <div className="wf-agent__avatar">A</div>
      <div className="wf-agent__meta">
        <div className="wf-agent__name">Atlas</div>
        <div className="wf-agent__sub mono">persona 4/4</div>
      </div>
      <Ic.ChevronDown cls="icon icon--sm"/>
    </button>
  );
}

function StudioTopbar({ state, setState, runName, setRunName, simOpen, onToggleSim, onLaunch }) {
  const canLaunch = state === 'ready';
  return (
    <div className="wf-top">
      <div className="wf-top__left">
        <button className="btn btn--ghost btn--icon" title="Back to workflows"><Ic.ChevronLeft cls="icon"/></button>
        <div className="wf-top__crumb mono s-dim">Workflows</div>
        <Ic.ChevronRight cls="icon icon--sm s-dim"/>
        <input
          className="wf-top__name"
          value={runName}
          onChange={e => setRunName(e.target.value)}
          spellCheck={false}
        />
        <StatusChip state={state}/>
      </div>

      <div className="wf-top__center">
        <div className="wf-states">
          <span className="mono s-dim wf-states__lbl">preview state</span>
          {WF_STATES.map(s => (
            <button
              key={s.id}
              className={`wf-states__btn ${state === s.id ? 'wf-states__btn--active' : ''}`}
              onClick={() => setState(s.id)}
              title={s.desc}
            >{s.label}</button>
          ))}
        </div>
      </div>

      <div className="wf-top__right">
        <AgentPill state={state}/>
        <div className="divider--v" style={{ height: 20, margin: '0 4px' }}/>
        <button className="btn btn--ghost" title="Save draft · ⌘S"><Ic.Check cls="icon icon--sm"/>Save</button>
        <button className={`btn ${simOpen ? 'btn--primary' : ''}`} onClick={onToggleSim} title="Dry-run · ⌘D">
          <Ic.Eye cls="icon icon--sm"/>Dry-run
        </button>
        <button
          className={`btn btn--primary ${!canLaunch ? 'wf-launch--disabled' : ''}`}
          disabled={!canLaunch}
          onClick={canLaunch ? onLaunch : undefined}
          title={canLaunch ? 'Launch · ⌘↵' : 'Launch available once preflight is green'}
        >
          <Ic.Bolt cls="icon icon--sm"/>Launch
        </button>
      </div>
    </div>
  );
}

// ===================================================================
// STEP CANVAS — the center column
// ===================================================================
function StepCanvas({ nodes, setNodes, expandedId, setExpandedId, focusedId, setFocusedId, readOnly, state }) {
  const canvasRef = useRefWS();

  const toggleExpand = (id) => setExpandedId(x => x === id ? null : id);

  const moveStep = (id, dir) => {
    if (readOnly) return;
    setNodes(ns => {
      const idx = ns.findIndex(n => n.id === id);
      const target = idx + dir;
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
              <span><b>Running.</b> Pause to edit · 247 prospects enrolled · day 2 of 12</span>
              <button className="btn btn--sm"><Ic.Pause cls="icon icon--sm"/>Pause</button>
            </div>
          )}
          {state === 'paused-error' && (
            <div className="wf-banner wf-banner--danger">
              <Ic.Warn cls="icon icon--sm s-danger"/>
              <span><b>Paused at step 4 of 5</b> for 12 prospects · resume disabled until daily budget resets</span>
              <button className="btn btn--sm">Details</button>
            </div>
          )}
          {!readOnly && (
            <>
              <button className="btn btn--sm"><Ic.Plus cls="icon icon--sm"/>Add step</button>
              <button className="btn btn--sm btn--ghost"><Ic.Filter cls="icon icon--sm"/>Keyboard</button>
            </>
          )}
        </div>
      </div>

      <div className="wf-canvas__scroll">
        <div className="wf-flow">
          <div className="wf-flow__start">
            <div className="wf-flow__start-dot"/>
            <div className="wf-flow__start-label">
              <span className="eyebrow">Enter</span>
              <span className="wf-flow__start-sub">847 prospects from "RevOps VPs · Series B · US"</span>
            </div>
          </div>

          {nodes.map((node, i) => {
            if (node.type === 'delay') {
              return <DelayPill key={node.id} node={node} readOnly={readOnly}/>;
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
                onMove={(d) => moveStep(node.id, d * 2)} /* step over paired delay */
                onDelete={() => deleteStep(node.id)}
                onDuplicate={() => duplicateStep(node.id)}
                onInsertDelay={() => insertDelayAfter(node.id)}
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
function WorkflowStudio() {
  const [state, setState] = useStateWF(() => localStorage.getItem('connect:wf-state') || 'authoring');
  const [runName, setRunName] = useStateWF('Campaign — Atlas — Q4 RevOps VPs');
  const [nodes, setNodes] = useStateWF(() => WF.defaultSequence);

  // default expanded step based on state
  const [expandedId, setExpandedId] = useStateWF(() => 's5');  // the DM
  const [focusedId, setFocusedId] = useStateWF('s5');
  const [simOpen, setSimOpen] = useStateWF(false);
  const [toastMsg, setToastMsg] = useStateWF(null);

  useEffectWF(() => { localStorage.setItem('connect:wf-state', state); }, [state]);

  // apply state-driven defaults
  useEffectWF(() => {
    if (state === 'empty') {
      setNodes([]);
      setExpandedId(null);
    } else if (state === 'authoring') {
      setNodes(WF.defaultSequence);
      setExpandedId('s5');
      setFocusedId('s5');
      setSimOpen(false);
    } else if (state === 'ready') {
      // swap DM to a persona-clean variant
      setNodes(WF.defaultSequence.map(n =>
        n.id === 's5' ? { ...n, template: "Hey {first_name}, {Hi|Hey|Quick note —} thanks for connecting. Noticed you're {rolling out Gong|scaling your RevOps function} at {company} — we shipped attribution wiring for four Series B RevOps leads this quarter. Worth a 15m swap?" } : n
      ));
      setExpandedId(null);
      setSimOpen(true);
    } else if (state === 'running' || state === 'paused-error') {
      setNodes(WF.defaultSequence);
      setExpandedId(null);
      setSimOpen(state === 'paused-error');
    }
  }, [state]);

  const useStarter = () => {
    setNodes(WF.defaultSequence);
    setState('authoring');
    setExpandedId('s5');
  };

  const launch = () => {
    setState('running');
    setToastMsg('Campaign launched · 847 prospects queued');
    setTimeout(() => setToastMsg(null), 3200);
  };

  const readOnly = state === 'running' || state === 'paused-error';

  return (
    <div className="wf" data-wf-state={state}>
      <StudioTopbar
        state={state} setState={setState}
        runName={runName} setRunName={setRunName}
        simOpen={simOpen}
        onToggleSim={() => setSimOpen(o => !o)}
        onLaunch={launch}
      />

      <div className="wf__grid">
        <TargetingPanel state={state}/>

        <main className="wf-center">
          {state === 'empty' ? (
            <EmptyCanvas onUseStarter={useStarter}/>
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
            />
          )}
        </main>

        <ReadinessPanel
          state={state}
          simOpen={simOpen}
          onToggleSim={() => setSimOpen(o => !o)}
          onLaunch={launch}
        />
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
