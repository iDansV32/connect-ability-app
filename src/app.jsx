// App root — wires everything together

const { useState: useStateA, useEffect: useEffectA } = React;

const DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "indigo",
  "density": "comfortable"
}/*EDITMODE-END*/;

function App() {
  const [section, setSection] = useStateA(() => localStorage.getItem('connect:section') || 'cockpit');
  const [theme, setTheme] = useStateA(() => localStorage.getItem('connect:theme') || DEFAULTS.theme);
  const [accent, setAccent] = useStateA(() => localStorage.getItem('connect:accent') || DEFAULTS.accent);
  const [density, setDensity] = useStateA(() => localStorage.getItem('connect:density') || DEFAULTS.density);
  const [accountName, setAccountName] = useStateA(() => localStorage.getItem('connect:accountName') || window.DEFAULT_ACCOUNT_NAME);
  const [sidebarCollapsed, setSidebarCollapsed] = useStateA(() => localStorage.getItem('connect:sidebarCollapsed') === '1');
  const [paletteOpen, setPaletteOpen] = useStateA(false);
  const [newAgentOpen, setNewAgentOpen] = useStateA(false);
  const [tweaksOpen, setTweaksOpen] = useStateA(false);

  useEffectA(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('connect:theme', theme); }, [theme]);
  useEffectA(() => { document.documentElement.dataset.accent = accent; localStorage.setItem('connect:accent', accent); }, [accent]);
  useEffectA(() => { document.documentElement.dataset.density = density; localStorage.setItem('connect:density', density); }, [density]);
  useEffectA(() => { localStorage.setItem('connect:section', section); }, [section]);
  useEffectA(() => { localStorage.setItem('connect:accountName', accountName); }, [accountName]);
  useEffectA(() => { localStorage.setItem('connect:sidebarCollapsed', sidebarCollapsed ? '1' : '0'); }, [sidebarCollapsed]);

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

  // Persist a tweak via edit-mode write-back
  const persistTweak = (setter, key) => (v) => {
    setter(v);
    try {
      window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [key]: v } }, '*');
    } catch {}
  };
  const setThemePersist = persistTweak(setTheme, 'theme');
  const setAccentPersist = persistTweak(setAccent, 'accent');
  const setDensityPersist = persistTweak(setDensity, 'density');
  const setAccountNamePersist = (value) => {
    const next = String(value || '').trim() || window.DEFAULT_ACCOUNT_NAME;
    setAccountName(next);
  };

  const renderSection = () => {
    if (section === 'cockpit') return <Cockpit onNav={setSection}/>;
    if (section === 'inbox') return <Inbox/>;
    if (section === 'workflows') return <WorkflowStudio onNav={setSection}/>;
    if (section === 'agents') return <AgentsPage onNav={setSection}/>;
    if (section === 'prospects') return <ProspectsPage onNav={setSection}/>;
    if (section === 'posts' || section === 'post-scheduler') return <PostsPage onNav={setSection}/>;
    if (section === 'settings') return <SettingsPage accountName={accountName} onAccountNameChange={setAccountNamePersist} />;
    return <Placeholder id={section} onNav={setSection}/>;
  };

  return (
    <div className="app">
      <Sidebar
        active={section}
        onNav={setSection}
        accountName={accountName}
        collapsed={sidebarCollapsed}
        onSetCollapsed={setSidebarCollapsed}
      />
      <div className="main">
        <Topbar
          onOpenPalette={() => setPaletteOpen(true)}
          theme={theme}
          onToggleTheme={() => setThemePersist(theme === 'dark' ? 'light' : 'dark')}
          onOpenTweaks={() => setTweaksOpen(true)}
          section={section}
          hidden={section === 'workflows'}
        />
        <div className="content">
          {renderSection()}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNav={(id) => { setSection(id); setPaletteOpen(false); }}/>
      <NewAgentModal
        open={newAgentOpen}
        onClose={() => setNewAgentOpen(false)}
        onCreated={() => { setNewAgentOpen(false); setSection('agents'); }}
      />
      <TweaksPanel open={tweaksOpen} onClose={() => setTweaksOpen(false)}
        theme={theme} setTheme={setThemePersist}
        accent={accent} setAccent={setAccentPersist}
        density={density} setDensity={setDensityPersist}/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
