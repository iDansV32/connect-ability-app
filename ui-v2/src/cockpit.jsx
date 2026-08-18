// Cockpit — the home view. Answers in under 3 seconds:
// - Accounts healthy? - What did agents do today? - What needs me? - Funnel? - Runs?

const { useState: useStateC, useEffect: useEffectC, useMemo: useMemoC } = React;

function Sparkline({ data, w = 96, h = 26, color = 'var(--primary)' }) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const area = d + ` L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark-grad)"/>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="2" fill={color}/>
    </svg>
  );
}

function KpiCard({ kpi, live }) {
  const pos = kpi.delta > 0, neg = kpi.delta < 0;
  const deltaCls = pos ? 's-ok' : neg ? 's-danger' : 's-dim';
  const spark = live.spark || kpi.spark;
  return (
    <div className="kpi">
      <div className="kpi__head">
        <span className="eyebrow">{kpi.label}</span>
        <span className={`kpi__delta ${deltaCls} mono`}>
          {pos && '+'}{kpi.delta.toFixed(1)}%
        </span>
      </div>
      <div className="kpi__val tabular">{live.value ?? kpi.value}</div>
      <div className="kpi__spark">
        <Sparkline data={spark}/>
        <span className="eyebrow s-dim">last 12h</span>
      </div>
    </div>
  );
}

function FunnelBar({ funnel }) {
  const max = funnel[0].value;
  return (
    <div className="funnel">
      {funnel.map((f, i) => {
        const w = (f.value / max) * 100;
        const convFromPrev = i > 0 ? ((f.value / funnel[i-1].value) * 100).toFixed(1) : null;
        const narrow = w < 10;
        return (
          <div key={f.label} className="funnel__row">
            <div className="funnel__label">
              <span className="funnel__name">{f.label}</span>
              <span className="funnel__pct mono s-dim">{f.pct.toFixed(1)}%</span>
            </div>
            <div className="funnel__track">
              <div className={`funnel__fill ${narrow ? 'funnel__fill--narrow' : ''}`} style={{ width: `${w}%` }}>
                <span className="funnel__val tabular">{f.value.toLocaleString()}</span>
              </div>
            </div>
            {convFromPrev && (
              <div className="funnel__step mono s-dim">→ {convFromPrev}%</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AccountHealthRow({ acc }) {
  const statusMap = {
    ok:        { label: 'OK',         cls: 's-ok',     chip: 'chip--ok' },
    warm:      { label: 'Warming',    cls: 's-info',   chip: 'chip--info' },
    cooldown:  { label: 'Cooldown',   cls: 's-warn',   chip: 'chip--warn' },
    challenge: { label: 'Challenge',  cls: 's-danger', chip: 'chip--danger' },
    banned:    { label: 'Restricted', cls: 's-danger', chip: 'chip--danger' },
  };
  const st = statusMap[acc.status];
  const budgetPct = (acc.dailyUsed / acc.dailyCeil) * 100;
  const warmPct = (acc.warmDay / acc.warmTotal) * 100;
  return (
    <div className="ahrow">
      <div className="ahrow__who">
        <div className="ahrow__avatar" style={{ background: `oklch(85% 0.06 ${220 + (acc.id.charCodeAt(4)*7)%180})`}}>{acc.name[0]}</div>
        <div className="col" style={{ gap: 2 }}>
          <div className="ahrow__name">{acc.name}</div>
          <div className="mono s-dim" style={{ fontSize: 10 }}>@{acc.handle}</div>
        </div>
      </div>
      <span className={`chip ${st.chip}`}><span className={`dot ${acc.status==='challenge' ? 'dot--pulse':''}`}></span>{st.label}</span>
      <div className="col ahrow__meter">
        <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
          <span className="eyebrow">Budget</span>
          <span className="mono tabular" style={{ fontSize: 10 }}>{acc.dailyUsed}/{acc.dailyCeil}</span>
        </div>
        <div className="bar">
          <div className={`bar__fill ${budgetPct > 90 ? 'bar__fill--warn' : ''}`} style={{ width: budgetPct+'%' }}></div>
        </div>
      </div>
      <div className="col ahrow__meter">
        <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
          <span className="eyebrow">Warm-up</span>
          <span className="mono tabular" style={{ fontSize: 10 }}>{acc.warmDay}/{acc.warmTotal}d</span>
        </div>
        <div className="bar">
          <div className="bar__fill bar__fill--info" style={{ width: warmPct+'%' }}></div>
        </div>
      </div>
      <div className="mono s-dim" style={{ fontSize: 11 }}>{acc.lastChallenge || '—'}</div>
    </div>
  );
}

function RunRow({ run, onToggle }) {
  const stateMap = {
    running: { label: 'Running', cls: 'chip--ok',   pulse: true },
    paused:  { label: 'Paused',  cls: 'chip--warn', pulse: false },
    queued:  { label: 'Queued',  cls: 'chip--info', pulse: false },
  };
  const st = stateMap[run.state];
  return (
    <div className="runrow">
      <span className={`chip ${st.cls}`}>
        <span className={`dot ${st.pulse ? 'dot--pulse' : ''}`}></span>{st.label}
      </span>
      <div className="col flex-1" style={{ gap: 2, minWidth: 0 }}>
        <div className="truncate" style={{ fontWeight: 500 }}>{run.name}</div>
        <div className="mono s-dim truncate" style={{ fontSize: 10 }}>
          agent <span className="s-info">{run.agent}</span>
          {run.pauseReason && <> · {run.pauseReason}</>}
        </div>
      </div>
      <div className="col" style={{ alignItems: 'flex-end', gap: 2 }}>
        <span className="tabular" style={{ fontSize: 13, fontWeight: 600 }}>{run.per_hour}<span className="s-dim mono" style={{ fontWeight: 400, fontSize: 10 }}>/hr</span></span>
        <span className="mono s-dim" style={{ fontSize: 10 }}>{run.queue.toLocaleString()} queued</span>
      </div>
      <button className="btn btn--icon btn--sm" onClick={() => onToggle(run.id)} title={run.state==='running' ? 'Pause' : 'Resume'}>
        {run.state === 'running' ? <Ic.Pause cls="icon--sm" /> : <Ic.Play cls="icon--sm" />}
      </button>
    </div>
  );
}

function NeedsMeItem({ item, onNav }) {
  const sev = item.severity;
  const Icon = item.kind === 'reply' ? Ic.Inbox : item.kind === 'challenge' ? Ic.Warn : item.kind === 'paused' ? Ic.Pause : Ic.Bolt;
  return (
    <button className={`needs__row needs__row--${sev}`} onClick={() => onNav(item.href)}>
      <span className={`needs__icon s-${sev}`}><Icon cls="icon" /></span>
      <span className="needs__text truncate">{item.label}</span>
      <Ic.ChevronRight cls="icon s-dim" />
    </button>
  );
}

function Cockpit({ onNav }) {
  const [pausedIds, setPausedIds] = useStateC(new Set(MOCK.runs.filter(r => r.state === 'paused').map(r => r.id)));
  const toggleRun = (id) => {
    setPausedIds(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const runs = MOCK.runs.map(r => ({
    ...r,
    state: pausedIds.has(r.id) ? 'paused' : (r.state === 'queued' ? 'queued' : 'running'),
    per_hour: pausedIds.has(r.id) ? 0 : (r.state === 'queued' ? 0 : r.per_hour),
  }));

  // Live kpis — tick the last spark value
  const [tick, setTick] = useStateC(0);
  useEffectC(() => {
    const iv = setInterval(() => setTick(t => t + 1), 2000);
    return () => clearInterval(iv);
  }, []);
  const liveKpis = useMemoC(() => {
    return MOCK.kpis.map(k => {
      const spark = [...k.spark];
      const last = spark[spark.length - 1];
      const jitter = Math.round((Math.sin(tick * 0.7 + k.key.length) * 0.5 + Math.random() * 0.5) * Math.max(1, last * 0.15));
      spark.push(Math.max(0, last + jitter));
      spark.shift();
      return { spark, value: k.value + Math.round(tick * (k.delta > 0 ? 0.3 : 0.05)) };
    });
  }, [tick]);

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="cockpit">
      <div className="cockpit__head">
        <div>
          <h1 className="page-title">{greeting}, Priya.</h1>
          <p className="page-sub">
            <span className="s-ok">5 of 6 accounts healthy</span> ·
            <span className="s-dim"> 4 workflows running</span> ·
            <span className="s-dim"> last sync </span><span className="mono">2s ago</span>
          </p>
        </div>
        <div className="row gap-2">
          <div className="segmented">
            <button className="segmented__btn">Today</button>
            <button className="segmented__btn segmented__btn--active">7d</button>
            <button className="segmented__btn">30d</button>
            <button className="segmented__btn">Custom</button>
          </div>
          <button className="btn"><Ic.Bolt cls="icon--sm" /> Run diagnostics</button>
          <button className="btn btn--primary" onClick={() => window.dispatchEvent(new CustomEvent('connect:newagent'))}>
            <Ic.Plus cls="icon--sm" /> New agent
          </button>
        </div>
      </div>

      <div className="cockpit__grid">
        {/* KPIs */}
        <section className="kpis">
          {MOCK.kpis.map((k, i) => <KpiCard key={k.key} kpi={k} live={liveKpis[i]} />)}
        </section>

        {/* Funnel + Needs-me side by side */}
        <section className="card">
          <div className="card__header">
            <div className="row gap-2">
              <span className="card__title">Outreach funnel</span>
              <span className="chip chip--line mono">7d · Δ wow</span>
            </div>
            <div className="row gap-2">
              <span className="eyebrow">Interested · <span className="s-ok">+22%</span></span>
              <button className="btn btn--ghost btn--sm">Full report →</button>
            </div>
          </div>
          <div className="card__body" style={{ paddingTop: 10 }}>
            <FunnelBar funnel={MOCK.funnel}/>
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <span className="card__title">Needs you</span>
            <span className="chip chip--danger"><span className="dot dot--pulse"></span>1 urgent</span>
          </div>
          <div className="needs">
            {MOCK.needsMe.map(n => <NeedsMeItem key={n.id} item={n} onNav={onNav} />)}
          </div>
        </section>

        {/* Account health */}
        <section className="card span-2">
          <div className="card__header">
            <div className="row gap-2">
              <span className="card__title">Account health</span>
              <span className="mono s-dim">6 LinkedIn accounts</span>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={() => onNav('health')}>Open health →</button>
          </div>
          <div className="ahrow ahrow--head">
            <div className="eyebrow">Account</div>
            <div className="eyebrow">State</div>
            <div className="eyebrow">Daily budget</div>
            <div className="eyebrow">Warm-up</div>
            <div className="eyebrow">Last challenge</div>
          </div>
          <div className="ahlist">
            {MOCK.accounts.map(a => <AccountHealthRow key={a.id} acc={a}/>)}
          </div>
        </section>

        {/* Runs */}
        <section className="card">
          <div className="card__header">
            <span className="card__title">Active runs</span>
            <button className="btn btn--ghost btn--sm" onClick={() => onNav('workflows')}>All →</button>
          </div>
          <div className="runs">
            {runs.map(r => <RunRow key={r.id} run={r} onToggle={toggleRun}/>)}
          </div>
        </section>
      </div>
    </div>
  );
}

Object.assign(window, { Cockpit, Sparkline });
