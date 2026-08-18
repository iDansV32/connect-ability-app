// Mock data — realistic operator-scale data for the Connect prototype.
// Names are original, not scraped from any real person.

const MOCK = {};

MOCK.accounts = [
  { id: 'acc_1', handle: 'priya.venkat',   name: 'Priya Venkat',       status: 'ok',       dailyUsed: 42, dailyCeil: 55, warmDay: 28, warmTotal: 28, lastChallenge: null },
  { id: 'acc_2', handle: 'marcus.hale',    name: 'Marcus Hale',        status: 'warm',     dailyUsed: 18, dailyCeil: 40, warmDay: 14, warmTotal: 28, lastChallenge: null },
  { id: 'acc_3', handle: 'ines.otero',     name: 'Inés Otero',         status: 'ok',       dailyUsed: 38, dailyCeil: 60, warmDay: 28, warmTotal: 28, lastChallenge: null },
  { id: 'acc_4', handle: 'd.kwon',         name: 'Daniel Kwon',        status: 'cooldown', dailyUsed: 52, dailyCeil: 55, warmDay: 28, warmTotal: 28, lastChallenge: '4h ago' },
  { id: 'acc_5', handle: 's.amara',        name: 'Shola Amara',        status: 'challenge',dailyUsed: 12, dailyCeil: 55, warmDay: 28, warmTotal: 28, lastChallenge: '18m ago' },
  { id: 'acc_6', handle: 'jo.bergstrom',   name: 'Jo Bergström',       status: 'ok',       dailyUsed: 29, dailyCeil: 60, warmDay: 28, warmTotal: 28, lastChallenge: null },
];

MOCK.agents = [
  { id: 'ag_1', name: 'Atlas',   role: 'Sr RevOps SDR', accountId: 'acc_1', personaDone: 4, avatar: 'A', hue: 220 },
  { id: 'ag_2', name: 'Juno',    role: 'Founder-voice', accountId: 'acc_2', personaDone: 3, avatar: 'J', hue: 30  },
  { id: 'ag_3', name: 'Oriel',   role: 'Technical AE',  accountId: 'acc_3', personaDone: 4, avatar: 'O', hue: 160 },
  { id: 'ag_4', name: 'Marlowe', role: 'Account exec',  accountId: 'acc_4', personaDone: 2, avatar: 'M', hue: 290 },
  { id: 'ag_5', name: 'Sable',   role: 'BDR',           accountId: 'acc_6', personaDone: 4, avatar: 'S', hue: 350 },
];

MOCK.kpis = [
  { key: 'viewed',   label: 'Profiles viewed',    value: 1284, delta: +12.4, spark: [8,11,9,14,17,13,19,22,18,21,24,27] },
  { key: 'requests', label: 'Connections sent',   value: 318,  delta: +4.1,  spark: [4,3,5,5,6,7,6,8,9,7,9,10] },
  { key: 'accepted', label: 'Accepted',           value: 142,  delta: -1.8,  spark: [3,4,3,5,4,6,5,4,7,6,5,6] },
  { key: 'dms',      label: 'DMs sent',           value: 197,  delta: +8.9,  spark: [3,5,4,6,7,6,8,7,9,11,10,12] },
  { key: 'replies',  label: 'Replies received',   value: 34,   delta: +22.0, spark: [1,0,2,1,3,2,3,4,3,5,4,6] },
  { key: 'posts',    label: 'Posts published',    value: 6,    delta: 0,     spark: [0,1,0,0,1,0,1,1,1,0,1,0] },
];

MOCK.funnel = [
  { label: 'Sent',       value: 1284, pct: 100 },
  { label: 'Accepted',   value: 462,  pct: 35.9 },
  { label: 'Replied',    value: 98,   pct: 7.6 },
  { label: 'Interested', value: 31,   pct: 2.4 },
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
  { id: 'health',     label: 'Account health', icon: 'Health', count: 6, badge: 'danger' },
  { id: 'apollo',     label: 'Apollo sync', icon: 'Apollo',    count: 0 },
  { id: 'analytics',  label: 'Analytics',  icon: 'Analytics',  count: 0 },
  { id: 'settings',   label: 'Settings',   icon: 'Settings',   count: 0 },
];

// Score breakdown sample
MOCK.scoreBreakdown = [
  { factor: 'Title match',       weight: 30, raw: 28, note: 'VP / Head of / Director in RevOps, Ops, Finance Ops' },
  { factor: 'Seniority',         weight: 20, raw: 18, note: 'Manager+, <15yr, not C-suite of F500' },
  { factor: 'Company stage',     weight: 20, raw: 16, note: 'Series B–D, 50–500 HC, SaaS or fintech' },
  { factor: 'Connection degree', weight: 15, raw: 13, note: '2nd-degree via Atlas or Juno' },
  { factor: 'Recent activity',   weight: 10, raw: 9,  note: 'Posted about RevOps in last 21 days' },
  { factor: 'Persona affinity',  weight: 5,  raw: 4,  note: 'Content style aligns with Atlas voice' },
];

Object.assign(window, { MOCK });
