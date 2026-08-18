// SDR Agents page — list + create / edit / delete agents against real backend.
// Re-skinned to the Stripe/Apple design system (split pane + tabs). All live
// electronAPI logic (load, save, delete, persona read/write) is preserved.

const { useState: useStateAG, useEffect: useEffectAG, useMemo: useMemoAG } = React;

const EMPTY_FORM = {
  id: null,
  name: '',
  accountId: '',
  niche: '',
  status: 'active',
  personaTitles: '',
  searchKeywords: '',
  connectionNoteTemplate: '',
  dmTemplatePrimary: '',
  dmTemplateFollowUp: '',
  contentPillars: '',
  postCadence: 'daily',
  timezone: 'America/Chicago',
  notifyDmReplies: true,
  notifyWorkflowFailures: true,
};

function splitList(s) {
  return String(s || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
}
function joinList(a) { return Array.isArray(a) ? a.join(', ') : ''; }

function agentToForm(a) {
  if (!a) return { ...EMPTY_FORM };
  return {
    id: a.id || null,
    name: a.name || '',
    accountId: a.accountId || '',
    niche: a.niche || '',
    status: a.status || 'active',
    personaTitles: joinList(a.personaTitles),
    searchKeywords: joinList(a.searchKeywords),
    connectionNoteTemplate: a.connectionNoteTemplate || '',
    dmTemplatePrimary: a.dmTemplatePrimary || '',
    dmTemplateFollowUp: a.dmTemplateFollowUp || '',
    contentPillars: joinList(a.contentPillars),
    postCadence: a.postCadence || 'daily',
    timezone: a.timezone || 'America/Chicago',
    notifyDmReplies: a.notifications ? !!a.notifications.dmReplies : true,
    notifyWorkflowFailures: a.notifications ? !!a.notifications.workflowFailures : true,
  };
}

function formToPayload(form) {
  return {
    id: form.id || undefined,
    name: form.name.trim(),
    accountId: form.accountId || null,
    niche: form.niche.trim(),
    status: form.status || 'active',
    personaTitles: splitList(form.personaTitles),
    searchKeywords: splitList(form.searchKeywords),
    connectionNoteTemplate: form.connectionNoteTemplate.trim(),
    dmTemplatePrimary: form.dmTemplatePrimary.trim(),
    dmTemplateFollowUp: form.dmTemplateFollowUp.trim(),
    contentPillars: splitList(form.contentPillars),
    postCadence: (form.postCadence || 'daily').trim(),
    timezone: (form.timezone || 'America/Chicago').trim(),
    notifications: {
      dmReplies: !!form.notifyDmReplies,
      workflowFailures: !!form.notifyWorkflowFailures,
    },
  };
}

function _agentHue(a) {
  if (a && a.hue != null) return a.hue;
  const s = String((a && (a.id || a.name)) || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

const AGENT_STATUS = {
  active: { label: 'Active', color: 'var(--ok)' },
  paused: { label: 'Paused', color: 'var(--warn)' },
  draft: { label: 'Draft', color: 'var(--text-faint)' },
  archived: { label: 'Archived', color: 'var(--text-faint)' },
};

function Ring({ pct, size = 44, color = 'var(--accent)' }) {
  const r = size / 2 - 4, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-2)" strokeWidth="4" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} style={{ transition: 'stroke-dashoffset 400ms var(--ease)' }} />
    </svg>
  );
}

const PERSONA_FILE_META = {
  'soul.md': {
    label: 'Soul',
    blurb: 'Core motivation. What this agent believes about their niche, mission, and unique perspective.',
    placeholder: '# Soul — {agent name}\n\n## Identity\n\n## Values\n- \n- \n- \n\n## Mission\n\n## Unique perspective\n',
  },
  'personality.md': {
    label: 'Personality',
    blurb: 'Energy, traits, humor, what they love or avoid talking about.',
    placeholder: '# Personality — {agent name}\n\n## Energy\n\n## Communication traits\n- \n- \n\n## Humor\n\n## What they love talking about\n- \n',
  },
  'writing-style.md': {
    label: 'Writing style',
    blurb: 'Sentence length, vocabulary, openings, closings, formatting, tone scale.',
    placeholder: '# Writing Style — {agent name}\n\n## Sentence structure\n\n## Vocabulary\n**Reaches for:** \n**Never writes:** \n\n## Message anatomy\n**Opening:** \n**Body:** \n**Close:** \n',
  },
  'boundaries.md': {
    label: 'Boundaries',
    blurb: 'Hard limits, topics to avoid, compliance rules, how to respond to opt-outs.',
    placeholder: '# Boundaries — {agent name}\n\n## Hard limits\n- Never guarantee outcomes\n- Honor opt-out requests immediately\n- \n\n## Topics to avoid\n- \n\n## Escalation responses\n',
  },
};
const PERSONA_FILE_ORDER = ['soul.md', 'personality.md', 'writing-style.md', 'boundaries.md'];

function AgentsPage({ onNav }) {
  const [agents, setAgents] = useStateAG([]);
  const [accounts, setAccounts] = useStateAG([]);
  const [selectedId, setSelectedId] = useStateAG(null);
  const [form, setForm] = useStateAG(() => ({ ...EMPTY_FORM }));
  const [mode, setMode] = useStateAG('view'); // 'view' | 'edit' | 'create'
  const [tab, setTab] = useStateAG('profile'); // 'profile' | 'persona'
  const [persona, setPersona] = useStateAG({ status: null, files: {}, loading: false, dirty: {}, drafts: {}, saving: null });
  const [loading, setLoading] = useStateAG(true);
  const [saving, setSaving] = useStateAG(false);
  const [toastMsg, setToastMsg] = useStateAG(null);
  const [listW, setListW] = useResizable('connect:agents:listw', 320, 240, 520);

  const toast = (msg) => { setToastMsg(msg); setTimeout(() => setToastMsg(null), 3000); };

  const load = async () => {
    if (!window.electronAPI) {
      // design preview: populate from MOCK
      setAgents(MOCK.agents.map(a => ({ ...a })));
      setSelectedId(prev => prev || (MOCK.agents[0] && MOCK.agents[0].id) || null);
      setForm(agentToForm(MOCK.agents[0]));
      setLoading(false);
      return;
    }
    try {
      const [agentList, accountList] = await Promise.all([
        window.electronAPI.getSdrAgents({ scope: 'all' }).catch(() => []),
        window.electronAPI.getLinkedInAccounts().catch(() => []),
      ]);
      const arr = Array.isArray(agentList) ? agentList : (agentList && agentList.agents) || [];
      const accs = Array.isArray(accountList) ? accountList : (accountList && accountList.accounts) || [];
      setAgents(arr);
      setAccounts(accs);
      if (arr.length > 0 && !selectedId) {
        setSelectedId(arr[0].id);
        setForm(agentToForm(arr[0]));
        setMode('view');
      } else if (arr.length === 0) {
        setSelectedId(null);
        setForm({ ...EMPTY_FORM });
        setMode('view');
      }
    } catch (e) {
      console.warn('Failed to load agents:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffectAG(() => {
    load();
    if (!window.electronAPI || !window.electronAPI.on) return;
    const onUpdate = () => load();
    window.electronAPI.on('sdr-agents-updated', onUpdate);
  }, []);

  useEffectAG(() => {
    const onFocus = (e) => {
      if (!e || !e.detail || !e.detail.id) return;
      setSelectedId(e.detail.id);
      setMode('view');
      setTab('profile');
    };
    window.addEventListener('connect:focus-agent', onFocus);
    return () => window.removeEventListener('connect:focus-agent', onFocus);
  }, []);

  useEffectAG(() => {
    const onCreate = () => startCreate();
    window.addEventListener('connect:newagent-inline', onCreate);
    return () => window.removeEventListener('connect:newagent-inline', onCreate);
  }, []);

  const selectedAgent = useMemoAG(
    () => agents.find(a => a.id === selectedId) || null,
    [agents, selectedId]
  );

  useEffectAG(() => {
    if (!selectedAgent) {
      setPersona({ status: null, files: {}, loading: false, dirty: {}, drafts: {}, saving: null });
      return;
    }
    if (!window.electronAPI || !window.electronAPI.getAgentPersona) {
      // design preview: populate persona files from MOCK so the tab renders filled
      const files = (window.MOCK && MOCK.personas && MOCK.personas[selectedAgent.id]) || {};
      setPersona({ status: null, files, loading: false, dirty: {}, drafts: {}, saving: null });
      return;
    }
    let cancelled = false;
    setPersona(p => ({ ...p, loading: true, dirty: {}, drafts: {}, saving: null }));
    window.electronAPI.getAgentPersona(selectedAgent.id).then(res => {
      if (cancelled) return;
      if (res && res.success) {
        setPersona({ status: res.status || null, files: res.files || {}, loading: false, dirty: {}, drafts: {}, saving: null });
      } else {
        setPersona({ status: null, files: {}, loading: false, dirty: {}, drafts: {}, saving: null });
      }
    }).catch(() => {
      if (!cancelled) setPersona({ status: null, files: {}, loading: false, dirty: {}, drafts: {}, saving: null });
    });
    return () => { cancelled = true; };
  }, [selectedAgent ? selectedAgent.id : null]);

  const personaCompletedCount = useMemoAG(() => {
    const files = persona.files || {};
    return PERSONA_FILE_ORDER.filter(name => {
      const v = files[name];
      return typeof v === 'string' && v.trim().length > 0;
    }).length;
  }, [persona.files]);

  const setPersonaDraft = (fileName, content) => {
    setPersona(p => ({ ...p, drafts: { ...p.drafts, [fileName]: content }, dirty: { ...p.dirty, [fileName]: true } }));
  };
  const resetPersonaDraft = (fileName) => {
    setPersona(p => {
      const drafts = { ...p.drafts }; delete drafts[fileName];
      const dirty = { ...p.dirty }; delete dirty[fileName];
      return { ...p, drafts, dirty };
    });
  };
  const savePersonaFile = async (fileName) => {
    if (!selectedAgent || !window.electronAPI || !window.electronAPI.writeAgentPersona) return;
    const content = persona.drafts[fileName] != null ? persona.drafts[fileName] : (persona.files[fileName] || '');
    setPersona(p => ({ ...p, saving: fileName }));
    try {
      const res = await window.electronAPI.writeAgentPersona({ agentId: selectedAgent.id, fileName, content });
      if (res && res.success) {
        setPersona(p => {
          const drafts = { ...p.drafts }; delete drafts[fileName];
          const dirty = { ...p.dirty }; delete dirty[fileName];
          return { ...p, status: res.status || p.status, files: { ...p.files, [fileName]: content }, drafts, dirty, saving: null };
        });
        toast(`Saved ${fileName}`);
      } else {
        setPersona(p => ({ ...p, saving: null }));
        toast('Save failed: ' + ((res && res.error) || 'unknown error'));
      }
    } catch (e) {
      setPersona(p => ({ ...p, saving: null }));
      toast('Save failed: ' + ((e && e.message) || 'unknown error'));
    }
  };
  const deletePersonaFile = async (fileName) => {
    if (!selectedAgent || !window.electronAPI || !window.electronAPI.deleteAgentPersona) return;
    if (!window.confirm(`Delete ${fileName}? The file will be removed from disk.`)) return;
    try {
      const res = await window.electronAPI.deleteAgentPersona({ agentId: selectedAgent.id, fileName });
      if (res && res.success) {
        setPersona(p => {
          const drafts = { ...p.drafts }; delete drafts[fileName];
          const dirty = { ...p.dirty }; delete dirty[fileName];
          return { ...p, status: res.status || p.status, files: { ...p.files, [fileName]: null }, drafts, dirty };
        });
        toast(`Deleted ${fileName}`);
      } else {
        toast('Delete failed: ' + ((res && res.error) || 'unknown error'));
      }
    } catch (e) {
      toast('Delete failed: ' + ((e && e.message) || 'unknown error'));
    }
  };

  const accountById = useMemoAG(() => {
    const m = {};
    accounts.forEach(a => { m[a.id || a.accountId] = a; });
    return m;
  }, [accounts]);

  const startCreate = () => {
    setSelectedId(null);
    setForm({ ...EMPTY_FORM, accountId: accounts[0] ? (accounts[0].id || accounts[0].accountId || '') : '' });
    setMode('create');
    setTab('profile');
  };
  const startEdit = () => { if (!selectedAgent) return; setForm(agentToForm(selectedAgent)); setMode('edit'); };
  const cancelEdit = () => {
    if (selectedAgent) { setForm(agentToForm(selectedAgent)); setMode('view'); }
    else if (agents[0]) { setSelectedId(agents[0].id); setForm(agentToForm(agents[0])); setMode('view'); }
    else { setForm({ ...EMPTY_FORM }); setMode('view'); }
  };
  const handleSelect = (a) => { setSelectedId(a.id); setForm(agentToForm(a)); setMode('view'); setTab('profile'); };

  const handleSave = async () => {
    if (!window.electronAPI || !window.electronAPI.saveSdrAgent) { toast('Save unavailable — running outside Electron'); return; }
    const name = form.name.trim();
    if (!name) { toast('Agent name is required'); return; }
    setSaving(true);
    try {
      const payload = formToPayload(form);
      const result = await window.electronAPI.saveSdrAgent(payload);
      if (result && result.success === false) { toast('Save failed: ' + (result.error || 'unknown error')); return; }
      const savedAgent = result && result.agent ? result.agent : null;
      const nextAgents = result && Array.isArray(result.agents) ? result.agents : null;
      if (nextAgents) setAgents(nextAgents); else await load();
      if (savedAgent) { setSelectedId(savedAgent.id); setForm(agentToForm(savedAgent)); }
      setMode('view');
      toast(mode === 'create' ? `Created "${name}"` : `Saved "${name}"`);
    } catch (e) {
      console.error(e);
      toast('Save failed — ' + (e && e.message ? e.message : 'unknown'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedAgent || !window.electronAPI || !window.electronAPI.deleteSdrAgent) return;
    if (!window.confirm(`Delete agent "${selectedAgent.name}"? This removes the record but leaves any persona files on disk.`)) return;
    try {
      const result = await window.electronAPI.deleteSdrAgent(selectedAgent.id);
      if (result && result.success === false) { toast('Delete failed: ' + (result.error || 'unknown error')); return; }
      const nextAgents = result && Array.isArray(result.agents) ? result.agents : null;
      if (nextAgents) setAgents(nextAgents); else await load();
      const remaining = nextAgents || agents.filter(a => a.id !== selectedAgent.id);
      if (remaining.length > 0) { setSelectedId(remaining[0].id); setForm(agentToForm(remaining[0])); }
      else { setSelectedId(null); setForm({ ...EMPTY_FORM }); }
      setMode('view');
      toast(`Deleted "${selectedAgent.name}"`);
    } catch (e) {
      toast('Delete failed — ' + (e && e.message ? e.message : 'unknown'));
    }
  };

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const readOnly = mode === 'view';
  const isCreate = mode === 'create';
  const headAgent = isCreate ? null : selectedAgent;
  const headName = isCreate ? (form.name || 'Untitled agent') : (selectedAgent ? selectedAgent.name : '');
  const headRole = isCreate ? 'New agent' : (selectedAgent ? (selectedAgent.role || 'SDR agent') : '');

  return (
    <div className="split">
      <div className="pane-list" style={{ width: listW, flexShrink: 0 }}>
        <div className="pane-head">
          <div className="row spread">
            <div><div className="eyebrow">Agents</div><div className="section-title" style={{ marginTop: 3 }}>{agents.length} agent{agents.length === 1 ? '' : 's'}</div></div>
            <button className="btn btn--primary btn--sm" type="button" onClick={startCreate}><Ic.Plus cls="icon--sm" />New</button>
          </div>
        </div>
        <div className="pane-scroll">
          {loading && <div className="empty-pad">Loading…</div>}
          {!loading && agents.length === 0 && !isCreate && (
            <div className="empty-pad">No agents yet. Click <b>New</b> to create your first agent.</div>
          )}
          {agents.map(a => {
            const acc = accountById[a.accountId];
            const isOrphan = !!a.accountId && !acc && accounts.length > 0;
            const isSel = a.id === selectedId && !isCreate;
            const st = AGENT_STATUS[a.status] || AGENT_STATUS.active;
            return (
              <button key={a.id} type="button" onClick={() => handleSelect(a)}
                className={`listitem ${isSel ? 'listitem--active' : ''}`} style={{ alignItems: 'center' }}>
                <Avatar name={a.name} hue={_agentHue(a)} size={38} />
                <div className="flex-1" style={{ minWidth: 0 }}>
                  <div className="listitem__name truncate row gap-2" style={{ alignItems: 'center' }}>
                    {a.name}
                    {isOrphan && <span className="chip chip--warn chip--sm">orphan</span>}
                  </div>
                  <div className="listitem__sub truncate row gap-1" style={{ alignItems: 'center' }}>
                    <span className="dot" style={{ width: 6, height: 6, color: st.color }} />{a.role || a.status}
                  </div>
                </div>
              </button>
            );
          })}
          {isCreate && (
            <div className="listitem listitem--active" style={{ alignItems: 'center' }}>
              <Avatar name={form.name || '?'} size={38} />
              <div className="flex-1" style={{ minWidth: 0 }}>
                <div className="listitem__name truncate">{form.name || 'New agent'}</div>
                <div className="listitem__sub">creating…</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <Resizer width={listW} setWidth={setListW} min={240} max={520} />

      <div className="detail">
        {(headAgent || isCreate) ? (
          <>
            <div className="detail__head">
              <div className="row gap-3">
                <Avatar name={headName || '?'} hue={_agentHue(headAgent || { name: headName })} size={46} />
                <div><div className="eyebrow">{headRole}</div><div className="detail__name">{headName}</div></div>
              </div>
              <div className="row gap-2">
                {readOnly && tab === 'profile' && (
                  <>
                    <button className="btn" type="button" onClick={startEdit}>Edit</button>
                    <button className="btn btn--danger" type="button" onClick={handleDelete}><Ic.Trash cls="icon--sm" />Delete</button>
                  </>
                )}
                {!readOnly && (
                  <>
                    <button className="btn" type="button" onClick={cancelEdit} disabled={saving}>Cancel</button>
                    <button className="btn btn--primary" type="button" onClick={handleSave} disabled={saving || !form.name.trim()}>
                      {saving ? 'Saving…' : (isCreate ? 'Create agent' : 'Save changes')}
                    </button>
                  </>
                )}
              </div>
            </div>

            {!isCreate && selectedAgent && (
              <div className="tabs">
                <button className={`tab ${tab === 'profile' ? 'tab--active' : ''}`} onClick={() => setTab('profile')}>Profile</button>
                <button className={`tab ${tab === 'persona' ? 'tab--active' : ''}`} onClick={() => setTab('persona')}>Persona files ({personaCompletedCount}/4)</button>
              </div>
            )}

            <div className="detail__scroll">
              {(isCreate || tab === 'profile') && (
                <AgentForm form={form} setField={setField} accounts={accounts} readOnly={readOnly} />
              )}
              {!isCreate && tab === 'persona' && selectedAgent && (
                <PersonaPanel agent={selectedAgent} persona={persona} completed={personaCompletedCount}
                  setDraft={setPersonaDraft} resetDraft={resetPersonaDraft} onSave={savePersonaFile} onDelete={deletePersonaFile} />
              )}
            </div>
          </>
        ) : (
          <div className="cockpit-empty" style={{ margin: 40 }}>
            <div className="cockpit-empty__icon"><Ic.Agents cls="icon--lg" /></div>
            <div style={{ fontSize: 16, fontWeight: 650, marginTop: 14 }}>No agent selected</div>
            <p className="s-dim" style={{ maxWidth: 360, textAlign: 'center', fontSize: 13.5, marginTop: 4 }}>
              Create your first SDR agent to start running workflows — an agent ties a LinkedIn account to a niche, message templates, and persona files.
            </p>
            <button className="btn btn--primary" style={{ marginTop: 16 }} type="button" onClick={startCreate}><Ic.Plus cls="icon--sm" />Create your first agent</button>
          </div>
        )}
      </div>

      {toastMsg && <div className="toast"><Ic.Check cls="icon--sm" />{toastMsg}</div>}
    </div>
  );
}

function AgentForm({ form, setField, accounts, readOnly }) {
  return (
    <div style={{ padding: 28 }}>
      <div className="form-grid">
        <div className="form-col">
          <div className="form-section-label">Identity</div>

          <div>
            <span className="field-label">Name *</span>
            <input className="field" value={form.name} onChange={e => setField('name', e.target.value)} disabled={readOnly} placeholder="e.g. Atlas" />
            <div className="field-hint">Shows up in workflows, inbox, and activity feed.</div>
          </div>

          <div>
            <span className="field-label">LinkedIn account</span>
            <select className="field" value={form.accountId} onChange={e => setField('accountId', e.target.value)} disabled={readOnly}>
              <option value="">— no account bound —</option>
              {accounts.map(a => {
                const id = a.id || a.accountId;
                const label = a.name || a.displayName || a.email || id;
                return <option key={id} value={id}>{label}</option>;
              })}
            </select>
            <div className="field-hint">{accounts.length === 0 ? 'No LinkedIn accounts configured. Add one in Settings.' : 'The agent only operates under this account.'}</div>
          </div>

          <div>
            <span className="field-label">Status</span>
            <select className="field" value={form.status} onChange={e => setField('status', e.target.value)} disabled={readOnly}>
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="draft">draft</option>
              <option value="archived">archived</option>
            </select>
          </div>

          <div>
            <span className="field-label">Niche</span>
            <input className="field" value={form.niche} onChange={e => setField('niche', e.target.value)} disabled={readOnly} placeholder="RevOps leaders at Series B SaaS companies" />
            <div className="field-hint">One-line description of who this agent targets.</div>
          </div>

          <div>
            <span className="field-label">Persona titles</span>
            <textarea className="field" value={form.personaTitles} onChange={e => setField('personaTitles', e.target.value)} disabled={readOnly} placeholder="VP RevOps, Director of RevOps, Head of Sales Operations" />
            <div className="field-hint">Comma- or newline-separated titles to filter on.</div>
          </div>

          <div>
            <span className="field-label">Search keywords</span>
            <textarea className="field" value={form.searchKeywords} onChange={e => setField('searchKeywords', e.target.value)} disabled={readOnly} placeholder="revops, attribution, pipeline hygiene" />
            <div className="field-hint">Comma- or newline-separated keywords for LinkedIn search.</div>
          </div>
        </div>

        <div className="form-col">
          <div className="form-section-label">Voice &amp; messaging</div>

          <div>
            <span className="field-label">Connection note template</span>
            <textarea className="field" value={form.connectionNoteTemplate} onChange={e => setField('connectionNoteTemplate', e.target.value)} disabled={readOnly} placeholder="Hi {first_name}, would love to connect." />
            <div className="field-hint">Sent with connection requests. Supports {'{first_name}'}.</div>
          </div>

          <div>
            <span className="field-label">First DM template</span>
            <textarea className="field" style={{ minHeight: 100 }} value={form.dmTemplatePrimary} onChange={e => setField('dmTemplatePrimary', e.target.value)} disabled={readOnly} placeholder="Hi {first_name}, thanks for connecting…" />
            <div className="field-hint">Sent after a connection is accepted. Supports {'{first_name}'}, {'{company}'}.</div>
          </div>

          <div>
            <span className="field-label">Follow-up DM template</span>
            <textarea className="field" style={{ minHeight: 100 }} value={form.dmTemplateFollowUp} onChange={e => setField('dmTemplateFollowUp', e.target.value)} disabled={readOnly} placeholder="Quick follow-up…" />
            <div className="field-hint">Second message in the sequence.</div>
          </div>

          <div>
            <span className="field-label">Content pillars</span>
            <textarea className="field" value={form.contentPillars} onChange={e => setField('contentPillars', e.target.value)} disabled={readOnly} placeholder="attribution, pipeline hygiene, sales engineering" />
            <div className="field-hint">Topics this agent posts about. Comma- or newline-separated.</div>
          </div>

          <div className="kv-grid">
            <div>
              <span className="field-label">Post cadence</span>
              <select className="field" value={form.postCadence} onChange={e => setField('postCadence', e.target.value)} disabled={readOnly}>
                <option value="daily">daily</option>
                <option value="weekdays">weekdays</option>
                <option value="weekly">weekly</option>
                <option value="custom">custom</option>
              </select>
            </div>
            <div>
              <span className="field-label">Timezone</span>
              <input className="field" value={form.timezone} onChange={e => setField('timezone', e.target.value)} disabled={readOnly} placeholder="America/Chicago" />
            </div>
          </div>

          <div className="form-section-label" style={{ marginTop: 4 }}>Notifications</div>
          <label className="check"><input type="checkbox" checked={!!form.notifyDmReplies} onChange={e => setField('notifyDmReplies', e.target.checked)} disabled={readOnly} />Notify me on DM replies</label>
          <label className="check"><input type="checkbox" checked={!!form.notifyWorkflowFailures} onChange={e => setField('notifyWorkflowFailures', e.target.checked)} disabled={readOnly} />Notify me on workflow failures</label>
        </div>
      </div>
    </div>
  );
}

function PersonaPanel({ agent, persona, completed, setDraft, resetDraft, onSave, onDelete }) {
  const files = persona.files || {};
  const isComplete = completed === 4;
  return (
    <div style={{ padding: 28, maxWidth: 900 }}>
      <div className={`persona-banner ${isComplete ? 'persona-banner--ok' : 'persona-banner--partial'}`}>
        <div className="persona-ring"><Ring pct={completed / 4} color={isComplete ? 'var(--ok)' : 'var(--warn)'} /></div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 650 }}>{isComplete ? `${agent.name}'s persona is complete` : `${completed} of 4 persona files defined`}</div>
          <div className="s-dim" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 2 }}>Persona files act as guardrails — they override DM templates, connection notes, and post content. Stored on disk under <code>personas/{agent.id}/</code>.</div>
        </div>
      </div>

      {persona.loading && <div className="empty-pad">Loading persona files…</div>}

      {!persona.loading && PERSONA_FILE_ORDER.map(name => {
        const meta = PERSONA_FILE_META[name] || { label: name, blurb: '', placeholder: '' };
        const saved = typeof files[name] === 'string' ? files[name] : '';
        const draft = persona.drafts[name];
        const value = draft != null ? draft : saved;
        const dirty = !!persona.dirty[name];
        const exists = typeof files[name] === 'string' && saved.length > 0;
        const isSaving = persona.saving === name;
        return (
          <details key={name} open={!exists || dirty} className="persona-file">
            <summary className="persona-file__head" style={{ listStyle: 'none' }}>
              <span className="dot" style={{ width: 9, height: 9, color: exists ? 'var(--ok)' : 'var(--text-faint)' }} />
              <span style={{ fontWeight: 600, fontSize: 14 }}>{meta.label}</span>
              <span className="mono s-faint" style={{ fontSize: 11.5 }}>{name}</span>
              {dirty && <span className="chip chip--warn chip--sm">unsaved</span>}
              <span className="flex-1" />
              <span className="s-faint" style={{ fontSize: 11.5 }}>{exists ? `${saved.length} chars` : 'empty'}</span>
            </summary>
            <div className="persona-file__body">
              {meta.blurb && <div className="s-dim" style={{ fontSize: 12.5, marginBottom: 10 }}>{meta.blurb}</div>}
              <textarea className="persona-file__ta" value={value} onChange={e => setDraft(name, e.target.value)} placeholder={meta.placeholder} />
              <div className="row gap-2" style={{ marginTop: 10 }}>
                <button className="btn btn--primary btn--sm" type="button" onClick={() => onSave(name)} disabled={isSaving || (!dirty && exists)}>{isSaving ? 'Saving…' : 'Save'}</button>
                {dirty && <button className="btn btn--sm" type="button" onClick={() => resetDraft(name)}>Discard changes</button>}
                <span className="flex-1" />
                {exists && <button className="btn btn--sm btn--danger" type="button" onClick={() => onDelete(name)}>Delete file</button>}
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}

Object.assign(window, { AgentsPage });
