// Settings page — manage LinkedIn accounts, Apollo integration, and app
// maintenance. Re-skinned to the design system; live Electron IPC preserved.

const { useState: useStateST, useEffect: useEffectST, useMemo: useMemoST } = React;

const COMMON_TIMEZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo', 'Europe/London',
  'Europe/Madrid', 'Europe/Berlin', 'Europe/Paris', 'Asia/Kolkata',
  'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtRelativeST(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function _stHue(s) {
  s = String(s || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function STField({ label, hint, children }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </label>
  );
}

const ACC_HEALTH = {
  ok: { label: 'Healthy', chip: 'chip--ok' }, warm: { label: 'Warming', chip: 'chip--info' },
  cooldown: { label: 'Cooldown', chip: 'chip--warn' }, challenge: { label: 'Challenge', chip: 'chip--danger' },
};

function SettingsPage({ accountName, onAccountNameChange }) {
  const [tab, setTab] = useStateST('accounts');
  return (
    <div className="col" style={{ height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '24px 32px 0', maxWidth: 924, margin: '0 auto', width: '100%' }}>
        <div className="eyebrow">Settings</div>
        <div className="page-title" style={{ fontSize: 24, marginTop: 3, marginBottom: 16 }}>Workspace</div>
      </div>
      <div className="tabs" style={{ padding: '0 32px', maxWidth: 924, margin: '0 auto', width: '100%', background: 'transparent' }}>
        {[['accounts', 'LinkedIn accounts'], ['apollo', 'Apollo'], ['maintenance', 'Maintenance']].map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'tab--active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="flex-1" style={{ overflowY: 'auto' }}>
        <div className="settings-wrap">
          {tab === 'accounts' && <LinkedInAccountsTab accountName={accountName} onAccountNameChange={onAccountNameChange} />}
          {tab === 'apollo' && <ApolloTab />}
          {tab === 'maintenance' && <MaintenanceTab />}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── LINKEDIN ACCOUNTS ───────────────────────────
function LinkedInAccountsTab({ accountName, onAccountNameChange }) {
  const [accounts, setAccounts] = useStateST([]);
  const [loading, setLoading] = useStateST(true);
  const [editing, setEditing] = useStateST(null);
  const [creating, setCreating] = useStateST(false);
  const [toast, setToast] = useStateST(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const load = async () => {
    if (!window.electronAPI) { setAccounts(MOCK.accounts); setLoading(false); return; }
    try {
      const a = await window.electronAPI.getLinkedInAccounts();
      setAccounts(Array.isArray(a) ? a : (a && a.accounts) || []);
    } catch (e) { console.warn('Accounts load failed:', e); }
    finally { setLoading(false); }
  };

  useEffectST(() => {
    load();
    if (!window.electronAPI || !window.electronAPI.on) return;
    window.electronAPI.on('linkedin-runtime-updated', load);
    window.electronAPI.on('linkedin-account-health-updated', load);
  }, []);

  const handleSave = async (form) => {
    if (!window.electronAPI || !window.electronAPI.saveLinkedInAccount) { showToast('Save unavailable outside Electron'); return; }
    try {
      const payload = {
        id: form.id || undefined,
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password || undefined,
        timezoneId: form.timezoneId || 'America/Chicago',
        workingHours: form.workingHoursEnabled
          ? { days: form.workingDays.length ? form.workingDays : [1, 2, 3, 4, 5], startHour: Number(form.startHour) || 8, startMinute: 0, endHour: Number(form.endHour) || 18, endMinute: 0 }
          : null,
      };
      const res = await window.electronAPI.saveLinkedInAccount(payload);
      if (res && res.success === false) { showToast('Save failed: ' + (res.error || 'unknown')); return; }
      showToast(form.id ? `Saved ${form.name}` : `Created ${form.name}`);
      setEditing(null); setCreating(false); load();
    } catch (e) {
      showToast('Save failed: ' + ((e && e.message) || 'unknown'));
    }
  };

  const handleDelete = async (acc) => {
    if (!window.electronAPI || !window.electronAPI.deleteLinkedInAccount) return;
    if (!window.confirm(`Delete LinkedIn account "${acc.name || acc.email}"?\n\nThis removes the account from this app. It does NOT log out of LinkedIn or delete the actual LinkedIn account. Any agents or workflows bound to it will become orphaned.`)) return;
    try {
      const res = await window.electronAPI.deleteLinkedInAccount(acc.id);
      if (res && res.success === false) { showToast('Delete failed: ' + (res.error || 'unknown')); return; }
      showToast(`Removed ${acc.name || acc.email}`); load();
    } catch (e) {
      showToast('Delete failed: ' + ((e && e.message) || 'unknown'));
    }
  };

  return (
    <div>
      <WorkspaceAccountCard
        accountName={accountName}
        onSaveAccountName={(value) => {
          onAccountNameChange && onAccountNameChange(value);
          showToast('Account name saved');
        }}
      />

      <div className="row spread" style={{ marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 650 }}>LinkedIn accounts</div>
          <div className="s-dim" style={{ fontSize: 13, marginTop: 2 }}>Each agent and workflow runs under exactly one of these accounts.</div>
        </div>
        <button className="btn btn--primary" type="button" onClick={() => setCreating(true)}><Ic.Plus cls="icon--sm" />Add account</button>
      </div>

      {loading && <div className="empty-pad">Loading…</div>}
      {!loading && accounts.length === 0 && !creating && (
        <div className="cockpit-empty">
          <p className="s-dim" style={{ fontSize: 13.5 }}>No LinkedIn accounts yet.</p>
          <button className="btn btn--primary" style={{ marginTop: 12 }} type="button" onClick={() => setCreating(true)}>Add your first account</button>
        </div>
      )}

      {creating && <AccountForm initial={accountToForm(null)} onSave={handleSave} onCancel={() => setCreating(false)} />}

      {accounts.map((acc) => {
        if (editing && editing.id === acc.id) {
          return <AccountForm key={acc.id} initial={editing} onSave={handleSave} onCancel={() => setEditing(null)} />;
        }
        const h = ACC_HEALTH[acc.status] || ACC_HEALTH.ok;
        const wh = acc.workingHours;
        return (
          <div key={acc.id} className="acct-card">
            <div className="row gap-3" style={{ marginBottom: 10 }}>
              <Avatar name={acc.name || acc.email} hue={acc.hue != null ? acc.hue : _stHue(acc.email || acc.name)} size={36} />
              <div className="flex-1" style={{ minWidth: 0 }}>
                <div className="row gap-2"><span style={{ fontSize: 14.5, fontWeight: 650 }}>{acc.name || acc.email}</span><span className="mono s-dim" style={{ fontSize: 12 }}>{acc.email}</span>
                  {acc.hasPassword === false && <span className="chip chip--warn chip--sm">no password</span>}</div>
              </div>
              {acc.status && <span className={`chip ${h.chip} chip--sm`}><span className={`dot ${acc.status === 'challenge' ? 'dot--pulse' : ''}`} />{h.label}</span>}
              <button className="btn btn--sm" onClick={() => setEditing(accountToForm(acc))}>Edit</button>
              <button className="btn btn--sm btn--danger" onClick={() => handleDelete(acc)}>Remove</button>
            </div>
            <div className="row gap-5 wrap s-dim" style={{ fontSize: 12.5 }}>
              <span>Timezone: <b style={{ color: 'var(--text-2)' }}>{acc.timezoneId || acc.tz || 'America/Chicago'}</b></span>
              {wh
                ? <span>Working hours: <b style={{ color: 'var(--text-2)' }}>{(wh.days || []).map(d => DAY_LABELS[d]).join('/')} {String(wh.startHour).padStart(2, '0')}:00–{String(wh.endHour).padStart(2, '0')}:00</b></span>
                : <span>Working hours: <b style={{ color: 'var(--text-2)' }}>default (Mon–Fri 8–18)</b></span>}
              {acc.warmUpStartedAt && <span>Warm-up: <b style={{ color: 'var(--text-2)' }}>{fmtRelativeST(acc.warmUpStartedAt)}</b></span>}
            </div>
          </div>
        );
      })}

      {toast && <div className="toast"><Ic.Check cls="icon--sm" />{toast}</div>}
    </div>
  );
}

function WorkspaceAccountCard({ accountName, onSaveAccountName }) {
  const [draft, setDraft] = useStateST(accountName || '');

  useEffectST(() => {
    setDraft(accountName || '');
  }, [accountName]);

  const trimmed = String(draft || '').trim();
  const current = String(accountName || '').trim();
  const canSave = trimmed.length > 0 && trimmed !== current;

  return (
    <div className="acct-card">
      <div className="row spread" style={{ gap: 16, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 650 }}>Account profile</div>
          <div className="s-dim" style={{ fontSize: 13, marginTop: 2 }}>
            This name appears in the bottom-left corner of the app and links back here.
          </div>
        </div>
        <button
          className="btn btn--primary"
          type="button"
          disabled={!canSave}
          onClick={() => canSave && onSaveAccountName && onSaveAccountName(trimmed)}
        >
          Save account name
        </button>
      </div>

      <STField label="Account name" hint="Shown in the sidebar footer and used for the profile badge initials.">
        <input
          className="field"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Jordan Avery"
        />
      </STField>
    </div>
  );
}

function accountToForm(acc) {
  return {
    id: acc ? acc.id : null,
    name: (acc && acc.name) || '',
    email: (acc && acc.email) || '',
    password: '',
    timezoneId: (acc && acc.timezoneId) || 'America/Chicago',
    workingHoursEnabled: !!(acc && acc.workingHours),
    workingDays: (acc && acc.workingHours && acc.workingHours.days) || [1, 2, 3, 4, 5],
    startHour: (acc && acc.workingHours && acc.workingHours.startHour) ?? 8,
    endHour: (acc && acc.workingHours && acc.workingHours.endHour) ?? 18,
  };
}

function AccountForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useStateST(() => ({ ...initial }));
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggleDay = (d) => setForm(f => {
    const set = new Set(f.workingDays);
    if (set.has(d)) set.delete(d); else set.add(d);
    return { ...f, workingDays: [...set].sort() };
  });
  const canSave = form.name.trim().length > 0 && /\S+@\S+\.\S+/.test(form.email.trim());

  return (
    <div className="acct-card" style={{ borderColor: 'var(--accent)', background: 'var(--accent-softer)' }}>
      <div style={{ fontSize: 14, fontWeight: 650, marginBottom: 14 }}>{form.id ? 'Edit account' : 'New LinkedIn account'}</div>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <STField label="Display name *"><input className="field" value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="e.g. Priya Venkat" /></STField>
        <STField label="LinkedIn email *"><input className="field" type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} placeholder="you@example.com" disabled={!!form.id} /></STField>
        <STField label={form.id ? 'New password (blank = keep current)' : 'LinkedIn password *'} hint={form.id ? 'Stored in your macOS keychain.' : 'Stored in your macOS keychain — never sent anywhere except LinkedIn itself.'}>
          <input className="field" type="password" value={form.password} onChange={(e) => setField('password', e.target.value)} placeholder={form.id ? '••••••••' : 'Required'} />
        </STField>
        <STField label="Timezone">
          <select className="field" value={form.timezoneId} onChange={(e) => setField('timezoneId', e.target.value)}>
            {COMMON_TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </STField>
      </div>

      <div className="row gap-2" style={{ marginTop: 16 }}>
        <label className="check" onClick={() => setField('workingHoursEnabled', !form.workingHoursEnabled)}>
          <span className={`checkbox ${form.workingHoursEnabled ? 'checkbox--on' : ''}`}>{form.workingHoursEnabled && <Ic.Check cls="icon--sm" />}</span>
          Restrict automation to working hours
        </label>
      </div>
      {form.workingHoursEnabled ? (
        <div className="row gap-2 wrap" style={{ marginTop: 12 }}>
          {DAY_LABELS.map((d, i) => (
            <button key={d} type="button" className={`daytoggle ${form.workingDays.includes(i) ? 'daytoggle--on' : ''}`} onClick={() => toggleDay(i)}>{d}</button>
          ))}
          <span className="row gap-2" style={{ marginLeft: 8 }}>
            <input className="field" style={{ width: 64, textAlign: 'center' }} type="number" min="0" max="23" value={form.startHour} onChange={(e) => setField('startHour', Math.max(0, Math.min(23, Number(e.target.value) || 0)))} />
            <span className="s-dim">to</span>
            <input className="field" style={{ width: 64, textAlign: 'center' }} type="number" min="1" max="24" value={form.endHour} onChange={(e) => setField('endHour', Math.max(1, Math.min(24, Number(e.target.value) || 18)))} />
          </span>
        </div>
      ) : (
        <div className="s-dim" style={{ fontSize: 11.5, marginTop: 10 }}>Off — automation runs whenever the scheduler ticks. Manual launches always run regardless of this setting.</div>
      )}

      <div className="row gap-2" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn btn--primary" onClick={() => onSave(form)} disabled={!canSave}>{form.id ? 'Save changes' : 'Create account'}</button>
      </div>
    </div>
  );
}

// ─────────────────────────── APOLLO ───────────────────────────
function ApolloTab() {
  const [integration, setIntegration] = useStateST(null);
  const [apiKey, setApiKey] = useStateST('');
  const [enabled, setEnabled] = useStateST(true);
  const [saving, setSaving] = useStateST(false);
  const [toast, setToast] = useStateST(null);
  const [loading, setLoading] = useStateST(true);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const load = async () => {
    if (!window.electronAPI) { setLoading(false); return; }
    try {
      const res = await window.electronAPI.getApolloIntegration();
      setIntegration(res || null);
      setEnabled(!!(res && res.enabled));
    } catch (e) { console.warn('Apollo load failed:', e); }
    finally { setLoading(false); }
  };
  useEffectST(() => { load(); }, []);

  const handleSave = async () => {
    if (!window.electronAPI || !window.electronAPI.configureApolloIntegration) return;
    setSaving(true);
    try {
      const payload = { enabled };
      if (apiKey && apiKey.trim()) payload.apiKey = apiKey.trim();
      const res = await window.electronAPI.configureApolloIntegration(payload);
      if (res && res.success) { showToast(apiKey ? 'API key saved' : 'Apollo settings updated'); setApiKey(''); load(); }
      else showToast('Save failed: ' + ((res && res.error) || 'unknown'));
    } catch (e) {
      showToast('Save failed: ' + ((e && e.message) || 'unknown'));
    } finally { setSaving(false); }
  };

  const handleClear = async () => {
    if (!window.electronAPI || !window.electronAPI.configureApolloIntegration) return;
    if (!window.confirm('Clear the saved Apollo API key? Sync features will stop working until you add a new key.')) return;
    setSaving(true);
    try {
      const res = await window.electronAPI.configureApolloIntegration({ clearApiKey: true, enabled: false });
      if (res && res.success) { showToast('API key cleared'); setApiKey(''); load(); }
      else showToast('Clear failed');
    } finally { setSaving(false); }
  };

  const hasKey = !!(integration && integration.hasApiKey);

  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 650 }}>Apollo integration</div>
      <div className="s-dim" style={{ fontSize: 13, marginTop: 2, marginBottom: 18, maxWidth: 620, lineHeight: 1.55 }}>
        Connect your Apollo workspace to sync prospects discovered by workflows into Apollo sequences.
        Your API key is stored in the macOS keychain — Connect calls Apollo's REST API directly.
      </div>

      {loading && <div className="empty-pad">Loading…</div>}

      <div className="acct-card">
        <div className="row spread" style={{ marginBottom: 14 }}>
          <div><div style={{ fontSize: 14, fontWeight: 650 }}>Status</div>
            <div className="s-dim" style={{ fontSize: 12.5 }}>{hasKey ? 'API key saved' : 'No API key configured'}{integration && integration.enabled ? ' · enabled' : ' · disabled'}</div></div>
          {hasKey
            ? <button className="btn btn--sm btn--danger" type="button" onClick={handleClear} disabled={saving}>Clear key</button>
            : <span className="chip chip--line chip--sm">not connected</span>}
        </div>
        <STField label="Apollo API key" hint="Find this under Apollo → Settings → Integrations → API.">
          <input className="field" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasKey ? '•••••••• (saved — paste a new value to replace)' : 'Paste your Apollo API key'} />
        </STField>
        <div className="row spread" style={{ marginTop: 16 }}>
          <div className="row gap-3"><Toggle on={enabled} onChange={setEnabled} /><span style={{ fontSize: 13.5 }}>Enable Apollo sync</span></div>
          <button className="btn btn--primary" type="button" onClick={handleSave}
            disabled={saving || (!apiKey.trim() && !!integration && integration.enabled === enabled)}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      {toast && <div className="toast"><Ic.Check cls="icon--sm" />{toast}</div>}
    </div>
  );
}

// ─────────────────────────── MAINTENANCE ───────────────────────────
function MaintenanceTab() {
  const [busy, setBusy] = useStateST(null);
  const [msg, setMsg] = useStateST(null);
  const showMsg = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 3500); };

  const runExportActivity = async () => {
    if (!window.electronAPI || !window.electronAPI.exportActivityReport) return;
    setBusy('activity');
    try {
      const res = await window.electronAPI.exportActivityReport({});
      if (res && res.cancelled) showMsg('Export cancelled', false);
      else if (res && res.success) showMsg(`Activity exported to ${res.outputDir || 'chosen folder'}`);
      else showMsg('Export failed: ' + ((res && res.error) || 'unknown'), false);
    } finally { setBusy(null); }
  };
  const runExportDiagnostics = async () => {
    if (!window.electronAPI || !window.electronAPI.exportDiagnosticsReport) return;
    setBusy('diag');
    try {
      const res = await window.electronAPI.exportDiagnosticsReport({});
      if (res && res.cancelled) showMsg('Export cancelled', false);
      else if (res && res.success) showMsg(`Diagnostics exported to ${res.outputDir || 'chosen folder'}`);
      else showMsg('Export failed: ' + ((res && res.error) || 'unknown'), false);
    } finally { setBusy(null); }
  };

  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 650, marginBottom: 18 }}>Maintenance</div>

      <div className="acct-card">
        <div style={{ fontSize: 14, fontWeight: 650 }}>Export activity report</div>
        <div className="s-dim" style={{ fontSize: 12.5, margin: '4px 0 12px', maxWidth: 560, lineHeight: 1.5 }}>Bundles all activity events, workflow runs, prospects, and step-outcome breakdowns into CSV + JSON files in a folder you choose.</div>
        <button className="btn" type="button" onClick={runExportActivity} disabled={busy === 'activity'}>{busy === 'activity' ? 'Exporting…' : 'Export activity report'}</button>
      </div>

      <div className="acct-card">
        <div style={{ fontSize: 14, fontWeight: 650 }}>Export diagnostics bundle</div>
        <div className="s-dim" style={{ fontSize: 12.5, margin: '4px 0 12px', maxWidth: 560, lineHeight: 1.5 }}>Captures runtime logs, account-health snapshots, transport-health stats, and recent workflow errors — useful for sharing with support.</div>
        <button className="btn" type="button" onClick={runExportDiagnostics} disabled={busy === 'diag'}>{busy === 'diag' ? 'Exporting…' : 'Export diagnostics'}</button>
      </div>

      <div className="acct-card">
        <div style={{ fontSize: 14, fontWeight: 650 }}>App data location</div>
        <div className="mono s-dim" style={{ fontSize: 11.5, marginTop: 8, wordBreak: 'break-all' }}>~/Library/Application Support/Connect Ability/</div>
        <div className="s-dim" style={{ fontSize: 11.5, marginTop: 6 }}>Includes: sdr-agents.json, prospect-queue.json, workflow-runs.json, scheduled-posts.json, inbox.json, sessions/, profile-screenshots/, personas/.</div>
      </div>

      {msg && <div className="toast" style={msg.ok ? undefined : { background: 'var(--danger)', color: '#fff' }}><Ic.Check cls="icon--sm" />{msg.text}</div>}
    </div>
  );
}

Object.assign(window, { SettingsPage });
