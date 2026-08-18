// Workflow Studio — mock data

const WF = {};

WF.stepTypes = {
  view_profile: { icon: 'Eye', label: 'View profile', summary: 'Visit profile, capture public headline' },
  like_posts: { icon: 'Star', label: 'Like posts', summary: 'Like N recent posts from prospect' },
  send_connection: { icon: 'Link', label: 'Send connection', summary: 'Send connection request with optional note' },
  send_dm: { icon: 'Send', label: 'Send DM', summary: 'Send direct message (requires accepted connection)' },
  check_connection_status: { icon: 'Check', label: 'Check status', summary: 'Poll for connection acceptance' },
};

// Outcome breakdown across the operator's last 100 runs of each step type
WF.outcomes = {
  view_profile:     { completed: 94, skipped_outside_working_hours: 3, skipped_budget_exceeded: 1, skipped_do_not_contact: 0, failed_transient: 2, failed_permanent: 0 },
  like_posts:       { completed: 88, skipped_outside_working_hours: 4, skipped_budget_exceeded: 2, skipped_do_not_contact: 1, failed_transient: 4, failed_permanent: 1 },
  send_connection:  { completed: 81, skipped_outside_working_hours: 5, skipped_budget_exceeded: 4, skipped_do_not_contact: 2, failed_transient: 6, failed_permanent: 2 },
  send_dm:          { completed: 74, skipped_outside_working_hours: 6, skipped_budget_exceeded: 5, skipped_do_not_contact: 3, failed_transient: 8, failed_permanent: 4 },
  check_connection_status: { completed: 98, skipped_outside_working_hours: 0, skipped_budget_exceeded: 0, skipped_do_not_contact: 0, failed_transient: 2, failed_permanent: 0 },
};

WF.defaultSequence = [
  { id: 's1', type: 'view_profile' },
  { id: 'd1', type: 'delay', hours: 24 },
  { id: 's2', type: 'view_profile' },
  { id: 'd2', type: 'delay', hours: 24 },
  { id: 's3', type: 'like_posts', count: 2, filter: 'recent' },
  { id: 'd3', type: 'delay', hours: 24 },
  { id: 's4', type: 'send_connection', withNote: true, note: "Hey {first_name}, {saw your post on {attribution|RevOps metrics}|loved your take on {pipeline hygiene|forecast accuracy}}. Would love to connect." },
  { id: 'd4', type: 'delay', hours: 48 },
  { id: 's5', type: 'send_dm', template: "Hey {first_name}, {Hi|Hey|Quick note —} thanks for connecting. Noticed you're {rolling out Gong|scaling your RevOps function} at {company} — we've shipped attribution wiring for four Series B RevOps leads this quarter. Worth a 15m swap?" },
];

// Persona rules (from the bound agent's writing-style.md + boundaries.md)
WF.personaRules = [
  { id: 'r1', kind: 'boundary', pattern: /leverage/gi,   label: "never writes 'leverage'",     severity: 'danger' },
  { id: 'r2', kind: 'boundary', pattern: /circle back/gi, label: "never writes 'circle back'",  severity: 'danger' },
  { id: 'r3', kind: 'style',    pattern: /!{2,}/g,        label: 'avoid double exclamation',    severity: 'warn' },
  { id: 'r4', kind: 'style',    pattern: /\bvery\b/gi,    label: "prefers specific modifiers over 'very'", severity: 'warn' },
];

WF.preflight = {
  green: [
    { cat: 'Agent',   label: 'Persona files complete',          detail: '4 of 4 · soul · personality · writing-style · boundaries', state: 'ok' },
    { cat: 'Agent',   label: 'Content pillars set',             detail: '3 pillars · RevOps, attribution, sales engineering',       state: 'ok' },
    { cat: 'Agent',   label: 'LinkedIn account bound',          detail: 'Atlas → Priya Venkat (@priya.venkat)',                     state: 'ok' },
    { cat: 'Account', label: 'Warm-up stage',                   detail: 'Day 28 of 28 · 100% envelope',                              state: 'ok' },
    { cat: 'Account', label: 'Daily budget',                    detail: '88 / 150 used · 62 remaining',                              state: 'ok' },
    { cat: 'Account', label: 'Working hours',                   detail: 'Active · Mon–Fri 9am–6pm PT',                               state: 'ok' },
    { cat: 'Account', label: 'Recent challenges',               detail: 'None in last 7 days',                                       state: 'ok' },
    { cat: 'Account', label: 'Transport health',                detail: 'Private API OK · DOM fallback OK',                          state: 'ok' },
  ],
  authoring: [
    { cat: 'Agent',   label: 'Persona files complete',          detail: '4 of 4',                                                    state: 'ok' },
    { cat: 'Agent',   label: 'LinkedIn account bound',          detail: 'Atlas → Priya Venkat',                                      state: 'ok' },
    { cat: 'Workflow',label: 'DM template passes persona lint', detail: '2 warnings · 1 boundary violation',                         state: 'warn', action: 'Jump to step 5' },
    { cat: 'Account', label: 'Warm-up stage',                   detail: 'Day 28 of 28 · 100% envelope',                              state: 'ok' },
    { cat: 'Account', label: 'Daily budget',                    detail: '88 / 150 used · 62 remaining',                              state: 'ok' },
    { cat: 'Account', label: 'Working hours',                   detail: 'Active · Mon–Fri 9am–6pm PT',                               state: 'ok' },
  ],
  pausedError: [
    { cat: 'Agent',   label: 'Persona files complete',          detail: '4 of 4',                                                    state: 'ok' },
    { cat: 'Account', label: 'Daily budget',                    detail: '150 / 150 exceeded',                                        state: 'danger', action: 'Wait for reset' },
    { cat: 'Account', label: 'Warm-up stage',                   detail: 'Day 14 of 28 · 60% envelope',                               state: 'ok' },
    { cat: 'Account', label: 'Working hours',                   detail: 'Active · Mon–Fri 9am–6pm PT',                               state: 'ok' },
  ],
};

WF.math = {
  perProspect: '6d 12h',
  campaign: '12 days',
  campaignDetail: 'to enroll all 847',
  load: '~73/day',
  loadDetail: 'fits budget · 50 headroom',
  replies: '~34',
  replyDetail: '4% avg reply rate · ±8',
};

// Targeting — saved lists
WF.targeting = {
  estimated: 847,
  meanScore: 62,
  breakdown: [
    { factor: 'Title match',       pct: 72 },
    { factor: 'Seniority',         pct: 68 },
    { factor: 'Company size',      pct: 58 },
    { factor: 'Connection degree', pct: 48 },
  ],
  histogram: [8, 12, 18, 32, 54, 98, 142, 186, 164, 94, 38], // 0-10, 10-20, ..., 90-100
  exclusions: [
    { label: 'Do not contact', count: 34 },
    { label: 'Already in sequence', count: 128 },
    { label: 'Recent DM <30d', count: 12 },
  ],
  pastSimilar: [4, 5, 4, 6, 7, 6, 8, 9, 8, 10, 11, 9],
};

// Simulation heatmap: 7 days × 24 hours. Values 0..1.
WF.simulate = (() => {
  const days = 7, hours = 24;
  const grid = [];
  for (let d = 0; d < days; d++) {
    const row = [];
    for (let h = 0; h < hours; h++) {
      const weekday = d < 5;
      const inHours = h >= 9 && h < 18;
      if (!weekday || !inHours) { row.push(0); continue; }
      // ramp mid-day, wobble with randomization
      const mid = 1 - Math.abs(h - 13.5) / 6;
      const jitter = Math.sin(d * 1.3 + h * 0.7) * 0.15 + Math.sin(h * 0.3 + d) * 0.1;
      row.push(Math.max(0, Math.min(1, mid * 0.85 + jitter + 0.15)));
    }
    grid.push(row);
  }
  return grid;
})();

Object.assign(window, { WF });
