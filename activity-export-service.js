const fs = require('fs');
const path = require('path');
const { ensureDirectoryExists } = require('./connect-documents');

const DEFAULT_EXPORT_PREFIX = 'connect-ability-export';

class ActivityExportService {
  createBundle(params = {}) {
    const outputDir = String(params.outputDir || '').trim();
    if (!outputDir) {
      throw new Error('Activity export requires an output directory');
    }

    ensureDirectoryExists(outputDir);

    const exportedAt = normalizeTimestamp(params.exportedAt) || new Date().toISOString();
    const bundleDir = path.join(outputDir, buildBundleDirectoryName(params.filters, exportedAt));
    ensureDirectoryExists(bundleDir);

    const overview = normalizeObject(params.overview);
    const filters = normalizeObject(params.filters);
    const workflowRuns = normalizeArray(params.workflowRuns);
    const workflowJobs = normalizeArray(params.workflowJobs);
    const prospects = normalizeArray(params.prospects);
    const replyEvents = normalizeArray(params.replyEvents)
      .filter((event) => cleanString(event?.type, 80) === 'dm_reply_received')
      .sort((left, right) => new Date(right.timestamp || 0).getTime() - new Date(left.timestamp || 0).getTime());
    const stepOutcomeBreakdown = normalizeStepOutcomeBreakdown(params.stepOutcomeBreakdown);

	    const manifest = {
	      exportedAt,
	      filters,
	      counts: {
	        workflowRuns: workflowRuns.length,
        workflowJobs: workflowJobs.length,
        prospects: prospects.length,
        dmReplies: replyEvents.length,
        stepOutcomeTotal: stepOutcomeBreakdown.totals.total || 0
	      },
	      overview
	    };

	    const writtenFiles = [
	      writeJson(path.join(bundleDir, 'overview.json'), manifest),
	      writeText(path.join(bundleDir, 'workflow-runs.csv'), buildWorkflowRunsCsv(workflowRuns)),
	      writeText(path.join(bundleDir, 'workflow-step-jobs.csv'), buildWorkflowJobsCsv(workflowJobs)),
	      writeText(path.join(bundleDir, 'prospects.csv'), buildProspectsCsv(prospects)),
	      writeText(path.join(bundleDir, 'dm-replies.csv'), buildReplyEventsCsv(replyEvents)),
	      writeText(path.join(bundleDir, 'step-outcome-breakdown.csv'), buildStepOutcomeBreakdownCsv(stepOutcomeBreakdown))
	    ];

	    return {
	      bundleDir,
	      fileCount: writtenFiles.length,
	      summary: manifest.counts
	    };
	  }
}

function buildBundleDirectoryName(filters = {}, exportedAt = new Date().toISOString()) {
  const accountHint = cleanFileName(filters.accountId || filters.accountName || '');
  const timestamp = formatTimestampForFileName(exportedAt);
  return [DEFAULT_EXPORT_PREFIX, accountHint || null, timestamp].filter(Boolean).join('-');
}

function buildWorkflowRunsCsv(runs = []) {
  return toCsv([
    'runId',
    'workflowId',
    'workflowName',
    'accountId',
    'accountName',
    'agentId',
    'agentName',
    'targetType',
    'status',
    'totalTargets',
    'completedTargets',
    'failedTargets',
    'cancelledTargets',
    'createdAt',
    'updatedAt',
    'completedAt',
    'lastError'
  ], runs.map((run) => ({
    runId: run.id || '',
    workflowId: run.workflowId || '',
    workflowName: run.workflowName || '',
    accountId: run.accountId || '',
    accountName: run.accountName || '',
    agentId: run.agentId || '',
    agentName: run.agentName || '',
    targetType: run.targetType || '',
    status: run.status || '',
    totalTargets: run.summary?.totalTargets ?? '',
    completedTargets: run.summary?.completedTargets ?? '',
    failedTargets: run.summary?.failedTargets ?? '',
    cancelledTargets: run.summary?.cancelledTargets ?? '',
    createdAt: run.createdAt || '',
    updatedAt: run.updatedAt || '',
    completedAt: run.completedAt || '',
    lastError: run.lastError || ''
  })));
}

function buildWorkflowJobsCsv(jobs = []) {
  return toCsv([
    'jobId',
    'runId',
    'workflowId',
    'workflowName',
    'accountId',
    'accountName',
    'agentId',
    'agentName',
    'targetId',
    'targetLabel',
    'targetValue',
    'prospectId',
    'stepIndex',
    'stepType',
    'status',
    'attempts',
    'scheduledFor',
    'startedAt',
    'completedAt',
    'errorMessage',
    'outcomeType',
    'reason'
  ], jobs.map((job) => ({
    jobId: job.id || '',
    runId: job.runId || '',
    workflowId: job.workflowId || '',
    workflowName: job.workflowName || '',
    accountId: job.accountId || '',
    accountName: job.accountName || '',
    agentId: job.agentId || '',
    agentName: job.agentName || '',
    targetId: job.targetId || '',
    targetLabel: job.targetLabel || '',
    targetValue: job.targetValue || '',
    prospectId: job.prospectId || '',
    stepIndex: job.stepIndex ?? '',
    stepType: job.stepType || '',
    status: job.status || '',
    attempts: job.attempts ?? '',
    scheduledFor: job.scheduledFor || '',
    startedAt: job.startedAt || '',
    completedAt: job.completedAt || '',
    errorMessage: job.errorMessage || '',
    outcomeType: job.result?.outcomeType || '',
    reason: job.result?.reason || ''
  })));
}

function buildProspectsCsv(prospects = []) {
  return toCsv([
    'prospectId',
    'accountId',
    'accountName',
    'agentId',
    'agentName',
    'fullName',
    'profileUrl',
    'title',
    'company',
    'state',
    'sourceType',
    'sourceLabel',
    'workflowId',
    'workflowName',
    'runId',
    'targetId',
    'views',
    'postLikes',
    'connectionRequests',
    'connectionAcceptances',
    'dmsSent',
    'dmReplies',
    'workflowsStarted',
    'workflowsCompleted',
    'workflowsFailed',
    'score',
    'scoreUpdatedAt',
    'scoreBreakdownTotal',
    'lastActionAt',
    'lastReplyAt',
    'connectionAcceptedAt',
    'createdAt',
    'updatedAt'
  ], prospects.map((prospect) => ({
    prospectId: prospect.id || '',
    accountId: prospect.accountId || '',
    accountName: prospect.accountName || '',
    agentId: prospect.agentId || '',
    agentName: prospect.agentName || '',
    fullName: prospect.fullName || '',
    profileUrl: prospect.profileUrl || '',
    title: prospect.title || '',
    company: prospect.company || '',
    state: prospect.state || '',
    sourceType: prospect.sourceType || '',
    sourceLabel: prospect.sourceLabel || '',
    workflowId: prospect.workflowAssignment?.workflowId || '',
    workflowName: prospect.workflowAssignment?.workflowName || '',
    runId: prospect.workflowAssignment?.runId || '',
    targetId: prospect.workflowAssignment?.targetId || '',
    views: prospect.metrics?.views ?? '',
    postLikes: prospect.metrics?.postLikes ?? '',
    connectionRequests: prospect.metrics?.connectionRequests ?? '',
    connectionAcceptances: prospect.metrics?.connectionAcceptances ?? '',
    dmsSent: prospect.metrics?.dmsSent ?? '',
    dmReplies: prospect.metrics?.dmReplies ?? '',
    workflowsStarted: prospect.metrics?.workflowsStarted ?? '',
    workflowsCompleted: prospect.metrics?.workflowsCompleted ?? '',
    workflowsFailed: prospect.metrics?.workflowsFailed ?? '',
    score: prospect.score ?? '',
    scoreUpdatedAt: prospect.scoreUpdatedAt || '',
    scoreBreakdownTotal: prospect.scoreBreakdown?.total ?? '',
    lastActionAt: prospect.lastActionAt || '',
    lastReplyAt: prospect.lastReplyAt || '',
    connectionAcceptedAt: prospect.metadata?.connectionAcceptedAt || '',
    createdAt: prospect.createdAt || '',
    updatedAt: prospect.updatedAt || ''
  })));
}

function buildReplyEventsCsv(replyEvents = []) {
  return toCsv([
    'eventId',
    'timestamp',
    'accountId',
    'accountName',
    'agentId',
    'agentName',
    'workflowId',
    'workflowName',
    'runId',
    'targetId',
    'prospectId',
    'senderName',
    'targetValue',
    'profileUrl',
    'status',
    'text',
    'notificationId',
    'conversationUrn',
    'messageUrn'
  ], replyEvents.map((event) => ({
    eventId: event.id || '',
    timestamp: event.timestamp || '',
    accountId: event.accountId || '',
    accountName: event.accountName || '',
    agentId: event.agentId || '',
    agentName: event.agentName || '',
    workflowId: event.workflowId || '',
    workflowName: event.workflowName || '',
    runId: event.runId || '',
    targetId: event.targetId || '',
    prospectId: event.prospectId || '',
    senderName: event.metadata?.senderName || '',
    targetValue: event.targetValue || '',
    profileUrl: event.profileUrl || '',
    status: event.status || '',
    text: event.metadata?.text || '',
    notificationId: event.metadata?.notificationId || '',
    conversationUrn: event.metadata?.conversationUrn || '',
    messageUrn: event.metadata?.messageUrn || ''
  })));
}

function buildStepOutcomeBreakdownCsv(breakdown) {
  const rows = [];
  for (const entry of (breakdown.byStepType || [])) {
    const stepType = cleanString(entry?.stepType, 80) || 'unknown';
    for (const outcome of (entry?.breakdown || [])) {
      rows.push({
        stepType,
        outcomeType: cleanString(outcome?.outcomeType, 80) || 'unknown',
        count: outcome?.count ?? 0
      });
    }
  }
  return toCsv(['stepType', 'outcomeType', 'count'], rows);
}

function normalizeStepOutcomeBreakdown(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const totals = (value.totals && typeof value.totals === 'object' && !Array.isArray(value.totals))
      ? value.totals
      : {};
    return {
      byStepType: Array.isArray(value.byStepType) ? value.byStepType : [],
      totals
    };
  }
  return { byStepType: [], totals: {} };
}

function toCsv(headers = [], rows = []) {
  const headerRow = headers.map(escapeCsvCell).join(',');
  const dataRows = rows.map((row) => (
    headers.map((header) => escapeCsvCell(row?.[header])).join(',')
  ));
  return `${[headerRow, ...dataRows].join('\n')}\n`;
}

function escapeCsvCell(value) {
  const normalized = value === null || value === undefined
    ? ''
    : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  return `"${normalized.replace(/"/g, '""')}"`;
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath, value) {
  ensureDirectoryExists(path.dirname(filePath));
  fs.writeFileSync(filePath, String(value));
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTimestamp(value) {
  const timestamp = cleanString(value, 80);
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function formatTimestampForFileName(value) {
  const normalized = normalizeTimestamp(value) || new Date().toISOString();
  return normalized.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function cleanFileName(value) {
  return cleanString(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = ActivityExportService;
