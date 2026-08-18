const { createId } = require('./connect-documents');

const DEFAULT_PLAN_DAYS = 90;
const DEFAULT_POSTING_TIME = '09:00';
const THREE_PER_WEEK_DAYS = new Set([1, 3, 5]);
const CADENCE_RULES = new Set(['daily', 'weekdays', 'three_per_week']);
const CONTENT_ANGLES = [
  'insight',
  'mistake',
  'framework',
  'story',
  'trend',
  'checklist',
  'question'
];

function buildAgentContentPlan(agent, options = {}) {
  if (!agent || typeof agent !== 'object') {
    throw new Error('Agent is required to build a content plan');
  }

  const agentId = cleanSingleLine(agent.id, 160);
  if (!agentId) {
    throw new Error('Agent id is required to build a content plan');
  }

  const agentName = cleanSingleLine(agent.name, 160) || 'SDR Agent';
  const accountId = cleanSingleLine(agent.accountId, 160);
  if (!accountId) {
    throw new Error(`SDR agent "${agentName}" must be assigned to a LinkedIn account before generating a content plan`);
  }

  const now = new Date();
  const totalDays = normalizeInteger(options.days, 1, 90, DEFAULT_PLAN_DAYS);
  const cadence = normalizeCadence(options.cadence || agent.postCadence);
  const postingTime = normalizePostingTime(options.postingTime || agent.postingTime || DEFAULT_POSTING_TIME);
  const startDate = normalizeStartDate(options.startDate, now);
  const timezone = cleanSingleLine(options.timezone || agent.timezone, 80) || 'America/Chicago';
  const niche = cleanSingleLine(agent.niche, 240) || 'your market';

  const pillars = normalizeList(agent.contentPillars, 20, 120);
  const personas = normalizeList(agent.personaTitles, 30, 120);
  const keywords = normalizeList(agent.searchKeywords, 40, 120);
  const themes = buildThemePool({ niche, pillars, personas, keywords });
  const scheduledDates = buildScheduledDates({
    startDate,
    totalDays,
    cadence
  });

  const planId = createId('plan');
  const planName = `${agentName} ${totalDays}-day content plan`;
  const posts = scheduledDates.map((dateValue, index) => {
    const theme = themes[index % themes.length];
    const angle = CONTENT_ANGLES[index % CONTENT_ANGLES.length];
    const persona = personas[index % Math.max(personas.length, 1)] || '';
    const keyword = keywords[index % Math.max(keywords.length, 1)] || '';
    const pillar = theme.pillar || niche;
    const brief = buildBrief({ agentName, niche, theme, angle, persona, keyword });
    const content = buildDraftPost({ niche, theme, angle, persona, keyword });

    return {
      id: createId('post'),
      content,
      scheduledDate: formatDateOnly(dateValue),
      scheduledTime: postingTime,
      status: 'pending',
      createdAt: now.toISOString(),
      hashtags: buildHashtags({ niche, pillar, keyword, persona }),
      mentions: [],
      includeImage: false,
      imagePath: null,
      postType: 'text',
      visibility: 'public',
      accountId,
      accountName: cleanSingleLine(agent.accountName, 160) || null,
      agentId,
      agentName,
      sourceType: 'agent_plan',
      planId,
      planName,
      timezone,
      contentPillar: pillar,
      contentAngle: angle,
      contentTheme: theme.label,
      contentBrief: brief,
      contentDay: index + 1
    };
  });

  return {
    planId,
    planName,
    cadence,
    days: totalDays,
    startDate: formatDateOnly(startDate),
    postingTime,
    timezone,
    agentId,
    agentName,
    accountId,
    posts
  };
}

function buildScheduledDates({ startDate, totalDays, cadence }) {
  const dates = [];
  let cursor = new Date(`${formatDateOnly(startDate)}T12:00:00`);

  while (dates.length < totalDays) {
    if (shouldIncludeDate(cursor, cadence)) {
      dates.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function shouldIncludeDate(dateValue, cadence) {
  const weekday = dateValue.getDay();
  if (cadence === 'weekdays') {
    return weekday >= 1 && weekday <= 5;
  }
  if (cadence === 'three_per_week') {
    return THREE_PER_WEEK_DAYS.has(weekday);
  }
  return true;
}

function buildThemePool({ niche, pillars, personas, keywords }) {
  const baseThemes = [];
  const pillarList = pillars.length ? pillars : [niche];

  pillarList.forEach((pillar, index) => {
    const persona = personas[index % Math.max(personas.length, 1)] || '';
    const keyword = keywords[index % Math.max(keywords.length, 1)] || '';
    const labelParts = [pillar, persona, keyword].filter(Boolean);
    baseThemes.push({
      pillar,
      persona,
      keyword,
      label: labelParts.join(' • ') || niche
    });
  });

  if (!baseThemes.length) {
    baseThemes.push({
      pillar: niche,
      persona: personas[0] || '',
      keyword: keywords[0] || '',
      label: niche
    });
  }

  return baseThemes;
}

function buildBrief({ niche, theme, angle, persona, keyword }) {
  const focus = keyword || theme.pillar || niche;
  const audience = persona || 'the right buyer';
  return `${capitalize(angle)} post about ${focus} for ${audience} in ${niche}.`;
}

function buildDraftPost({ niche, theme, angle, persona, keyword }) {
  const audience = persona || 'the teams I work with';
  const focus = keyword || theme.pillar || niche;
  const pillar = theme.pillar || niche;
  const intro = buildIntro(angle, focus, audience);
  const takeaway = buildTakeaway(angle, pillar, niche);

  return [
    intro,
    '',
    `A pattern I keep seeing in ${niche}: ${pillar} has moved from "nice to have" to a real growth lever.`,
    '',
    `Three things worth pressure-testing this week:`,
    `1. Where is ${focus} slowing down handoffs or expansion?`,
    `2. Which customer signal should the team review every week?`,
    `3. What would make this easier for ${audience}?`,
    '',
    takeaway,
    '',
    `Curious how others are approaching this right now.`
  ].join('\n');
}

function buildIntro(angle, focus, audience) {
  switch (angle) {
    case 'mistake':
      return `One mistake I see teams make around ${focus}: optimizing the tactic before they define the operating rule.`;
    case 'framework':
      return `A simple framework I use when thinking about ${focus} for ${audience}: signal, action, follow-through.`;
    case 'story':
      return `A quick story from a recent conversation about ${focus}: the biggest bottleneck was not effort, it was clarity.`;
    case 'trend':
      return `A trend I am watching closely in ${focus}: teams are moving from reactive fixes to repeatable systems.`;
    case 'checklist':
      return `A short checklist for anyone reviewing ${focus} this quarter: alignment, timing, and ownership.`;
    case 'question':
      return `A question I keep asking about ${focus}: what would need to be true for this process to feel obvious to the buyer?`;
    case 'insight':
    default:
      return `One insight about ${focus}: the teams that win usually make it easier for ${audience} to act, not just to understand.`;
  }
}

function buildTakeaway(angle, pillar, niche) {
  switch (angle) {
    case 'framework':
      return `If you are working on ${pillar} in ${niche}, start by making ownership and next steps impossible to miss.`;
    case 'question':
      return `The better the internal answer to that question, the easier it becomes to create momentum without adding noise.`;
    default:
      return `That usually creates better conversations, cleaner prioritization, and stronger execution across ${niche}.`;
  }
}

function buildHashtags({ niche, pillar, keyword, persona }) {
  const values = [niche, pillar, keyword, persona]
    .map((value) => toHashtag(value))
    .filter(Boolean);

  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

function toHashtag(value) {
  const cleaned = cleanSingleLine(value, 80).replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  if (!cleaned) return '';
  const compact = cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return compact ? `#${compact.slice(0, 40)}` : '';
}

function normalizeStartDate(value, now = new Date()) {
  const cleaned = cleanSingleLine(value, 40);
  if (cleaned) {
    const parsed = new Date(`${cleaned}T12:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(12, 0, 0, 0);
  return next;
}

function normalizePostingTime(value) {
  const cleaned = cleanSingleLine(value, 16);
  if (/^\d{2}:\d{2}$/.test(cleaned)) {
    const [hours, minutes] = cleaned.split(':').map((part) => Number.parseInt(part, 10));
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
  }
  return DEFAULT_POSTING_TIME;
}

function normalizeCadence(value) {
  const cleaned = cleanSingleLine(value, 40).toLowerCase();
  return CADENCE_RULES.has(cleaned) ? cleaned : 'daily';
}

function normalizeList(value, maxItems, maxLength) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,]/g);
  const seen = new Set();
  return values
    .map((entry) => cleanSingleLine(entry, maxLength))
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function normalizeInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function formatDateOnly(dateValue) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function cleanSingleLine(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function capitalize(value) {
  const cleaned = cleanSingleLine(value, 80);
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : '';
}

module.exports = {
  buildAgentContentPlan
};
