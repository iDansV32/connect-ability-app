// Cockpit — operator home. Configurable: pick the metrics + panels you want.
// Visual language: colored bar-rows (funnel / account health / active runs).
// Live data comes from electronAPI; falls back to MOCK in the design preview.

const { useState: useStateC, useEffect: useEffectC, useMemo: useMemoC } = React;

// Stable hue (0–360) from a string, for avatars / run bars on live data.
function hueFromString(s) {
  s = String(s || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// Retained for any external callers; unused by the redesigned cockpit.
function Sparkline({ data, w = 96, h = 26, color = 'var(--accent)' }) {
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * (h - 4) - 2]);
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
}

function KpiCard({ kpi }) {
  const pos = kpi.delta > 0, neg = kpi.delta < 0;
  return (
    <div className="kpi">
      <div className="kpi__top">
        <span className="kpi__dot" style={{ background: kpi.color }} />
        <span className="kpi__label">{kpi.label}</span>
      </div>
      <div className="kpi__val tabular">{Number(kpi.value || 0).toLocaleString()}</div>
      <span className={`kpi__delta ${pos ? 'kpi__delta--up' : neg ? 'kpi__delta--down' : ''}`}>
        {pos ? <Ic.ArrowUp cls="icon--sm" /> : neg ? <Ic.ArrowDown cls="icon--sm" /> : null}
        {Math.abs(kpi.delta || 0).toFixed(1)}%
      </span>
    </div>
  );
}

function FunnelBar({ funnel }) {
  const max = funnel[0] ? funnel[0].value : 1;
  return (
    <div className="funnel">
      {funnel.map((f, i) => {
        const w = Math.max((f.value / (max || 1)) * 100, 7);
        const conv = i > 0 && funnel[i - 1].value ? ((f.value / funnel[i - 1].value) * 100).toFixed(0) : null;
        return (
          <div key={f.label} className="funnel__row">
            <div className="col" style={{ gap: 1 }}>
              <span className="funnel__name">{f.label}</span>
              <span className="funnel__pct s-dim tabular">{(f.pct || 0).toFixed(1)}% of sent</span>
            </div>
            <div className="funnel__track">
              <div className="funnel__fill" style={{ width: `${w}%`, background: f.color }}>
                {f.value.toLocaleString()}
              </div>
            </div>
            <span className="funnel__conv">{conv ? `${conv}% →` : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

const AH_STATUS = {
  ok:        { label: 'Healthy',     chip: 'chip--ok',     color: 'var(--c-green)' },
  warm:      { label: 'Warming up',  chip: 'chip--info',   color: 'var(--c-sky)' },
  cooldown:  { label: 'Cooldown',    chip: 'chip--warn',   color: 'var(--c-orange)' },
  challenge: { label: 'Challenge',   chip: 'chip--danger', color: 'var(--c-rose)' },
  banned:    { label: 'Restricted',  chip: 'chip--danger', color: 'var(--c-rose)' },
};

function AccountHealthRow({ acc }) {
  const st = AH_STATUS[acc.status] || AH_STATUS.ok;
  const budget = acc.dailyCeil > 0 ? (acc.dailyUsed / acc.dailyCeil) * 100 : 0;
  return (
    <div className="vrow vrow--health">
      <div className="vrow__label">
        <Avatar name={acc.name} hue={acc.hue} size={34} />
        <div className="col" style={{ minWidth: 0, gap: 1 }}>
          <span className="vrow__name truncate">{acc.name}</span>
          <span className="s-dim truncate" style={{ fontSize: 12 }}>{acc.email || ('@' + acc.handle)}</span>
        </div>
      </div>
      <div className="vtrack">
        <div className="vfill" style={{ width: Math.max(budget, 13) + '%', background: st.color }}>{acc.dailyUsed} / {acc.dailyCeil}</div>
      </div>
      <div className="vrow__trail">
        <span className="s-dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Warm {acc.warmDay}/{acc.warmTotal}d</span>
        <span className={`chip ${st.chip} chip--sm`} style={{ minWidth: 92, justifyContent: 'center' }}><span className={`dot ${acc.status === 'challenge' ? 'dot--pulse' : ''}`} />{st.label}</span>
      </div>
    </div>
  );
}

function RunRow({ run, onToggle }) {
  const map = {
    running: { label: 'Running', chip: 'chip--ok', pulse: true },
    paused: { label: 'Paused', chip: 'chip--warn', pulse: false },
    queued: { label: 'Queued', chip: 'chip--info', pulse: false },
  };
  const st = map[run.state] || map.queued;
  const total = run.total || 0;
  const done = run.done || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const color = run.hue != null ? window.oklchHex(62, 0.16, run.hue) : 'var(--accent)';
  return (
    <div className="vrow vrow--run">
      <div className="col" style={{ gap: 2, minWidth: 0 }}>
        <span className="vrow__name truncate">{run.name}</span>
        <span className="s-dim truncate" style={{ fontSize: 12 }}>via {run.agent}{run.pauseReason ? ` · ${run.pauseReason}` : ''}</span>
      </div>
      <div className="vtrack">
        <div className="vfill" style={{ width: Math.max(pct, 13) + '%', background: run.state === 'queued' ? 'var(--text-faint)' : color }}>{done.toLocaleString()} / {total.toLocaleString()}</div>
      </div>
      <div className="vrow__trail">
        <span className="tabular s-dim" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{run.per_hour}/hr</span>
        <span className={`chip ${st.chip} chip--sm`} style={{ minWidth: 84, justifyContent: 'center' }}><span className={`dot ${st.pulse ? 'dot--pulse' : ''}`} />{st.label}</span>
        <button className="btn btn--icon btn--sm" onClick={() => onToggle(run.id)} title={run.state === 'running' ? 'Pause' : 'Resume'}>
          {run.state === 'running' ? <Ic.Pause cls="icon--sm" /> : <Ic.Play cls="icon--sm" />}
        </button>
      </div>
    </div>
  );
}

// ===================================================================
// Real-data adapters — transform electronAPI responses into the shape
// the cockpit expects. Each falls back to MOCK when the API is missing.
// ===================================================================
function fmtRelative(ms) {
  if (!ms) return null;
  const diff = Date.now() - Number(ms);
  if (diff < 0) return 'now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

const KPI_COLORS = {
  viewed: 'var(--c-violet)', requests: 'var(--c-indigo)', accepted: 'var(--c-blue)',
  dms: 'var(--c-sky)', replies: 'var(--c-teal)', posts: 'var(--c-amber)',
};

function adaptKpis(analytics, inboxUnread, postsActive) {
  const t = (analytics && analytics.totals) || {};
  return [
    { key: 'viewed',   label: 'Profiles viewed',  value: Number(t.profilesViewed        || 0), delta: 0, color: KPI_COLORS.viewed },
    { key: 'requests', label: 'Connections sent', value: Number(t.connectionRequests    || 0), delta: 0, color: KPI_COLORS.requests },
    { key: 'accepted', label: 'Accepted',         value: Number(t.connectionAcceptances || 0), delta: 0, color: KPI_COLORS.accepted },
    { key: 'dms',      label: 'DMs sent',         value: Number(t.dmsSent               || 0), delta: 0, color: KPI_COLORS.dms },
    { key: 'replies',  label: 'Replies received', value: Number(t.dmReplies             || 0), delta: 0, color: KPI_COLORS.replies },
    { key: 'posts',    label: 'Posts published',  value: Number(postsActive             || 0), delta: 0, color: KPI_COLORS.posts },
  ];
}

function adaptFunnel(analytics, interestedCount) {
  const t = (analytics && analytics.totals) || {};
  const sent = Number(t.connectionRequests || 0);
  const accepted = Number(t.connectionAcceptances || 0);
  const replied = Number(t.dmReplies || 0);
  const interested = Number(interestedCount || 0);
  const base = Math.max(sent, 1);
  const pct = (n) => (n / base) * 100;
  return [
    { label: 'Sent',       value: sent,       pct: 100,            color: 'var(--c-violet)' },
    { label: 'Accepted',   value: accepted,   pct: pct(accepted),  color: 'var(--c-blue)' },
    { label: 'Replied',    value: replied,    pct: pct(replied),   color: 'var(--c-teal)' },
    { label: 'Interested', value: interested, pct: pct(interested),color: 'var(--c-green)' },
  ];
}

function adaptAccounts(healthRows) {
  if (!Array.isArray(healthRows)) return [];
  return healthRows.map((a, i) => {
    const rawStatus = String(a.status || a.state || '').toLowerCase();
    let status = 'ok';
    if (rawStatus.includes('challenge')) status = 'challenge';
    else if (rawStatus.includes('cooldown')) status = 'cooldown';
    else if (rawStatus.includes('warm'))     status = 'warm';
    else if (rawStatus.includes('banned') || rawStatus.includes('restrict')) status = 'banned';
    const email = a.email || a.handle || a.accountId || '';
    const handle = (String(email).split('@')[0] || '').replace(/\s+/g, '.').toLowerCase();
    const id = a.accountId || a.id || ('acc_' + i);
    const name = a.name || a.displayName || email || 'Account';
    return {
      id, name, handle, email: a.email || '',
      hue: a.hue != null ? a.hue : hueFromString(id + name),
      status,
      dailyUsed: Number(a.dailyUsed || a.quotaUsed || a.actionsToday || 0),
      dailyCeil: Number(a.dailyCeil || a.quotaCeiling || a.dailyLimit || 0),
      warmDay: Number(a.warmDay || a.warmUpDay || 0),
      warmTotal: Number(a.warmTotal || a.warmUpTotal || 28),
      lastChallenge: fmtRelative(a.lastChallengeAt || a.lastChallenge || a.challengeDetectedAt),
    };
  });
}

function adaptRuns(runRows, agents) {
  if (!Array.isArray(runRows)) return [];
  const agentById = new Map((agents || []).map(a => [a.id || a.agentId, a]));
  return runRows.map((r, i) => {
    const rawStatus = String(r.status || r.state || '').toLowerCase();
    let state = 'queued';
    if (rawStatus.includes('running'))       state = 'running';
    else if (rawStatus.includes('paused'))   state = 'paused';
    else if (rawStatus.includes('queued') || rawStatus.includes('pending')) state = 'queued';
    const agentRec = agentById.get(r.agentId);
    const agentName = (agentRec && agentRec.name) || r.agentName || r.agent || '—';
    const queue = Number(r.queueSize || r.pending || r.remaining || 0);
    const total = Number(r.total || r.targetCount || r.totalTargets || r.queueTotal || (queue + Number(r.done || r.completed || 0)) || queue);
    const done = Number(r.done || r.completed || r.processed || Math.max(total - queue, 0));
    return {
      id: r.runId || r.id || ('r' + i),
      name: r.name || r.workflowName || r.templateName || 'Unnamed run',
      agent: agentName,
      hue: (agentRec && agentRec.hue != null) ? agentRec.hue : hueFromString(agentName),
      state,
      per_hour: Number(r.actionsPerHour || r.rateHr || 0),
      queue, total, done,
      pauseReason: r.pauseReason || r.pausedReason || null,
    };
  });
}

function deriveNeedsMe({ accounts, runs, unreadInbox }) {
  const out = [];
  if (unreadInbox > 0) {
    out.push({ id: 'reply', kind: 'reply', label: unreadInbox + ' unread ' + (unreadInbox === 1 ? 'reply' : 'replies') + ' · triage', severity: 'info', href: 'inbox' });
  }
  (accounts || []).forEach(a => {
    if (a.status === 'challenge') {
      out.push({ id: 'ch-' + a.id, kind: 'challenge', label: a.name + ' — account challenge' + (a.lastChallenge ? ' (' + a.lastChallenge + ')' : ''), severity: 'danger', href: 'settings' });
    }
  });
  const paused = (runs || []).filter(r => r.state === 'paused');
  if (paused.length) {
    out.push({ id: 'paused', kind: 'paused', label: paused.length + ' ' + (paused.length === 1 ? 'workflow' : 'workflows') + ' paused — needs review', severity: 'warn', href: 'workflows' });
  }
  (accounts || []).forEach(a => {
    if (a.dailyCeil > 0 && a.dailyUsed / a.dailyCeil >= 0.9 && a.status !== 'challenge') {
      out.push({ id: 'budget-' + a.id, kind: 'budget', label: a.name + ' at ' + Math.round(a.dailyUsed / a.dailyCeil * 100) + '% daily ceiling', severity: 'warn', href: 'settings' });
    }
  });
  return out;
}

function useCockpitData() {
  // A fresh install must never render invented numbers. Seed from the same
  // adapters the live path uses, fed empty inputs, so the zeroed shape cannot
  // drift from adaptKpis/adaptFunnel — and so a failed load leaves zeros on
  // screen instead of demo data.
  const [state, setState] = useStateC(() => ({
    kpis: adaptKpis({}, 0, 0), funnel: adaptFunnel({}, 0), accounts: [], runs: [],
    needsMe: [], operatorName: '', loaded: false,
  }));

  const load = async () => {
    if (!window.electronAPI) {
      // Design-preview mode: no Electron bridge, so there is no real data to
      // read. Populate from the demo fixture so the shipped layouts can be
      // reviewed in a plain browser. This branch never runs inside the app.
      setState({
        kpis: MOCK.kpis, funnel: MOCK.funnel, accounts: [], runs: [],
        needsMe: MOCK.needsMe, operatorName: '', loaded: false,
      });
      return;
    }
    try {
      const [analytics, healthRaw, accountsRaw, runsRaw, agentsRaw, inboxRaw, postsRaw] = await Promise.all([
        window.electronAPI.getActivityAnalytics({}).catch(() => ({})),
        window.electronAPI.getLinkedInAccountHealth().catch(() => ({})),
        window.electronAPI.getLinkedInAccounts().catch(() => []),
        window.electronAPI.getSdrWorkflowRuns().catch(() => []),
        window.electronAPI.getSdrAgents().catch(() => []),
        window.electronAPI.getInbox({}).catch(() => ({ conversations: [] })),
        window.electronAPI.getScheduledPosts().catch(() => ({ posts: [] })),
      ]);

      const accountList = Array.isArray(accountsRaw) ? accountsRaw : (accountsRaw && accountsRaw.accounts) || [];
      const healthMap = (healthRaw && typeof healthRaw === 'object' && !Array.isArray(healthRaw)) ? healthRaw : {};
      const healthList = accountList.map((acc) => {
        const h = healthMap[acc.id] || {};
        const challengeAt = h.challenged && h.challenged.at;
        const workflowStatus = h.workflow && h.workflow.status;
        let status = 'ok';
        if (challengeAt) status = 'challenge';
        else if (workflowStatus === 'cooldown') status = 'cooldown';
        return {
          ...acc,
          status,
          lastChallengeAt: challengeAt || null,
          dailyUsed: acc.dailyUsed || 0,
          dailyCeil: acc.dailyCeiling || acc.dailyLimit || 0,
        };
      });
      const runsList = Array.isArray(runsRaw) ? runsRaw : (runsRaw && runsRaw.runs) || [];
      const agentsList = Array.isArray(agentsRaw) ? agentsRaw : (agentsRaw && agentsRaw.agents) || [];
      const inboxList = Array.isArray(inboxRaw) ? inboxRaw : (inboxRaw && inboxRaw.conversations) || [];
      const postList = Array.isArray(postsRaw) ? postsRaw : (postsRaw && postsRaw.posts) || [];

      const unreadInbox = inboxList.filter(c => c.unread || c.status === 'new' || c.status === 'paused').length;
      const interested = inboxList.filter(c => String(c.intent || '').toLowerCase() === 'interested').length;
      const postsActive = postList.filter(p => {
        const s = String(p.status || '').toLowerCase();
        return s && s !== 'cancelled' && s !== 'failed';
      }).length;

      const accounts = adaptAccounts(healthList);
      const runs = adaptRuns(runsList, agentsList);
      const kpis = adaptKpis(analytics, unreadInbox, postsActive);
      const funnel = adaptFunnel(analytics, interested);
      const needsMe = deriveNeedsMe({ accounts, runs, unreadInbox });

      const operatorName = (agentsList[0] && agentsList[0].name) || '';
      setState({ kpis, funnel, accounts, runs, needsMe, operatorName, loaded: true });
    } catch (e) {
      console.warn('Cockpit load failed:', e);
    }
  };

  useEffectC(() => {
    load();
    if (!window.electronAPI || !window.electronAPI.on) return;
    const refresh = () => { load(); };
    ['activity-analytics-updated', 'linkedin-runtime-updated',
     'linkedin-account-health-updated', 'sdr-workflow-runs-updated',
     'inbox-updated', 'linkedin-challenge-detected',
     'post-published', 'prospects-updated', 'sdr-agents-updated'
    ].forEach(ch => window.electronAPI.on(ch, refresh));
    const poll = setInterval(load, 30000);
    return () => clearInterval(poll);
  }, []);

  return state;
}

// ---------- Customize popover ----------
const DEFAULT_COCKPIT = {
  metrics: { viewed: true, requests: true, accepted: false, dms: false, replies: true, posts: false },
  sections: { needs: true, runs: true, funnel: false, health: false },
};

function ToggleRow({ label, checked, onChange, color }) {
  return (
    <button className="cfg-row" onClick={() => onChange(!checked)}>
      <span className="cfg-row__label">{color && <span className="dot" style={{ color, width: 8, height: 8 }} />}{label}</span>
      <span className={`cfg-switch ${checked ? 'cfg-switch--on' : ''}`}><span className="cfg-switch__knob" /></span>
    </button>
  );
}

function CustomizePanel({ cfg, setCfg, metrics, onClose }) {
  const setMetric = (k, v) => setCfg(c => ({ ...c, metrics: { ...c.metrics, [k]: v } }));
  const setSection = (k, v) => setCfg(c => ({ ...c, sections: { ...c.sections, [k]: v } }));
  const panels = [['needs', 'Needs you'], ['runs', 'Active runs'], ['funnel', 'Outreach funnel'], ['health', 'Account health']];
  return (
    <>
      <div className="popover-scrim" onClick={onClose} />
      <div className="cfg-pop">
        <div className="cfg-pop__head">
          <span style={{ fontWeight: 650, fontSize: 14 }}>Customize cockpit</span>
          <button className="btn btn--ghost btn--icon btn--sm" onClick={onClose}><Ic.X cls="icon--sm" /></button>
        </div>
        <div className="cfg-pop__body">
          <div className="cfg-pop__sec">
            <div className="eyebrow" style={{ marginBottom: 4 }}>Metrics</div>
            {metrics.map(k => <ToggleRow key={k.key} label={k.label} color={k.color} checked={!!cfg.metrics[k.key]} onChange={v => setMetric(k.key, v)} />)}
          </div>
          <div className="cfg-pop__sec">
            <div className="eyebrow" style={{ marginBottom: 4 }}>Panels</div>
            {panels.map(([id, label]) => <ToggleRow key={id} label={label} checked={!!cfg.sections[id]} onChange={v => setSection(id, v)} />)}
          </div>
        </div>
      </div>
    </>
  );
}

function Cockpit({ onNav }) {
  const data = useCockpitData();
  const [range, setRange] = useStateC('7d');
  const [cfg, setCfg] = useStateC(() => {
    try { const s = JSON.parse(localStorage.getItem('connect:cockpit')); if (s && s.metrics && s.sections) return s; } catch {}
    return DEFAULT_COCKPIT;
  });
  const [customOpen, setCustomOpen] = useStateC(false);
  const [pausedIds, setPausedIds] = useStateC(new Set());
  useEffectC(() => { localStorage.setItem('connect:cockpit', JSON.stringify(cfg)); }, [cfg]);

  useEffectC(() => {
    setPausedIds(new Set(data.runs.filter(r => r.state === 'paused').map(r => r.id)));
  }, [data.runs]);

  const toggleRun = (id) => {
    const isPaused = pausedIds.has(id);
    setPausedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    if (window.electronAPI) {
      (isPaused ? window.electronAPI.resumeWorkflowRun : window.electronAPI.pauseWorkflowRun)(id)
        .catch(e => console.warn('Toggle run failed:', e));
    }
  };

  const runs = data.runs.map(r => ({
    ...r,
    state: pausedIds.has(r.id) ? 'paused' : (r.state === 'queued' ? 'queued' : 'running'),
    per_hour: pausedIds.has(r.id) ? 0 : (r.state === 'queued' ? 0 : r.per_hour),
  }));

  const shownKpis = data.kpis.filter(k => cfg.metrics[k.key]);

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  // No fixture fallback: on a fresh install there is no operator name yet, and
  // the greeting below already degrades to "there".
  const firstName = String(data.operatorName || '').split(/\s+/)[0];
  const healthy = data.accounts.filter(a => a.status === 'ok').length;
  const total = data.accounts.length;
  const running = runs.filter(r => r.state === 'running').length;
  const urgent = data.needsMe.filter(n => n.severity === 'danger').length;

  const S = cfg.sections;
  const topPair = [S.funnel && 'funnel', S.needs && 'needs'].filter(Boolean);
  const nothingOn = shownKpis.length === 0 && !S.funnel && !S.needs && !S.runs && !S.health;

  const FunnelCard = (
    <section className="card" key="funnel">
      <div className="card__header card__header--bordered">
        <div className="row gap-2"><span className="card__title">Outreach funnel</span><span className="chip chip--line chip--sm mono">{range}</span></div>
        <button className="btn btn--ghost btn--sm" onClick={() => onNav('prospects')}>Full report<Ic.ArrowRight cls="icon--sm" /></button>
      </div>
      <div className="card__body"><FunnelBar funnel={data.funnel} /></div>
    </section>
  );
  const NeedsCard = (
    <section className="card" key="needs">
      <div className="card__header card__header--bordered">
        <span className="card__title">Needs you</span>
        {urgent > 0
          ? <span className="chip chip--danger"><span className="dot dot--pulse" />{urgent} urgent</span>
          : <span className="chip chip--line chip--sm">{data.needsMe.length} items</span>}
      </div>
      <div className="needs">
        {data.needsMe.length === 0
          ? <div className="empty-pad">Nothing needs you right now.</div>
          : data.needsMe.map(n => {
            const Icon = n.kind === 'reply' ? Ic.Inbox : n.kind === 'challenge' ? Ic.Warn : n.kind === 'paused' ? Ic.Pause : Ic.Bolt;
            return (
              <button key={n.id} className="needs__row" onClick={() => onNav(n.href)}>
                <span className={`needs__icon needs__icon--${n.severity}`}><Icon cls="icon--sm" /></span>
                <span className="needs__text">{n.label}</span>
                <Ic.ChevronRight cls="icon s-faint" />
              </button>
            );
          })}
      </div>
    </section>
  );

  return (
    <div className="cockpit">
      <div className="cockpit__head">
        <div>
          <h1 className="page-title">{greet}, <span className="greet-accent">{firstName || 'there'}</span>.</h1>
          <p className="page-sub row gap-2" style={{ alignItems: 'center' }}>
            <span className="dot" style={{ color: total > 0 && healthy === total ? 'var(--ok)' : 'var(--warn)', width: 7, height: 7 }} />
            <span style={{ color: 'var(--text-2)' }}>{total > 0 ? `${healthy} of ${total} accounts healthy` : 'No accounts configured'}</span>
            <span className="s-faint">·</span>
            <span className="s-dim">{running} {running === 1 ? 'workflow' : 'workflows'} running</span>
          </p>
        </div>
        <div className="row gap-2">
          <div className="seg">
            {['Today', '7d', '30d'].map(r => (
              <button key={r} className={`seg__btn ${range === r ? 'seg__btn--active' : ''}`} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <button className={`btn ${customOpen ? 'btn--soft' : ''}`} onClick={() => setCustomOpen(o => !o)}><Ic.Filter cls="icon--sm" />Customize</button>
            {customOpen && <CustomizePanel cfg={cfg} setCfg={setCfg} metrics={data.kpis} onClose={() => setCustomOpen(false)} />}
          </div>
          <button className="btn btn--primary" onClick={() => window.dispatchEvent(new CustomEvent('connect:newagent'))}><Ic.Plus cls="icon--sm" />New agent</button>
        </div>
      </div>

      {nothingOn ? (
        <div className="cockpit-empty">
          <div className="cockpit-empty__icon"><Ic.Cockpit cls="icon--lg" /></div>
          <div style={{ fontSize: 16, fontWeight: 650, marginTop: 14 }}>Your cockpit is empty</div>
          <p className="s-dim" style={{ fontSize: 13.5, marginTop: 4, maxWidth: 340 }}>Pick the metrics and panels you care about — your cockpit stays focused on what matters to you.</p>
          <button className="btn btn--primary" style={{ marginTop: 16 }} onClick={() => setCustomOpen(true)}><Ic.Filter cls="icon--sm" />Customize cockpit</button>
        </div>
      ) : (
        <>
          {shownKpis.length > 0 && (
            <section className="kpis">
              {shownKpis.map(k => <KpiCard key={k.key} kpi={k} />)}
            </section>
          )}

          {topPair.length > 0 && (
            <div className="cockpit__pair" style={{ gridTemplateColumns: topPair.length === 2 ? '1.4fr 1fr' : '1fr' }}>
              {S.funnel && FunnelCard}
              {S.needs && NeedsCard}
            </div>
          )}

          {S.health && (
            <section className="card" style={{ marginTop: 18 }}>
              <div className="card__header card__header--bordered">
                <div className="row gap-2"><span className="card__title">Account health</span><span className="s-dim" style={{ fontSize: 12.5 }}>{total} LinkedIn {total === 1 ? 'account' : 'accounts'}</span></div>
                <button className="btn btn--ghost btn--sm" onClick={() => onNav('settings')}>Manage<Ic.ArrowRight cls="icon--sm" /></button>
              </div>
              <div className="vhead vhead--health">
                <span className="eyebrow">Account</span>
                <span className="eyebrow">Daily budget used</span>
                <span className="eyebrow" style={{ textAlign: 'right' }}>Warm-up · status</span>
              </div>
              {data.accounts.length === 0
                ? <div className="empty-pad">No accounts connected yet.</div>
                : data.accounts.map(a => <AccountHealthRow key={a.id} acc={a} />)}
            </section>
          )}

          {S.runs && (
            <section className="card" style={{ marginTop: 18 }}>
              <div className="card__header card__header--bordered">
                <div className="row gap-2"><span className="card__title">Active runs</span><span className="s-dim" style={{ fontSize: 12.5 }}>{running} running</span></div>
                <button className="btn btn--ghost btn--sm" onClick={() => onNav('workflows')}>All workflows<Ic.ArrowRight cls="icon--sm" /></button>
              </div>
              <div className="runs">
                {runs.length === 0
                  ? <div className="empty-pad">No runs yet.</div>
                  : runs.map(r => <RunRow key={r.id} run={r} onToggle={toggleRun} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

Object.assign(window, { Cockpit, Sparkline });
