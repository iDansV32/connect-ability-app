// Three lightweight admin pages — wired to real Electron IPC.
// Replaces the Placeholder for /health, /apollo, /analytics.

const { useState: useStateAD, useEffect: useEffectAD, useMemo: useMemoAD } = React;

function fmtDateAD(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

function fmtRelativeAD(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function MetricCardAD({ label, value, sub, tone }) {
  const toneColor =
    tone === 'ok' ? '#3a9c4d' :
    tone === 'warn' ? '#b07000' :
    tone === 'danger' ? '#c33' :
    'var(--text)';
  return (
    <div style={{
      padding: 12, border: '1px solid var(--line)', borderRadius: 8,
      background: 'var(--surface)',
    }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.1, color: toneColor }}>{value}</div>
      {sub && <div className="s-dim" style={{ fontSize: 11, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// ACCOUNT HEALTH PAGE
// ─────────────────────────────────────────────────────────
function AccountHealthPage() {
  const [accounts, setAccounts] = useStateAD([]);
  const [health, setHealth] = useStateAD({});
  const [loading, setLoading] = useStateAD(true);
  const [clearing, setClearing] = useStateAD(null);

  const load = async () => {
    if (!window.electronAPI) { setLoading(false); return; }
    try {
      const [a, h] = await Promise.all([
        window.electronAPI.getLinkedInAccounts().catch(() => []),
        window.electronAPI.getLinkedInAccountHealth().catch(() => ({})),
      ]);
      const accList = Array.isArray(a) ? a : (a && a.accounts) || [];
      setAccounts(accList);
      setHealth(h && typeof h === 'object' && !Array.isArray(h) ? h : {});
    } catch (e) { console.warn('Health load failed:', e); }
    finally { setLoading(false); }
  };

  useEffectAD(() => {
    load();
    if (!window.electronAPI || !window.electronAPI.on) return;
    const refresh = () => load();
    ['linkedin-account-health-updated', 'linkedin-challenge-detected', 'linkedin-runtime-updated']
      .forEach(ch => window.electronAPI.on(ch, refresh));
    const poll = setInterval(load, 30000);
    return () => clearInterval(poll);
  }, []);

  const rows = useMemoAD(() => accounts.map(acc => {
    const h = health[acc.id] || {};
    const challengeAt = h.challenged && h.challenged.at;
    const workflowStatus = h.workflow && h.workflow.status;
    const replyStatus = h.replyMonitor && h.replyMonitor.status;
    const sessionVerifiedAt = h.session && h.session.lastVerifiedAt;
    const sessionFailureAt = h.session && h.session.lastAuthFailureAt;
    let status = 'ok';
    if (challengeAt) status = 'challenge';
    else if (workflowStatus === 'cooldown') status = 'cooldown';
    return {
      account: acc,
      status,
      challengeAt,
      workflowStatus,
      replyStatus,
      sessionVerifiedAt,
      sessionFailureAt,
      challengeType: h.challenged && h.challenged.type,
    };
  }), [accounts, health]);

  const counts = useMemoAD(() => ({
    total: rows.length,
    ok: rows.filter(r => r.status === 'ok').length,
    cooldown: rows.filter(r => r.status === 'cooldown').length,
    challenge: rows.filter(r => r.status === 'challenge').length,
  }), [rows]);

  const handleClearChallenge = async (accountId) => {
    if (!window.electronAPI || !window.electronAPI.clearLinkedInAccountChallenge) return;
    setClearing(accountId);
    try {
      const res = await window.electronAPI.clearLinkedInAccountChallenge(accountId);
      if (!res || res.success === false) {
        window.alert('Could not clear challenge: ' + (res && res.error || 'unknown'));
      }
      load();
    } finally { setClearing(null); }
  };

  return (
    <div style={{ padding: '14px 24px', height: '100%', overflowY: 'auto' }}>
      <div style={{ marginBottom: 18 }}>
        <div className="eyebrow">Account health</div>
        <h2 style={{ fontSize: 22, margin: '3px 0 0', fontWeight: 600 }}>LinkedIn accounts</h2>
      </div>

      {/* Summary metrics */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 10, marginBottom: 18,
      }}>
        <MetricCardAD label="Total accounts" value={counts.total} />
        <MetricCardAD label="Healthy" value={counts.ok} tone="ok" />
        <MetricCardAD label="Cooldown" value={counts.cooldown} tone={counts.cooldown ? 'warn' : 'ok'} />
        <MetricCardAD label="Challenges" value={counts.challenge} tone={counts.challenge ? 'danger' : 'ok'} />
      </div>

      {loading && <div className="s-dim">Loading…</div>}
      {!loading && rows.length === 0 && (
        <div style={{
          padding: 40, textAlign: 'center', color: 'var(--text-dim)',
          border: '1px dashed var(--line)', borderRadius: 8,
        }}>
          <p>No LinkedIn accounts configured.</p>
          <p style={{ fontSize: 12 }}>Open <b>Credentials</b> in the sidebar to add one.</p>
        </div>
      )}

      {/* Per-account cards */}
      {rows.map(({ account, status, challengeAt, challengeType, workflowStatus, replyStatus, sessionVerifiedAt, sessionFailureAt }) => {
        const statusColor =
          status === 'ok' ? '#3a9c4d' :
          status === 'cooldown' ? '#b07000' :
          status === 'challenge' ? '#c33' : 'var(--text-dim)';
        return (
          <div key={account.id} style={{
            padding: 14, marginBottom: 10, border: '1px solid var(--line)', borderRadius: 8,
            background: 'var(--surface)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 3,
                background: statusColor + '22', color: statusColor, fontWeight: 700,
                letterSpacing: 0.4, textTransform: 'uppercase',
              }}>{status}</span>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{account.name || account.email}</div>
              <span className="mono s-dim" style={{ fontSize: 11 }}>{account.email}</span>
              <span style={{ flex: 1 }} />
              {status === 'challenge' && (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={clearing === account.id}
                  onClick={() => handleClearChallenge(account.id)}
                >{clearing === account.id ? 'Clearing…' : 'Clear challenge'}</button>
              )}
            </div>

            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 8, fontSize: 12,
            }}>
              <div>
                <div className="eyebrow" style={{ fontSize: 10 }}>Workflow runtime</div>
                <div>{workflowStatus || 'idle'}</div>
              </div>
              <div>
                <div className="eyebrow" style={{ fontSize: 10 }}>Reply monitor</div>
                <div>{replyStatus || 'idle'}</div>
              </div>
              <div>
                <div className="eyebrow" style={{ fontSize: 10 }}>Last session verified</div>
                <div>{sessionVerifiedAt ? fmtRelativeAD(sessionVerifiedAt) : '—'}</div>
              </div>
              <div>
                <div className="eyebrow" style={{ fontSize: 10 }}>Last auth failure</div>
                <div className={sessionFailureAt ? 's-danger' : ''}>
                  {sessionFailureAt ? fmtRelativeAD(sessionFailureAt) : 'none'}
                </div>
              </div>
              {challengeAt && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div className="eyebrow" style={{ fontSize: 10, color: '#c33' }}>Active challenge</div>
                  <div className="s-danger">
                    {challengeType || 'unknown'} · detected {fmtRelativeAD(challengeAt)} ({fmtDateAD(challengeAt)})
                  </div>
                </div>
              )}
            </div>

            <div className="s-dim" style={{ fontSize: 11, marginTop: 6 }}>
              <span>Daily used: {account.dailyUsed || 0} / {account.dailyCeiling || account.dailyLimit || 'no ceiling'}</span>
              {account.warmUpStartedAt && <span> · Warm-up started {fmtRelativeAD(account.warmUpStartedAt)}</span>}
              {account.timezoneId && <span> · TZ: {account.timezoneId}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// APOLLO SYNC PAGE
// ─────────────────────────────────────────────────────────
function ApolloSyncPage() {
  const [integration, setIntegration] = useStateAD(null);
  const [bindings, setBindings] = useStateAD([]);
  const [syncStatus, setSyncStatus] = useStateAD([]);
  const [loading, setLoading] = useStateAD(true);

  const load = async () => {
    if (!window.electronAPI) { setLoading(false); return; }
    try {
      const [int_, binds, status] = await Promise.all([
        window.electronAPI.getApolloIntegration ? window.electronAPI.getApolloIntegration().catch(() => null) : Promise.resolve(null),
        window.electronAPI.listApolloBindings ? window.electronAPI.listApolloBindings({}).catch(() => []) : Promise.resolve([]),
        window.electronAPI.getApolloSyncStatus ? window.electronAPI.getApolloSyncStatus({ limit: 50 }).catch(() => []) : Promise.resolve([]),
      ]);
      setIntegration(int_ || null);
      setBindings(Array.isArray(binds) ? binds : (binds && binds.bindings) || []);
      setSyncStatus(Array.isArray(status) ? status : (status && status.entries) || []);
    } catch (e) { console.warn('Apollo load failed:', e); }
    finally { setLoading(false); }
  };

  useEffectAD(() => { load(); const poll = setInterval(load, 60000); return () => clearInterval(poll); }, []);

  const enabled = !!(integration && integration.enabled);
  const hasKey = !!(integration && integration.hasApiKey);

  return (
    <div style={{ padding: '14px 24px', height: '100%', overflowY: 'auto' }}>
      <div style={{ marginBottom: 18 }}>
        <div className="eyebrow">Apollo</div>
        <h2 style={{ fontSize: 22, margin: '3px 0 0', fontWeight: 600 }}>Apollo sync</h2>
      </div>

      {!enabled && !hasKey && (
        <div style={{
          padding: 18, border: '1px dashed var(--line)', borderRadius: 8,
          background: 'rgba(40,130,255,0.04)', marginBottom: 16,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Apollo isn't connected</div>
          <p className="s-dim" style={{ fontSize: 12, margin: 0, maxWidth: 560, lineHeight: 1.5 }}>
            Connect your Apollo workspace to sync prospects from workflows + groups into Apollo
            sequences. Today, this app calls Apollo via the public REST API — you'll need an Apollo
            API key with sequence + contact permissions. Save it via the <code>configure_apollo_integration</code>
            MCP tool, or paste it into <b>Credentials</b> (not yet wired in this UI).
          </p>
        </div>
      )}

      {loading && <div className="s-dim">Loading…</div>}

      {(enabled || hasKey) && (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 10, marginBottom: 18,
          }}>
            <MetricCardAD label="Integration" value={enabled ? 'Active' : 'Disabled'} tone={enabled ? 'ok' : 'warn'} />
            <MetricCardAD label="API key" value={hasKey ? 'Saved' : 'Missing'} tone={hasKey ? 'ok' : 'danger'} />
            <MetricCardAD label="Bindings" value={bindings.length} />
            <MetricCardAD label="Recent syncs" value={syncStatus.length} />
          </div>

          <Section title={`Bindings (${bindings.length})`}>
            {bindings.length === 0 && <div className="s-dim" style={{ fontSize: 12 }}>No bindings yet.</div>}
            {bindings.map((b, i) => (
              <div key={b.id || i} style={cardStyleAD}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="mono" style={{ fontSize: 11 }}>{b.targetType || '—'}</span>
                  <span style={{ fontSize: 13, fontWeight: 550 }}>{b.label || b.targetId}</span>
                  <span style={{ flex: 1 }} />
                  <span className="s-dim mono" style={{ fontSize: 10 }}>{b.sequenceName || b.sequenceId}</span>
                </div>
                <div className="s-dim" style={{ fontSize: 11, marginTop: 4 }}>
                  Updated {fmtRelativeAD(b.updatedAt || b.createdAt)}
                </div>
              </div>
            ))}
          </Section>

          <Section title="Recent sync activity" style={{ marginTop: 16 }}>
            {syncStatus.length === 0 && <div className="s-dim" style={{ fontSize: 12 }}>No sync events recorded.</div>}
            {syncStatus.slice(0, 20).map((s, i) => {
              const ok = String(s.status || '').toLowerCase() === 'enrolled' || String(s.status || '').toLowerCase() === 'ok';
              return (
                <div key={s.id || i} style={cardStyleAD}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 3, fontWeight: 700,
                      background: (ok ? '#3a9c4d' : '#b07000') + '22',
                      color: ok ? '#3a9c4d' : '#b07000',
                      letterSpacing: 0.4, textTransform: 'uppercase',
                    }}>{s.status}</span>
                    <span style={{ fontSize: 12 }}>{s.prospectName || s.prospectId || s.contactId}</span>
                    <span style={{ flex: 1 }} />
                    <span className="s-dim mono" style={{ fontSize: 10 }}>{fmtRelativeAD(s.updatedAt || s.createdAt)}</span>
                  </div>
                  {s.skipReason && <div className="s-dim" style={{ fontSize: 11, marginTop: 4 }}>{s.skipReason}</div>}
                </div>
              );
            })}
          </Section>
        </>
      )}
    </div>
  );
}

// Analytics page removed — overlaps with the Cockpit. See the Cockpit for
// live KPI tiles and the activity feed.

function Section({ title, children, style }) {
  return (
    <section style={style}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </section>
  );
}

function BreakdownRow({ label, total }) {
  return (
    <div style={cardStyleAD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <span style={{ fontWeight: 550 }}>{label}</span>
        <span className="mono tabular">{total || 0}</span>
      </div>
    </div>
  );
}

function ActivityRow({ item }) {
  return (
    <div style={cardStyleAD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
        <span style={{ fontWeight: 550 }}>{item.type || item.event || 'event'}</span>
        <span className="s-dim mono" style={{ fontSize: 10 }}>{fmtRelativeAD(item.timestamp || item.at)}</span>
      </div>
      {item.profileUrl && <div className="s-dim mono" style={{ fontSize: 10, marginTop: 2, wordBreak: 'break-all' }}>
        {item.profileUrl.replace(/^https?:\/\//, '')}
      </div>}
    </div>
  );
}

const cardStyleAD = {
  padding: 10, border: '1px solid var(--line)', borderRadius: 6,
  background: 'var(--surface)',
};

Object.assign(window, { AccountHealthPage, ApolloSyncPage });
