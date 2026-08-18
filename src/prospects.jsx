// Prospects page — list every profile we've touched and a detail view showing
// bio data, action timeline, and DM thread. Re-skinned to the design system;
// live electronAPI wiring (prospects, activity events, thread, screenshot)
// preserved.

const { useState: useStatePR, useEffect: useEffectPR, useMemo: useMemoPR } = React;

const ACTION_LABELS = {
  profile_viewed: 'Viewed profile',
  connection_request_sent: 'Connection request sent',
  connection_accepted: 'Connection accepted',
  posts_liked: 'Liked recent posts',
  skill_endorsed: 'Endorsed skill',
  follow_user: 'Followed user',
  unfollow_user: 'Unfollowed user',
  dm_sent: 'DM sent',
  dm_reply_received: 'DM reply received',
  workflow_started: 'Workflow started',
  workflow_step_completed: 'Workflow step completed',
  workflow_step_failed: 'Workflow step failed',
  workflow_step_skipped: 'Workflow step skipped',
  prospect_archived: 'Prospect archived',
  post_published: 'Post published',
};

const PROSPECT_STATE = {
  replied: { label: 'Replied', chip: 'chip--ok' },
  in_sequence: { label: 'In sequence', chip: 'chip--info' },
  contacted: { label: 'Contacted', chip: 'chip--accent' },
  viewed: { label: 'Viewed', chip: 'chip--line' },
  suppressed: { label: 'Suppressed', chip: 'chip--warn' },
  archived: { label: 'Archived', chip: 'chip--warn' },
};

function _prospectStateChip(state) {
  const s = String(state || '').toLowerCase();
  return PROSPECT_STATE[s] || { label: s || '—', chip: 'chip--line' };
}

function _tlColor(type, status) {
  const t = String(type || '').toLowerCase();
  if (status === 'error' || t.includes('failed')) return 'var(--c-rose)';
  if (t.includes('skipped')) return 'var(--c-orange)';
  if (t.includes('reply')) return 'var(--c-teal)';
  if (t.includes('dm')) return 'var(--c-indigo)';
  if (t.includes('accepted')) return 'var(--c-green)';
  if (t.includes('connection')) return 'var(--c-blue)';
  if (t.includes('liked') || t.includes('like')) return 'var(--c-amber)';
  if (t.includes('view')) return 'var(--c-sky)';
  return 'var(--accent)';
}

function _prospectHue(p, name) {
  if (p && p.hue != null) return p.hue;
  const s = String((p && p.id) || name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function fmtDateP(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}
function recipientNameFromUrlP(url) {
  if (!url) return '';
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  if (!m) return '';
  return decodeURIComponent(m[1]).replace(/-/g, ' ');
}
function normUrl(u) {
  return String(u || '').replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
}

function ProspectsPage({ onNav }) {
  const [prospects, setProspects] = useStatePR([]);
  const [conversations, setConversations] = useStatePR([]);
  const [selectedId, setSelectedId] = useStatePR(null);
  const [search, setSearch] = useStatePR('');
  const [loading, setLoading] = useStatePR(true);
  const [events, setEvents] = useStatePR([]);
  const [eventsLoading, setEventsLoading] = useStatePR(false);
  const [thread, setThread] = useStatePR(null);
  const [threadLoading, setThreadLoading] = useStatePR(false);
  const [listW, setListW] = useResizable('connect:prospects:listw', 340, 260, 540);

  const load = async () => {
    if (!window.electronAPI) {
      // design preview: populate from MOCK so the ranked list + scores render
      const pList = (window.MOCK && MOCK.prospects) ? MOCK.prospects.map(p => ({ ...p })) : [];
      const cList = (window.MOCK && MOCK.conversations) ? MOCK.conversations : [];
      setProspects(pList);
      setConversations(cList);
      if (pList.length > 0) setSelectedId(prev => prev || pList[0].id);
      setLoading(false);
      return;
    }
    try {
      const [p, c] = await Promise.all([
        window.electronAPI.getSdrProspects({}).catch(() => []),
        window.electronAPI.getInbox ? window.electronAPI.getInbox({}).catch(() => []) : Promise.resolve([]),
      ]);
      const pList = Array.isArray(p) ? p : (p && p.prospects) || [];
      const cList = Array.isArray(c) ? c : (c && c.conversations) || [];
      setProspects(pList);
      setConversations(cList);
      if (pList.length > 0 && !selectedId) setSelectedId(pList[0].id);
    } catch (e) {
      console.warn('Prospects load failed:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffectPR(() => {
    load();
    if (!window.electronAPI || !window.electronAPI.on) return;
    const refresh = () => load();
    ['prospects-updated', 'sdr-workflow-runs-updated', 'inbox-updated'].forEach(ch =>
      window.electronAPI.on(ch, refresh)
    );
    const onFocus = (e) => { if (e && e.detail && e.detail.id) setSelectedId(e.detail.id); };
    window.addEventListener('connect:focus-prospect', onFocus);
    return () => window.removeEventListener('connect:focus-prospect', onFocus);
  }, []);

  const selected = useMemoPR(
    () => prospects.find(p => p.id === selectedId) || null,
    [prospects, selectedId]
  );

  useEffectPR(() => {
    if (!selected) { setEvents([]); setThread(null); return; }
    if (!window.electronAPI) {
      // design preview: show the mock activity timeline for this prospect
      const evts = (window.MOCK && MOCK.prospectEvents && MOCK.prospectEvents[selected.id]) || [];
      setEvents(evts);
      setThread(null);
      return;
    }
    let cancelled = false;
    setEventsLoading(true);
    window.electronAPI.listActivityEvents({
      prospectId: selected.id,
      profileUrl: selected.profileUrl || selected.normalizedProfileUrl || null,
      limit: 200,
    }).then(res => {
      if (cancelled) return;
      setEvents(Array.isArray(res) ? res : []);
    }).catch(() => { if (!cancelled) setEvents([]); })
      .finally(() => { if (!cancelled) setEventsLoading(false); });

    const targetUrl = normUrl(selected.profileUrl || selected.normalizedProfileUrl);
    const convo = conversations.find(c => {
      const url = c.profileUrl || c.participantProfileUrl || (c.participant && c.participant.profileUrl);
      return targetUrl && normUrl(url) === targetUrl;
    });
    if (convo && window.electronAPI.getInboxConversation) {
      setThreadLoading(true);
      window.electronAPI.getInboxConversation(convo.conversationUrn || convo.id, {})
        .then(res => { if (!cancelled) setThread(res || convo); })
        .catch(() => { if (!cancelled) setThread(convo); })
        .finally(() => { if (!cancelled) setThreadLoading(false); });
    } else {
      setThread(null);
    }
    return () => { cancelled = true; };
  }, [selected ? selected.id : null, conversations]);

  const filtered = useMemoPR(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return prospects;
    return prospects.filter(p => {
      const fields = [p.fullName, p.title, p.company, p.profileUrl, p.agentName, p.accountName, p.sourceLabel, p.state].filter(Boolean).join(' ').toLowerCase();
      return fields.includes(q);
    });
  }, [prospects, search]);

  const sorted = useMemoPR(() => {
    const arr = [...filtered];
    arr.sort((a, b) => Date.parse(b.lastActionAt || b.updatedAt || 0) - Date.parse(a.lastActionAt || a.updatedAt || 0));
    return arr;
  }, [filtered]);

  return (
    <div className="split">
      <div className="pane-list" style={{ width: listW, flexShrink: 0 }}>
        <div className="pane-head">
          <div className="row spread" style={{ marginBottom: 12 }}>
            <div><div className="eyebrow">Prospects</div><div className="section-title" style={{ marginTop: 3 }}>{prospects.length.toLocaleString()} touched</div></div>
            <button className="btn btn--ghost btn--icon btn--sm" type="button" onClick={load} title="Refresh"><Ic.Refresh cls="icon--sm" /></button>
          </div>
          <div className="searchbox">
            <Ic.Search cls="icon--sm s-dim" />
            <input placeholder="Search name, title, company…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="pane-scroll">
          {loading && <div className="empty-pad">Loading…</div>}
          {!loading && sorted.length === 0 && (
            <div className="empty-pad">{search ? 'No prospects match this search.' : 'No prospects yet. Run a workflow first.'}</div>
          )}
          {sorted.map(p => {
            const name = p.fullName && !/^https?:/.test(p.fullName) ? p.fullName : recipientNameFromUrlP(p.profileUrl);
            const st = _prospectStateChip(p.state);
            return (
              <button key={p.id} type="button" onClick={() => setSelectedId(p.id)}
                className={`listitem ${p.id === selectedId ? 'listitem--active' : ''}`}>
                <Avatar name={name || '?'} hue={_prospectHue(p, name)} size={38} />
                <div className="flex-1" style={{ minWidth: 0 }}>
                  <div className="row spread gap-2">
                    <span className="listitem__name truncate">{name || '(unnamed)'}</span>
                    <span className="s-faint" style={{ fontSize: 11 }}>{p.lastActionAt ? new Date(p.lastActionAt).toLocaleDateString() : ''}</span>
                  </div>
                  <div className="listitem__sub truncate">{p.title || p.sourceLabel || p.profileUrl || '—'}{p.company ? ` · ${p.company}` : ''}</div>
                  <div className="row gap-2" style={{ marginTop: 6 }}>
                    <span className={`chip ${st.chip} chip--sm`}>{st.label}</span>
                    {p.score != null && <span className="mono s-faint" style={{ fontSize: 11 }}>{p.score}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <Resizer width={listW} setWidth={setListW} min={260} max={540} />

      <div className="detail">
        {selected
          ? <ProspectDetail prospect={selected} events={events} eventsLoading={eventsLoading} thread={thread} threadLoading={threadLoading} />
          : <div className="empty-pad" style={{ marginTop: 60 }}>Select a prospect to see their bio, timeline, and DM thread.</div>}
      </div>
    </div>
  );
}

function ProspectDetail({ prospect, events, eventsLoading, thread, threadLoading }) {
  const url = prospect.profileUrl || prospect.normalizedProfileUrl || '';
  const name = prospect.fullName && !/^https?:/.test(prospect.fullName) ? prospect.fullName : recipientNameFromUrlP(url);
  const st = _prospectStateChip(prospect.state);
  const hasScore = prospect.score != null;

  const screenshotPath = prospect.metadata && prospect.metadata.lastScreenshotPath;
  const [screenshotDataUrl, setScreenshotDataUrl] = useStatePR(null);
  useEffectPR(() => {
    if (!screenshotPath || !window.electronAPI || !window.electronAPI.readProfileScreenshot) {
      setScreenshotDataUrl(null); return;
    }
    let cancelled = false;
    window.electronAPI.readProfileScreenshot({ path: screenshotPath })
      .then((res) => { if (!cancelled) setScreenshotDataUrl(res && res.success ? res.dataUrl : null); })
      .catch(() => { if (!cancelled) setScreenshotDataUrl(null); });
    return () => { cancelled = true; };
  }, [screenshotPath]);

  const timeline = useMemoPR(() => {
    if (!Array.isArray(events)) return [];
    return [...events].sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
  }, [events]);

  const messages = useMemoPR(() => {
    if (!thread) return [];
    const list = Array.isArray(thread.messages) ? thread.messages : (thread.conversation && thread.conversation.messages) || [];
    return [...list].sort((a, b) => Date.parse(a.sentAt || a.createdAt || 0) - Date.parse(b.sentAt || b.createdAt || 0));
  }, [thread]);

  return (
    <div className="detail__scroll">
      <div className="prospect-hero">
        <Avatar name={name || '?'} hue={_prospectHue(prospect, name)} size={60} />
        <div className="flex-1" style={{ minWidth: 0 }}>
          <div className="eyebrow">Prospect</div>
          <div style={{ fontSize: 23, fontWeight: 650, letterSpacing: '-0.02em', margin: '2px 0 4px' }}>{name || '(unnamed)'}</div>
          <div className="s-dim" style={{ fontSize: 13.5 }}>{prospect.title || '—'}{prospect.company ? ` · ${prospect.company}` : ''}</div>
          {url && (
            <a className="mono s-accent" style={{ fontSize: 12, textDecoration: 'none' }} href={url}
              onClick={(e) => { e.preventDefault(); if (window.electronAPI && window.electronAPI.send) window.electronAPI.send('open-external', url); }}>{normUrl(url)}</a>
          )}
        </div>
        <div className="col" style={{ alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
          <span className={`chip ${st.chip}`}>{st.label}</span>
          {hasScore && <span className="chip chip--sm" style={{ background: 'var(--surface-3)', color: scoreColor(prospect.score), fontWeight: 700 }}>Score {prospect.score}</span>}
        </div>
      </div>

      <div style={{ padding: 24 }}>
        <div className="kv-grid" style={{ marginBottom: 24 }}>
          {[
            ['Agent', prospect.agentName || '—'],
            ['Account', prospect.accountName || '—'],
            ['Source', prospect.sourceLabel || '—'],
            ['First seen', fmtDateP(prospect.firstSeenAt || prospect.createdAt)],
            ['Last action', fmtDateP(prospect.lastActionAt)],
            ...(prospect.lastReplyAt ? [['Last reply', fmtDateP(prospect.lastReplyAt)]] : []),
            ...(prospect.metadata && prospect.metadata.location ? [['Location', prospect.metadata.location]] : []),
          ].map(([k, v]) => (
            <div key={k} className="kv-card kv"><span className="eyebrow" style={{ fontSize: 10 }}>{k}</span><span className="kv__val" style={{ fontSize: 13 }}>{v}</span></div>
          ))}
        </div>

        {screenshotPath && (
          <section className="card" style={{ marginBottom: 20 }}>
            <div className="card__header card__header--bordered">
              <span className="card__title">Captured top card</span>
              <span className="s-faint mono" style={{ fontSize: 10 }}>{screenshotPath.split('/').pop()}</span>
            </div>
            <div className="card__body">
              {screenshotDataUrl
                ? <img src={screenshotDataUrl} alt="LinkedIn profile top card" style={{ width: '100%', maxWidth: 900, borderRadius: 'var(--r-sm)', border: '1px solid var(--border)' }} />
                : <div className="s-dim" style={{ fontSize: 12 }}>Loading screenshot…</div>}
            </div>
          </section>
        )}

        {hasScore && (
          <section className="card" style={{ marginBottom: 20 }}>
            <div className="card__header card__header--bordered">
              <span className="card__title">Lead score</span>
              <span className="chip chip--sm" style={{ background: 'var(--surface-3)', color: scoreColor(prospect.score), fontWeight: 700 }}>{prospect.score}/100</span>
            </div>
            <div className="card__body"><ScoreBars score={prospect.score} notes={false} /></div>
          </section>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 20 }}>
          <section className="card">
            <div className="card__header card__header--bordered"><span className="card__title">Action timeline</span></div>
            <div className="card__body">
              {eventsLoading && <div className="s-dim" style={{ fontSize: 12 }}>Loading…</div>}
              {!eventsLoading && timeline.length === 0 && <div className="s-dim" style={{ fontSize: 12 }}>No activity recorded for this profile yet.</div>}
              <div className="timeline">
                {timeline.map((evt, idx) => {
                  const label = ACTION_LABELS[evt.type] || evt.type;
                  const meta = evt.metadata || {};
                  const stepType = meta.stepType || (meta.step && meta.step.type);
                  return (
                    <div key={evt.id || idx} className="tl-item">
                      <span className="tl-dot" style={{ background: _tlColor(evt.type, evt.status) }} />
                      <div className="flex-1">
                        <div style={{ fontSize: 13, fontWeight: 550 }}>{label}{stepType && stepType !== evt.type ? ` (${String(stepType).replace(/_/g, ' ')})` : ''}</div>
                        <div className="s-dim mono" style={{ fontSize: 11, marginTop: 2 }}>{fmtDateP(evt.timestamp)}{evt.workflowName ? ` · ${evt.workflowName}` : ''}</div>
                        {meta.outcomeType && meta.outcomeType !== 'completed' && (
                          <div className="s-dim" style={{ fontSize: 11, marginTop: 2, fontStyle: 'italic' }}>{String(meta.outcomeType).replace(/_/g, ' ')}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card__header card__header--bordered"><span className="card__title">DM thread</span></div>
            <div className="card__body">
              {threadLoading && <div className="s-dim" style={{ fontSize: 12 }}>Loading thread…</div>}
              {!threadLoading && !thread && <div className="s-dim" style={{ fontSize: 12 }}>No DM thread for this prospect yet.</div>}
              {thread && messages.length === 0 && <div className="s-dim" style={{ fontSize: 12 }}>Conversation exists but no messages captured yet.</div>}
              {messages.length > 0 && (
                <div className="col gap-3">
                  {messages.map((m, i) => {
                    const out = m.direction === 'outbound' || m.fromSelf || m.isOurs;
                    return (
                      <div key={m.id || i} className={`msg ${out ? 'msg--out' : 'msg--in'}`} style={{ maxWidth: '88%' }}>
                        <div className="msg__bubble" style={{ fontSize: 13 }}>{m.body || m.text || m.preview || '(no body captured)'}</div>
                        <div className="msg__meta">{out ? 'You' : (m.senderName || 'Them')} · {fmtDateP(m.sentAt || m.createdAt)}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ProspectsPage });
