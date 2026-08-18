// New Agent modal — triggered from ⌘K or cockpit "New agent" button

const { useState: useStateM, useEffect: useEffectM } = React;

function NewAgentModal({ open, onClose, onCreated }) {
  const [step, setStep] = useStateM(0);
  const [name, setName] = useStateM('');
  const [role, setRole] = useStateM('');
  const [account, setAccount] = useStateM('');
  const [tone, setTone] = useStateM('concise');
  const [accounts, setAccounts] = useStateM([]);
  const [saving, setSaving] = useStateM(false);
  const [error, setError] = useStateM(null);

  // Load real LinkedIn accounts when the modal opens.
  useEffectM(() => {
    if (!open || !window.electronAPI || !window.electronAPI.getLinkedInAccounts) return;
    window.electronAPI.getLinkedInAccounts().then((res) => {
      const list = Array.isArray(res) ? res : (res && res.accounts) || [];
      setAccounts(list);
      if (list[0]) setAccount(list[0].id || list[0].accountId || '');
    }).catch(() => setAccounts([]));
  }, [open]);

  useEffectM(() => {
    if (!open) { setStep(0); setName(''); setRole(''); setError(null); setSaving(false); }
    const onKey = (e) => { if (e.key === 'Escape' && open) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const steps = ['Identity', 'Account + voice', 'Persona files'];

  const handleCreate = async () => {
    if (!name.trim()) { setError('Agent name is required'); setStep(0); return; }
    if (!window.electronAPI || !window.electronAPI.saveSdrAgent) {
      setError('Save unavailable — running outside Electron');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        accountId: account || null,
        niche: role.trim(),
        status: 'active',
        metadata: { contentTone: [tone] },
      };
      const result = await window.electronAPI.saveSdrAgent(payload);
      if (result && result.success === false) {
        setError(result.error || 'Save failed');
        return;
      }
      const savedAgent = result && result.agent ? result.agent : null;
      if (typeof onCreated === 'function') onCreated(savedAgent);
      try { window.dispatchEvent(new CustomEvent('connect:agents-updated', { detail: savedAgent })); } catch {}
      onClose();
    } catch (e) {
      setError((e && e.message) || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal__head">
          <div>
            <div className="eyebrow">New SDR agent</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 3 }}>Build a new persona</div>
          </div>
          <button className="btn btn--ghost btn--icon" onClick={onClose}><Ic.X/></button>
        </div>

        <div className="modal__steps">
          {steps.map((s, i) => (
            <div key={s} className={`mstep ${i===step?'mstep--active':''} ${i<step?'mstep--done':''}`}>
              <div className="mstep__num">{i < step ? <Ic.Check cls="icon--sm"/> : i+1}</div>
              <span>{s}</span>
            </div>
          ))}
        </div>

        <div className="modal__body">
          {step === 0 && (
            <div className="col gap-3">
              <label className="field">
                <span className="eyebrow">Agent name</span>
                <input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Halcyon" autoFocus/>
                <span className="field__hint">Shows up in the inbox, logs, and activity feed.</span>
              </label>
              <label className="field">
                <span className="eyebrow">Role</span>
                <input className="input" value={role} onChange={e=>setRole(e.target.value)} placeholder="Sr RevOps SDR · Founder voice · Technical AE"/>
              </label>
            </div>
          )}

          {step === 1 && (
            <div className="col gap-3">
              <label className="field">
                <span className="eyebrow">LinkedIn account binding</span>
                <select className="input" value={account} onChange={e=>setAccount(e.target.value)}>
                  <option value="">— no account bound —</option>
                  {accounts.map(a => {
                    const id = a.id || a.accountId;
                    const label = a.name || a.displayName || a.email || id;
                    return <option key={id} value={id}>{label}</option>;
                  })}
                </select>
                <span className="field__hint">{accounts.length === 0 ? 'No LinkedIn accounts configured. Add one in Credentials.' : 'Agent will only operate under this account.'}</span>
              </label>
              <div className="field">
                <span className="eyebrow">Writing tone preset</span>
                <div className="row gap-2">
                  {['concise', 'warm', 'technical', 'founder'].map(t => (
                    <button key={t} className={`btn ${tone===t?'btn--primary':''}`} onClick={()=>setTone(t)}>{t}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="col gap-3">
              <div className="s-dim" style={{ fontSize: 12 }}>
                The soul of this app. Four markdown files define how your agent writes, what they care about, and where they won't go.
              </div>
              {[
                { f: 'soul.md',          d: 'Core motivation. Why this persona exists and what they believe.', lines: 18 },
                { f: 'personality.md',   d: 'Voice quirks, humor baseline, pet peeves.', lines: 24 },
                { f: 'writing-style.md', d: 'Sentence length, vocabulary, punctuation conventions.', lines: 12 },
                { f: 'boundaries.md',    d: 'Topics, tones, and claims to avoid. Hard rules.', lines: 8 },
              ].map(p => (
                <div key={p.f} className="personafile">
                  <div className="personafile__icon mono">md</div>
                  <div className="col flex-1 gap-1">
                    <div className="row gap-2">
                      <span className="mono" style={{ fontWeight: 500 }}>{p.f}</span>
                      <span className="chip chip--line mono">empty · seed from template</span>
                    </div>
                    <div className="s-dim" style={{ fontSize: 11 }}>{p.d}</div>
                  </div>
                  <button className="btn btn--sm">Open editor</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal__foot">
          <span className="mono s-dim" style={{ fontSize: 11 }}>
            {error ? <span style={{ color: 'var(--danger, #c00)' }}>{error}</span> : `Step ${step+1} of ${steps.length}`}
          </span>
          <div className="row gap-2">
            {step > 0 && <button className="btn" onClick={()=>setStep(s=>s-1)} disabled={saving}>Back</button>}
            {step < steps.length - 1 ? (
              <button className="btn btn--primary" onClick={()=>setStep(s=>s+1)} disabled={step===0 && !name}>
                Next <Ic.ChevronRight cls="icon--sm"/>
              </button>
            ) : (
              <button className="btn btn--primary" onClick={handleCreate} disabled={saving || !name.trim()}>
                <Ic.Check cls="icon--sm"/>{saving ? 'Creating…' : 'Create agent'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { NewAgentModal });
