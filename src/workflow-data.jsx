// Workflow Studio — config + (now-empty) data scaffolding.
// All runtime numbers, histograms, prospects, and run outcomes come from the
// real Electron backend via useWorkflowData(). Anything left in here is just
// UI labels / icon mapping for step types and persona-lint rule patterns.

const WF = {};

// Step type config — labels and icon names. Not data; safe to keep.
WF.stepTypes = {
  view_profile: { icon: 'Eye', label: 'View profile', summary: 'Visit profile, capture public headline' },
  like_posts: { icon: 'Star', label: 'Like posts', summary: 'Like N recent posts from prospect' },
  send_connection: { icon: 'Link', label: 'Send connection', summary: 'Send connection request with optional note' },
  send_dm: { icon: 'Send', label: 'Send DM', summary: 'Send direct message (requires accepted connection)' },
  check_connection_status: { icon: 'Check', label: 'Check status', summary: 'Poll for connection acceptance' },
};

// Real run-outcome data comes from getActivityAnalytics(). Empty until wired.
WF.outcomes = {};

// "Use this sequence" starter — clean skeleton with empty templates.
// Templates are blank so nothing fake is committed to the user's first save.
WF.defaultSequence = [
  { id: 's1', type: 'view_profile' },
  { id: 'd1', type: 'delay', hours: 24 },
  { id: 's2', type: 'like_posts', count: 2, filter: 'recent' },
  { id: 'd2', type: 'delay', hours: 24 },
  { id: 's3', type: 'send_connection', withNote: false, note: '' },
  { id: 'd3', type: 'delay', hours: 48 },
  { id: 's4', type: 'send_dm', template: '' },
];

// Persona-lint patterns. Generic LinkedIn copy-style rules — they fire only
// against the user's own template text and only show inside the SpintaxEditor.
WF.personaRules = [
  { id: 'r1', kind: 'boundary', pattern: /leverage/gi,    label: "avoid 'leverage'",            severity: 'warn' },
  { id: 'r2', kind: 'boundary', pattern: /circle back/gi, label: "avoid 'circle back'",         severity: 'warn' },
  { id: 'r3', kind: 'style',    pattern: /!{2,}/g,        label: 'avoid double exclamation',    severity: 'warn' },
  { id: 'r4', kind: 'style',    pattern: /\bvery\b/gi,    label: "prefers specific modifiers over 'very'", severity: 'warn' },
];

// Preflight is computed live from agent + account + active runs in
// computePreflight(); these fallback buckets are intentionally empty.
WF.preflight = { green: [], authoring: [], pausedError: [] };

// Workflow math is computed live in computeMath(); fallback is em-dash.
WF.math = {
  perProspect: '—',
  campaign: '—',     campaignDetail: '',
  load: '—',         loadDetail: '',
  replies: '—',      replyDetail: '',
};

// Targeting panel side-data — empty until backed by real prospect-score data.
WF.targeting = {
  estimated: 0,
  meanScore: 0,
  breakdown: [],
  histogram: [],
  exclusions: [],
  pastSimilar: [],
};

// Simulation heatmap — empty until a real working-hours + quota simulator
// lands. Consumer renders an empty state when this is [].
WF.simulate = [];

Object.assign(window, { WF });
