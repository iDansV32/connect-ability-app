// Workflow Studio — Targeting (left), Readiness (right), Simulation heatmap

const { useState: useStateWP, useMemo: useMemoWP } = React;

// ===================================================================
// TARGETING PANEL (left)
// ===================================================================
function TargetingPanel({ state }) {
  const [source, setSource] = useStateWP('list');
  const t = WF.targeting;

  const max = Math.max(...t.histogram);
  const pastMax = Math.max(...t.pastSimilar);

  return (
    <aside className="wf-left">
      <div className="wf-left__head">
        <div className="eyebrow">Targeting</div>
        <h3 className="wf-left__title">Who this campaign acts on</h3>
      </div>

      {/* Source tabs */}
      <div className="wf-srctabs" role="tablist">
        {[
          { id: 'search', label: 'Search' },
          { id: 'list',   label: 'Prospect list' },
          { id: 'group',  label: 'Group' },
          { id: 'import', label: 'Import' },
        ].map(tab => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={source === tab.id}
            className={`wf-srctab ${source === tab.id ? 'wf-srctab--active' : ''}`}
            onClick={() => setSource(tab.id)}
          >{tab.label}</button>
        ))}
      </div>

      {/* Source body */}
      <div className="wf-src">
        {source === 'search' && (
          <>
            <label className="wf-label">LinkedIn search URL or keywords</label>
            <input className="input" defaultValue="VP RevOps · Series B · United States" />
            <div className="wf-hint">Live result count · <b className="tabular">847</b> matches</div>
            <div className="wf-filters">
              <div className="wf-filter"><span className="wf-filter__key">Seniority</span><span className="wf-filter__val">VP, Director</span></div>
              <div className="wf-filter"><span className="wf-filter__key">Location</span><span className="wf-filter__val">United States</span></div>
              <div className="wf-filter"><span className="wf-filter__key">Company size</span><span className="wf-filter__val">51–1,000</span></div>
            </div>
          </>
        )}
        {source === 'list' && (
          <>
            <label className="wf-label">Saved list</label>
            <div className="input wf-select">
              <span>RevOps VPs · Series B · US</span>
              <Ic.ChevronDown cls="icon icon--sm" />
            </div>
            <div className="wf-list-stats">
              <div><span className="wf-list-stats__k">Prospects</span><span className="wf-list-stats__v tabular">847</span></div>
              <div><span className="wf-list-stats__k">Mean score</span><span className="wf-list-stats__v tabular">62<span className="wf-list-stats__slash">/100</span></span></div>
            </div>
          </>
        )}
        {source === 'group' && (
          <>
            <label className="wf-label">Group</label>
            <div className="input wf-select">
              <span>Modern GTM — Q4 push</span>
              <Ic.ChevronDown cls="icon icon--sm" />
            </div>
            <div className="wf-hint">3 lists · 847 total · 34 excluded</div>
          </>
        )}
        {source === 'import' && (
          <>
            <label className="wf-label">Paste URLs or upload CSV</label>
            <textarea className="input" rows="4" placeholder="https://www.linkedin.com/in/..." />
            <button className="btn btn--sm"><Ic.Plus cls="icon icon--sm"/>Upload CSV</button>
          </>
        )}
      </div>

      {/* Score histogram */}
      <div className="wf-section">
        <div className="wf-section__head">
          <div className="eyebrow">Score distribution</div>
          <span className="mono wf-section__aside tabular">0 → 100</span>
        </div>
        <div className="wf-histogram" role="img" aria-label="Lead score distribution across 10 buckets">
          {t.histogram.map((v, i) => (
            <div key={i} className="wf-hist__col">
              <div
                className={`wf-hist__bar ${i >= 5 ? 'wf-hist__bar--hot' : ''}`}
                style={{ height: `${(v / max) * 100}%` }}
                title={`${i*10}–${(i+1)*10}: ${v}`}
              />
            </div>
          ))}
        </div>
        <div className="wf-hist__axis mono tabular">
          <span>0</span><span>50</span><span>100</span>
        </div>
      </div>

      {/* Score breakdown (four-segment bar) */}
      <div className="wf-section">
        <div className="wf-section__head">
          <div className="eyebrow">Mean score breakdown</div>
          <span className="wf-section__aside tabular mono">62 / 100</span>
        </div>
        <div className="wf-scorebar">
          {t.breakdown.map((b) => (
            <div key={b.factor} className="wf-scorebar__seg">
              <div className="wf-scorebar__label">
                <span className="wf-scorebar__factor">{b.factor}</span>
                <span className="tabular wf-scorebar__pct">{b.pct}</span>
              </div>
              <div className="wf-scorebar__track">
                <div className="wf-scorebar__fill" style={{ width: `${b.pct}%` }}/>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Exclusions */}
      <div className="wf-section">
        <div className="wf-section__head">
          <div className="eyebrow">Exclusions active</div>
        </div>
        <div className="wf-excl">
          {t.exclusions.map(x => (
            <div key={x.label} className="wf-excl__row">
              <Ic.Ban cls="icon icon--sm s-dim"/>
              <span className="wf-excl__label">{x.label}</span>
              <span className="wf-excl__count mono tabular">{x.count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Past similar sparkline */}
      <div className="wf-section">
        <div className="wf-section__head">
          <div className="eyebrow">Past similar · reply %</div>
          <span className="wf-section__aside tabular mono">12 campaigns</span>
        </div>
        <svg viewBox="0 0 200 40" className="wf-spark">
          <path
            d={`M ${t.pastSimilar.map((v,i) => `${(i/(t.pastSimilar.length-1))*200},${40 - (v/pastMax)*34 - 3}`).join(' L ')}`}
            fill="none" stroke="var(--primary)" strokeWidth="1.5"
          />
          <path
            d={`M 0,40 L ${t.pastSimilar.map((v,i) => `${(i/(t.pastSimilar.length-1))*200},${40 - (v/pastMax)*34 - 3}`).join(' L ')} L 200,40 Z`}
            fill="var(--primary)" opacity="0.08"
          />
        </svg>
      </div>
    </aside>
  );
}

// ===================================================================
// PREFLIGHT ROW
// ===================================================================
function PreflightRow({ item }) {
  const dotCls = item.state === 'ok' ? 's-ok' : item.state === 'warn' ? 's-warn' : item.state === 'danger' ? 's-danger' : 's-dim';
  return (
    <div className={`pfrow pfrow--${item.state}`}>
      <span className={`dot ${dotCls}`} />
      <div className="pfrow__body">
        <div className="pfrow__label">{item.label}</div>
        <div className="pfrow__detail">{item.detail}</div>
      </div>
      {item.action && <button className="pfrow__action">{item.action}</button>}
    </div>
  );
}

// ===================================================================
// SIMULATION HEATMAP
// ===================================================================
function SimulationHeatmap({ grid, bottleneck }) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <div className="wf-sim">
      <div className="wf-sim__head">
        <div>
          <div className="eyebrow">Dry-run · next 7 days</div>
          <div className="wf-sim__sub">Respects working hours, warm-up envelope, and 60–95% quota randomization</div>
        </div>
        <div className="wf-sim__legend">
          <span className="wf-sim__legend-label mono">idle</span>
          <div className="wf-sim__ramp">
            {[0.05, 0.25, 0.45, 0.65, 0.85, 1].map((a,i) => (
              <div key={i} className="wf-sim__ramp-cell" style={{ opacity: Math.max(0.12, a) }}/>
            ))}
          </div>
          <span className="wf-sim__legend-label mono">peak</span>
        </div>
      </div>

      <div className="wf-sim__grid">
        <div className="wf-sim__xaxis mono tabular">
          <span></span>
          {[0, 6, 12, 18, 23].map(h => <span key={h} style={{ gridColumn: h + 2 }}>{h}</span>)}
        </div>
        {grid.map((row, d) => (
          <div key={d} className="wf-sim__row">
            <div className="wf-sim__ylabel mono">{days[d]}</div>
            {row.map((v, h) => (
              <div
                key={h}
                className={`wf-sim__cell ${v === 0 ? 'wf-sim__cell--off' : ''}`}
                style={{ opacity: v === 0 ? 1 : 0.15 + v * 0.85 }}
                title={`${days[d]} ${h}:00 — ${v === 0 ? 'outside working hours' : `${Math.round(v * 12)} actions`}`}
              />
            ))}
          </div>
        ))}
      </div>

      {bottleneck && (
        <div className="wf-sim__bottleneck">
          <Ic.Warn cls="icon icon--sm s-warn"/>
          <span>{bottleneck}</span>
          <button className="pfrow__action">Jump to fix</button>
        </div>
      )}
    </div>
  );
}

// ===================================================================
// READINESS PANEL (right)
// ===================================================================
function ReadinessPanel({ state, simOpen, onToggleSim, onLaunch }) {
  const checks = state === 'ready' || state === 'running' ? WF.preflight.green
               : state === 'paused-error' ? WF.preflight.pausedError
               : WF.preflight.authoring;

  const grouped = useMemoWP(() => {
    const g = {};
    checks.forEach(c => { (g[c.cat] = g[c.cat] || []).push(c); });
    return g;
  }, [checks]);

  const hasRed = checks.some(c => c.state === 'danger');
  const hasWarn = checks.some(c => c.state === 'warn');
  const canLaunch = !hasRed && !hasWarn && state !== 'running';

  return (
    <aside className="wf-right">
      <div className="wf-right__head">
        <div className="eyebrow">Readiness</div>
        <h3 className="wf-right__title">Pre-flight</h3>
      </div>

      <div className="wf-right__scroll">
        {Object.entries(grouped).map(([cat, items]) => (
          <div key={cat} className="pfgroup">
            <div className="pfgroup__head mono">{cat}</div>
            <div className="pfgroup__body">
              {items.map((it, i) => <PreflightRow key={i} item={it}/>)}
            </div>
          </div>
        ))}

        {/* Workflow math */}
        <div className="pfgroup">
          <div className="pfgroup__head mono">Workflow math</div>
          <div className="pfgroup__body">
            <div className="mathrow">
              <span className="mathrow__k">Per prospect</span>
              <span className="mathrow__v tabular">{WF.math.perProspect}</span>
            </div>
            <div className="mathrow">
              <span className="mathrow__k">Enroll time</span>
              <span className="mathrow__v tabular">{WF.math.campaign}</span>
              <span className="mathrow__aside">{WF.math.campaignDetail}</span>
            </div>
            <div className="mathrow">
              <span className="mathrow__k">Daily load</span>
              <span className="mathrow__v tabular">{WF.math.load}</span>
              <span className="mathrow__aside">{WF.math.loadDetail}</span>
            </div>
            <div className="mathrow">
              <span className="mathrow__k">Est. replies</span>
              <span className="mathrow__v tabular">{WF.math.replies}</span>
              <span className="mathrow__aside">{WF.math.replyDetail}</span>
            </div>
          </div>
        </div>

        {/* Simulation inline */}
        <div className="pfgroup">
          <button className={`pfgroup__head pfgroup__head--btn mono ${simOpen ? 'pfgroup__head--open' : ''}`} onClick={onToggleSim}>
            <span>Simulation</span>
            <span className="row gap-2">
              <span className="kbd">⌘D</span>
              <Ic.ChevronDown cls={`icon icon--sm ${simOpen ? 'rot180' : ''}`}/>
            </span>
          </button>
          {simOpen && (
            <SimulationHeatmap
              grid={WF.simulate}
              bottleneck={state === 'paused-error' ? 'Day 3 · budget ceiling hit at 11:20am — 42 actions skipped' : null}
            />
          )}
        </div>
      </div>

      {/* Launch button */}
      <div className="wf-right__foot">
        {state === 'running' ? (
          <button className="btn btn--lg btn--warn wf-launch wf-launch--pause">
            <Ic.Pause cls="icon"/> Pause campaign
          </button>
        ) : state === 'paused-error' ? (
          <button className="btn btn--lg wf-launch wf-launch--disabled" disabled title="Daily budget exceeded — resume disabled">
            <Ic.Ban cls="icon"/> Resume blocked
          </button>
        ) : (
          <button
            className={`btn btn--lg btn--primary wf-launch ${canLaunch ? '' : 'wf-launch--disabled'}`}
            disabled={!canLaunch}
            onClick={canLaunch ? onLaunch : undefined}
            title={canLaunch ? 'Launch campaign · ⌘↵' : 'Resolve preflight warnings to launch'}
          >
            <Ic.Bolt cls="icon"/> Launch campaign
          </button>
        )}
        <div className="wf-launch__hint mono">
          {canLaunch
            ? <><span className="dot s-ok"/>All systems go · ⌘↵</>
            : state === 'running'
              ? <><span className="dot s-info dot--pulse"/>Running · day 2 of 12</>
              : state === 'paused-error'
                ? <><span className="dot s-danger"/>Paused · budget ceiling hit</>
                : <><span className="dot s-warn"/>{hasRed ? '1 blocker' : '1 warning'} · review preflight</>}
        </div>
      </div>
    </aside>
  );
}

Object.assign(window, { TargetingPanel, ReadinessPanel, PreflightRow, SimulationHeatmap });
