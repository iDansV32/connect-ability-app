'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────────

const REPORT_EVENT_LIMIT = 2000;
const DM_PREVIEW_LENGTH = 120;
const DM_TEXT_LENGTH = 200;
const POST_PREVIEW_LENGTH = 160;

// ─── DailyReportService ────────────────────────────────────────────────────────

class DailyReportService {
  constructor(options = {}) {
    if (!options.analytics) throw new Error('DailyReportService requires options.analytics');
    this.analytics = options.analytics;
    this.prospects = options.prospects || null; // optional — used for name/title enrichment
  }

  /**
   * Generate a report for one agent over a time period.
   *
   * options:
   *   date: 'YYYY-MM-DD'         → midnight-to-midnight in `timezone`
   *   from: ISO string           → start of custom range
   *   to:   ISO string           → end of custom range
   *   timezone: 'America/Chicago' (default UTC)
   *
   * Returns the full structured report object.
   */
  generateReport(agentId, options = {}) {
    if (!agentId) throw new Error('agentId is required');

    const { since, until, label } = resolveTimeRange(options);

    // Pull all events for this agent in the period
    const events = this.analytics.getEvents({
      agentId,
      since,
      until,
      activityLimit: REPORT_EVENT_LIMIT
    });

    // Build prospect lookup map for name/title enrichment
    const prospectMap = buildProspectMap(this.prospects, agentId);

    // Derive agent name from first event (or fall back)
    const agentName = events.length > 0 ? (events[0].agentName || agentId) : agentId;

    const detail = buildDetail(events, prospectMap);
    const summary = buildSummary(detail);

    return {
      agentId,
      agentName,
      period: { from: since, to: until, label },
      generatedAt: new Date().toISOString(),
      summary,
      detail
    };
  }
}

// ─── Time range ────────────────────────────────────────────────────────────────

function resolveTimeRange(options = {}) {
  const timezone = String(options.timezone || 'UTC');

  // Custom ISO range
  if (options.from && options.to) {
    const from = new Date(options.from).toISOString();
    const to = new Date(options.to).toISOString();
    return { since: from, until: to, label: formatRangeLabel(from, to) };
  }

  // Specific date → midnight-to-midnight in timezone
  const dateStr = options.date || todayInTimezone(timezone);
  const { start, end } = dayBoundsInTimezone(dateStr, timezone);
  return { since: start, until: end, label: formatDateLabel(dateStr) };
}

function todayInTimezone(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date()); // en-CA gives YYYY-MM-DD
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function dayBoundsInTimezone(dateStr, timezone) {
  // dateStr: 'YYYY-MM-DD'
  // Returns { start, end } as UTC ISO strings representing midnight-to-midnight
  // in the given timezone.
  const [year, month, day] = dateStr.split('-').map(Number);

  // Build Date objects for midnight in the target timezone.
  // We do this by finding the UTC offset at that local midnight.
  function localMidnightAsUtc(y, m, d) {
    // Try to find the UTC time that corresponds to local midnight.
    // Strategy: create a rough UTC candidate, then correct using the offset.
    const roughUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // noon UTC as rough anchor
    const offset = getTimezoneOffsetMinutes(roughUtc, timezone);
    // Local midnight = UTC midnight + offset → UTC midnight - offset minutes from UTC
    const utcMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offset * 60 * 1000);
    return utcMidnight.toISOString();
  }

  const nextDay = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));
  const nextYear = nextDay.getUTCFullYear();
  const nextMonth = nextDay.getUTCMonth() + 1;
  const nextDate = nextDay.getUTCDate();

  return {
    start: localMidnightAsUtc(year, month, day),
    end: localMidnightAsUtc(nextYear, nextMonth, nextDate)
  };
}

function getTimezoneOffsetMinutes(date, timezone) {
  // Returns UTC offset in minutes for the given date and timezone.
  // Positive = east of UTC (UTC+N), negative = west.
  try {
    const utcStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).format(date);

    const tzStr = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).format(date);

    const [utcH, utcM] = utcStr.split(':').map(Number);
    const [tzH, tzM] = tzStr.split(':').map(Number);
    return (tzH * 60 + tzM) - (utcH * 60 + utcM);
  } catch (_) {
    return 0;
  }
}

function formatDateLabel(dateStr) {
  try {
    const d = new Date(`${dateStr}T12:00:00Z`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_) {
    return dateStr;
  }
}

function formatRangeLabel(from, to) {
  try {
    const f = new Date(from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const t = new Date(to).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${f} – ${t}`;
  } catch (_) {
    return `${from} – ${to}`;
  }
}

// ─── Prospect enrichment ───────────────────────────────────────────────────────

function buildProspectMap(prospectStore, agentId) {
  if (!prospectStore) return new Map();
  try {
    const prospects = prospectStore.getAllProspects({ agentId });
    const map = new Map();
    for (const p of prospects) {
      if (p.id) map.set(p.id, p);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

function enrichName(event, prospectMap) {
  if (event.prospectId && prospectMap.has(event.prospectId)) {
    const p = prospectMap.get(event.prospectId);
    return p.fullName || event.targetValue || null;
  }
  return event.targetValue || null;
}

function enrichTitle(event, prospectMap) {
  if (event.prospectId && prospectMap.has(event.prospectId)) {
    const p = prospectMap.get(event.prospectId);
    const parts = [p.title, p.company].filter(Boolean);
    return parts.join(' @ ') || null;
  }
  return null;
}

// ─── Detail builder ────────────────────────────────────────────────────────────

function buildDetail(events, prospectMap) {
  const detail = {
    profilesViewed: [],
    dmsSent: [],
    dmsReceived: [],
    postsPublished: [],
    postsLikedByUs: [],
    connectionsRequested: [],
    connectionsAccepted: [],
    postLikedByOthers: [],
    workflowsCompleted: [],
    workflowsFailed: []
  };

  for (const event of events) {
    const { type, timestamp, profileUrl, metadata } = event;
    const name = enrichName(event, prospectMap);
    const title = enrichTitle(event, prospectMap);

    switch (type) {
      case 'profile_viewed':
        detail.profilesViewed.push(compact({ timestamp, profileUrl, name, title }));
        break;

      case 'dm_sent':
        detail.dmsSent.push(compact({
          timestamp,
          profileUrl,
          name,
          title,
          preview: truncate(metadata?.messageTemplate || metadata?.message, DM_PREVIEW_LENGTH)
        }));
        break;

      case 'dm_reply_received':
        detail.dmsReceived.push(compact({
          timestamp,
          profileUrl,
          name,
          title,
          text: truncate(metadata?.text || metadata?.body, DM_TEXT_LENGTH)
        }));
        break;

      case 'post_published':
        detail.postsPublished.push(compact({
          timestamp,
          postId: event.postId || null,
          preview: truncate(metadata?.content || metadata?.text, POST_PREVIEW_LENGTH)
        }));
        break;

      case 'post_liked':
        detail.postsLikedByUs.push(compact({ timestamp, profileUrl, name, title }));
        break;

      case 'post_liked_by_others':
        detail.postLikedByOthers.push(compact({ timestamp, profileUrl, name, title }));
        break;

      case 'connection_requested':
        detail.connectionsRequested.push(compact({ timestamp, profileUrl, name, title }));
        break;

      case 'connection_accepted':
        detail.connectionsAccepted.push(compact({
          timestamp,
          profileUrl,
          name,
          title,
          inferred: Boolean(metadata?.connectionAcceptedInferred)
        }));
        break;

      case 'workflow_completed':
        detail.workflowsCompleted.push(compact({
          timestamp,
          workflowId: event.workflowId,
          workflowName: event.workflowName,
          runId: event.runId
        }));
        break;

      case 'workflow_failed':
        detail.workflowsFailed.push(compact({
          timestamp,
          workflowId: event.workflowId,
          workflowName: event.workflowName,
          runId: event.runId,
          reason: metadata?.reason || null
        }));
        break;

      default:
        break;
    }
  }

  return detail;
}

function buildSummary(detail) {
  return {
    profilesViewed: detail.profilesViewed.length,
    dmsSent: detail.dmsSent.length,
    dmsReceived: detail.dmsReceived.length,
    postsPublished: detail.postsPublished.length,
    postsLikedByUs: detail.postsLikedByUs.length,
    connectionsRequested: detail.connectionsRequested.length,
    connectionsAccepted: detail.connectionsAccepted.length,
    postLikedByOthers: detail.postLikedByOthers.length,
    workflowsCompleted: detail.workflowsCompleted.length,
    workflowsFailed: detail.workflowsFailed.length
  };
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function truncate(str, maxLength) {
  if (!str) return null;
  const text = String(str).trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function compact(obj) {
  // Remove null/undefined values for a cleaner response
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) result[key] = value;
  }
  return result;
}

module.exports = DailyReportService;
