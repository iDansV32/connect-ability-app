// Workflow Studio — Step canvas, spintax editor, persona lint

const { useState: useStateWS, useMemo: useMemoWS, useRef: useRefWS, useEffect: useEffectWS } = React;

// ===================================================================
// SPINTAX + PLACEHOLDER TOKENIZER
// parses: {a|b|c} → spin token, {first_name} → placeholder token, plain text → text
// ===================================================================
function tokenize(template) {
  const tokens = [];
  let i = 0;
  while (i < template.length) {
    if (template[i] === '{') {
      let depth = 1, j = i + 1;
      while (j < template.length && depth > 0) {
        if (template[j] === '{') depth++;
        else if (template[j] === '}') depth--;
        if (depth > 0) j++;
      }
      const inner = template.slice(i + 1, j);
      if (inner.includes('|')) {
        // spintax — split at top-level pipes
        const parts = [];
        let d = 0, start = 0;
        for (let k = 0; k < inner.length; k++) {
          if (inner[k] === '{') d++;
          else if (inner[k] === '}') d--;
          else if (inner[k] === '|' && d === 0) { parts.push(inner.slice(start, k)); start = k + 1; }
        }
        parts.push(inner.slice(start));
        tokens.push({ kind: 'spin', options: parts, choice: 0 });
      } else {
        tokens.push({ kind: 'placeholder', name: inner });
      }
      i = j + 1;
    } else {
      let j = i;
      while (j < template.length && template[j] !== '{') j++;
      tokens.push({ kind: 'text', value: template.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

function renderSample(tokens, seed) {
  // deterministic-ish sample given a seed so the "3 random samples" feel distinct
  let rand = seed;
  const next = () => { rand = (rand * 9301 + 49297) % 233280; return rand / 233280; };
  const sampleData = { first_name: 'Daniel', company: 'Paloma', attribution: 'attribution wiring' };
  return tokens.map(tok => {
    if (tok.kind === 'text') return tok.value;
    if (tok.kind === 'placeholder') return sampleData[tok.name] || `[${tok.name}]`;
    if (tok.kind === 'spin') {
      const opt = tok.options[Math.floor(next() * tok.options.length)];
      const inner = tokenize(opt);
      return renderSample(inner, rand);
    }
  }).join('');
}

function countVariations(tokens) {
  return tokens.reduce((acc, tok) => {
    if (tok.kind === 'spin') {
      const innerCounts = tok.options.map(o => countVariations(tokenize(o)));
      return acc * innerCounts.reduce((a,b) => a+b, 0);
    }
    return acc;
  }, 1);
}

function violations(text) {
  const out = [];
  for (const rule of WF.personaRules) {
    let m;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    while ((m = re.exec(text)) !== null) {
      out.push({ rule, index: m.index, match: m[0] });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

// ===================================================================
// SPINTAX EDITOR — contenteditable-ish with pill tokens
// ===================================================================
function SpintaxEditor({ template, onChange, showLint = true }) {
  const tokens = useMemoWS(() => tokenize(template), [template]);
  const plain = useMemoWS(() => renderSample(tokens, 42), [tokens]); // for lint

  const [choices, setChoices] = useStateWS({}); // token index → option index (for preview cycling)

  const totalVariations = useMemoWS(() => countVariations(tokens), [tokens]);
  const charCount = plain.length;

  const lintIssues = useMemoWS(() => violations(plain), [plain]);

  // Render tokens as inline pills / text / underlined placeholders
  // Also detect lint spans within plain text pieces and underline them
  const renderTokens = () => {
    let plainOffset = 0;
    return tokens.map((tok, idx) => {
      if (tok.kind === 'text') {
        const start = plainOffset;
        const end = plainOffset + tok.value.length;
        plainOffset = end;
        const local = lintIssues.filter(l => l.index >= start && l.index < end);
        if (local.length === 0) return <span key={idx}>{tok.value}</span>;
        // break the text to inject underline spans
        const parts = [];
        let cursor = start;
        local.forEach((iss, k) => {
          if (iss.index > cursor) parts.push(<span key={`t${k}`}>{tok.value.slice(cursor - start, iss.index - start)}</span>);
          parts.push(
            <span key={`v${k}`} className={`spin-lint spin-lint--${iss.rule.severity}`} title={iss.rule.label}>
              {tok.value.slice(iss.index - start, iss.index - start + iss.match.length)}
            </span>
          );
          cursor = iss.index + iss.match.length;
        });
        if (cursor < end) parts.push(<span key="tt">{tok.value.slice(cursor - start)}</span>);
        return <React.Fragment key={idx}>{parts}</React.Fragment>;
      }
      if (tok.kind === 'placeholder') {
        plainOffset += (tok.name.length); // approx
        return <span key={idx} className="spin-ph" title={`placeholder: ${tok.name}`}>{tok.name}</span>;
      }
      if (tok.kind === 'spin') {
        const chosen = choices[idx] ?? 0;
        const sample = renderSample(tokenize(tok.options[chosen]), 0);
        plainOffset += sample.length;
        return (
          <span key={idx} className="spin-pill" tabIndex="0"
                onClick={() => setChoices(c => ({...c, [idx]: ((c[idx] ?? 0) + 1) % tok.options.length}))}
                title={`${tok.options.length} variations · click to cycle`}>
            <span className="spin-pill__val">{tok.options[chosen]}</span>
            <span className="spin-pill__count mono">{tok.options.length}</span>
          </span>
        );
      }
    });
  };

  // 3 live-preview samples
  const samples = useMemoWS(() => [7, 23, 41].map(s => renderSample(tokens, s)), [tokens]);

  const maxLen = 1000;
  return (
    <div className="spin">
      <div className="spin__editor" contentEditable={false}>
        <div className="spin__content">
          {renderTokens()}
        </div>
      </div>

      <div className="spin__meta">
        <span className="spin__meta-chip"><Ic.Sparkle cls="icon icon--sm"/>{totalVariations.toLocaleString()} variations</span>
        <span className="spin__meta-chip"><Ic.User cls="icon icon--sm"/>2 placeholders</span>
        <span className={`spin__meta-chip tabular ${charCount > maxLen ? 's-danger' : ''}`}>{charCount} / {maxLen}</span>
        <div className="flex-1" />
        <button className="btn btn--sm btn--ghost" title="Insert spin">+ spin</button>
        <button className="btn btn--sm btn--ghost" title="Insert placeholder">+ var</button>
      </div>

      {/* Live preview — 3 sampled DMs rendered as bubbles */}
      <div className="spin__preview">
        <div className="spin__preview-head eyebrow">Live preview · 3 samples from {totalVariations.toLocaleString()}</div>
        <div className="spin__bubbles">
          {samples.map((s, i) => (
            <div key={i} className="spin__bubble">
              <span className="spin__bubble-idx mono tabular">0{i+1}</span>
              <span className="spin__bubble-text">{s}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Persona lint */}
      {showLint && (
        <div className="spin__lint">
          <div className="spin__lint-head">
            <span className="eyebrow">Persona compliance · Atlas</span>
            <span className="mono s-dim">reading writing-style.md · boundaries.md</span>
          </div>
          {lintIssues.length === 0 ? (
            <div className="spin__lint-clean"><Ic.Check cls="icon icon--sm s-ok"/>No violations. Tone matches agent target.</div>
          ) : (
            <div className="spin__lint-list">
              {lintIssues.map((iss, i) => (
                <div key={i} className={`spin__lint-item spin__lint-item--${iss.rule.severity}`}>
                  <span className={`dot ${iss.rule.severity === 'danger' ? 's-danger' : 's-warn'}`}/>
                  <span className="spin__lint-label">{iss.rule.label}</span>
                  <code className="spin__lint-snippet mono">"{iss.match}"</code>
                  <button className="pfrow__action">Fix</button>
                </div>
              ))}
              <div className="spin__lint-item spin__lint-item--info">
                <span className="dot s-info"/>
                <span className="spin__lint-label">Tone score: 6.2 / 10 casual · agent target 7</span>
                <button className="pfrow__action">Adjust</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ===================================================================
// OUTCOME RATE CHIP
// ===================================================================
function OutcomeChip({ stepType }) {
  const [open, setOpen] = useStateWS(false);
  const o = WF.outcomes[stepType];
  if (!o) return null;
  const total = Object.values(o).reduce((a,b) => a+b, 0);
  const completed = o.completed;
  const pct = Math.round((completed / total) * 100);
  const sev = pct >= 85 ? 'ok' : pct >= 70 ? 'warn' : 'danger';

  const breakdown = [
    { k: 'completed',                  v: o.completed,                    cls: 's-ok' },
    { k: 'skipped (working hours)',    v: o.skipped_outside_working_hours, cls: 's-dim' },
    { k: 'skipped (budget)',           v: o.skipped_budget_exceeded,      cls: 's-dim' },
    { k: 'skipped (do not contact)',   v: o.skipped_do_not_contact,       cls: 's-dim' },
    { k: 'failed transient',           v: o.failed_transient,             cls: 's-warn' },
    { k: 'failed permanent',           v: o.failed_permanent,             cls: 's-danger' },
  ];

  return (
    <div className="oc" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className={`chip chip--${sev} mono tabular`}>{pct}% completed</span>
      {open && (
        <div className="oc__pop">
          <div className="oc__head eyebrow">Last 100 runs · {stepType}</div>
          <div className="oc__bar">
            {breakdown.filter(b => b.v > 0).map((b, i) => (
              <div key={i} className={`oc__bar-seg oc__bar-seg--${b.cls.replace('s-','')}`} style={{ flex: b.v }} title={`${b.k}: ${b.v}`}/>
            ))}
          </div>
          <div className="oc__list">
            {breakdown.map((b, i) => (
              <div key={i} className="oc__row">
                <span className={`dot ${b.cls}`}/>
                <span className="oc__k">{b.k}</span>
                <span className="oc__v tabular mono">{b.v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ===================================================================
// STEP NODE — collapsed & expanded
// ===================================================================
function DelayPill({ node, readOnly, onEdit }) {
  const display = node.hours >= 24 ? `${node.hours / 24}d` : `${node.hours}h`;
  return (
    <div className="wf-delay">
      <div className="wf-delay__line"/>
      <div className="wf-delay__pill">
        <Ic.Clock cls="icon icon--sm"/>
        <span className="tabular mono">wait {display}</span>
        {!readOnly && <>
          <span className="wf-delay__sep"/>
          <span className="wf-delay__hint">would land Sat 2am → Mon 9am</span>
        </>}
      </div>
      <div className="wf-delay__line"/>
    </div>
  );
}

function StepNode({ node, index, expanded, focused, readOnly, onToggle, onEdit, onMove, onDelete, onDuplicate, onInsertDelay }) {
  const def = WF.stepTypes[node.type];
  if (!def) return null;
  const Icon = Ic[def.icon];

  const summary = (() => {
    if (node.type === 'like_posts') return `Like ${node.count || 2} ${node.filter || 'recent'} posts`;
    if (node.type === 'send_connection') return node.withNote ? 'Connection request with note' : 'Connection request, no note';
    if (node.type === 'send_dm') return (node.template || '').slice(0, 62) + (node.template && node.template.length > 62 ? '…' : '');
    return def.summary;
  })();

  return (
    <div
      className={`stepnode ${expanded ? 'stepnode--expanded' : ''} ${focused ? 'stepnode--focused' : ''} ${readOnly ? 'stepnode--readonly' : ''}`}
      onClick={() => !expanded && onToggle && onToggle()}
      data-step-type={node.type}
    >
      <div className="stepnode__head">
        <div className="stepnode__handle" title="Drag to reorder">
          <Ic.Dots cls="icon icon--sm"/>
        </div>
        <div className="stepnode__icon"><Icon cls="icon"/></div>
        <div className="stepnode__title-wrap">
          <div className="stepnode__idx mono">step {index + 1}</div>
          <div className="stepnode__title">{def.label}</div>
        </div>
        <div className="stepnode__summary">{summary}</div>
        <OutcomeChip stepType={node.type}/>
        <div className="stepnode__tools">
          <button className="btn btn--icon btn--sm btn--ghost" title="Move up · ⌘↑" onClick={(e) => { e.stopPropagation(); onMove && onMove(-1); }}><Ic.ArrowUp cls="icon icon--sm"/></button>
          <button className="btn btn--icon btn--sm btn--ghost" title="Move down · ⌘↓" onClick={(e) => { e.stopPropagation(); onMove && onMove(1); }}><Ic.ArrowDown cls="icon icon--sm"/></button>
          <button className="btn btn--icon btn--sm btn--ghost" title="Duplicate · D" onClick={(e) => { e.stopPropagation(); onDuplicate && onDuplicate(); }}><Ic.Plus cls="icon icon--sm"/></button>
          <button className="btn btn--icon btn--sm btn--ghost" title="Delete · Del" onClick={(e) => { e.stopPropagation(); onDelete && onDelete(); }}><Ic.X cls="icon icon--sm"/></button>
        </div>
      </div>

      {expanded && (
        <div className="stepnode__body" onClick={e => e.stopPropagation()}>
          {node.type === 'send_dm' && (
            <>
              <div className="stepnode__field">
                <label className="wf-label row gap-2">
                  <span>DM template</span>
                  <span className="mono s-dim">spintax + placeholders</span>
                </label>
                <SpintaxEditor template={node.template}/>
              </div>
            </>
          )}
          {node.type === 'send_connection' && (
            <>
              <div className="stepnode__row">
                <label className="wf-toggle">
                  <input type="checkbox" defaultChecked={node.withNote}/>
                  <span className="wf-toggle__track"><span className="wf-toggle__thumb"/></span>
                  <span>Send with note</span>
                </label>
                <span className="mono s-dim">300-char LinkedIn limit</span>
              </div>
              {node.withNote && (
                <div className="stepnode__field">
                  <label className="wf-label">Connection note</label>
                  <SpintaxEditor template={node.note} showLint={false}/>
                </div>
              )}
            </>
          )}
          {node.type === 'like_posts' && (
            <div className="stepnode__field stepnode__field--row">
              <div>
                <label className="wf-label">Count</label>
                <div className="wf-stepper">
                  <button className="btn btn--sm btn--icon">−</button>
                  <span className="tabular mono">{node.count || 2}</span>
                  <button className="btn btn--sm btn--icon">+</button>
                </div>
              </div>
              <div>
                <label className="wf-label">Filter</label>
                <div className="segmented">
                  <button className={`segmented__btn ${node.filter === 'recent' ? 'segmented__btn--active' : ''}`}>Recent</button>
                  <button className={`segmented__btn ${node.filter !== 'recent' ? 'segmented__btn--active' : ''}`}>Most engaged</button>
                </div>
              </div>
            </div>
          )}
          {node.type === 'view_profile' && (
            <div className="stepnode__field">
              <div className="stepnode__note">
                <Ic.Info cls="icon icon--sm s-info"/>
                <span>Warms the connection signal. Captures public headline + current role for downstream step personalization.</span>
              </div>
            </div>
          )}

          <div className="stepnode__foot">
            <button className="btn btn--sm btn--ghost" onClick={() => onInsertDelay && onInsertDelay()}><Ic.Plus cls="icon icon--sm"/>Insert delay after</button>
            <div className="flex-1"/>
            <button className="btn btn--sm btn--ghost" onClick={onToggle}>Collapse</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===================================================================
// EMPTY STATE
// ===================================================================
function EmptyCanvas({ onUseStarter }) {
  return (
    <div className="wf-empty">
      <div className="wf-empty__card">
        <div className="wf-empty__icon"><Ic.Workflow cls="icon icon--xl"/></div>
        <div className="eyebrow">First-time setup</div>
        <h2 className="wf-empty__title">Start with the proven sequence</h2>
        <p className="wf-empty__lede">
          Most Connect operators open with two profile views, a light engagement, a connection request, then a DM.
          It warms the signal before asking for anything.
        </p>
        <div className="wf-empty__flow">
          {['View', 'Wait 24h', 'View', 'Wait 24h', 'Like posts', 'Wait 24h', 'Connect', 'Wait 48h', 'DM'].map((s, i) => (
            <React.Fragment key={i}>
              <div className={`wf-empty__chip ${s.startsWith('Wait') ? 'wf-empty__chip--delay' : ''}`}>{s}</div>
              {i < 8 && <div className="wf-empty__arrow">→</div>}
            </React.Fragment>
          ))}
        </div>
        <div className="wf-empty__stats row gap-4">
          <div><div className="eyebrow">Accept rate</div><div className="wf-empty__stat tabular">38%</div></div>
          <div><div className="eyebrow">Reply rate</div><div className="wf-empty__stat tabular">4.2%</div></div>
          <div><div className="eyebrow">Run duration</div><div className="wf-empty__stat tabular">6d 12h</div></div>
          <div><div className="eyebrow">Based on</div><div className="wf-empty__stat tabular">100 runs</div></div>
        </div>
        <div className="row gap-2 wf-empty__cta">
          <button className="btn btn--primary btn--lg" onClick={onUseStarter}><Ic.Sparkle cls="icon"/>Use this sequence</button>
          <button className="btn btn--lg">Start blank</button>
          <button className="btn btn--lg btn--ghost">Browse templates</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { StepNode, DelayPill, EmptyCanvas, SpintaxEditor, OutcomeChip, tokenize, renderSample, countVariations });
