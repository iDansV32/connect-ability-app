// App root — wires everything together

const { useState: useStateA, useEffect: useEffectA } = React;

const DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light"
}/*EDITMODE-END*/;

function App() {
  const [section, setSection] = useStateA(() => localStorage.getItem('connect:section') || 'cockpit');
  const [theme, setTheme] = useStateA(() => localStorage.getItem('connect:theme') || DEFAULTS.theme);
  const [collapsed, setCollapsed] = useStateA(false);
  const [paletteOpen, setPaletteOpen] = useStateA(false);
  const [newAgentOpen, setNewAgentOpen] = useStateA(false);
  const [tweaksOpen, setTweaksOpen] = useStateA(false);
  const [activeAccount, setActiveAccount] = useStateA('all');

  useEffectA(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('connect:theme', theme); }, [theme]);
  useEffectA(() => { localStorage.setItem('connect:section', section); }, [section]);

  // ⌘K
  useEffectA(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Global event bus from palette
  useEffectA(() => {
    const onNewAgent = () => setNewAgentOpen(true);
    const onToggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark');
    window.addEventListener('connect:newagent', onNewAgent);
    window.addEventListener('connect:toggletheme', onToggle);
    return () => {
      window.removeEventListener('connect:newagent', onNewAgent);
      window.removeEventListener('connect:toggletheme', onToggle);
    };
  }, []);

  // Edit mode protocol — listener first, then announce
  useEffectA(() => {
    const onMsg = (e) => {
      if (!e.data) return;
      if (e.data.type === '__activate_edit_mode') setTweaksOpen(true);
      else if (e.data.type === '__deactivate_edit_mode') setTweaksOpen(false);
    };
    window.addEventListener('message', onMsg);
    try {
      window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    } catch {}
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Persist theme via edit-mode write-back
  const setThemePersist = (t) => {
    setTheme(t);
    try {
      window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { theme: t } }, '*');
    } catch {}
  };

  const renderSection = () => {
    if (section === 'cockpit') return <Cockpit onNav={setSection}/>;
    if (section === 'inbox') return <Inbox/>;
    if (section === 'workflows') return <WorkflowStudio/>;
    return <Placeholder id={section} onNav={setSection}/>;
  };

  return (
    <div className="app">
      <Sidebar active={section} onNav={setSection} collapsed={collapsed} onToggleCollapsed={() => setCollapsed(c => !c)}/>
      <div className="shell__main">
        <Topbar
          onOpenPalette={() => setPaletteOpen(true)}
          theme={theme}
          onToggleTheme={() => setThemePersist(theme === 'dark' ? 'light' : 'dark')}
          activeAccount={activeAccount}
          onAccount={setActiveAccount}
          section={section}
          hidden={section === 'workflows'}
        />
        <div className="shell__content">
          {renderSection()}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNav={(id) => { setSection(id); setPaletteOpen(false); }}/>
      <NewAgentModal open={newAgentOpen} onClose={() => setNewAgentOpen(false)}/>
      <TweaksPanel open={tweaksOpen} onClose={() => setTweaksOpen(false)} theme={theme} setTheme={setThemePersist}/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
