// Shell — Sidebar, Topbar, Command palette, Tweaks, resizable panes.
// Visual system: Stripe/Apple-inspired (see styles/tokens.css). Live data
// wiring (nav badge counts, palette feeds) is preserved from the backend.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// Workspace label shown before the operator names their workspace. A fresh
// install must not display a person's name it invented, so this is a neutral
// product string rather than a fallback into the design fixture.
const DEFAULT_ACCOUNT_NAME = 'Your workspace';

// ---------- Avatar ----------
function Avatar({ name, hue, size = 32, gradient }) {
  const initials = (name || '?').split(' ').map(n => n[0]).slice(0, 2).join('');
  const bg = gradient ? 'var(--grad-accent)'
    : (hue != null ? window.oklchHex(72, 0.13, hue) : 'var(--accent)');
  return (
    <span className="avatar" style={{ width: size, height: size, background: bg, fontSize: size * 0.4 }}>{initials}</span>
  );
}

// ---------- Live nav-badge counts ----------
// Pull live nav-badge counts from real backend data. Falls back silently to 0
// if a fetch fails. Subscribes to the relevant IPC events so the badges
// refresh as runs / posts / inbox conversations change.
function useNavCounts() {
  const [counts, setCounts] = useState({});

  const load = async () => {
    if (!window.electronAPI) return;
    try {
      const [agents, runs, inbox, prospects, posts, health] = await Promise.all([
        window.electronAPI.getSdrAgents ? window.electronAPI.getSdrAgents({ scope: 'all' }).catch(() => []) : Promise.resolve([]),
        window.electronAPI.getSdrWorkflowRuns ? window.electronAPI.getSdrWorkflowRuns().catch(() => []) : Promise.resolve([]),
        window.electronAPI.getInbox ? window.electronAPI.getInbox({}).catch(() => []) : Promise.resolve([]),
        window.electronAPI.getSdrProspects ? window.electronAPI.getSdrProspects({}).catch(() => []) : Promise.resolve([]),
        window.electronAPI.getScheduledPosts ? window.electronAPI.getScheduledPosts().catch(() => []) : Promise.resolve([]),
        window.electronAPI.getLinkedInAccountHealth ? window.electronAPI.getLinkedInAccountHealth().catch(() => []) : Promise.resolve([]),
      ]);
      const arr = (x, key) => Array.isArray(x) ? x : (x && (x[key] || x.items)) || [];

      const agentList = arr(agents, 'agents');
      const runList = arr(runs, 'runs');
      const inboxList = arr(inbox, 'conversations');
      const prospectList = arr(prospects, 'prospects');
      const postList = arr(posts, 'posts');
      const healthList = arr(health, 'accounts');

      const activeRuns = runList.filter(r => {
        const s = String(r.status || r.state || '').toLowerCase();
        return s && !['completed', 'cancelled', 'failed'].includes(s);
      }).length;

      const unread = inboxList.filter(c =>
        c.unread || ['new', 'paused', 'suppressed'].includes(String(c.status || '').toLowerCase())
      ).length;

      const upcomingPosts = postList.filter(p => {
        const s = String(p.status || '').toLowerCase();
        return s === 'pending' || s === 'scheduled';
      }).length;

      const unhealthy = healthList.filter(a => {
        const s = String(a.status || a.state || '').toLowerCase();
        return s.includes('challenge') || s.includes('cooldown') || s.includes('banned');
      }).length;

      setCounts({
        agents: agentList.length,
        workflows: activeRuns,
        inbox: unread,
        prospects: prospectList.length,
        posts: upcomingPosts,
        health: unhealthy,
        settings: 0,
        cockpit: 0,
      });
    } catch (e) {
      console.warn('Nav counts load failed:', e);
    }
  };

  useEffect(() => {
    load();
    if (!window.electronAPI || !window.electronAPI.on) return;
    const refresh = () => load();
    ['sdr-agents-updated', 'sdr-workflow-runs-updated', 'inbox-updated',
     'prospects-updated', 'post-published', 'linkedin-account-health-updated',
    ].forEach(ch => window.electronAPI.on(ch, refresh));
    const poll = setInterval(load, 30000);
    return () => clearInterval(poll);
  }, []);

  return counts;
}

// ---------- Sidebar ----------
function Sidebar({ active, onNav, accountName, collapsed, onSetCollapsed }) {
  const liveCounts = useNavCounts();
  const displayName = String(accountName || '').trim() || DEFAULT_ACCOUNT_NAME;
  const [hoverOpen, setHoverOpen] = useState(false);
  const expanded = !collapsed || hoverOpen;
  return (
    <aside
      className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''} ${collapsed && hoverOpen ? 'sidebar--peek' : ''}`}
      onMouseEnter={() => { if (collapsed) setHoverOpen(true); }}
      onMouseLeave={() => setHoverOpen(false)}
    >
      <div className={`sidebar__brand ${expanded ? '' : 'sidebar__brand--compact'}`}>
        <div className="brand-mark"><Ic.Logo cls="icon" /></div>
        {expanded && (
          <>
            <div className="flex-1" style={{ minWidth: 0 }}>
              <div className="brand-name">Connect</div>
            </div>
            <button
              className="btn btn--ghost btn--icon btn--sm"
              type="button"
              onClick={() => onSetCollapsed && onSetCollapsed(collapsed ? false : true)}
              title={collapsed ? 'Keep sidebar open' : 'Collapse sidebar'}
            >
              {collapsed ? <Ic.ChevronRight cls="icon--sm" /> : <Ic.ChevronLeft cls="icon--sm" />}
            </button>
          </>
        )}
      </div>

      <div className="sidebar__section" style={{ flex: 1, overflowY: 'auto' }}>
        {MOCK.nav.map(grp => (
          <div key={grp.group}>
            {expanded && <div className="sidebar__label">{grp.group}</div>}
            <nav className="nav">
              {grp.items.map(item => {
                const Icon = Ic[item.icon] || Ic.Workflow;
                const isActive = active === item.id;
                const count = liveCounts[item.id] != null ? liveCounts[item.id] : 0;
                const badge = item.id === 'inbox' && count > 0 ? 'info'
                  : item.id === 'health' && count > 0 ? 'danger'
                  : null;
                return (
                  <button key={item.id}
                    className={`navitem ${isActive ? 'navitem--active' : ''} ${expanded ? '' : 'navitem--icononly'}`}
                    onClick={() => onNav(item.id)}
                    title={!expanded ? item.label : undefined}>
                    {expanded ? (
                      <>
                      <span className="navitem__label">{item.label}</span>
                      {count > 0 && (
                        <span className={`navitem__count ${badge ? 'navitem__count--' + badge : ''}`}>
                          {count > 999 ? (count / 1000).toFixed(1) + 'k' : count}
                        </span>
                      )}
                    </>
                    ) : (
                      <Icon cls="navitem__icon" />
                    )}
                  </button>
                );
              })}
            </nav>
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        <button
          className={`userchip ${expanded ? '' : 'userchip--icononly'}`}
          type="button"
          onClick={() => onNav('settings')}
          title="Open settings"
        >
          <Avatar name={displayName} gradient size={34} />
          {expanded && (
            <>
            <div className="flex-1" style={{ minWidth: 0, textAlign: 'left' }}>
              <div className="userchip__name truncate">{displayName}</div>
              <div className="userchip__role truncate">Open settings</div>
            </div>
            <Ic.Dots cls="icon--sm s-dim" />
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

const SECTION_TITLES = {
  cockpit: 'Cockpit', inbox: 'Inbox', agents: 'Agents', workflows: 'Workflows',
  prospects: 'Prospects', posts: 'Posts', settings: 'Settings',
};

// ---------- Topbar ----------
function Topbar({ onOpenPalette, theme, onToggleTheme, onOpenTweaks, section, hidden }) {
  if (hidden) return null;
  const title = SECTION_TITLES[section] || 'Connect';
  return (
    <header className="topbar">
      <div className="flex-1" style={{ minWidth: 0 }}>
        <div className="section-title truncate">{title}</div>
      </div>
      <button className="topbar__search" onClick={onOpenPalette}>
        <Ic.Search cls="icon--sm" />
        <span className="topbar__search-text">Search prospects, agents, runs…</span>
        <span className="row gap-1"><span className="kbd">⌘</span><span className="kbd">K</span></span>
      </button>
      <button className="btn btn--ghost btn--icon" title="Notifications"><Ic.Bell cls="icon" /></button>
      <button className="btn btn--ghost btn--icon" onClick={onToggleTheme} title="Toggle theme">
        {theme === 'dark' ? <Ic.Sun cls="icon" /> : <Ic.Moon cls="icon" />}
      </button>
      {onOpenTweaks && (
        <button className="btn btn--ghost btn--icon" onClick={onOpenTweaks} title="Tweaks — appearance, accent, density">
          <Ic.Filter cls="icon" />
        </button>
      )}
    </header>
  );
}

function sectionLabel(id) {
  const m = { cockpit:'Operator cockpit', agents:'SDR Agents', workflows:'Workflow Studio',
    inbox:'Unified Inbox', prospects:'Prospects', posts:'Scheduled Posts',
    health:'Account Health', apollo:'Apollo Sync', analytics:'Analytics', settings:'Settings' };
  return m[id] || id;
}

// ---------- Command Palette ----------
function CommandPalette({ open, onClose, onNav }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 10); }, [open]);
  useEffect(() => { if (!open) setQ(''); }, [open]);

  // Real data feeds — only fetched while the palette is open.
  const [data, setData] = useState({ agents: [], runs: [], prospects: [], posts: [], accounts: [] });
  useEffect(() => {
    if (!open || !window.electronAPI) return;
    let cancelled = false;
    Promise.all([
      window.electronAPI.getSdrAgents ? window.electronAPI.getSdrAgents({ scope: 'all' }).catch(() => []) : Promise.resolve([]),
      window.electronAPI.getSdrWorkflowRuns ? window.electronAPI.getSdrWorkflowRuns().catch(() => []) : Promise.resolve([]),
      window.electronAPI.getSdrProspects ? window.electronAPI.getSdrProspects({}).catch(() => []) : Promise.resolve([]),
      window.electronAPI.getScheduledPosts ? window.electronAPI.getScheduledPosts().catch(() => []) : Promise.resolve([]),
      window.electronAPI.getLinkedInAccounts ? window.electronAPI.getLinkedInAccounts().catch(() => []) : Promise.resolve([]),
    ]).then(([agents, runs, prospects, posts, accounts]) => {
      if (cancelled) return;
      const norm = (x) => Array.isArray(x) ? x : (x && (x.agents || x.runs || x.prospects || x.posts || x.accounts)) || [];
      setData({
        agents: norm(agents),
        runs: norm(runs),
        prospects: norm(prospects),
        posts: norm(posts),
        accounts: norm(accounts),
      });
    });
    return () => { cancelled = true; };
  }, [open]);

  const commands = useMemo(() => {
    const navItems = MOCK.navItems.map(n => ({
      kind: 'page', label: `Go to ${n.label}`, icon: n.icon,
      action: () => onNav(n.id), terms: [n.label, n.id],
    }));
    const actions = [
      { kind: 'action', label: 'Create agent', icon: 'Plus',
        action: () => window.dispatchEvent(new CustomEvent('connect:newagent')),
        terms: ['create', 'new', 'agent'] },
      { kind: 'action', label: 'Toggle theme', icon: 'Moon',
        action: () => window.dispatchEvent(new CustomEvent('connect:toggletheme')),
        terms: ['theme', 'dark', 'light', 'mode'] },
    ];

    const agents = (data.agents || []).map(a => ({
      kind: 'agent', label: a.name || a.id, sub: a.niche || a.accountName || '',
      icon: 'Agents',
      action: () => { onNav('agents'); window.dispatchEvent(new CustomEvent('connect:focus-agent', { detail: { id: a.id } })); },
      terms: [a.name, a.niche, a.accountName, ...(a.personaTitles || []), ...(a.searchKeywords || []), a.id],
    }));

    const runs = (data.runs || []).map(r => ({
      kind: 'run', label: r.workflowName || r.name || r.id,
      sub: `${r.status || 'queued'} · ${r.agentName || 'unassigned'}`,
      icon: 'Workflow',
      action: () => { onNav('workflows'); window.dispatchEvent(new CustomEvent('connect:focus-run', { detail: { id: r.id || r.runId } })); },
      terms: [r.workflowName, r.name, r.agentName, r.accountName, r.id, r.targetType, r.status],
    }));

    const prospects = (data.prospects || []).map(p => {
      const url = p.profileUrl || p.normalizedProfileUrl || '';
      const m = url ? /linkedin\.com\/in\/([^/?#]+)/i.exec(url) : null;
      const slug = m ? decodeURIComponent(m[1]).replace(/-/g, ' ') : '';
      const realName = (p.fullName && !/^https?:/.test(p.fullName)) ? p.fullName : slug;
      return {
        kind: 'prospect',
        label: realName || url || p.id,
        sub: [p.title, p.company].filter(Boolean).join(' · ') || p.sourceLabel || url,
        icon: 'User',
        action: () => { onNav('prospects'); window.dispatchEvent(new CustomEvent('connect:focus-prospect', { detail: { id: p.id } })); },
        terms: [p.fullName, p.title, p.company, p.agentName, p.accountName, p.sourceLabel, url, slug, p.id],
      };
    });

    const posts = (data.posts || []).map(p => ({
      kind: 'post',
      label: (p.content || '').slice(0, 60) || p.id,
      sub: `${p.status || '—'} · ${p.scheduledDate || ''} ${p.scheduledTime || ''}`.trim(),
      icon: 'Calendar',
      action: () => onNav('posts'),
      terms: [p.content, p.accountName, p.agentName, p.status, p.contentPillar, p.id],
    }));

    const accounts = (data.accounts || []).map(a => ({
      kind: 'account',
      label: a.name || a.email,
      sub: a.email,
      icon: 'Settings',
      action: () => onNav('settings'),
      terms: [a.name, a.email, a.timezoneId, a.id],
    }));

    const all = [...navItems, ...actions, ...agents, ...runs, ...prospects, ...posts, ...accounts];
    if (!q) return all.slice(0, 12);

    const needle = q.toLowerCase().trim();
    return all
      .filter(c => {
        const blob = [c.label, c.sub, ...(c.terms || [])].filter(Boolean).join(' ').toLowerCase();
        return blob.includes(needle);
      })
      .slice(0, 30);
  }, [q, onNav, data]);

  const [cursor, setCursor] = useState(0);
  useEffect(() => { setCursor(0); }, [q]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c+1, commands.length-1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c-1, 0)); }
    else if (e.key === 'Enter' && commands[cursor]) { commands[cursor].action(); onClose(); }
    else if (e.key === 'Escape') onClose();
  };

  if (!open) return null;
  return (
    <div className="scrim" onClick={onClose}>
      <div className="palette" onClick={e => e.stopPropagation()}>
        <div className="palette__in">
          <Ic.Search cls="icon s-dim" />
          <input ref={inputRef} className="palette__input" placeholder="Type a command or search…"
                 value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}/>
          <span className="kbd">esc</span>
        </div>
        <div className="palette__list">
          {commands.length === 0 && <div className="palette__empty">No matches found.</div>}
          {commands.map((c, i) => {
            const Icon = Ic[c.icon] || Ic.Dots;
            return (
              <button key={i} className={`palette__row ${i === cursor ? 'palette__row--active' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => { c.action(); onClose(); }}>
                <Icon cls="icon s-dim" />
                <span className="palette__row-label">{c.label}</span>
                {c.sub && <span className="palette__row-sub">{c.sub}</span>}
                <span className="palette__row-kind">{c.kind}</span>
              </button>
            );
          })}
        </div>
        <div className="palette__foot">
          <span className="row gap-2"><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
          <span className="row gap-2"><span className="kbd">↵</span> select</span>
          <span className="row gap-2"><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  );
}

// ---------- Tweaks (theme + accent + density) ----------
function Toggle({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} style={{
      width: 42, height: 24, borderRadius: 99, padding: 2, flexShrink: 0,
      background: on ? 'var(--accent)' : 'var(--surface-3)', border: '1px solid var(--border-2)',
      transition: 'background 160ms', position: 'relative',
    }}>
      <span style={{
        display: 'block', width: 18, height: 18, borderRadius: 99, background: '#fff',
        boxShadow: 'var(--shadow-sm)', transform: on ? 'translateX(18px)' : 'translateX(0)',
        transition: 'transform 180ms cubic-bezier(0.32,0.72,0,1)',
      }} />
    </button>
  );
}

function TweaksPanel({ open, onClose, theme, setTheme, accent, setAccent, density, setDensity }) {
  if (!open) return null;
  const accents = [
    { id: 'indigo', label: 'Indigo', hex: '#635bff' },
    { id: 'blue', label: 'Blue', hex: '#2f7bff' },
    { id: 'teal', label: 'Teal', hex: '#11c2a3' },
    { id: 'rose', label: 'Rose', hex: '#f5527a' },
  ];
  return (
    <div className="tweaks">
      <div className="tweaks__head">
        <span className="card__title">Tweaks</span>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={onClose}><Ic.X cls="icon--sm" /></button>
      </div>
      <div className="tweaks__body">
        <div className="tweaks__row">
          <span className="eyebrow">Appearance</span>
          <div className="seg" style={{ width: '100%' }}>
            <button className={`seg__btn flex-1 ${theme === 'light' ? 'seg__btn--active' : ''}`} onClick={() => setTheme('light')}>Light</button>
            <button className={`seg__btn flex-1 ${theme === 'dark' ? 'seg__btn--active' : ''}`} onClick={() => setTheme('dark')}>Dark</button>
          </div>
        </div>
        <div className="tweaks__row">
          <span className="eyebrow">Accent</span>
          <div className="row gap-2">
            {accents.map(a => (
              <button key={a.id} onClick={() => setAccent && setAccent(a.id)} title={a.label} style={{
                width: 30, height: 30, borderRadius: 8, background: a.hex,
                border: accent === a.id ? '2px solid var(--text)' : '2px solid transparent',
                boxShadow: accent === a.id ? 'var(--shadow-sm)' : 'none', outline: accent === a.id ? '2px solid var(--surface)' : 'none', outlineOffset: -4,
              }} />
            ))}
          </div>
        </div>
        <div className="tweaks__row">
          <span className="eyebrow">Density</span>
          <div className="seg" style={{ width: '100%' }}>
            <button className={`seg__btn flex-1 ${density === 'comfortable' ? 'seg__btn--active' : ''}`} onClick={() => setDensity && setDensity('comfortable')}>Comfortable</button>
            <button className={`seg__btn flex-1 ${density === 'compact' ? 'seg__btn--active' : ''}`} onClick={() => setDensity && setDensity('compact')}>Compact</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Resizable panes ----------
function useResizable(key, def, min, max) {
  const [w, setW] = useState(() => { const s = parseInt(localStorage.getItem(key), 10); return (s && s >= min && s <= max) ? s : def; });
  useEffect(() => { localStorage.setItem(key, String(w)); }, [w]);
  const clamp = (v) => Math.max(min, Math.min(max, v));
  return [w, (v) => setW(clamp(v)), min, max];
}

function Resizer({ width, setWidth, min = 280, max = 620 }) {
  const onDown = (e) => {
    e.preventDefault();
    const sx = e.clientX, sw = width;
    const move = (ev) => setWidth(Math.max(min, Math.min(max, sw + ev.clientX - sx)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add('resizing');
  };
  const onDbl = () => setWidth(Math.round((min + max) / 2));
  return <div className="resizer" onMouseDown={onDown} onDoubleClick={onDbl} title="Drag to resize · double-click to reset"><span className="resizer__bar" /></div>;
}

Object.assign(window, { Sidebar, Topbar, CommandPalette, TweaksPanel, Avatar, Toggle, sectionLabel, SECTION_TITLES, useResizable, Resizer, DEFAULT_ACCOUNT_NAME });
