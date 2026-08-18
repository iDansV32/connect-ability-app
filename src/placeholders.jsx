// Placeholder views for the remaining sections — intentionally sparse but real-looking

const PLACEHOLDER_TEXT = {
  agents: { title: 'SDR Agents', desc: 'Triple panel: agent list → config → persona files. Each agent carries four markdown files (soul, personality, writing-style, boundaries).' },
  workflows: { title: 'Workflow Studio', desc: 'Visual step builder. view_profile → delay → like_posts → delay → send_connection → delay → send_dm with readiness checks.' },
  prospects: { title: 'Prospects', desc: 'Ranked queue scored 0–100 with expandable score breakdown. 1,247 prospects across 6 accounts.' },
  posts: { title: 'Scheduled Posts', desc: 'Calendar + list hybrid across all accounts. Bulk schedule, content pillars, draft → scheduled → published.' },
  health: { title: 'Account Health & Safety', desc: '"Is my account about to get banned?" Calm when green, specific when not. 6 LinkedIn accounts.' },
  apollo: { title: 'Apollo Sync', desc: 'Sequence binding + sync status. Dry-run prominent. Skip reasons grouped.' },
  analytics: { title: 'Analytics', desc: 'Step-outcome stacked bars per step type. The real differentiator: skip-reason transparency.' },
  settings: { title: 'Settings', desc: 'Credentials, MCP server status, export destinations, scheduled daily reports, feature flags.' },
};

function Placeholder({ id, onNav }) {
  const p = PLACEHOLDER_TEXT[id] || { title: id, desc: '' };
  return (
    <div className="placeholder">
      <div className="placeholder__head">
        <div>
          <div className="eyebrow">Section</div>
          <h1 className="page-title">{p.title}</h1>
          <p className="page-sub" style={{ maxWidth: 540 }}>{p.desc}</p>
        </div>
        <div className="row gap-2">
          <button className="btn">Specs</button>
          <button className="btn btn--primary"><Ic.Plus cls="icon--sm"/>New</button>
        </div>
      </div>
      <div className="placeholder__shell">
        <div className="placeholder__left">
          <div className="eyebrow" style={{ padding: '10px 14px 6px' }}>List</div>
          {[...Array(8)].map((_, i) => (
            <div key={i} className="placeholder__row">
              <div className="placeholder__avatar"></div>
              <div className="col flex-1 gap-1">
                <div className="placeholder__line" style={{ width: '60%' }}></div>
                <div className="placeholder__line placeholder__line--sm" style={{ width: '35%' }}></div>
              </div>
            </div>
          ))}
        </div>
        <div className="placeholder__center">
          <div className="placeholder__hero">
            <div className="eyebrow" style={{ marginBottom: 12 }}>Coming in next pass</div>
            <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{p.title} · full implementation</div>
            <div className="s-dim" style={{ fontSize: 13, maxWidth: 420, lineHeight: 1.5 }}>
              The Cockpit and Inbox are wired as interactive prototypes in this pass. Open either from the sidebar —
              they show the full pattern library that will drive this view.
            </div>
            <div className="row gap-2" style={{ marginTop: 20 }}>
              <button className="btn btn--primary" onClick={() => onNav('cockpit')}>Open Cockpit</button>
              <button className="btn" onClick={() => onNav('inbox')}>Open Inbox</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Placeholder });
