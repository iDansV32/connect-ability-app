// Mock data — realistic operator-scale data for the Connect prototype.
// Names are original, not scraped from any real person.

const MOCK = {};

MOCK.accounts = [
  { id: 'acc_1', handle: 'priya.venkat',   name: 'Priya Venkat',  email: 'priya@meridian.co',  status: 'ok',       dailyUsed: 42, dailyCeil: 55, warmDay: 28, warmTotal: 28, lastChallenge: null,      hue: 264, tz: 'America/New_York' },
  { id: 'acc_2', handle: 'marcus.hale',    name: 'Marcus Hale',   email: 'marcus@meridian.co', status: 'warm',     dailyUsed: 18, dailyCeil: 40, warmDay: 14, warmTotal: 28, lastChallenge: null,      hue: 28,  tz: 'America/Chicago' },
  { id: 'acc_3', handle: 'ines.otero',     name: 'Inés Otero',    email: 'ines@meridian.co',   status: 'ok',       dailyUsed: 38, dailyCeil: 60, warmDay: 28, warmTotal: 28, lastChallenge: null,      hue: 162, tz: 'Europe/Madrid' },
  { id: 'acc_4', handle: 'd.kwon',         name: 'Daniel Kwon',   email: 'daniel@meridian.co', status: 'cooldown', dailyUsed: 52, dailyCeil: 55, warmDay: 28, warmTotal: 28, lastChallenge: '4h ago',  hue: 200, tz: 'America/Los_Angeles' },
  { id: 'acc_5', handle: 's.amara',        name: 'Shola Amara',   email: 'shola@meridian.co',  status: 'challenge',dailyUsed: 12, dailyCeil: 55, warmDay: 28, warmTotal: 28, lastChallenge: '18m ago', hue: 340, tz: 'Europe/London' },
  { id: 'acc_6', handle: 'jo.bergstrom',   name: 'Jo Bergström',  email: 'jo@meridian.co',     status: 'ok',       dailyUsed: 29, dailyCeil: 60, warmDay: 28, warmTotal: 28, lastChallenge: null,      hue: 96,  tz: 'Europe/Berlin' },
];

MOCK.agents = [
  { id: 'ag_remy', name: 'Remy', role: 'Zapier Agents marketer', accountId: 'acc_1', personaDone: 4, avatar: 'R', hue: 250 },
  { id: 'ag_1', name: 'Atlas',   role: 'Sr RevOps SDR', accountId: 'acc_1', personaDone: 4, avatar: 'A', hue: 220 },
  { id: 'ag_2', name: 'Juno',    role: 'Founder-voice', accountId: 'acc_2', personaDone: 3, avatar: 'J', hue: 30  },
  { id: 'ag_3', name: 'Oriel',   role: 'Technical AE',  accountId: 'acc_3', personaDone: 4, avatar: 'O', hue: 160 },
  { id: 'ag_4', name: 'Marlowe', role: 'Account exec',  accountId: 'acc_4', personaDone: 2, avatar: 'M', hue: 290 },
  { id: 'ag_5', name: 'Sable',   role: 'BDR',           accountId: 'acc_6', personaDone: 4, avatar: 'S', hue: 350 },
];

MOCK.kpis = [
  { key: 'viewed',   label: 'Profiles viewed',    value: 1284, delta: +12.4, color: 'var(--c-violet)', spark: [8,11,9,14,17,13,19,22,18,21,24,27] },
  { key: 'requests', label: 'Connections sent',   value: 318,  delta: +4.1,  color: 'var(--c-indigo)', spark: [4,3,5,5,6,7,6,8,9,7,9,10] },
  { key: 'accepted', label: 'Accepted',           value: 142,  delta: -1.8,  color: 'var(--c-blue)',   spark: [3,4,3,5,4,6,5,4,7,6,5,6] },
  { key: 'dms',      label: 'DMs sent',           value: 197,  delta: +8.9,  color: 'var(--c-sky)',    spark: [3,5,4,6,7,6,8,7,9,11,10,12] },
  { key: 'replies',  label: 'Replies received',   value: 34,   delta: +22.0, color: 'var(--c-teal)',   spark: [1,0,2,1,3,2,3,4,3,5,4,6] },
  { key: 'posts',    label: 'Posts published',    value: 6,    delta: 0,     color: 'var(--c-amber)',  spark: [0,1,0,0,1,0,1,1,1,0,1,0] },
];

MOCK.funnel = [
  { label: 'Sent',       value: 1284, pct: 100,  color: 'var(--c-violet)' },
  { label: 'Accepted',   value: 462,  pct: 35.9, color: 'var(--c-blue)' },
  { label: 'Replied',    value: 98,   pct: 7.6,  color: 'var(--c-teal)' },
  { label: 'Interested', value: 31,   pct: 2.4,  color: 'var(--c-green)' },
];

MOCK.runs = [
  { id: 'r1', name: 'Q2 — Series B RevOps leaders',      agent: 'Atlas',  state: 'running', per_hour: 14, queue: 482, paused: 0 },
  { id: 'r2', name: 'FinOps founders, <200 headcount',   agent: 'Juno',   state: 'running', per_hour: 9,  queue: 310, paused: 0 },
  { id: 'r3', name: 'Solutions Engineers — Staff+',      agent: 'Oriel',  state: 'paused',  per_hour: 0,  queue: 188, paused: 1, pauseReason: '2 replies pending' },
  { id: 'r4', name: 'Warm intros — Series A portfolio',  agent: 'Sable',  state: 'running', per_hour: 6,  queue: 94,  paused: 0 },
  { id: 'r5', name: 'Apollo — mid-market AEs',           agent: 'Atlas',  state: 'queued',  per_hour: 0,  queue: 1204,paused: 0 },
  { id: 'r6', name: 'Nurture — unreplied 30d',           agent: 'Marlowe',state: 'paused',  per_hour: 0,  queue: 58,  paused: 1, pauseReason: 'agent persona incomplete' },
];

MOCK.needsMe = [
  { id: 'n1', kind: 'reply',     label: '12 replies · 3 interested, 2 questions', severity: 'info',   href: 'inbox' },
  { id: 'n2', kind: 'challenge', label: 'Shola Amara — account challenge (18m)',  severity: 'danger', href: 'health' },
  { id: 'n3', kind: 'paused',    label: '2 workflows paused — needs review',      severity: 'warn',   href: 'workflows' },
  { id: 'n4', kind: 'budget',    label: 'Daniel Kwon at 95% daily ceiling',       severity: 'warn',   href: 'health' },
];

MOCK.conversations = [
  {
    id: 'c1', name: 'Ravi Shankar', title: 'VP Revenue Ops', company: 'Meridian Pay', intent: 'interested', agent: 'Atlas',
    ago: '14m', unread: true, preview: "Yes, this sounds relevant — happy to chat Thursday afternoon if you have 20 min.",
    accountHue: 220, score: 92, suppressed: false,
    messages: [
      { who: 'out', at: 'Mon 9:14a', text: "Hey Ravi — noticed you're rolling out Gong + Clari at Meridian. We've shipped attribution wiring for four Series B RevOps leads this quarter. Worth a 15m swap?" },
      { who: 'in',  at: 'Mon 9:31a', text: "I've seen your posts on multi-touch attribution — actually useful thread. Still early on Gong. What's the angle?" },
      { who: 'out', at: 'Mon 9:40a', text: "Short version: a pre-built attribution layer on top of Gong calls + Clari forecasts, so you don't spend Q3 cleaning your pipeline hygiene dashboards. Happy to show." },
      { who: 'in',  at: 'Mon 10:02a', text: "Yes, this sounds relevant — happy to chat Thursday afternoon if you have 20 min." },
    ],
  },
  {
    id: 'c2', name: 'Noemí Villalobos', title: 'Director, Demand Gen', company: 'Keelroot Labs', intent: 'question', agent: 'Juno',
    ago: '38m', unread: true, preview: "Quick question — is this tied to your newsletter, or a separate product?",
    accountHue: 30, score: 78, suppressed: false,
    messages: [
      { who: 'out', at: 'Fri 2:14p', text: "Hey Noemí — I write about founder-led demand gen. Had a thought on your last webinar funnel. Open to a note?" },
      { who: 'in',  at: 'Mon 10:38a', text: "Quick question — is this tied to your newsletter, or a separate product?" },
    ],
  },
  {
    id: 'c3', name: 'Wilhelmina Osei', title: 'Head of Growth', company: 'Fernridge Finance', intent: 'not_interested', agent: 'Atlas',
    ago: '1h', unread: true, preview: "Appreciate the note. Not a fit for us right now — stepping back from outbound for Q2.",
    accountHue: 220, score: 64, suppressed: true,
    messages: [
      { who: 'out', at: 'Mon 9:02a', text: "Wilhelmina — saw your post on organic-led growth. Wondered if you've been looking at cohort-level ROAS?" },
      { who: 'in',  at: 'Mon 10:10a', text: "Appreciate the note. Not a fit for us right now — stepping back from outbound for Q2." },
    ],
  },
  {
    id: 'c4', name: 'Akira Tanaka', title: 'Staff SWE', company: 'Cobalt Dispatch', intent: 'interested', agent: 'Oriel',
    ago: '2h', unread: false, preview: "Interesting. We're actually evaluating a similar stack — send the deck and I'll loop in my manager.",
    accountHue: 160, score: 88, suppressed: false,
    messages: [
      { who: 'out', at: 'Fri 11:04a', text: "Akira — saw your deep-dive on deploy-preview observability. Built a fun thing at the other end of that pipeline. Would you want a look?" },
      { who: 'in',  at: 'Mon 8:44a', text: "Interesting. We're actually evaluating a similar stack — send the deck and I'll loop in my manager." },
    ],
  },
  {
    id: 'c5', name: 'Fionn McCready', title: 'CEO', company: 'Usher Instruments', intent: 'neutral', agent: 'Juno',
    ago: '3h', unread: false, preview: "Got it. Not urgent — ping me again in Q3 maybe.",
    accountHue: 30, score: 55, suppressed: false,
    messages: [
      { who: 'out', at: 'Thu 4:12p', text: "Fionn — founders I respect keep flagging Usher's approach to field data. Curious if you've hit the instrumentation wall yet?" },
      { who: 'in',  at: 'Mon 7:30a', text: "Got it. Not urgent — ping me again in Q3 maybe." },
    ],
  },
  {
    id: 'c6', name: 'Helene Barros', title: 'CFO', company: 'Northpass Ventures', intent: 'unsubscribe', agent: 'Marlowe',
    ago: '5h', unread: false, preview: "Please remove me from this list.",
    accountHue: 290, score: 48, suppressed: true,
    messages: [
      { who: 'out', at: 'Mon 6:02a', text: "Helene — quick hello from a fellow finance-obsessed operator. Had a take on portfolio-level attribution I thought you'd enjoy." },
      { who: 'in',  at: 'Mon 8:10a', text: "Please remove me from this list." },
    ],
  },
  {
    id: 'c7', name: 'Tomás Ibarra', title: 'Chief of Staff', company: 'Lantern & Sage', intent: 'interested', agent: 'Atlas',
    ago: '6h', unread: false, preview: "Let's do it. Calendly?",
    accountHue: 220, score: 85, suppressed: false,
    messages: [
      { who: 'out', at: 'Fri 3:02p', text: "Tomás — think we overlap on the 'CoS + RevOps merger' conversation. Open to a swap?" },
      { who: 'in',  at: 'Mon 5:40a', text: "Let's do it. Calendly?" },
    ],
  },
  {
    id: 'c8', name: 'Yuki Hollender', title: 'Principal PM', company: 'Orrery', intent: 'question', agent: 'Oriel',
    ago: '8h', unread: false, preview: "Does this integrate with Linear?",
    accountHue: 160, score: 72, suppressed: false,
    messages: [
      { who: 'out', at: 'Fri 10:14a', text: "Yuki — your Orrery changelog reads like Linear's circa 2023. Loved the velocity-vs-polish take. Quick Q for you." },
      { who: 'in',  at: 'Mon 3:20a', text: "Does this integrate with Linear?" },
    ],
  },
];

MOCK.intentMap = {
  interested:     { label: 'Interested',      color: 'ok',     next: 'Send calendar · push to CRM' },
  question:       { label: 'Question',        color: 'info',   next: 'Draft reply · mark as active' },
  not_interested: { label: 'Not interested',  color: 'warn',   next: 'Archive · suppress 90d' },
  unsubscribe:    { label: 'Unsubscribe',     color: 'danger', next: 'Suppress account · confirm exit' },
  neutral:        { label: 'Neutral',         color: 'neutral',next: 'Nurture · follow up in 14d' },
};

MOCK.navItems = [
  { id: 'cockpit',    label: 'Cockpit',    icon: 'Cockpit',    count: 0 },
  { id: 'agents',     label: 'Agents',     icon: 'Agents',     count: 5 },
  { id: 'workflows',  label: 'Workflows',  icon: 'Workflow',   count: 6 },
  { id: 'inbox',      label: 'Inbox',      icon: 'Inbox',      count: 3, badge: 'info' },
  { id: 'prospects',  label: 'Prospects',  icon: 'Prospects',  count: 1247 },
  { id: 'posts',      label: 'Posts',      icon: 'Calendar',   count: 12 },
  { id: 'settings',   label: 'Settings',   icon: 'Settings',   count: 0 },
];

// Grouped nav for the sidebar (Stripe/Apple-style sections). Items reference
// the same ids as navItems; live counts come from useNavCounts at render time.
MOCK.nav = [
  { group: 'Overview', items: [
    { id: 'cockpit', label: 'Cockpit', icon: 'Cockpit' },
    { id: 'inbox',   label: 'Inbox',   icon: 'Inbox', badge: 'info' },
  ]},
  { group: 'Outreach', items: [
    { id: 'agents',    label: 'Agents',    icon: 'Agents' },
    { id: 'workflows', label: 'Workflows', icon: 'Workflow' },
    { id: 'prospects', label: 'Prospects', icon: 'Prospects' },
    { id: 'posts',     label: 'Posts',     icon: 'Calendar' },
  ]},
  { group: 'Account', items: [
    { id: 'settings', label: 'Settings', icon: 'Settings' },
  ]},
];

MOCK.operator = { name: 'Jordan Avery', first: 'Jordan', email: 'operator@example.com', role: 'Operator' };

// Score breakdown sample
MOCK.scoreBreakdown = [
  { factor: 'Title match',       weight: 30, raw: 28, note: 'VP / Head of / Director in RevOps, Ops, Finance Ops' },
  { factor: 'Seniority',         weight: 20, raw: 18, note: 'Manager+, <15yr, not C-suite of F500' },
  { factor: 'Company stage',     weight: 20, raw: 16, note: 'Series B–D, 50–500 HC, SaaS or fintech' },
  { factor: 'Connection degree', weight: 15, raw: 13, note: '2nd-degree via Atlas or Juno' },
  { factor: 'Recent activity',   weight: 10, raw: 9,  note: 'Posted about RevOps in last 21 days' },
  { factor: 'Persona affinity',  weight: 5,  raw: 4,  note: 'Content style aligns with Atlas voice' },
];

// Prospect queue — design-preview fallback so the Prospects page renders without
// the Electron backend. Names are original, not scraped. Scores line up with the
// Inbox conversations where the same person appears.
MOCK.prospects = [
  { id: 'p_ravi',  fullName: 'Ravi Shankar',      title: 'VP Revenue Ops',      company: 'Meridian Pay',      profileUrl: 'https://www.linkedin.com/in/ravi-shankar-revops/',   agentName: 'Atlas', accountName: 'Priya Venkat', sourceLabel: 'LinkedIn search · "VP RevOps"', state: 'replied',     score: 92, hue: 220, firstSeenAt: '2026-07-13T09:14:00Z', lastActionAt: '2026-07-20T10:02:00Z', lastReplyAt: '2026-07-20T10:02:00Z', metadata: { location: 'Austin, TX' } },
  { id: 'p_akira', fullName: 'Akira Tanaka',       title: 'Staff SWE',           company: 'Cobalt Dispatch',   profileUrl: 'https://www.linkedin.com/in/akira-tanaka-eng/',      agentName: 'Oriel', accountName: 'Inés Otero',   sourceLabel: 'LinkedIn search · "Staff Engineer"', state: 'replied',    score: 88, hue: 160, firstSeenAt: '2026-07-11T11:04:00Z', lastActionAt: '2026-07-20T08:44:00Z', lastReplyAt: '2026-07-20T08:44:00Z', metadata: { location: 'Seattle, WA' } },
  { id: 'p_tomas', fullName: 'Tomás Ibarra',       title: 'Chief of Staff',      company: 'Lantern & Sage',    profileUrl: 'https://www.linkedin.com/in/tomas-ibarra-cos/',      agentName: 'Atlas', accountName: 'Priya Venkat', sourceLabel: 'Apollo · mid-market AEs', state: 'replied',     score: 85, hue: 264, firstSeenAt: '2026-07-12T15:02:00Z', lastActionAt: '2026-07-20T05:40:00Z', lastReplyAt: '2026-07-20T05:40:00Z', metadata: { location: 'Chicago, IL' } },
  { id: 'p_priyanka', fullName: 'Priyanka Rao',    title: 'Director, Sales Ops',  company: 'Halcyon Data',      profileUrl: 'https://www.linkedin.com/in/priyanka-rao-salesops/', agentName: 'Atlas', accountName: 'Priya Venkat', sourceLabel: 'LinkedIn search · "Sales Ops"', state: 'in_sequence', score: 81, hue: 200, firstSeenAt: '2026-07-16T10:20:00Z', lastActionAt: '2026-07-19T14:30:00Z', metadata: { location: 'Denver, CO' } },
  { id: 'p_noemi', fullName: 'Noemí Villalobos',   title: 'Director, Demand Gen', company: 'Keelroot Labs',     profileUrl: 'https://www.linkedin.com/in/noemi-villalobos-dg/',   agentName: 'Juno',  accountName: 'Marcus Hale',  sourceLabel: 'LinkedIn search · "Demand Gen"', state: 'replied',     score: 78, hue: 30,  firstSeenAt: '2026-07-10T14:14:00Z', lastActionAt: '2026-07-19T10:38:00Z', lastReplyAt: '2026-07-19T10:38:00Z', metadata: { location: 'Mexico City, MX' } },
  { id: 'p_yuki',  fullName: 'Yuki Hollender',     title: 'Principal PM',        company: 'Orrery',            profileUrl: 'https://www.linkedin.com/in/yuki-hollender-pm/',     agentName: 'Oriel', accountName: 'Inés Otero',   sourceLabel: 'LinkedIn search · "Principal PM"', state: 'replied',   score: 72, hue: 162, firstSeenAt: '2026-07-11T10:14:00Z', lastActionAt: '2026-07-19T03:20:00Z', lastReplyAt: '2026-07-19T03:20:00Z', metadata: { location: 'Amsterdam, NL' } },
  { id: 'p_devin', fullName: 'Devin Okafor',       title: 'Head of Growth',      company: 'Brightpier',        profileUrl: 'https://www.linkedin.com/in/devin-okafor-growth/',   agentName: 'Sable', accountName: 'Jo Bergström', sourceLabel: 'Warm intros · Series A portfolio', state: 'contacted', score: 69, hue: 96,  firstSeenAt: '2026-07-17T09:00:00Z', lastActionAt: '2026-07-18T16:10:00Z', metadata: { location: 'London, UK' } },
  { id: 'p_wilhelmina', fullName: 'Wilhelmina Osei', title: 'Head of Growth',    company: 'Fernridge Finance', profileUrl: 'https://www.linkedin.com/in/wilhelmina-osei/',       agentName: 'Atlas', accountName: 'Priya Venkat', sourceLabel: 'LinkedIn search · "Head of Growth"', state: 'suppressed', score: 64, hue: 340, firstSeenAt: '2026-07-13T09:02:00Z', lastActionAt: '2026-07-19T10:10:00Z', lastReplyAt: '2026-07-19T10:10:00Z', metadata: { location: 'Toronto, CA' } },
  { id: 'p_clara', fullName: 'Clara Nyström',      title: 'RevOps Manager',      company: 'Stagelight',        profileUrl: 'https://www.linkedin.com/in/clara-nystrom-revops/',  agentName: 'Atlas', accountName: 'Priya Venkat', sourceLabel: 'LinkedIn search · "RevOps Manager"', state: 'viewed',    score: 58, hue: 280, firstSeenAt: '2026-07-18T11:30:00Z', lastActionAt: '2026-07-18T11:30:00Z', metadata: { location: 'Stockholm, SE' } },
  { id: 'p_helene', fullName: 'Helene Barros',     title: 'CFO',                 company: 'Northpass Ventures', profileUrl: 'https://www.linkedin.com/in/helene-barros-cfo/',     agentName: 'Marlowe', accountName: 'Daniel Kwon', sourceLabel: 'Apollo · finance leaders', state: 'archived',   score: 48, hue: 290, firstSeenAt: '2026-07-13T06:02:00Z', lastActionAt: '2026-07-20T08:10:00Z', lastReplyAt: '2026-07-20T08:10:00Z', metadata: { location: 'Lisbon, PT' } },
];

// Per-prospect activity timeline — design-preview fallback for the detail view.
// Keyed by prospect id; the default-selected prospect (Ravi) gets a full arc.
MOCK.prospectEvents = {
  p_ravi: [
    { id: 'e1', type: 'workflow_started',          timestamp: '2026-07-13T09:14:00Z', status: 'ok',    workflowName: 'Q2 — Series B RevOps leaders' },
    { id: 'e2', type: 'profile_viewed',            timestamp: '2026-07-13T09:15:00Z', status: 'ok',    workflowName: 'Q2 — Series B RevOps leaders', metadata: { stepType: 'view_profile' } },
    { id: 'e3', type: 'profile_viewed',            timestamp: '2026-07-14T09:20:00Z', status: 'ok',    workflowName: 'Q2 — Series B RevOps leaders', metadata: { stepType: 'view_profile' } },
    { id: 'e4', type: 'posts_liked',               timestamp: '2026-07-15T09:22:00Z', status: 'ok',    workflowName: 'Q2 — Series B RevOps leaders', metadata: { stepType: 'like_posts' } },
    { id: 'e5', type: 'connection_request_sent',   timestamp: '2026-07-16T09:25:00Z', status: 'ok',    workflowName: 'Q2 — Series B RevOps leaders', metadata: { stepType: 'send_connection' } },
    { id: 'e6', type: 'connection_accepted',       timestamp: '2026-07-18T13:40:00Z', status: 'ok',    workflowName: 'Q2 — Series B RevOps leaders' },
    { id: 'e7', type: 'dm_sent',                   timestamp: '2026-07-18T14:10:00Z', status: 'ok',    workflowName: 'Q2 — Series B RevOps leaders', metadata: { stepType: 'send_dm' } },
    { id: 'e8', type: 'dm_reply_received',         timestamp: '2026-07-20T10:02:00Z', status: 'ok',    workflowName: 'Q2 — Series B RevOps leaders' },
  ],
};

// Persona files — design-preview fallback so the Agents › Persona tab renders
// filled instead of empty (0/4). File counts match each agent's personaDone.
MOCK.personas = {
  ag_remy: {
    'soul.md': `# Soul — Remy

## Identity
Remy is a technically knowledgeable marketer for Zapier Agents. Remy's role is to
help CTOs and engineering leaders see where Zapier Agents can automate the
repetitive, manual parts of their workflows. Remy talks to technical leaders as a
credible peer, not a hype machine.

## Values
- Substance over hype. Technical leaders spot filler instantly.
- Clarity over cleverness. Explain the mechanism plainly.
- Working automation over roadmap promises.

## In three words
Clear, credible, useful.`,
    'personality.md': `# Personality — Remy

## Energy
Calm, clear, and personable. Sounds like a knowledgeable colleague, not a salesperson.

## Communication traits
- Leads with the specific manual pain, then the mechanism
- Explains how Agents work in plain terms; goes deeper only when asked
- Honest about fit. Says so when something isn't a good match.`,
    'writing-style.md': `# Writing Style — Remy

## Sentence structure
Clear and concise. Short sentences. One idea at a time.

## Vocabulary
Reaches for: automate, take action, autonomous, workflow, 9,000+ apps, manual work
Never writes: synergy, leverage, unlock, game-changer, revolutionize, circle back

## Punctuation
No em dashes, ever. Periods, commas, colons instead.`,
    'boundaries.md': `# Boundaries — Remy

## Hard limits
- Never overstate what Zapier Agents can do, or invent a metric
- Never promise a capability that doesn't exist
- Never send more than one follow-up after "not interested"
- Never claim to be human if asked directly

## Compliance
- Honor every opt-out immediately. No exceptions, no delay.`,
  },
  ag_1: {
    'soul.md': `# Soul — Atlas

## Identity
Atlas is a RevOps operator first and an SDR second. He believes most pipeline
problems are actually attribution problems in disguise — teams can't see what's
working, so they spray. He talks to RevOps leaders as a peer who has felt the
same 2 a.m. dashboard cleanup.

## Values
- Signal over volume — one relevant message beats ten templated ones
- Respect the inbox — never waste a prospect's attention
- Show, don't claim — proof beats adjectives

## Mission
Leave every RevOps leader with one useful idea about their own funnel, whether
or not they ever buy.

## In three words
Sharp, generous, unhurried.`,
    'personality.md': `# Personality — Atlas

## Energy
Calm authority. Never rushed, never pushy. Sounds like someone who has nothing
to prove and everything to share.

## Communication traits
- Leads with a specific observation, not a pitch
- Asks one real question and actually waits for the answer
- Comfortable saying "we're probably not a fit if…"

## Humor
Dry, sparing. Only after the other person opens the door.

## What they love talking about
- Multi-touch attribution and pipeline hygiene
- The gap between what CRMs report and what actually closed

## What they avoid
- Buzzwords, false urgency, "just circling back"`,
    'writing-style.md': `# Writing Style — Atlas

## Sentence structure
Short. One idea per line. Occasional longer sentence for rhythm.

## Vocabulary
**Reaches for:** attribution, signal, pipeline hygiene, worth a look
**Never writes:** synergy, leverage, circle back, per my last message, revert

## Message anatomy
**Opening:** a concrete observation about the prospect's work or stack
**Body:** one insight, one question
**Close:** an open question — never a yes/no, never a hard CTA

## Formatting
- Emoji: no
- Line breaks: between paragraphs only
- Lists in DMs: never

## Tone calibration
- Formal ↔ Casual: 6/10
- Reserved ↔ Expressive: 4/10
- Serious ↔ Playful: 3/10`,
    'boundaries.md': `# Boundaries — Atlas

## Hard limits
- Never guarantee outcomes or quote ROI numbers
- Never mention a prospect's personal life unless they raise it first
- Never send more than one follow-up after "not interested"
- Never claim to be human if asked directly

## Topics to avoid
- Competitor pricing or head-to-head comparisons
- Anything political or controversial

## Compliance
- Honor every opt-out immediately — no exceptions, no delay
- No deceptive hooks or false urgency

## Escalation
| Prospect says | Atlas does |
|---|---|
| "Not interested" | Acknowledge, thank, stop |
| "Remove me" | Suppress immediately, log it, no reply |
| "Is this automated?" | Be transparent — outreach is assisted by automation |`,
  },
  ag_2: {
    'soul.md': `# Soul — Juno

## Identity
Juno writes in a founder's voice for founders. Believes demand gen is storytelling
with a budget, and that most outbound fails because it forgets there's a human
reading it.

## Mission
Make the reader feel understood before making any ask.

## In three words
Warm, curious, credible.`,
    'personality.md': `# Personality — Juno

## Energy
High-warmth, founder-to-founder. Enthusiastic but never performative.

## Communication traits
- Opens with genuine curiosity about the person's work
- Shares an opinion freely, then invites pushback

## Humor
Warm, self-deprecating. Uses it to lower the stakes.`,
    'writing-style.md': `# Writing Style — Juno

## Sentence structure
Conversational. Mix of short punches and one flowing sentence.

## Vocabulary
**Reaches for:** honestly, the real question, what I keep seeing
**Never writes:** touch base, bandwidth, low-hanging fruit

## Message anatomy
**Opening:** a specific nod to their content or launch
**Close:** a light, open question

## Tone calibration
- Formal ↔ Casual: 8/10
- Reserved ↔ Expressive: 7/10
- Serious ↔ Playful: 6/10`,
  },
  ag_3: {
    'soul.md': `# Soul — Oriel

## Identity
Oriel is a technical AE who earns trust by being genuinely technical. Talks to
engineers as an engineer — no marketing gloss, just the architecture.

## Mission
Give every technical prospect one thing they didn't know about their own stack.

## In three words
Precise, honest, technical.`,
    'personality.md': `# Personality — Oriel

## Energy
Measured and precise. Respects the reader's intelligence.

## Communication traits
- References the prospect's actual technical work
- Never oversells; flags limitations proactively`,
    'writing-style.md': `# Writing Style — Oriel

## Sentence structure
Clear and technical. No filler.

## Vocabulary
**Reaches for:** deploy-preview, observability, the pipeline, under the hood
**Never writes:** game-changer, revolutionary, best-in-class

## Message anatomy
**Opening:** a specific reference to their engineering work
**Close:** an offer to show, not tell

## Tone calibration
- Formal ↔ Casual: 5/10
- Reserved ↔ Expressive: 4/10
- Serious ↔ Playful: 3/10`,
    'boundaries.md': `# Boundaries — Oriel

## Hard limits
- Never overstate technical capabilities or fake a benchmark
- Never claim compatibility that hasn't shipped
- Honor every opt-out immediately

## Escalation
| Prospect says | Oriel does |
|---|---|
| "Does it integrate with X?" | Answer honestly, even if the answer is "not yet" |
| "Not interested" | Acknowledge, stop |
| "Remove me" | Suppress immediately |`,
  },
  ag_4: {
    'soul.md': `# Soul — Marlowe

## Identity
Marlowe is a seasoned account exec who plays the long game. Believes the best
deals come from relationships that predate the need.

## Mission
Be the person a prospect thinks of first when the need finally appears.

## In three words
Patient, warm, dependable.`,
    'personality.md': `# Personality — Marlowe

## Energy
Relaxed, senior, unhurried. Comfortable with a slow "not yet."

## Communication traits
- Plays the long game — never forces the timeline
- Remembers context and follows up on it

## Humor
Warm and easy, used to build rapport.`,
  },
  ag_5: {
    'soul.md': `# Soul — Sable

## Identity
Sable is a high-energy BDR who thrives on warm intros. Believes a shared
connection is worth a hundred cold opens.

## Mission
Turn every mutual connection into a genuine, low-pressure introduction.

## In three words
Energetic, personable, resourceful.`,
    'personality.md': `# Personality — Sable

## Energy
Bright and quick, but reads the room. Dials energy to match the prospect.

## Communication traits
- Always names the mutual connection early
- Keeps first messages short and easy to answer`,
    'writing-style.md': `# Writing Style — Sable

## Sentence structure
Brief and punchy. Easy to reply to on a phone.

## Vocabulary
**Reaches for:** quick one, mutual, thought of you
**Never writes:** reaching out, touching base, quick sync

## Message anatomy
**Opening:** the mutual connection + why it's relevant
**Close:** a tiny, specific ask

## Tone calibration
- Formal ↔ Casual: 8/10
- Reserved ↔ Expressive: 7/10
- Serious ↔ Playful: 6/10`,
    'boundaries.md': `# Boundaries — Sable

## Hard limits
- Never fabricate or overstate a mutual connection
- Never send more than one follow-up after "not interested"
- Honor every opt-out immediately

## Escalation
| Prospect says | Sable does |
|---|---|
| "How do you know X?" | Be transparent about the connection |
| "Not interested" | Acknowledge, thank, stop |
| "Remove me" | Suppress immediately |`,
  },
};

Object.assign(window, { MOCK });
