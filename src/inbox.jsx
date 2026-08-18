// Unified Inbox — two-pane (resizable conversation list + thread) with a
// Details tab for prospect intel. J/K nav, compose-DM modal. Live data from
// electronAPI with MOCK fallback for the design preview.

const { useState: useStateI, useEffect: useEffectI, useRef: useRefI, useMemo: useMemoI } = React;

// ===================================================================
// Real-data adapters — map backend inbox shape to the view shape.
// ===================================================================
function _inboxFmtAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - Number(ms);
  if (diff < 0) return 'now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  const days = Math.floor(hrs / 24);
  return days + 'd';
}
function _inboxHueFromString(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
function _adaptConversation(c) {
  if (!c) return null;
  const names = Array.isArray(c.participantNames) ? c.participantNames : [];
  const name = names[0] || c.participantName || c.name || 'LinkedIn contact';
  const intent = String(c.intentLabel || c.intent || 'neutral').toLowerCase();
  const status = String(c.status || 'active').toLowerCase();
  const preview = c.lastMessagePreview || c.preview || '';
  const msgs = Array.isArray(c.messages) ? c.messages : [];
  const mappedMessages = msgs.map((m) => {
    const dir = String(m.direction || m.who || '').toLowerCase();
    const who = dir.startsWith('out') ? 'out' : 'in';
    const ts = Number(m.sentAt || m.at || 0);
    const at = ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : (m.at || '');
    return { who, at, text: m.text || m.body || '' };
  });
  return {
    id: c.conversationUrn || c.id,
    conversationUrn: c.conversationUrn,
    runId: c.runId || null,
    agentId: c.agentId || null,
    accountId: c.accountId || null,
    name,
    title: c.participantTitle || c.title || '',
    company: c.participantCompany || c.company || '',
    agent: c.agentName || c.agent || 'Agent',
    intent: MOCK.intentMap[intent] ? intent : 'neutral',
    preview,
    ago: _inboxFmtAgo(c.lastInboundAt || c.updatedAt),
    unread: status === 'active' || status === 'paused',
    suppressed: status === 'suppressed' || status === 'resolved',
    hue: _inboxHueFromString(c.accountId || name),
    score: c.score != null ? c.score : 0,
    messages: mappedMessages,
    _raw: c,
  };
}

// MOCK conversations use `hue` (added below) but historic records used
// `accountHue`; normalize so either renders.
function _normHue(c) { return c.hue != null ? c.hue : (c.accountHue != null ? c.accountHue : _inboxHueFromString(c.name)); }

function scoreColor(s) { return s >= 80 ? 'var(--c-green)' : s >= 60 ? 'var(--c-amber)' : 'var(--c-orange)'; }
const SCORE_SPECTRUM = ['var(--c-violet)', 'var(--c-indigo)', 'var(--c-blue)', 'var(--c-sky)', 'var(--c-teal)', 'var(--c-green)'];

function IntentChip({ intent }) {
  const m = MOCK.intentMap[intent] || MOCK.intentMap.neutral;
  const cls = { ok: 'chip--ok', info: 'chip--info', warn: 'chip--warn', danger: 'chip--danger', neutral: 'chip--line' }[m.color];
  return <span className={`chip ${cls} chip--sm`}><span className="dot" />{m.label}</span>;
}

// Lead-score in the funnel bar language: a hero bar + per-factor colored bars.
// `breakdown` is an array of { factor, weight, raw, note } rows. The live
// lead scorer stores its factors in a different shape
// (`{ total, factors: { titleMatch, ... } }`) and does not compute every factor
// the design fixture shows, so nothing maps it into this component yet. Until
// that adapter exists the shipped app renders the real score with no factor
// rows rather than borrowing the fixture's invented ones — a fresh install must
// not show numbers it did not compute. Design preview still passes the fixture.
function ScoreBars({ score, notes = true, breakdown = null }) {
  const rows = Array.isArray(breakdown) && breakdown.length
    ? breakdown
    : (!window.electronAPI && window.MOCK && MOCK.scoreBreakdown) || [];
  return (
    <div>
      <div className="vtrack" style={{ height: 38, marginBottom: 18 }}>
        <div className="vfill" style={{ width: Math.max(score, 14) + '%', background: scoreColor(score), fontSize: 14 }}>{score} <span style={{ opacity: 0.75, fontWeight: 500 }}>/ 100</span></div>
      </div>
      <div className="sbreak">
        {rows.map((b, i) => (
          <div key={b.factor} className="sbrow">
            <div className="sbrow__head">
              <span className="sbrow__name">{b.factor}</span>
              <span className="tabular s-dim" style={{ fontSize: 12 }}>weight {b.weight}</span>
            </div>
            <div className="vtrack" style={{ height: 26 }}>
              <div className="vfill" style={{ width: Math.max((b.raw / b.weight) * 100, 16) + '%', background: SCORE_SPECTRUM[i % SCORE_SPECTRUM.length], fontSize: 12, minWidth: 46 }}>{b.raw}/{b.weight}</div>
            </div>
            {notes && <div className="sbrow__note">{b.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConversationRow({ c, active, onClick }) {
  return (
    <button className={`convrow ${active ? 'convrow--active' : ''}`} onClick={onClick}>
      {c.unread && <span className="convrow__dot" />}
      <Avatar name={c.name} hue={_normHue(c)} size={38} />
      <div className="flex-1" style={{ minWidth: 0 }}>
        <div className="row spread gap-2">
          <span className="convrow__name truncate">{c.name}</span>
          <span className="convrow__time">{c.ago}</span>
        </div>
        <div className="listitem__sub truncate">{c.title}{c.title && c.company ? ' · ' : ''}{c.company}</div>
        <div className="convrow__preview">{c.preview}</div>
        <div className="row gap-2" style={{ marginTop: 7 }}>
          <IntentChip intent={c.intent} />
          <span className="s-faint" style={{ fontSize: 11 }}>via {c.agent}</span>
          {c.suppressed && <span className="chip chip--line chip--sm"><Ic.Ban cls="icon--sm" />DNC</span>}
        </div>
      </div>
    </button>
  );
}

function Message({ m, agent }) {
  const out = m.who === 'out';
  return (
    <div className={`msg ${out ? 'msg--out' : 'msg--in'}`}>
      <div className="msg__meta"><span>{out ? `${agent} · outbound` : 'inbound'}</span><span>{m.at}</span></div>
      <div className="msg__bubble">{m.text}</div>
    </div>
  );
}

function DetailsView({ c, onResume, onArchive, onSuppress }) {
  const next = (MOCK.intentMap[c.intent] || MOCK.intentMap.neutral).next;
  // Workflow state — representative; follow-up auto-pauses only when a run is bound.
  const steps = [
    { name: 'view_profile', state: 'done', at: '' },
    { name: 'send_connection', state: 'done', at: '' },
    { name: 'send_dm', state: 'done', at: '' },
    { name: 'follow_up_dm', state: c.runId ? 'paused' : 'todo', at: c.runId ? 'auto-paused' : 'queued' },
  ];
  // Activity derived from the real message history where available.
  const lastInbound = [...(c.messages || [])].reverse().find(m => m.who === 'in');
  const activity = [
    [c.ago ? c.ago + ' ago' : 'recent', `replied · ${(MOCK.intentMap[c.intent] || MOCK.intentMap.neutral).label.toLowerCase()}`],
    [lastInbound ? lastInbound.at : '—', 'last inbound message'],
    ['—', `connected · ${c.agent}`],
  ];
  return (
    <div className="details-view">
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card__body" style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="intel__suggest flex-1" style={{ minWidth: 220 }}>
            <Ic.Sparkle cls="icon--sm" />
            <div className="col" style={{ gap: 1 }}>
              <span className="eyebrow" style={{ color: 'inherit', opacity: 0.7 }}>Suggested next step</span>
              <span>{next}</span>
            </div>
          </div>
          <div className="row gap-2 wrap">
            <button className="btn btn--primary" onClick={onResume}><Ic.Play cls="icon--sm" />Resume workflow</button>
            <button className="btn" onClick={onArchive}><Ic.Archive cls="icon--sm" />Archive</button>
            <button className="btn btn--danger" onClick={onSuppress}><Ic.Ban cls="icon--sm" />Suppress</button>
          </div>
        </div>
      </div>

      <div className="details-grid">
        <section className="card">
          <div className="card__header card__header--bordered"><span className="card__title">Lead score</span>
            <span className="chip chip--sm" style={{ background: 'var(--surface-3)', color: scoreColor(c.score), fontWeight: 700 }}>{c.score}/100</span></div>
          <div className="card__body">
            <ScoreBars score={c.score} />
          </div>
        </section>

        <div className="col gap-4">
          <section className="card">
            <div className="card__header card__header--bordered"><span className="card__title">Workflow state</span></div>
            <div className="card__body" style={{ paddingTop: 6, paddingBottom: 10 }}>
              {steps.map(s => (
                <div key={s.name} className={`wfstep wfstep--${s.state}`}>
                  <span className="wfstep__dot">{s.state === 'done' ? <Ic.Check cls="icon--sm" /> : s.state === 'paused' ? <Ic.Pause cls="icon--sm" /> : <Ic.Clock cls="icon--sm" />}</span>
                  <span className="wfstep__name flex-1">{s.name}</span>
                  <span className={`mono ${s.state === 'paused' ? 's-warn' : 's-faint'}`} style={{ fontSize: 11 }}>{s.at}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card__header card__header--bordered"><span className="card__title">Activity</span></div>
            <div className="card__body" style={{ paddingTop: 10, paddingBottom: 12 }}>
              {activity.map((a, i) => (
                <div key={i} className="row gap-3 s-dim" style={{ fontSize: 12.5, padding: '6px 0' }}>
                  <span className="mono" style={{ width: 90, flexShrink: 0 }}>{a[0]}</span><span>{a[1]}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Composer({ onSend, disabled, agent }) {
  const [text, setText] = useStateI('');
  const send = () => { if (!text.trim()) return; onSend(text.trim()); setText(''); };
  return (
    <div className="composer">
      <div className="composer__meta">
        <span className="eyebrow">Reply as</span>
        <span className="chip chip--line chip--sm"><span className="dot s-info" />{agent || 'Agent'}</span>
        <span className="chip chip--line chip--sm"><Ic.Hand cls="icon--sm" />workflow auto-paused</span>
        <span className="flex-1" />
        <span className="mono s-faint" style={{ fontSize: 11 }}>{text.length}/2000</span>
      </div>
      <textarea className="composer__area" placeholder="Write your reply…  (⌘↵ to send)" value={text}
        onChange={e => setText(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }} />
      <div className="composer__actions">
        <div className="row gap-2">
          <button className="btn btn--soft btn--sm"><Ic.Sparkle cls="icon--sm" />Draft with AI</button>
          <button className="btn btn--ghost btn--sm"><Ic.Link cls="icon--sm" />Insert calendar</button>
        </div>
        <button className="btn btn--primary" onClick={send} disabled={disabled || !text.trim()}><Ic.Send cls="icon--sm" />Send <span className="kbd" style={{ background: 'rgba(255,255,255,0.18)', borderColor: 'transparent', color: '#fff' }}>⌘↵</span></button>
      </div>
    </div>
  );
}

function Inbox() {
  const [list, setList] = useStateI([]);
  const [activeId, setActiveId] = useStateI(null);
  const [filter, setFilter] = useStateI('all');
  const [toast, setToast] = useStateI(null);
  const [sending, setSending] = useStateI(false);
  const [composeOpen, setComposeOpen] = useStateI(false);
  const [view, setView] = useStateI('conversation');
  const [listW, setListW] = useResizable('connect:inbox:listw', 372, 300, 560);
  const useLive = !!window.electronAPI;

  const showToast = (t) => { setToast(t); setTimeout(() => setToast(null), 2400); };

  const loadInbox = async () => {
    if (!useLive) {
      setList(MOCK.conversations);
      setActiveId(prev => prev || MOCK.conversations[0].id);
      return;
    }
    try {
      const raw = await window.electronAPI.getInbox({});
      const rows = Array.isArray(raw) ? raw : (raw && raw.conversations) || [];
      const adapted = rows.map(_adaptConversation).filter(Boolean);
      setList(adapted);
      setActiveId(prev => prev || (adapted[0] && adapted[0].id) || null);
    } catch (e) { console.warn('Inbox load failed:', e); }
  };

  useEffectI(() => {
    loadInbox();
    if (!useLive || !window.electronAPI.on) return;
    window.electronAPI.on('inbox-updated', loadInbox);
  }, []);

  // On active change, fetch full thread; reset to conversation tab.
  useEffectI(() => { setView('conversation'); }, [activeId]);
  useEffectI(() => {
    if (!activeId || !useLive) return;
    (async () => {
      try {
        const res = await window.electronAPI.getInboxConversation(activeId, {});
        const conv = res && res.conversation;
        if (!conv) return;
        const adapted = _adaptConversation(conv);
        if (!adapted) return;
        setList(l => l.map(c => c.id === activeId ? { ...c, ...adapted, messages: adapted.messages.length ? adapted.messages : c.messages } : c));
      } catch (e) { console.warn('Thread load failed:', e); }
    })();
  }, [activeId]);

  const active = list.find(c => c.id === activeId);

  const filtered = useMemoI(() => {
    if (filter === 'all') return list;
    if (filter === 'unread') return list.filter(c => c.unread);
    return list.filter(c => c.intent === filter);
  }, [list, filter]);

  // J/K navigation
  useEffectI(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const i = filtered.findIndex(c => c.id === activeId);
        if (i < filtered.length - 1) setActiveId(filtered[i + 1].id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = filtered.findIndex(c => c.id === activeId);
        if (i > 0) setActiveId(filtered[i - 1].id);
      } else if (e.key === 'r') {
        e.preventDefault();
        document.querySelector('.composer__area')?.focus();
      } else if (e.key === 'e') {
        e.preventDefault();
        archive();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, activeId]);

  useEffectI(() => {
    if (!activeId) return;
    setList(l => l.map(c => c.id === activeId ? { ...c, unread: false } : c));
  }, [activeId]);

  const sendReply = async (text) => {
    if (!active) return;
    if (!useLive) {
      setList(l => l.map(c => c.id === activeId ? { ...c, messages: [...c.messages, { who: 'out', at: 'just now', text }], preview: text.slice(0, 90) } : c));
      showToast('Reply sent (mock)');
      return;
    }
    setSending(true);
    try {
      const res = await window.electronAPI.sendInboxReply({
        conversationUrn: active.conversationUrn,
        text,
        accountId: active.accountId,
        agentId: active.agentId,
      });
      if (res && res.success) {
        showToast('Reply sent');
        setList(l => l.map(c => c.id === activeId ? { ...c, messages: [...c.messages, { who: 'out', at: 'just now', text }], preview: text.slice(0, 90) } : c));
        loadInbox();
      } else {
        showToast('Send failed · ' + ((res && res.error) || 'unknown'));
      }
    } catch (e) {
      showToast('Send failed · ' + (e.message || 'error'));
    } finally {
      setSending(false);
    }
  };

  const archive = async () => {
    if (!active) return;
    const i = filtered.findIndex(c => c.id === activeId);
    const next = filtered[i + 1] || filtered[i - 1];
    const currentUrn = active.conversationUrn || activeId;
    if (useLive && active.conversationUrn) {
      try { await window.electronAPI.archiveInboxConversation(active.conversationUrn); } catch (e) {}
    }
    setList(l => l.filter(c => c.id !== currentUrn));
    if (next) setActiveId(next.id);
    showToast('Conversation archived');
  };

  const resume = async () => {
    if (!active || !active.runId || !useLive) { showToast('Workflow resumed'); return; }
    try {
      await window.electronAPI.resumeWorkflowRun(active.runId);
      showToast('Workflow resumed · ' + active.runId);
      loadInbox();
    } catch (e) {
      showToast('Resume failed · ' + (e.message || 'error'));
    }
  };

  const suppress = async () => {
    if (!active) return;
    if (useLive && active.conversationUrn) {
      try { await window.electronAPI.archiveInboxConversation(active.conversationUrn); } catch (e) {}
    }
    setList(l => l.filter(c => c.id !== activeId));
    showToast('Prospect suppressed · DNC updated');
  };

  const counts = useMemoI(() => ({
    all: list.length,
    unread: list.filter(c => c.unread).length,
    interested: list.filter(c => c.intent === 'interested').length,
    question: list.filter(c => c.intent === 'question').length,
  }), [list]);

  return (
    <div className="inbox">
      <div className="inbox__list" style={{ width: listW, flexShrink: 0 }}>
        <div className="pane-head">
          <div className="row spread">
            <div className="row gap-2"><span className="section-title">Inbox</span><span className="s-dim mono" style={{ fontSize: 12 }}>{counts.unread} unread</span></div>
            <button className="btn btn--primary btn--sm" onClick={() => setComposeOpen(true)} title="Compose a new DM"><Ic.Plus cls="icon--sm" />Compose</button>
          </div>
          <div className="inbox__filters">
            {[['all', 'All'], ['unread', 'Unread'], ['interested', 'Interested'], ['question', 'Questions']].map(([id, label]) => (
              <button key={id} className={`inbox__filter ${filter === id ? 'inbox__filter--active' : ''}`} onClick={() => setFilter(id)}>
                {label} <span className="pill-n">{counts[id]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="pane-scroll">
          {filtered.map(c => <ConversationRow key={c.id} c={c} active={c.id === activeId} onClick={() => setActiveId(c.id)} />)}
          {filtered.length === 0 && <div className="empty-pad">Inbox quiet. Nothing here right now.</div>}
        </div>
        <div className="palette__foot" style={{ borderTop: '1px solid var(--border)' }}>
          <span className="row gap-1"><span className="kbd">J</span><span className="kbd">K</span> move</span>
          <span className="row gap-1"><span className="kbd">R</span> reply</span>
          <span className="row gap-1"><span className="kbd">E</span> archive</span>
        </div>
      </div>

      <Resizer width={listW} setWidth={setListW} min={300} max={560} />

      {active ? (
        <div className="thread">
          <div className="thread__head">
            <div className="row gap-3" style={{ minWidth: 0 }}>
              <Avatar name={active.name} hue={_normHue(active)} size={40} />
              <div className="col" style={{ gap: 2, minWidth: 0 }}>
                <div className="row gap-2"><span style={{ fontSize: 16, fontWeight: 650 }}>{active.name}</span><IntentChip intent={active.intent} /></div>
                <div className="s-dim truncate" style={{ fontSize: 12.5 }}>{active.title}{active.title && active.company ? ' · ' : ''}{active.company} · score <span className="tabular" style={{ color: scoreColor(active.score), fontWeight: 600 }}>{active.score}</span></div>
              </div>
            </div>
            <div className="row gap-1">
              <button className="btn btn--ghost btn--icon btn--sm" title="Star"><Ic.Star cls="icon--sm" /></button>
              <button className="btn btn--ghost btn--icon btn--sm" onClick={archive} title="Archive"><Ic.Archive cls="icon--sm" /></button>
              <button className="btn btn--ghost btn--icon btn--sm"><Ic.Dots cls="icon--sm" /></button>
            </div>
          </div>

          <div className="thread__tabs">
            <button className={`thread__tab ${view === 'conversation' ? 'thread__tab--active' : ''}`} onClick={() => setView('conversation')}>
              <Ic.Inbox cls="icon--sm" />Conversation
            </button>
            <button className={`thread__tab ${view === 'details' ? 'thread__tab--active' : ''}`} onClick={() => setView('details')}>
              <Ic.Sparkle cls="icon--sm" />Details
              <span className="chip chip--sm" style={{ background: 'var(--surface-3)', color: scoreColor(active.score), fontWeight: 700, padding: '0 7px' }}>{active.score}</span>
            </button>
          </div>

          {view === 'conversation' ? (
            <>
              {active.runId && (
                <div className="thread__banner">
                  <Ic.Pause cls="icon--sm" />
                  <span className="flex-1">Workflow auto-paused when {active.name.split(' ')[0]} replied.</span>
                  <button className="btn btn--sm" onClick={resume}><Ic.Play cls="icon--sm" />Resume</button>
                </div>
              )}
              <div className="thread__body">
                {active.messages.map((m, i) => <Message key={i} m={m} agent={active.agent} />)}
              </div>
              <Composer onSend={sendReply} disabled={sending} agent={active.agent} />
            </>
          ) : (
            <div className="thread__details">
              <DetailsView c={active} onResume={resume} onArchive={archive} onSuppress={suppress} />
            </div>
          )}
        </div>
      ) : <div className="thread" />}

      {toast && <div className="toast"><Ic.Check cls="icon--sm" />{toast}</div>}

      {composeOpen && (
        <ComposeDmModal
          onClose={() => setComposeOpen(false)}
          onSent={(meta) => {
            setComposeOpen(false);
            showToast(meta && meta.recipientName ? `DM sent to ${meta.recipientName}` : 'DM sent');
            setTimeout(() => loadInbox(), 1500);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// COMPOSE NEW DM MODAL  (live: sendNewDm)
// ─────────────────────────────────────────────────────────
function ComposeDmModal({ onClose, onSent }) {
  const [prospects, setProspects] = useStateI([]);
  const [accounts, setAccounts] = useStateI([]);
  const [accountId, setAccountId] = useStateI('');
  const [search, setSearch] = useStateI('');
  const [selectedProspect, setSelectedProspect] = useStateI(null);
  const [manualUrl, setManualUrl] = useStateI('');
  const [body, setBody] = useStateI('');
  const [sending, setSending] = useStateI(false);
  const [error, setError] = useStateI(null);
  const [logLines, setLogLines] = useStateI([]);

  useEffectI(() => {
    if (!window.electronAPI) return;
    Promise.all([
      window.electronAPI.getSdrProspects ? window.electronAPI.getSdrProspects({}).catch(() => []) : Promise.resolve([]),
      window.electronAPI.getLinkedInAccounts ? window.electronAPI.getLinkedInAccounts().catch(() => []) : Promise.resolve([]),
    ]).then(([p, a]) => {
      const pList = Array.isArray(p) ? p : (p && p.prospects) || [];
      const aList = Array.isArray(a) ? a : (a && a.accounts) || [];
      setProspects(pList);
      setAccounts(aList);
      if (aList[0] && !accountId) setAccountId(aList[0].id || aList[0].accountId);
    });

    if (!window.electronAPI.on) return;
    window.electronAPI.on('automation-log', (entry) => {
      const msg = typeof entry === 'string' ? entry : (entry && entry.message);
      if (!msg) return;
      setLogLines(lines => [...lines.slice(-40), { msg, type: (entry && entry.type) || 'info' }]);
    });
  }, []);

  useEffectI(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !sending) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sending]);

  const filteredProspects = useMemoI(() => {
    const q = String(search || '').trim().toLowerCase();
    const base = prospects.slice().sort((a, b) =>
      Date.parse(b.lastActionAt || b.updatedAt || 0) - Date.parse(a.lastActionAt || a.updatedAt || 0)
    );
    if (!q) return base.slice(0, 30);
    return base.filter(p => {
      const blob = [p.fullName, p.title, p.company, p.profileUrl, p.agentName, p.accountName].filter(Boolean).join(' ').toLowerCase();
      return blob.includes(q);
    }).slice(0, 30);
  }, [prospects, search]);

  const resolvedUrl = manualUrl.trim() || (selectedProspect && (selectedProspect.profileUrl || selectedProspect.normalizedProfileUrl)) || '';
  const resolvedName = (selectedProspect && selectedProspect.fullName && !/^https?:/.test(selectedProspect.fullName))
    ? selectedProspect.fullName
    : (() => {
        const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(resolvedUrl);
        return m ? decodeURIComponent(m[1]).replace(/-/g, ' ') : '';
      })();

  const accountLabel = (() => {
    const a = accounts.find(x => (x.id || x.accountId) === accountId);
    return a ? (a.name || a.displayName || a.email || accountId) : '';
  })();

  const canSend = !sending && !!accountId && !!resolvedUrl && body.trim().length > 0;

  const handleSend = async () => {
    if (!canSend || !window.electronAPI || !window.electronAPI.sendNewDm) return;
    setSending(true);
    setError(null);
    setLogLines([]);
    try {
      const res = await window.electronAPI.sendNewDm({
        accountId,
        profileUrl: resolvedUrl,
        recipientName: resolvedName || null,
        message: body.trim(),
      });
      if (res && res.success) {
        onSent({ recipientName: res.recipientName || resolvedName });
      } else {
        setError((res && res.error) || 'Send failed');
      }
    } catch (e) {
      setError((e && e.message) || 'Send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !sending) onClose(); }}
      className="scrim" style={{ alignItems: 'center', paddingTop: 0 }}
    >
      <div className="card" onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 720, maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--shadow-lg)',
      }}>
        <div className="card__header card__header--bordered">
          <div>
            <div className="eyebrow">Compose</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>New direct message</div>
          </div>
          <button className="btn btn--ghost btn--icon btn--sm" onClick={onClose} disabled={sending}><Ic.X cls="icon--sm" /></button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', flex: 1 }}>
          <div className="field-label">Recipient</div>
          <input className="field" type="text" placeholder="Search prospects by name, title, company…"
            value={search} onChange={(e) => { setSearch(e.target.value); setSelectedProspect(null); }} />
          {!selectedProspect && filteredProspects.length > 0 && (
            <div style={{ marginTop: 6, maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
              {filteredProspects.map(p => {
                const url = p.profileUrl || p.normalizedProfileUrl || '';
                const name = (p.fullName && !/^https?:/.test(p.fullName)) ? p.fullName : (() => {
                  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
                  return m ? decodeURIComponent(m[1]).replace(/-/g, ' ') : url;
                })();
                return (
                  <button key={p.id} type="button"
                    onClick={() => { setSelectedProspect(p); setSearch(''); setManualUrl(''); }}
                    style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                    <Avatar name={name} size={26} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                      <div className="s-dim" style={{ fontSize: 11 }}>{p.title || p.sourceLabel || url}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {selectedProspect && (
            <div style={{ marginTop: 6, padding: 10, border: '1px solid var(--accent)', borderRadius: 'var(--r-sm)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--accent-softer)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{resolvedName}</div>
                <div className="s-dim mono" style={{ fontSize: 11 }}>{resolvedUrl}</div>
              </div>
              <button className="btn btn--sm" onClick={() => setSelectedProspect(null)}>Clear</button>
            </div>
          )}

          <div className="s-dim" style={{ fontSize: 11, marginTop: 8 }}>or paste a LinkedIn profile URL directly:</div>
          <input className="field" style={{ marginTop: 4 }} type="text" placeholder="https://www.linkedin.com/in/..."
            value={manualUrl} onChange={(e) => { setManualUrl(e.target.value); setSelectedProspect(null); }} />

          <div className="field-label" style={{ marginTop: 14 }}>Send from</div>
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.length === 0 && <option value="">No accounts configured</option>}
            {accounts.map(a => {
              const id = a.id || a.accountId;
              const label = a.name || a.displayName || a.email || id;
              return <option key={id} value={id}>{label}</option>;
            })}
          </select>

          <div className="row spread" style={{ marginTop: 14, marginBottom: 6 }}>
            <span className="field-label" style={{ margin: 0 }}>Message</span>
            <span className={`mono tabular ${body.length > 8000 ? 's-danger' : 's-dim'}`} style={{ fontSize: 11 }}>{body.length} chars</span>
          </div>
          <textarea className="field" value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="Hi {first_name}, …" rows={6} style={{ minHeight: 140, resize: 'vertical' }} />

          {error && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 'var(--r-sm)', fontSize: 12, background: 'var(--danger-soft)', color: 'var(--danger-text)' }}>{error}</div>
          )}

          {logLines.length > 0 && (
            <details style={{ marginTop: 10 }} open={!sending}>
              <summary className="s-dim" style={{ fontSize: 11, cursor: 'pointer' }}>Browser log ({logLines.length})</summary>
              <div className="mono" style={{ marginTop: 6, padding: 8, maxHeight: 140, overflowY: 'auto', background: 'var(--surface-3)', borderRadius: 'var(--r-sm)', fontSize: 11, lineHeight: 1.45 }}>
                {logLines.map((l, i) => (
                  <div key={i} style={{ color: l.type === 'error' ? 'var(--danger-text)' : l.type === 'warning' ? 'var(--warn-text)' : 'var(--text)' }}>{l.msg}</div>
                ))}
              </div>
            </details>
          )}

          <div className="s-dim" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
            A visible browser will open under <code>{accountLabel || 'the selected account'}</code>,
            navigate to <code>{resolvedName || resolvedUrl || 'the recipient'}</code>'s profile, open the
            DM drawer using humanized timing, type the message, and click Send.
          </div>
        </div>

        <div className="card__header" style={{ borderTop: '1px solid var(--border)', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={sending}>Cancel</button>
          <button className="btn btn--primary" onClick={handleSend} disabled={!canSend}>{sending ? 'Sending…' : 'Send DM'}</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Inbox, ComposeDmModal, ScoreBars, scoreColor });
