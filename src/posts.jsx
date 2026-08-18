// Scheduled Posts page — compose + schedule LinkedIn posts on a chosen account
// and review upcoming/published runs. Re-skinned to the design system; live
// publish-linkedin-post / scheduled-posts wiring preserved.

const { useState: useStatePO, useEffect: useEffectPO, useMemo: useMemoPO } = React;

function fmtDateTimePO(dateStr, timeStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(`${dateStr}T${timeStr || '09:00'}:00`);
    return d.toLocaleString();
  } catch { return `${dateStr}${timeStr ? ' ' + timeStr : ''}`; }
}

function defaultScheduleDateTime() {
  const now = new Date();
  now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15 + 60, 0, 0);
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mn = String(now.getMinutes()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mn}` };
}

const POST_STATUS_CHIP = {
  published: 'chip--ok',
  scheduled: 'chip--info',
  pending: 'chip--info',
  failed: 'chip--danger',
  cancelled: 'chip--line',
};
function postStatusChip(status) {
  return POST_STATUS_CHIP[String(status || '').toLowerCase()] || 'chip--line';
}

function PostsPage({ onNav }) {
  const [accounts, setAccounts] = useStatePO([]);
  const [posts, setPosts] = useStatePO([]);
  const [loading, setLoading] = useStatePO(true);

  const initial = defaultScheduleDateTime();
  const [content, setContent] = useStatePO('');
  const [accountId, setAccountId] = useStatePO('');
  const [mode, setMode] = useStatePO('schedule'); // 'schedule' | 'now'
  const [scheduledDate, setScheduledDate] = useStatePO(initial.date);
  const [scheduledTime, setScheduledTime] = useStatePO(initial.time);
  const [visibility, setVisibility] = useStatePO('public');
  const [submitting, setSubmitting] = useStatePO(false);
  const [statusMsg, setStatusMsg] = useStatePO(null);
  const [logLines, setLogLines] = useStatePO([]);

  const load = async () => {
    if (!window.electronAPI) { setLoading(false); return; }
    try {
      const [a, p] = await Promise.all([
        window.electronAPI.getLinkedInAccounts().catch(() => []),
        window.electronAPI.getScheduledPosts().catch(() => []),
      ]);
      const accList = Array.isArray(a) ? a : (a && a.accounts) || [];
      const postList = Array.isArray(p) ? p : (p && p.posts) || [];
      setAccounts(accList);
      if (accList[0] && !accountId) setAccountId(accList[0].id || accList[0].accountId);
      setPosts(postList);
    } catch (e) { console.warn('Posts load failed:', e); }
    finally { setLoading(false); }
  };

  useEffectPO(() => {
    load();
    if (!window.electronAPI || !window.electronAPI.on) return;
    const refresh = () => load();
    window.electronAPI.on('post-published', refresh);
    window.electronAPI.on('automation-log', (entry) => {
      const msg = typeof entry === 'string' ? entry : (entry && entry.message);
      if (!msg) return;
      setLogLines((lines) => [...lines.slice(-60), { msg, at: new Date(), type: (entry && entry.type) || 'info' }]);
    });
  }, []);

  const charCount = content.length;
  const charLimit = 3000;
  const canSubmit = !submitting && !!accountId && content.trim().length > 0
    && (mode === 'now' || (!!scheduledDate && !!scheduledTime));

  const accountLabel = useMemoPO(() => {
    const a = accounts.find(x => (x.id || x.accountId) === accountId);
    return a ? (a.name || a.displayName || a.email || accountId) : '';
  }, [accounts, accountId]);

  const handleSubmit = async () => {
    if (!window.electronAPI || !window.electronAPI.publishLinkedInPost) {
      setStatusMsg({ type: 'error', text: 'Publishing unavailable outside Electron.' });
      return;
    }
    if (!canSubmit) return;
    setSubmitting(true);
    setStatusMsg(null);
    setLogLines([]);
    try {
      const payload = { accountId, content: content.trim(), visibility, immediate: mode === 'now' };
      if (mode === 'schedule') { payload.scheduledDate = scheduledDate; payload.scheduledTime = scheduledTime; }
      const res = await window.electronAPI.publishLinkedInPost(payload);
      if (res && res.accepted === false) {
        setStatusMsg({ type: 'error', text: `Could not start: ${res.error || res.reason || 'unknown'}` });
      } else {
        const verb = mode === 'now' ? 'Publishing now' : `Scheduling for ${fmtDateTimePO(scheduledDate, scheduledTime)}`;
        setStatusMsg({ type: 'info', text: `${verb} on ${accountLabel}… (browser will open, watch for "post-published" below)` });
        setTimeout(() => { setContent(''); load(); }, 1500);
      }
    } catch (e) {
      setStatusMsg({ type: 'error', text: `Submit failed: ${(e && e.message) || 'unknown'}` });
    } finally {
      setSubmitting(false);
    }
  };

  const cancelPost = async (post) => {
    if (!window.electronAPI || !window.electronAPI.saveScheduledPosts) return;
    if (!window.confirm(`Cancel "${post.content.slice(0, 60)}…"?\nThe post will be marked cancelled locally. If it was already pushed to LinkedIn's scheduler you will need to delete it from LinkedIn manually.`)) return;
    try {
      const next = posts.map(p => p.id === post.id ? { ...p, status: 'cancelled' } : p);
      await window.electronAPI.saveScheduledPosts(next);
      load();
    } catch (e) { /* swallow */ }
  };

  const upcoming = useMemoPO(() => {
    return posts.filter(p => ['pending', 'scheduled'].includes(String(p.status || '').toLowerCase()))
      .sort((a, b) => `${a.scheduledDate || ''}${a.scheduledTime || ''}`.localeCompare(`${b.scheduledDate || ''}${b.scheduledTime || ''}`));
  }, [posts]);

  const recent = useMemoPO(() => {
    return posts.filter(p => !['pending', 'scheduled'].includes(String(p.status || '').toLowerCase()))
      .sort((a, b) => Date.parse(b.publishedAt || b.createdAt || 0) - Date.parse(a.publishedAt || a.createdAt || 0))
      .slice(0, 20);
  }, [posts]);

  return (
    <div className="split">
      <aside className="pane-list" style={{ width: 460, flexShrink: 0 }}>
        <div style={{ padding: 20, overflowY: 'auto' }}>
          <div className="eyebrow">Compose post</div>
          <div className="section-title" style={{ fontSize: 18, margin: '4px 0 16px' }}>New LinkedIn post</div>

          <div style={{ marginBottom: 14 }}>
            <span className="field-label">LinkedIn account</span>
            <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.length === 0 && <option value="">No accounts configured</option>}
              {accounts.map(a => {
                const id = a.id || a.accountId;
                const label = a.name || a.displayName || a.email || id;
                return <option key={id} value={id}>{label}</option>;
              })}
            </select>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div className="row spread" style={{ marginBottom: 6 }}>
              <span className="field-label" style={{ margin: 0 }}>Post content</span>
              <span className={`mono tabular ${charCount > charLimit ? 's-danger' : 's-dim'}`} style={{ fontSize: 11 }}>{charCount} / {charLimit}</span>
            </div>
            <textarea className="field" value={content} onChange={(e) => setContent(e.target.value)}
              placeholder={"What do you want to say?\n\nLinkedIn allows up to 3,000 characters. Break thoughts across short paragraphs so it reads cleanly on mobile."}
              style={{ minHeight: 200, resize: 'vertical' }} />
          </div>

          <div className="seg" style={{ width: '100%', marginBottom: 14 }}>
            <button type="button" className={`seg__btn flex-1 ${mode === 'schedule' ? 'seg__btn--active' : ''}`} onClick={() => setMode('schedule')}>Schedule for later</button>
            <button type="button" className={`seg__btn flex-1 ${mode === 'now' ? 'seg__btn--active' : ''}`} onClick={() => setMode('now')}>Post now</button>
          </div>

          {mode === 'schedule' && (
            <div className="kv-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 14 }}>
              <div>
                <span className="field-label">Date</span>
                <input className="field" type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} min={new Date().toISOString().slice(0, 10)} />
              </div>
              <div>
                <span className="field-label">Time</span>
                <input className="field" type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} />
              </div>
            </div>
          )}

          <div style={{ marginBottom: 18 }}>
            <span className="field-label">Visibility</span>
            <select className="field" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="public">Anyone (public)</option>
              <option value="connections">Connections only</option>
            </select>
          </div>

          <button type="button" className="btn btn--primary btn--lg" disabled={!canSubmit} onClick={handleSubmit}
            style={{ width: '100%' }} title={!accountId ? 'Pick an account first' : !content.trim() ? 'Write something first' : ''}>
            {submitting ? 'Working…' : mode === 'now' ? 'Publish now' : `Schedule for ${fmtDateTimePO(scheduledDate, scheduledTime)}`}
          </button>

          {statusMsg && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 'var(--r-sm)', fontSize: 12,
              background: statusMsg.type === 'error' ? 'var(--danger-soft)' : 'var(--info-soft)',
              color: statusMsg.type === 'error' ? 'var(--danger-text)' : 'var(--info-text)' }}>{statusMsg.text}</div>
          )}

          {logLines.length > 0 && (
            <details style={{ marginTop: 10 }} open>
              <summary className="s-dim" style={{ fontSize: 11, cursor: 'pointer' }}>Browser log ({logLines.length})</summary>
              <div className="mono" style={{ marginTop: 6, padding: 8, maxHeight: 200, overflowY: 'auto', background: 'var(--surface-3)', borderRadius: 'var(--r-sm)', fontSize: 11, lineHeight: 1.5 }}>
                {logLines.map((l, i) => (
                  <div key={i} style={{ color: l.type === 'error' ? 'var(--danger-text)' : l.type === 'warning' ? 'var(--warn-text)' : l.type === 'success' ? 'var(--ok-text)' : 'var(--text)' }}>{l.msg}</div>
                ))}
              </div>
            </details>
          )}

          <div className="s-dim" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
            A visible browser will open under <code>{accountLabel || 'the selected account'}</code>,
            type the post using humanized keystrokes, and {mode === 'now' ? 'click Publish.' : "use LinkedIn's native scheduler to pick the date and time you set above."}
          </div>
        </div>
      </aside>

      <div className="detail">
        <div className="detail__scroll" style={{ padding: '24px 28px' }}>
          <PostSection title="Upcoming" count={upcoming.length}>
            {upcoming.length === 0 && <div className="s-dim" style={{ fontSize: 12.5 }}>Nothing scheduled.</div>}
            <div className="posts-grid">{upcoming.map(p => <PostCard key={p.id} post={p} onCancel={() => cancelPost(p)} />)}</div>
          </PostSection>

          <PostSection title="Recent" count={recent.length} style={{ marginTop: 28 }}>
            {recent.length === 0 && <div className="s-dim" style={{ fontSize: 12.5 }}>No posts published or attempted yet.</div>}
            <div className="posts-grid">{recent.map(p => <PostCard key={p.id} post={p} />)}</div>
          </PostSection>
        </div>
      </div>
    </div>
  );
}

function PostSection({ title, count, children, style }) {
  return (
    <section style={style}>
      <div className="row gap-2" style={{ marginBottom: 12 }}>
        <span className="card__title">{title}</span>
        <span className="chip chip--line chip--sm">{count}</span>
      </div>
      {children}
    </section>
  );
}

function PostCard({ post, onCancel }) {
  const status = String(post.status || '').toLowerCase() || 'unknown';
  return (
    <div className="post-card">
      <div className="row spread">
        <span className={`chip ${postStatusChip(status)} chip--sm`}>{status}</span>
        {onCancel && <button type="button" className="btn btn--ghost btn--sm btn--danger" onClick={onCancel}>Cancel</button>}
      </div>
      <p style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{post.content || '(empty)'}</p>
      {post.error && <div style={{ padding: 6, fontSize: 11, color: 'var(--danger-text)', background: 'var(--danger-soft)', borderRadius: 'var(--r-xs)' }}>Error: {post.error}</div>}
      <div className="row spread" style={{ marginTop: 'auto', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
        <span className="s-dim" style={{ fontSize: 11.5 }}>{post.accountName || post.accountId || '—'}</span>
        <span className="row gap-1 s-dim" style={{ fontSize: 12 }}><Ic.Clock cls="icon--sm" />{fmtDateTimePO(post.scheduledDate, post.scheduledTime)}</span>
      </div>
    </div>
  );
}

Object.assign(window, { PostsPage });
