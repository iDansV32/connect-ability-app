// Workflow Studio — Targeting (left), Readiness (right), Simulation heatmap

const { useState: useStateWP, useMemo: useMemoWP } = React;

// ===================================================================
// TARGETING PANEL (left)
// ===================================================================
function TargetingPanel({
  state, groups, selectedGroupId, onSelectGroup, prospectCount,
  targetSource, onSelectSource, searchTerm, onSearchTerm, searchMatchCount, totalProspects,
  importText, onImportText, importUrlCount, targetLabel,
  liveSearch, onRunLiveSearch, searchAccountEmail,
  maxProfiles, onMaxProfiles,
}) {
  const source = targetSource || 'group';
  const setSource = onSelectSource || (() => {});
  const t = WF.targeting || {};
  const histogram = Array.isArray(t.histogram) ? t.histogram : [];
  const breakdown = Array.isArray(t.breakdown) ? t.breakdown : [];
  const exclusions = Array.isArray(t.exclusions) ? t.exclusions : [];
  const pastSimilar = Array.isArray(t.pastSimilar) ? t.pastSimilar : [];
  const liveCount = typeof prospectCount === 'number' && prospectCount > 0 ? prospectCount : null;

  const max = histogram.length ? Math.max(...histogram) : 1;
  const pastMax = pastSimilar.length ? Math.max(...pastSimilar) : 1;

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
            <label className="wf-label">LinkedIn search term or keywords</label>
            <input
              className="input"
              placeholder="e.g. software engineer, Head of People"
              value={searchTerm || ''}
              onChange={(e) => onSearchTerm && onSearchTerm(e.target.value)}
              autoFocus
            />
            <label className="wf-label" style={{ marginTop: 10 }}>How many profiles to enroll</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                className="input"
                type="number"
                min="1"
                max="50"
                value={maxProfiles == null ? 10 : maxProfiles}
                onChange={(e) => onMaxProfiles && onMaxProfiles(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                style={{ width: 90 }}
              />
              <span className="s-dim" style={{ fontSize: 11 }}>capped by your daily activity budget</span>
            </div>
            <div className="wf-hint s-dim" style={{ marginTop: 8, lineHeight: 1.5 }}>
              When you click <b>Launch</b>, a visible browser opens
              {searchAccountEmail ? <> using <code>{searchAccountEmail}</code></> : <> using the agent's bound account</>},
              runs a stealth LinkedIn people-search, then queues the workflow steps against the top {maxProfiles == null ? 10 : maxProfiles} matches.
            </div>

            {liveSearch && liveSearch.loading && (
              <div className="wf-hint" style={{ marginTop: 10, color: 'var(--accent, #2a6dde)' }}>
                <b>Searching LinkedIn…</b> a visible browser is running the stealth search.
              </div>
            )}

            {liveSearch && !liveSearch.loading && liveSearch.urls && liveSearch.urls.length > 0 && (
              <div className="wf-section" style={{ marginTop: 12, paddingTop: 0 }}>
                <div className="wf-list-stats">
                  <div>
                    <span className="wf-list-stats__k">Last search results</span>
                    <span className="wf-list-stats__v tabular">{liveSearch.urls.length}</span>
                  </div>
                </div>
                <details style={{ marginTop: 8 }}>
                  <summary className="s-dim" style={{ fontSize: 11, cursor: 'pointer' }}>
                    Show URLs
                  </summary>
                  <div style={{
                    marginTop: 6, padding: 8, maxHeight: 180, overflowY: 'auto',
                    background: 'var(--surface-strong, rgba(0,0,0,0.04))', borderRadius: 6,
                    fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace', fontSize: 11,
                    lineHeight: 1.5, wordBreak: 'break-all',
                  }}>
                    {liveSearch.urls.map((u, i) => <div key={i}>{u}</div>)}
                  </div>
                </details>
                <div className="wf-hint s-dim" style={{ marginTop: 6 }}>
                  Re-running Launch with the same term reuses these results. Edit the term to discard them and search again.
                </div>
              </div>
            )}

            {liveSearch && !liveSearch.loading && liveSearch.error && (
              <div className="wf-hint" style={{ color: 'var(--warn, #b07000)', marginTop: 8 }}>
                {liveSearch.error}
              </div>
            )}
          </>
        )}
        {source === 'group' && (
          <>
            <label className="wf-label">Group</label>
            {Array.isArray(groups) && groups.length > 0 ? (
              <select
                className="input wf-select"
                value={selectedGroupId || ''}
                onChange={(e) => onSelectGroup && onSelectGroup(e.target.value || null)}
                style={{ width: '100%' }}
              >
                <option value="">— select a group —</option>
                {groups.map(g => {
                  const id = g.id || g.groupId;
                  const label = g.name || g.label || id;
                  const count = g.profileCount || (Array.isArray(g.profiles) ? g.profiles.length : null);
                  return (
                    <option key={id} value={id}>
                      {label}{count != null ? ` · ${count} profiles` : ''}
                    </option>
                  );
                })}
              </select>
            ) : (
              <div className="input wf-select" style={{ color: 'var(--text-dim)' }}>
                <span>No groups saved yet</span>
              </div>
            )}
            {liveCount != null && (
              <div className="wf-list-stats">
                <div><span className="wf-list-stats__k">Prospects</span><span className="wf-list-stats__v tabular">{liveCount.toLocaleString()}</span></div>
              </div>
            )}
            <div className="wf-hint">
              {selectedGroupId && liveCount != null
                ? 'Launch will queue actions against this group'
                : selectedGroupId
                  ? 'Group has no profiles yet'
                  : 'Select a group to enable Launch'}
            </div>
          </>
        )}
        {source === 'import' && (
          <>
            <label className="wf-label">Paste LinkedIn profile URLs</label>
            <textarea
              className="input"
              rows="6"
              placeholder="https://www.linkedin.com/in/jane-doe&#10;https://www.linkedin.com/in/john-smith"
              value={importText || ''}
              onChange={(e) => onImportText && onImportText(e.target.value)}
              style={{ fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace', fontSize: 12 }}
            />
            <div className="wf-list-stats" style={{ marginTop: 8 }}>
              <div>
                <span className="wf-list-stats__k">URLs detected</span>
                <span className="wf-list-stats__v tabular">{importUrlCount || 0}</span>
              </div>
            </div>
            <div className="wf-hint s-dim">One per line or comma-separated. Anything that isn't a <code>linkedin.com/in/...</code> URL is ignored.</div>
          </>
        )}
      </div>
      {liveCount != null && (
        <div className="wf-section" style={{ paddingTop: 6 }}>
          <div style={{
            padding: '8px 10px', borderRadius: 6, fontSize: 12,
            background: 'var(--accent-soft, rgba(40,130,255,0.08))',
            border: '1px solid var(--accent-line, rgba(40,130,255,0.18))',
          }}>
            <b className="tabular">{liveCount.toLocaleString()}</b> prospect{liveCount === 1 ? '' : 's'} will enter the campaign — <span className="s-dim">{targetLabel || ''}</span>
          </div>
        </div>
      )}

      {/* Score histogram — only renders when real prospect-score data is available */}
      {histogram.length > 0 && (
        <div className="wf-section">
          <div className="wf-section__head">
            <div className="eyebrow">Score distribution</div>
            <span className="mono wf-section__aside tabular">0 → 100</span>
          </div>
          <div className="wf-histogram" role="img" aria-label="Lead score distribution across 10 buckets">
            {histogram.map((v, i) => (
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
      )}

      {breakdown.length > 0 && (
        <div className="wf-section">
          <div className="wf-section__head">
            <div className="eyebrow">Mean score breakdown</div>
            <span className="wf-section__aside tabular mono">{t.meanScore || 0} / 100</span>
          </div>
          <div className="wf-scorebar">
            {breakdown.map((b) => (
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
      )}

      {exclusions.length > 0 && (
        <div className="wf-section">
          <div className="wf-section__head">
            <div className="eyebrow">Exclusions active</div>
          </div>
          <div className="wf-excl">
            {exclusions.map(x => (
              <div key={x.label} className="wf-excl__row">
                <Ic.Ban cls="icon icon--sm s-dim"/>
                <span className="wf-excl__label">{x.label}</span>
                <span className="wf-excl__count mono tabular">{x.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {pastSimilar.length > 1 && (
        <div className="wf-section">
          <div className="wf-section__head">
            <div className="eyebrow">Past similar · reply %</div>
            <span className="wf-section__aside tabular mono">{pastSimilar.length} campaigns</span>
          </div>
          <svg viewBox="0 0 200 40" className="wf-spark">
            <path
              d={`M ${pastSimilar.map((v,i) => `${(i/(pastSimilar.length-1))*200},${40 - (v/pastMax)*34 - 3}`).join(' L ')}`}
              fill="none" stroke="var(--primary)" strokeWidth="1.5"
            />
            <path
              d={`M 0,40 L ${pastSimilar.map((v,i) => `${(i/(pastSimilar.length-1))*200},${40 - (v/pastMax)*34 - 3}`).join(' L ')} L 200,40 Z`}
              fill="var(--primary)" opacity="0.08"
            />
          </svg>
        </div>
      )}
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
  if (!Array.isArray(grid) || grid.length === 0) {
    return (
      <div className="wf-sim">
        <div className="wf-sim__head">
          <div>
            <div className="eyebrow">Dry-run · next 7 days</div>
            <div className="wf-sim__sub s-dim">Simulation not available yet — launch the run to see real-time pacing.</div>
          </div>
        </div>
      </div>
    );
  }
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
function ReadinessPanel({ state, simOpen, onToggleSim, onLaunch, onPause, onResume, onCancel, preflight, canLaunch: canLaunchProp, activeRun, math }) {
  const mathFinal = (math && typeof math === 'object') ? math : WF.math;
  const checks = Array.isArray(preflight) && preflight.length > 0
    ? preflight
    : (state === 'ready' || state === 'running' ? WF.preflight.green
       : state === 'paused-error' ? WF.preflight.pausedError
       : WF.preflight.authoring);

  const grouped = useMemoWP(() => {
    const g = {};
    checks.forEach(c => { (g[c.cat] = g[c.cat] || []).push(c); });
    return g;
  }, [checks]);

  const hasRed = checks.some(c => c.state === 'danger');
  const hasWarn = checks.some(c => c.state === 'warn');
  const canLaunch = typeof canLaunchProp === 'boolean' ? canLaunchProp : (!hasRed && !hasWarn && state !== 'running');

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
              <span className="mathrow__v tabular">{mathFinal.perProspect}</span>
            </div>
            <div className="mathrow">
              <span className="mathrow__k">Enroll time</span>
              <span className="mathrow__v tabular">{mathFinal.campaign}</span>
              <span className="mathrow__aside">{mathFinal.campaignDetail}</span>
            </div>
            <div className="mathrow">
              <span className="mathrow__k">Daily load</span>
              <span className="mathrow__v tabular">{mathFinal.load}</span>
              <span className="mathrow__aside">{mathFinal.loadDetail}</span>
            </div>
            <div className="mathrow">
              <span className="mathrow__k">Est. replies</span>
              <span className="mathrow__v tabular">{mathFinal.replies}</span>
              <span className="mathrow__aside">{mathFinal.replyDetail}</span>
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
              bottleneck={null}
            />
          )}
        </div>
      </div>

      {/* Launch / Pause / Resume / Cancel */}
      <div className="wf-right__foot">
        {state === 'running' ? (
          <>
            <button className="btn btn--lg btn--warn wf-launch wf-launch--pause" onClick={onPause} type="button">
              <Ic.Pause cls="icon"/> Pause campaign
            </button>
            <button
              className="btn wf-launch"
              onClick={onCancel}
              type="button"
              style={{ marginTop: 6, color: 'var(--danger, #c00)' }}
            >
              <Ic.X cls="icon icon--sm"/> Cancel campaign
            </button>
          </>
        ) : state === 'paused-error' ? (
          <>
            <button className="btn btn--lg btn--primary wf-launch" onClick={onResume} type="button">
              <Ic.Play cls="icon"/> Resume campaign
            </button>
            <button
              className="btn wf-launch"
              onClick={onCancel}
              type="button"
              style={{ marginTop: 6, color: 'var(--danger, #c00)' }}
            >
              <Ic.X cls="icon icon--sm"/> Cancel campaign
            </button>
          </>
        ) : (
          <button
            className={`btn btn--lg btn--primary wf-launch ${canLaunch ? '' : 'wf-launch--disabled'}`}
            disabled={!canLaunch}
            onClick={canLaunch ? onLaunch : undefined}
            title={canLaunch ? 'Launch campaign · ⌘↵' : 'Resolve preflight warnings to launch'}
            type="button"
          >
            <Ic.Bolt cls="icon"/> Launch campaign
          </button>
        )}
        <div className="wf-launch__hint mono">
          {canLaunch
            ? <><span className="dot s-ok"/>All systems go · ⌘↵</>
            : state === 'running'
              ? <><span className="dot s-info dot--pulse"/>Running</>
              : state === 'paused-error'
                ? <><span className="dot s-danger"/>{activeRun && activeRun.pauseReason ? activeRun.pauseReason : 'Paused'}</>
                : <><span className="dot s-warn"/>{hasRed ? 'Preflight blocker' : 'Preflight warning'} · review checks</>}
        </div>
      </div>
    </aside>
  );
}

function WorkflowSetupRail({
  groups, selectedGroupId, onSelectGroup, prospectCount,
  targetSource, onSelectSource, searchTerm, onSearchTerm, searchMatchCount,
  importText, onImportText, importUrlCount, targetLabel,
  liveSearch, onRunLiveSearch, searchAccountEmail,
  maxProfiles, onMaxProfiles,
  preflight, math, simOpen, onToggleSim,
}) {
  const source = targetSource || 'group';
  const liveCount = typeof prospectCount === 'number' && prospectCount > 0 ? prospectCount : null;
  const checks = Array.isArray(preflight) ? preflight : [];
  const mathFinal = (math && typeof math === 'object') ? math : WF.math;

  const iconMeta = (state) => {
    if (state === 'ok') return { bg: 'var(--ok-soft)', fg: 'var(--ok-text)', Icon: Ic.Check };
    if (state === 'warn') return { bg: 'var(--warn-soft)', fg: 'var(--warn-text)', Icon: Ic.Warn };
    return { bg: 'var(--danger-soft)', fg: 'var(--danger-text)', Icon: Ic.X };
  };

  return (
    <aside className="wf__side">
      <div className="wf__side-sec">
        <div className="eyebrow">Targeting</div>
        <div className="wf__side-title">Who this campaign acts on</div>

        <div className="wf-side-tabs" role="tablist">
          {[
            { id: 'search', label: 'Search' },
            { id: 'group', label: 'Group' },
            { id: 'import', label: 'Import' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={source === tab.id}
              className={`wf-side-tab ${source === tab.id ? 'wf-side-tab--active' : ''}`}
              onClick={() => onSelectSource && onSelectSource(tab.id)}
            >{tab.label}</button>
          ))}
        </div>

        <div className="wf-side-body">
          {source === 'search' && (
            <>
              <label className="field-label">LinkedIn search term</label>
              <input
                className="field"
                placeholder="e.g. Head of People, RevOps leader"
                value={searchTerm || ''}
                onChange={(e) => onSearchTerm && onSearchTerm(e.target.value)}
              />

              <label className="field-label" style={{ marginTop: 8 }}>Profiles to enroll</label>
              <div className="row gap-2" style={{ alignItems: 'center' }}>
                <input
                  className="field"
                  type="number"
                  min="1"
                  max="50"
                  value={maxProfiles == null ? 10 : maxProfiles}
                  onChange={(e) => onMaxProfiles && onMaxProfiles(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  style={{ width: 88 }}
                />
                <span className="wf-side-note">capped by your daily budget</span>
              </div>

              <div className="wf-side-note" style={{ marginTop: 8 }}>
                Launch opens a visible browser
                {searchAccountEmail ? <> with <code>{searchAccountEmail}</code></> : <> with the agent&apos;s account</>}
                , runs the stealth LinkedIn search, then queues the workflow against the top {maxProfiles == null ? 10 : maxProfiles} matches.
              </div>

              <div className="row gap-2" style={{ marginTop: 10 }}>
                <button
                  className="btn btn--sm btn--ghost"
                  type="button"
                  onClick={onRunLiveSearch}
                  disabled={!String(searchTerm || '').trim() || (liveSearch && liveSearch.loading)}
                >
                  <Ic.Search cls="icon icon--sm" />
                  {liveSearch && liveSearch.loading ? 'Searching…' : 'Preview matches'}
                </button>
                {searchMatchCount > 0 && (
                  <span className="wf-side-note">{searchMatchCount} saved prospects also match this term</span>
                )}
              </div>

              {liveSearch && !liveSearch.loading && Array.isArray(liveSearch.urls) && liveSearch.urls.length > 0 && (
                <div className="wf-side-liststats">
                  <div>
                    <span className="wf-side-liststats__k">Last search</span>
                    <span className="wf-side-liststats__v tabular">{liveSearch.urls.length}</span>
                  </div>
                  <div>
                    <span className="wf-side-liststats__k">Mode</span>
                    <span className="wf-side-liststats__v">Live</span>
                  </div>
                </div>
              )}

              {liveSearch && !liveSearch.loading && liveSearch.error && (
                <div className="wf-side-note wf-side-note--warn">{liveSearch.error}</div>
              )}
            </>
          )}

          {source === 'group' && (
            <>
              <label className="field-label">Saved group</label>
              {Array.isArray(groups) && groups.length > 0 ? (
                <select
                  className="field"
                  value={selectedGroupId || ''}
                  onChange={(e) => onSelectGroup && onSelectGroup(e.target.value || null)}
                >
                  <option value="">Select a group</option>
                  {groups.map((group) => {
                    const id = group.id || group.groupId;
                    const label = group.name || group.label || id;
                    const count = group.profileCount || (Array.isArray(group.profiles) ? group.profiles.length : Array.isArray(group.members) ? group.members.length : null);
                    return (
                      <option key={id} value={id}>
                        {label}{count != null ? ` · ${count} profiles` : ''}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <div className="field field--static">No groups saved yet</div>
              )}
            </>
          )}

          {source === 'import' && (
            <>
              <label className="field-label">LinkedIn profile URLs</label>
              <textarea
                className="field wf-side-textarea"
                rows="6"
                placeholder="https://www.linkedin.com/in/jane-doe"
                value={importText || ''}
                onChange={(e) => onImportText && onImportText(e.target.value)}
              />
              <div className="wf-side-liststats">
                <div>
                  <span className="wf-side-liststats__k">URLs detected</span>
                  <span className="wf-side-liststats__v tabular">{importUrlCount || 0}</span>
                </div>
              </div>
              <div className="wf-side-note">One per line or comma-separated. Only <code>linkedin.com/in/…</code> URLs are used.</div>
            </>
          )}
        </div>

        {liveCount != null && (
          <div className="wf-side-banner">
            <b className="tabular">{liveCount.toLocaleString()}</b> prospect{liveCount === 1 ? '' : 's'} will enter the campaign
            {targetLabel ? <> — <span>{targetLabel}</span></> : null}
          </div>
        )}
      </div>

      <div className="wf__side-sec">
        <div className="eyebrow">Preflight</div>
        <div className="wf__side-title">Ready before launch</div>
        <div className="wf-side-stack">
          {checks.map((item, index) => {
            const meta = iconMeta(item.state);
            const Icon = meta.Icon;
            return (
              <div key={`${item.label}-${index}`} className="preflight-row">
                <span className="preflight-ic" style={{ background: meta.bg, color: meta.fg }}>
                  <Icon cls="icon icon--sm" />
                </span>
                <div className="flex-1">
                  <div className="wf-side-rowtitle">{item.label}</div>
                  <div className="wf-side-note">{item.detail}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="wf__side-sec">
        <div className="eyebrow">Estimated</div>
        <div className="wf__side-title">Campaign math</div>
        <div className="metric-row"><span className="wf-side-metric__k">Per prospect</span><span className="wf-side-metric__v tabular">{mathFinal.perProspect}</span></div>
        <div className="metric-row"><span className="wf-side-metric__k">Campaign</span><span className="wf-side-metric__v">{mathFinal.campaign}</span></div>
        <div className="metric-row"><span className="wf-side-metric__k">Daily load</span><span className="wf-side-metric__v">{mathFinal.load}</span></div>
        <div className="metric-row"><span className="wf-side-metric__k">Est. replies</span><span className="wf-side-metric__v">{mathFinal.replies}</span></div>
        <div className="wf-side-note" style={{ marginTop: 10 }}>{mathFinal.replyDetail}</div>
      </div>

      <div className="wf__side-sec">
        <div className="row spread" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <div className="eyebrow">Dry-run</div>
            <div className="wf__side-title">Pacing preview</div>
          </div>
          <button className="btn btn--ghost btn--sm" type="button" onClick={onToggleSim}>
            {simOpen ? 'Hide' : 'Show'}
          </button>
        </div>
        {simOpen ? (
          <SimulationHeatmap grid={WF.simulate} bottleneck={null} />
        ) : (
          <div className="wf-side-note">Use Dry-run to preview the next 7 days before launch.</div>
        )}
      </div>
    </aside>
  );
}

Object.assign(window, { TargetingPanel, ReadinessPanel, WorkflowSetupRail, PreflightRow, SimulationHeatmap });
