// Icons — hand-crafted inline SVG icon set (24px grid, stroke-based)
// Used throughout Connect. NO emoji.

const Ic = {};
const s = (path, vb = '0 0 24 24') => ({ children }) => (
  <svg viewBox={vb} fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={children || 'icon'}>
    {path}
  </svg>
);

Ic.Cockpit = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <rect x="3" y="3" width="8" height="10" rx="1.5"/>
    <rect x="13" y="3" width="8" height="6" rx="1.5"/>
    <rect x="13" y="11" width="8" height="10" rx="1.5"/>
    <rect x="3" y="15" width="8" height="6" rx="1.5"/>
  </svg>
);

Ic.Agents = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <circle cx="9" cy="8" r="3.2"/>
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/>
    <circle cx="17" cy="6" r="2.2"/>
    <path d="M15 13c2.5 0 5 1.8 5 5"/>
  </svg>
);

Ic.Workflow = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <rect x="3" y="4" width="6" height="4" rx="1"/>
    <rect x="15" y="4" width="6" height="4" rx="1"/>
    <rect x="9" y="16" width="6" height="4" rx="1"/>
    <path d="M6 8v4h12V8"/>
    <path d="M12 12v4"/>
  </svg>
);

Ic.Inbox = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M3 13l2.5-7.5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.5L21 13"/>
    <path d="M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5h-6a3 3 0 0 1-6 0H3z"/>
  </svg>
);

Ic.Prospects = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M4 6h12M4 12h12M4 18h8"/>
    <circle cx="20" cy="6" r="1.5" fill="currentColor"/>
    <circle cx="20" cy="12" r="1.5" fill="currentColor"/>
    <circle cx="16" cy="18" r="1.5" fill="currentColor"/>
  </svg>
);

Ic.Calendar = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <rect x="3.5" y="5" width="17" height="15" rx="2"/>
    <path d="M3.5 10h17M8 3v4M16 3v4"/>
  </svg>
);

Ic.Health = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M12 21s-7-4.3-7-10a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 5.7-7 10-7 10h-4z" opacity="0.4"/>
    <path d="M3 12h4l2-4 3 8 2-4h7"/>
  </svg>
);

Ic.Apollo = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <circle cx="12" cy="12" r="8"/>
    <path d="M4 12a8 8 0 0 1 16 0M12 4a8 8 0 0 1 0 16"/>
  </svg>
);

Ic.Analytics = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M4 20h16"/>
    <rect x="6" y="12" width="3" height="6" rx="0.5"/>
    <rect x="11" y="8" width="3" height="10" rx="0.5"/>
    <rect x="16" y="4" width="3" height="14" rx="0.5"/>
  </svg>
);

Ic.Settings = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>
  </svg>
);

Ic.Search = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <circle cx="11" cy="11" r="6.5"/>
    <path d="m20 20-3.5-3.5"/>
  </svg>
);

Ic.Bell = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M6 8a6 6 0 1 1 12 0v4l2 4H4l2-4V8z"/>
    <path d="M10 20a2 2 0 0 0 4 0"/>
  </svg>
);

Ic.Sun = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <circle cx="12" cy="12" r="4"/>
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>
  </svg>
);

Ic.Moon = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11z"/>
  </svg>
);

Ic.ChevronRight = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="m9 6 6 6-6 6"/>
  </svg>
);

Ic.ChevronDown = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="m6 9 6 6 6-6"/>
  </svg>
);

Ic.ChevronLeft = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="m15 6-6 6 6 6"/>
  </svg>
);

Ic.ArrowUp = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M12 19V5M5 12l7-7 7 7"/>
  </svg>
);

Ic.ArrowDown = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M12 5v14M5 12l7 7 7-7"/>
  </svg>
);

Ic.Plus = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M12 5v14M5 12h14"/>
  </svg>
);

Ic.X = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M6 6l12 12M18 6 6 18"/>
  </svg>
);

Ic.Check = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="m5 12 5 5L20 7"/>
  </svg>
);

Ic.Play = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" className={cls}>
    <path d="M7 5v14l12-7z"/>
  </svg>
);

Ic.Pause = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" className={cls}>
    <rect x="6" y="5" width="4" height="14" rx="1"/>
    <rect x="14" y="5" width="4" height="14" rx="1"/>
  </svg>
);

Ic.Send = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M21 3 3 10l7 3 3 7 8-17z"/>
  </svg>
);

Ic.Command = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6z"/>
  </svg>
);

Ic.Dots = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={cls}>
    <circle cx="6" cy="12" r="1.4"/>
    <circle cx="12" cy="12" r="1.4"/>
    <circle cx="18" cy="12" r="1.4"/>
  </svg>
);

Ic.Pin = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M12 3v10M6 13h12l-2 3H8l-2-3zM12 16v5"/>
  </svg>
);

Ic.Archive = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <rect x="3" y="4" width="18" height="4" rx="1"/>
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>
  </svg>
);

Ic.Ban = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <circle cx="12" cy="12" r="9"/>
    <path d="M5.5 5.5 18.5 18.5"/>
  </svg>
);

Ic.Clock = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M12 7v5l3 2"/>
  </svg>
);

Ic.Bolt = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M13 3 4 14h7l-1 7 9-11h-7l1-7z"/>
  </svg>
);

Ic.Warn = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M10.3 3.9 2.5 17.6A2 2 0 0 0 4.2 20.6h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>
    <path d="M12 9v4M12 17h0"/>
  </svg>
);

Ic.Info = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <circle cx="12" cy="12" r="9"/>
    <path d="M12 8h0M11 12h1v5h1"/>
  </svg>
);

Ic.User = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <circle cx="12" cy="8" r="4"/>
    <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>
  </svg>
);

Ic.Link = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M10 14a4 4 0 0 1 0-5.7l3-3a4 4 0 0 1 5.7 5.7l-1.5 1.5"/>
    <path d="M14 10a4 4 0 0 1 0 5.7l-3 3a4 4 0 0 1-5.7-5.7l1.5-1.5"/>
  </svg>
);

Ic.Eye = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/>
    <circle cx="12" cy="12" r="2.5"/>
  </svg>
);

Ic.Hand = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M7 11V5a1.5 1.5 0 0 1 3 0v5M10 10V4a1.5 1.5 0 0 1 3 0v6M13 10V5a1.5 1.5 0 0 1 3 0v7M16 12V8a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-2a6 6 0 0 1-5.2-3L4 15a1.5 1.5 0 0 1 2.5-1.6L8 15"/>
  </svg>
);

Ic.Sparkle = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.5 5.5l2.8 2.8M15.7 15.7l2.8 2.8M5.5 18.5l2.8-2.8M15.7 8.3l2.8-2.8"/>
  </svg>
);

Ic.Filter = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="M4 5h16l-6 8v6l-4-2v-4L4 5z"/>
  </svg>
);

Ic.Star = ({ cls = 'icon' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d="m12 3 2.7 6 6.3.6-4.8 4.3 1.4 6.1L12 17l-5.6 3 1.4-6.1L3 9.6 9.3 9 12 3z"/>
  </svg>
);

Object.assign(window, { Ic });
