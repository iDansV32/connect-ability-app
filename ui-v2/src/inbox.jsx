// Unified Inbox — conversation list + thread + composer + J/K nav

const { useState: useStateI, useEffect: useEffectI, useRef: useRefI, useMemo: useMemoI } = React;

function IntentChip({ intent }) {
  const m = MOCK.intentMap[intent];
  const cls = {
    ok: 'chip--ok', info: 'chip--info', warn: 'chip--warn', danger: 'chip--danger', neutral: 'chip--line'
  }[m.color];
  return <span className={`chip ${cls}`}><span className="dot"></span>{m.label}</span>;
}

function ScoreBar({ score }) {
  const hue = score >= 80 ? 155 : score >= 60 ? 75 : 25;
  return (
    <div className="scorebar" title={`Lead score · ${score}`}>
      <span className="scorebar__num mono tabular">{score}</span>
      <div className="scorebar__track">
        <div className="scorebar__fill" style={{ width: `${score}%`, background: `oklch(60% 0.14 ${hue})` }}/>
      </div>
    </div>
  );
}

function ConversationRow({ c, active, onClick, idx }) {
  return (
    <button className={`convrow ${active ? 'convrow--active' : ''} ${c.unread ? 'convrow--unread' : ''}`} onClick={onClick}>
      <div className="convrow__rail"></div>
      <div className="convrow__avatar" style={{ background: `oklch(85% 0.06 ${c.accountHue})` }}>
        {c.name.split(' ').map(n=>n[0]).slice(0,2).join('')}
      </div>
      <div className="col flex-1" style={{ gap: 2, minWidth: 0 }}>
        <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
          <span className="convrow__name truncate">{c.name}</span>
          <span className="mono s-dim convrow__time">{c.ago}</span>
        </div>
        <div className="mono s-dim truncate" style={{ fontSize: 11 }}>
          {c.title} · {c.company}
        </div>
        <div className="convrow__preview truncate">{c.preview}</div>
        <div className="row gap-2" style={{ marginTop: 3 }}>
          <IntentChip intent={c.intent}/>
          <span className="mono s-dim" style={{ fontSize: 10 }}>via {c.agent}</span>
          {c.suppressed && <span className="chip chip--line"><Ic.Ban cls="icon--sm"/>DNC</span>}
        </div>
      </div>
    </button>
  );
}

function Message({ m, agentName }) {
  const out = m.who === 'out';
  return (
    <div className={`msg ${out ? 'msg--out' : 'msg--in'}`}>
      <div className="msg__meta mono">
        <span>{out ? `${agentName} · outbound` : 'inbound'}</span>
        <span className="s-dim">{m.at}</span>
      </div>
      <div className="msg__bubble">{m.text}</div>
    </div>
  );
}

function Composer({ onSend, disabled }) {
  const [text, setText] = useStateI('');
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };
  return (
    <div className="composer">
      <div className="composer__meta">
        <span className="eyebrow">Reply as</span>
        <span className="chip chip--line"><span className="dot s-info"></span>Atlas · @priya.venkat</span>
        <span className="chip chip--line"><Ic.Hand cls="icon--sm"/>workflow auto-paused</span>
        <span className="flex-1"></span>
        <span className="mono s-dim" style={{ fontSize: 11 }}>{text.length} / 2000</span>
      </div>
      <textarea
        className="composer__area"
        placeholder="Write your reply… (⌘↵ to send)"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if ((e.metaKey||e.ctrlKey) && e.key === 'Enter') send(); }}
      />
      <div className="composer__actions">
        <div className="row gap-2">
          <button className="btn btn--ghost btn--sm"><Ic.Sparkle cls="icon--sm"/>Draft with Atlas</button>
          <button className="btn btn--ghost btn--sm"><Ic.Link cls="icon--sm"/>Insert calendar</button>
        </div>
        <div className="row gap-2">
          <button className="btn btn--sm"><Ic.Archive cls="icon--sm"/>Archive</button>
          <button className="btn btn--sm btn--danger"><Ic.Ban cls="icon--sm"/>Suppress</button>
          <button className="btn btn--primary btn--sm" onClick={send} disabled={disabled || !text.trim()}>
            <Ic.Send cls="icon--sm"/>Send <span className="kbd" style={{ background: 'rgba(255,255,255,0.12)', borderColor: 'transparent', color: 'currentColor' }}>⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ScoreBreakdown({ score }) {
  const [open, setOpen] = useStateI(false);
  const hue = score >= 80 ? 155 : score >= 60 ? 75 : 25;
  return (
    <div className="card" style={{ boxShadow: 'none' }}>
      <div className="card__header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o=>!o)}>
        <div className="row gap-2">
          <span className="card__title">Lead score</span>
          <span className="chip mono" style={{ background: `oklch(95% 0.04 ${hue})`, color: `oklch(40% 0.14 ${hue})` }}>
            {score} / 100
          </span>
        </div>
        <Ic.ChevronDown cls={`icon s-dim ${open ? 'rot' : ''}`}/>
      </div>
      {open && (
        <div className="card__body" style={{ paddingTop: 0 }}>
          {MOCK.scoreBreakdown.map(b => (
            <div key={b.factor} className="scorebreakdown__row">
              <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, fontWeight: 500 }}>{b.factor}</span>
                <span className="mono tabular s-dim" style={{ fontSize: 11 }}>{b.raw} / {b.weight}</span>
              </div>
              <div className="bar" style={{ height: 3 }}>
                <div className="bar__fill" style={{ width: (b.raw/b.weight*100)+'%' }}/>
              </div>
              <div className="s-dim" style={{ fontSize: 11, marginTop: 3 }}>{b.note}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IntelPanel({ c, onResume, onArchive, onSuppress }) {
  const nextAction = MOCK.intentMap[c.intent].next;
  return (
    <aside className="intel">
      <div className="intel__head">
        <div className="row gap-3">
          <div className="intel__avatar" style={{ background: `oklch(80% 0.08 ${c.accountHue})` }}>
            {c.name.split(' ').map(n=>n[0]).slice(0,2).join('')}
          </div>
          <div className="col flex-1" style={{ gap: 2 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</div>
            <div className="s-dim" style={{ fontSize: 12 }}>{c.title}</div>
            <div className="s-dim mono" style={{ fontSize: 11 }}>{c.company}</div>
          </div>
        </div>
        <div className="row gap-2" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <IntentChip intent={c.intent}/>
          <span className="chip chip--line mono">via {c.agent}</span>
        </div>
      </div>

      <div className="intel__section">
        <div className="row gap-2" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <span className="eyebrow">Suggested next step</span>
          <span className="kbd">⌘⇧A</span>
        </div>
        <div className="intel__suggest">
          <Ic.Sparkle cls="icon s-info"/>
          <span style={{ fontSize: 12, fontWeight: 500 }}>{nextAction}</span>
        </div>
        <div className="row gap-2" style={{ marginTop: 8 }}>
          <button className="btn btn--primary btn--sm flex-1" onClick={onResume}>
            <Ic.Play cls="icon--sm"/>Resume workflow
          </button>
        </div>
        <div className="row gap-2" style={{ marginTop: 6 }}>
          <button className="btn btn--sm flex-1" onClick={onArchive}><Ic.Archive cls="icon--sm"/>Archive</button>
          <button className="btn btn--sm btn--danger flex-1" onClick={onSuppress}><Ic.Ban cls="icon--sm"/>Suppress</button>
        </div>
      </div>

      <div className="intel__section">
        <ScoreBreakdown score={c.score}/>
      </div>

      <div className="intel__section">
        <div className="eyebrow" style={{ marginBottom: 8 }}>Workflow state</div>
        <div className="wflow">
          <div className="wflow__step wflow__step--done">
            <Ic.Check cls="icon--sm"/>
            <span>view_profile</span>
            <span className="mono s-dim" style={{ fontSize: 10, marginLeft: 'auto' }}>Fri 9:04a</span>
          </div>
          <div className="wflow__step wflow__step--done">
            <Ic.Check cls="icon--sm"/>
            <span>send_connection</span>
            <span className="mono s-dim" style={{ fontSize: 10, marginLeft: 'auto' }}>Fri 9:14a</span>
          </div>
          <div className="wflow__step wflow__step--done">
            <Ic.Check cls="icon--sm"/>
            <span>send_dm</span>
            <span className="mono s-dim" style={{ fontSize: 10, marginLeft: 'auto' }}>Mon 9:14a</span>
          </div>
          <div className="wflow__step wflow__step--paused">
            <Ic.Pause cls="icon--sm"/>
            <span>follow_up_dm</span>
            <span className="mono s-warn" style={{ fontSize: 10, marginLeft: 'auto' }}>auto-paused</span>
          </div>
        </div>
      </div>

      <div className="intel__section">
        <div className="eyebrow" style={{ marginBottom: 8 }}>Activity</div>
        <div className="col gap-2">
          <div className="row gap-2 mono s-dim" style={{ fontSize: 11 }}>
            <span style={{ width: 70 }}>14m ago</span><span>replied · intent: {c.intent}</span>
          </div>
          <div className="row gap-2 mono s-dim" style={{ fontSize: 11 }}>
            <span style={{ width: 70 }}>2h ago</span><span>opened InMail</span>
          </div>
          <div className="row gap-2 mono s-dim" style={{ fontSize: 11 }}>
            <span style={{ width: 70 }}>Fri</span><span>connected · Atlas (acc_1)</span>
          </div>
          <div className="row gap-2 mono s-dim" style={{ fontSize: 11 }}>
            <span style={{ width: 70 }}>Fri</span><span>posted · "RevOps metrics that matter"</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Inbox() {
  const [list, setList] = useStateI(MOCK.conversations);
  const [activeId, setActiveId] = useStateI(list[0].id);
  const [filter, setFilter] = useStateI('all');
  const [toast, setToast] = useStateI(null);
  const activeIdx = list.findIndex(c => c.id === activeId);
  const active = list[activeIdx];

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
        if (i < filtered.length - 1) setActiveId(filtered[i+1].id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = filtered.findIndex(c => c.id === activeId);
        if (i > 0) setActiveId(filtered[i-1].id);
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

  // Mark read on select
  useEffectI(() => {
    setList(l => l.map(c => c.id === activeId ? { ...c, unread: false } : c));
  }, [activeId]);

  const showToast = (t) => { setToast(t); setTimeout(() => setToast(null), 2400); };

  const sendReply = (text) => {
    setList(l => l.map(c => c.id === activeId ? {
      ...c,
      messages: [...c.messages, { who: 'out', at: 'just now', text }],
      preview: text.slice(0, 90),
    } : c));
    showToast('Reply sent · workflow resumed');
  };

  const archive = () => {
    const i = filtered.findIndex(c => c.id === activeId);
    setList(l => l.filter(c => c.id !== activeId));
    const next = filtered[i+1] || filtered[i-1];
    if (next) setActiveId(next.id);
    showToast('Conversation archived');
  };

  const resume = () => showToast('Workflow resumed · next step queues in 2h');
  const suppress = () => showToast('Prospect suppressed · do-not-contact list updated');

  const filterCounts = useMemoI(() => ({
    all: list.length,
    unread: list.filter(c=>c.unread).length,
    interested: list.filter(c=>c.intent==='interested').length,
    question: list.filter(c=>c.intent==='question').length,
    not_interested: list.filter(c=>c.intent==='not_interested').length,
  }), [list]);

  return (
    <div className="inbox">
      {/* Left: conversation list */}
      <div className="inbox__list-wrap">
        <div className="inbox__list-head">
          <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Inbox</span>
            <span className="mono s-dim" style={{ fontSize: 11 }}>{filtered.length} · {list.filter(c=>c.unread).length} unread</span>
          </div>
          <div className="inbox__filters">
            {[
              { id: 'all', label: 'All', count: filterCounts.all },
              { id: 'unread', label: 'Unread', count: filterCounts.unread },
              { id: 'interested', label: 'Interested', count: filterCounts.interested },
              { id: 'question', label: 'Questions', count: filterCounts.question },
            ].map(f => (
              <button key={f.id} className={`inbox__filter ${filter===f.id?'inbox__filter--active':''}`} onClick={() => setFilter(f.id)}>
                {f.label} <span className="mono s-dim" style={{ fontSize: 10 }}>{f.count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="inbox__list">
          {filtered.map(c => (
            <ConversationRow key={c.id} c={c} active={c.id === activeId} onClick={() => setActiveId(c.id)} />
          ))}
          {filtered.length === 0 && (
            <div className="empty">
              <div className="empty__title">Inbox quiet.</div>
              <div className="empty__sub">Last reply 2 days ago from Jane Doe.</div>
            </div>
          )}
        </div>
        <div className="inbox__foot mono s-dim">
          <span className="row gap-1"><span className="kbd">J</span><span className="kbd">K</span> move</span>
          <span className="row gap-1"><span className="kbd">R</span> reply</span>
          <span className="row gap-1"><span className="kbd">E</span> archive</span>
        </div>
      </div>

      {/* Center: thread */}
      <div className="thread">
        {active && <>
          <div className="thread__head">
            <div className="col" style={{ gap: 2, minWidth: 0 }}>
              <div className="row gap-2">
                <span style={{ fontSize: 15, fontWeight: 600 }}>{active.name}</span>
                <IntentChip intent={active.intent}/>
              </div>
              <div className="mono s-dim" style={{ fontSize: 11 }}>
                {active.title} · {active.company} · score <span className="tabular">{active.score}</span>
              </div>
            </div>
            <div className="row gap-1">
              <button className="btn btn--ghost btn--icon btn--sm"><Ic.Star cls="icon--sm"/></button>
              <button className="btn btn--ghost btn--icon btn--sm" onClick={archive}><Ic.Archive cls="icon--sm"/></button>
              <button className="btn btn--ghost btn--icon btn--sm"><Ic.Dots cls="icon--sm"/></button>
            </div>
          </div>

          <div className="thread__banner">
            <Ic.Pause cls="icon s-warn"/>
            <span style={{ fontSize: 12 }}>
              Workflow <span className="mono">Q2 — RevOps leaders</span> auto-paused when {active.name.split(' ')[0]} replied.
            </span>
            <button className="btn btn--primary btn--sm" onClick={resume}>
              <Ic.Play cls="icon--sm"/>Resume
            </button>
          </div>

          <div className="thread__body">
            {active.messages.map((m, i) => <Message key={i} m={m} agentName={active.agent}/>)}
          </div>

          <Composer onSend={sendReply} />
        </>}
      </div>

      {/* Right: intel */}
      {active && <IntelPanel c={active} onResume={resume} onArchive={archive} onSuppress={suppress} />}

      {toast && <div className="toast"><Ic.Check cls="icon--sm"/> {toast}</div>}
    </div>
  );
}

Object.assign(window, { Inbox });
