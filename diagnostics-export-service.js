const fs = require('fs');
const path = require('path');
const { ensureDirectoryExists } = require('./connect-documents');

const DEFAULT_EXPORT_PREFIX = 'connect-ability-diagnostics';

class DiagnosticsExportService {
  createBundle(params = {}) {
    const outputDir = String(params.outputDir || '').trim();
    if (!outputDir) {
      throw new Error('Diagnostics export requires an output directory');
    }

    ensureDirectoryExists(outputDir);

    const exportedAt = normalizeTimestamp(params.exportedAt) || new Date().toISOString();
    const bundleDir = path.join(outputDir, buildBundleDirectoryName(params.filters, exportedAt));
    ensureDirectoryExists(bundleDir);

    const filters = normalizeObject(params.filters);
    const workflowRuns = normalizeArray(params.workflowRuns);
    const workflowJobs = normalizeArray(params.workflowJobs);
    const prospects = normalizeArray(params.prospects);
    const activityEvents = normalizeArray(params.activityEvents);
    const runtimeLogs = normalizeArray(params.runtimeLogs);
    const accountHealth = normalizeObject(params.accountHealth);
    const replyMonitorState = normalizeObject(params.replyMonitorState);
    const stepOutcomeBreakdown = normalizeStepOutcomeBreakdown(params.stepOutcomeBreakdown);

    const manifest = {
      exportedAt,
      filters,
      counts: {
        workflowRuns: workflowRuns.length,
        workflowJobs: workflowJobs.length,
        prospects: prospects.length,
        activityEvents: activityEvents.length,
        runtimeLogs: runtimeLogs.length,
        stepOutcomeTotal: stepOutcomeBreakdown.totals.total
      }
    };

    const writtenFiles = [
      writeJson(path.join(bundleDir, 'overview.json'), manifest),
      writeJson(path.join(bundleDir, 'workflow-runs.json'), workflowRuns),
      writeJson(path.join(bundleDir, 'workflow-step-jobs.json'), workflowJobs),
      writeJson(path.join(bundleDir, 'prospects.json'), prospects),
      writeJsonLines(path.join(bundleDir, 'activity-events.jsonl'), activityEvents),
      writeJsonLines(path.join(bundleDir, 'runtime-logs.jsonl'), runtimeLogs),
      writeJson(path.join(bundleDir, 'linkedin-account-health.json'), accountHealth),
      writeJson(path.join(bundleDir, 'reply-monitor-state.json'), replyMonitorState),
      writeJson(path.join(bundleDir, 'step-outcome-breakdown.json'), stepOutcomeBreakdown)
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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

function writeJsonLines(filePath, values) {
  const payload = normalizeArray(values)
    .map((value) => JSON.stringify(value))
    .join('\n');
  fs.writeFileSync(filePath, payload ? `${payload}\n` : '');
  return filePath;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeStepOutcomeBreakdown(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const totals = (value.totals && typeof value.totals === 'object' && !Array.isArray(value.totals))
      ? { total: 0, completed: 0, skipped: 0, failed: 0, ...value.totals }
      : { total: 0, completed: 0, skipped: 0, failed: 0 };
    return {
      byStepType: Array.isArray(value.byStepType) ? value.byStepType : [],
      totals
    };
  }
  return { byStepType: [], totals: { total: 0, completed: 0, skipped: 0, failed: 0 } };
}

function normalizeTimestamp(value) {
  const timestamp = new Date(value || '');
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function formatTimestampForFileName(value) {
  return normalizeTimestamp(value)
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function cleanFileName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

module.exports = DiagnosticsExportService;
