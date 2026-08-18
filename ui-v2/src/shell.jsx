// Shell — Sidebar, Topbar, Command palette, Tweaks panel

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ========== Sidebar ==========
function Sidebar({ active, onNav, collapsed, onToggleCollapsed }) {
  return (
    <aside className={`shell__sidebar ${collapsed ? 'shell__sidebar--collapsed' : ''}`}>
      <div className="shell__brand">
        <div className="shell__brand-mark">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path d="M6 6h5a5 5 0 0 1 5 5v0a5 5 0 0 0 5 5h1" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
            <circle cx="5" cy="5" r="2" fill="currentColor"/>
            <circle cx="19" cy="19" r="2" fill="currentColor"/>
          </svg>
        </div>
        {!collapsed && <>
          <div className="shell__brand-text">
            <div className="shell__brand-name">Connect</div>
            <div className="shell__brand-env">workspace · ops</div>
          </div>
          <button className="btn btn--ghost btn--icon btn--sm" onClick={onToggleCollapsed} title="Collapse sidebar">
            <Ic.ChevronLeft />
          </button>
        </>}
      </div>

      <nav className="shell__nav">
        {MOCK.navItems.map(item => {
          const Icon = Ic[item.icon];
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              className={`navitem ${isActive ? 'navitem--active' : ''}`}
              onClick={() => onNav(item.id)}
              title={collapsed ? item.label : undefined}
            >
              <Icon cls="icon navitem__icon" />
              {!collapsed && <>
                <span className="navitem__label">{item.label}</span>
                {item.count > 0 && (
                  <span className={`navitem__count ${item.badge ? 'navitem__count--'+item.badge : ''}`}>
                    {item.count > 999 ? (item.count/1000).toFixed(1)+'k' : item.count}
                  </span>
                )}
              </>}
            </button>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="shell__sidebar-foot">
          <div className="opswitch">
            <div className="opswitch__avatar">VK</div>
            <div className="opswitch__meta">
              <div className="opswitch__name">Priya Venkat</div>
              <div className="opswitch__role mono">operator · 6 accounts</div>
            </div>
            <Ic.ChevronDown cls="icon s-dim" />
          </div>
        </div>
      )}
    </aside>
  );
}

// ========== Topbar ==========
function Topbar({ onOpenPalette, theme, onToggleTheme, activeAccount, onAccount, section, hidden }) {
  const [notifOpen, setNotifOpen] = useState(false);
  const activeAcc = MOCK.accounts.find(a => a.id === activeAccount) || { name: 'All accounts', handle: 'all' };
  const healthy = MOCK.accounts.filter(a => a.status === 'ok').length;
  const warn = MOCK.accounts.filter(a => a.status === 'warm' || a.status === 'cooldown').length;
  const bad = MOCK.accounts.filter(a => a.status === 'challenge' || a.status === 'banned').length;

  if (hidden) return null;

  return (
    <header className="shell__topbar">
      <div className="topbar__crumb">
        <span className="eyebrow">Section</span>
        <span className="topbar__crumb-val">{sectionLabel(section)}</span>
      </div>

      <button className="topbar__search" onClick={onOpenPalette}>
        <Ic.Search cls="icon s-dim" />
        <span className="topbar__search-text">Search prospects, agents, runs…</span>
        <span className="row gap-1">
          <span className="kbd">⌘</span><span className="kbd">K</span>
        </span>
      </button>

      <div className="row gap-2">
        <button className="topbar__pill" title="Account health">
          <span className="s-ok row gap-1"><span className="dot"></span><span className="mono">{healthy}</span></span>
          {warn > 0 && <span className="s-warn row gap-1"><span className="dot"></span><span className="mono">{warn}</span></span>}
          {bad > 0 && <span className="s-danger row gap-1"><span className="dot dot--pulse"></span><span className="mono">{bad}</span></span>}
          <span className="s-dim mono" style={{ fontSize: 10 }}>health</span>
        </button>

        <div className="topbar__select">
          <span className="dot s-ok"></span>
          <span className="truncate" style={{ maxWidth: 120 }}>{activeAcc.name}</span>
          <Ic.ChevronDown cls="icon s-dim" />
        </div>

        <button className="btn btn--ghost btn--icon" onClick={() => setNotifOpen(!notifOpen)} title="Notifications">
          <Ic.Bell cls="icon" />
          <span className="topbar__notifdot"></span>
        </button>

        <button className="btn btn--ghost btn--icon" onClick={onToggleTheme} title="Toggle theme">
          {theme === 'dark' ? <Ic.Sun cls="icon" /> : <Ic.Moon cls="icon" />}
        </button>
      </div>
    </header>
  );
}

function sectionLabel(id) {
  const m = { cockpit:'Operator cockpit', agents:'SDR Agents', workflows:'Workflow Studio',
    inbox:'Unified Inbox', prospects:'Prospects', posts:'Scheduled Posts',
    health:'Account Health', apollo:'Apollo Sync', analytics:'Analytics', settings:'Settings' };
  return m[id] || id;
}

// ========== Command Palette ==========
function CommandPalette({ open, onClose, onNav }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 10); }, [open]);
  useEffect(() => { if (!open) setQ(''); }, [open]);

  const commands = useMemo(() => {
    const base = [
      ...MOCK.navItems.map(n => ({ kind: 'nav', label: `Go to ${n.label}`, icon: n.icon, action: () => onNav(n.id), shortcut: null })),
      { kind: 'action', label: 'Create agent',           icon: 'Plus',  action: () => window.dispatchEvent(new CustomEvent('connect:newagent')) },
      { kind: 'action', label: 'Pause all workflows',    icon: 'Pause', action: () => {} },
      { kind: 'action', label: 'Toggle theme',           icon: 'Sun',   action: () => window.dispatchEvent(new CustomEvent('connect:toggletheme')) },
      { kind: 'action', label: 'Launch warm-up stage 3', icon: 'Bolt',  action: () => {} },
    ];
    const prospects = MOCK.conversations.map(c => ({
      kind: 'prospect', label: `${c.name} · ${c.company}`, icon: 'User', sub: c.title, action: () => onNav('inbox')
    }));
    const all = [...base, ...prospects];
    if (!q) return all.slice(0, 10);
    return all.filter(c => (c.label + ' ' + (c.sub||'')).toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  }, [q, onNav]);

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
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" onClick={e => e.stopPropagation()}>
        <div className="palette__in">
          <Ic.Search cls="icon icon--lg s-dim" />
          <input ref={inputRef} className="palette__input" placeholder="Type a command or search…"
                 value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}/>
          <span className="kbd">esc</span>
        </div>
        <div className="palette__list">
          {commands.length === 0 && <div className="palette__empty">No matches.</div>}
          {commands.map((c, i) => {
            const Icon = Ic[c.icon] || Ic.Dots;
            return (
              <button key={i} className={`palette__row ${i === cursor ? 'palette__row--active' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => { c.action(); onClose(); }}>
                <Icon cls="icon s-dim" />
                <span className="palette__row-label">{c.label}</span>
                {c.sub && <span className="palette__row-sub mono">{c.sub}</span>}
                <span className="palette__row-kind eyebrow">{c.kind}</span>
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

// ========== Tweaks panel (theme toggle only for now) ==========
function TweaksPanel({ open, onClose, theme, setTheme }) {
  if (!open) return null;
  return (
    <div className="tweaks">
      <div className="tweaks__head">
        <span className="card__title">Tweaks</span>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={onClose}><Ic.X /></button>
      </div>
      <div className="tweaks__body">
        <div className="tweaks__row">
          <span className="eyebrow">Theme</span>
          <div className="segmented">
            <button className={`segmented__btn ${theme==='light'?'segmented__btn--active':''}`} onClick={() => setTheme('light')}>Light</button>
            <button className={`segmented__btn ${theme==='dark'?'segmented__btn--active':''}`} onClick={() => setTheme('dark')}>Dark</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Sidebar, Topbar, CommandPalette, TweaksPanel, sectionLabel });
