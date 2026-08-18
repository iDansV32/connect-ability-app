const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DiagnosticsExportService = require('../diagnostics-export-service');
const { createTempWorkspace, readJson } = require('./test-helpers');

test('DiagnosticsExportService writes a diagnostics bundle with runtime logs and state snapshots', () => {
  const workspace = createTempWorkspace('diagnostics-export-service-');
  try {
    const service = new DiagnosticsExportService();
    const result = service.createBundle({
      outputDir: workspace.root,
      exportedAt: '2026-03-21T12:00:00.000Z',
      filters: {
        accountId: 'account-1',
        correlationId: 'corr-run-1'
      },
      workflowRuns: [
        {
          id: 'run-1',
          correlationId: 'corr-run-1'
        }
      ],
      workflowJobs: [
        {
          id: 'job-1',
          correlationId: 'corr-step-1',
          rootCorrelationId: 'corr-run-1'
        }
      ],
      prospects: [
        {
          id: 'prospect-1',
          score: 88,
          scoreUpdatedAt: '2026-03-21T12:00:00.000Z',
          scoreBreakdown: {
            total: 0.88
          }
        }
      ],
      activityEvents: [
        {
          id: 'evt-1',
          type: 'dm_sent',
          correlationId: 'corr-step-1',
          rootCorrelationId: 'corr-run-1'
        }
      ],
      runtimeLogs: [
        {
          id: 'log-1',
          message: 'Started workflow step',
          correlationId: 'corr-step-1',
          rootCorrelationId: 'corr-run-1'
        }
      ],
      accountHealth: {
        'account-1': {
          workflow: {
            status: 'healthy'
          }
        }
      },
      replyMonitorState: {
        version: 2,
        accounts: {},
        notifications: {}
      },
      stepOutcomeBreakdown: {
        byStepType: [
          {
            stepType: 'send_dm',
            total: 3,
            breakdown: [
              { outcomeType: 'completed', count: 2 },
              { outcomeType: 'failed_permanent', count: 1 }
            ]
          }
        ],
        totals: { total: 3, completed: 2, skipped: 0, failed: 1 }
      }
    });

    assert.equal(result.fileCount, 9);
    assert.equal(result.summary.workflowRuns, 1);
    assert.equal(result.summary.runtimeLogs, 1);
    assert.equal(result.summary.stepOutcomeTotal, 3);

    const overview = readJson(path.join(result.bundleDir, 'overview.json'));
    const runs = readJson(path.join(result.bundleDir, 'workflow-runs.json'));
    const health = readJson(path.join(result.bundleDir, 'linkedin-account-health.json'));
    const logs = fs.readFileSync(path.join(result.bundleDir, 'runtime-logs.jsonl'), 'utf8');
    const prospects = readJson(path.join(result.bundleDir, 'prospects.json'));
    const breakdown = readJson(path.join(result.bundleDir, 'step-outcome-breakdown.json'));

    assert.equal(overview.filters.correlationId, 'corr-run-1');
    assert.equal(runs[0].correlationId, 'corr-run-1');
    assert.equal(health['account-1'].workflow.status, 'healthy');
    assert.match(logs, /corr-step-1/);
    assert.equal(prospects[0].score, 88);
    assert.equal(prospects[0].scoreBreakdown.total, 0.88);
    assert.equal(breakdown.byStepType[0].stepType, 'send_dm');
    assert.equal(breakdown.byStepType[0].total, 3);
    assert.equal(breakdown.totals.total, 3);
    assert.equal(breakdown.totals.failed, 1);
  } finally {
    workspace.cleanup();
  }
});
