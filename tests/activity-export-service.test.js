const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ActivityExportService = require('../activity-export-service');
const { createTempWorkspace, readJson } = require('./test-helpers');

test('ActivityExportService creates an export bundle with workflow, prospect, and reply files', () => {
  const workspace = createTempWorkspace('activity-export-service-');
  try {
    const service = new ActivityExportService();
    const result = service.createBundle({
      outputDir: workspace.root,
      exportedAt: '2026-03-21T12:00:00.000Z',
      filters: {
        accountId: 'account-1'
      },
      overview: {
        totals: {
          connectionRequests: 1,
          connectionAcceptances: 1,
          dmsSent: 1,
          dmReplies: 1
        }
      },
      workflowRuns: [
        {
          id: 'run-1',
          workflowId: 'workflow-1',
          workflowName: 'Chief of Staff Sequence',
          accountId: 'account-1',
          accountName: 'Account One',
          agentId: 'agent-1',
          agentName: 'Agent One',
          targetType: 'search',
          status: 'completed',
          summary: {
            totalTargets: 1,
            completedTargets: 1,
            failedTargets: 0,
            cancelledTargets: 0
          },
          createdAt: '2026-03-20T12:00:00.000Z',
          updatedAt: '2026-03-21T12:00:00.000Z',
          completedAt: '2026-03-21T12:00:00.000Z'
        }
      ],
      workflowJobs: [
        {
          id: 'job-1',
          runId: 'run-1',
          workflowId: 'workflow-1',
          workflowName: 'Chief of Staff Sequence',
          accountId: 'account-1',
          accountName: 'Account One',
          agentId: 'agent-1',
          agentName: 'Agent One',
          targetId: 'target-1',
          targetLabel: 'Jane Doe',
          targetValue: 'https://www.linkedin.com/in/jane-doe/',
          prospectId: 'prospect-1',
          stepIndex: 3,
          stepType: 'send_dm',
          status: 'completed',
          attempts: 1,
          scheduledFor: '2026-03-21T11:00:00.000Z',
          startedAt: '2026-03-21T11:00:00.000Z',
          completedAt: '2026-03-21T11:02:00.000Z',
          result: {
            outcomeType: 'completed'
          }
        }
      ],
      prospects: [
        {
          id: 'prospect-1',
          accountId: 'account-1',
          accountName: 'Account One',
          agentId: 'agent-1',
          agentName: 'Agent One',
          fullName: 'Jane Doe',
          profileUrl: 'https://www.linkedin.com/in/jane-doe/',
          title: 'Chief of Staff',
          company: 'Acme',
          state: 'active',
          sourceType: 'search',
          sourceLabel: 'Chief of Staff',
          workflowAssignment: {
            workflowId: 'workflow-1',
            workflowName: 'Chief of Staff Sequence',
            runId: 'run-1',
            targetId: 'target-1'
          },
          metrics: {
            views: 1,
            postLikes: 1,
            connectionRequests: 1,
            connectionAcceptances: 1,
            dmsSent: 1,
            dmReplies: 1,
            workflowsStarted: 1,
            workflowsCompleted: 1,
            workflowsFailed: 0
          },
          metadata: {
            connectionAcceptedAt: '2026-03-21T11:59:00.000Z'
          },
          score: 91,
          scoreUpdatedAt: '2026-03-21T12:00:00.000Z',
          scoreBreakdown: {
            total: 0.91,
            factors: {
              titleMatch: {
                score: 1,
                weight: 0.45,
                weighted: 0.45,
                matchedKeyword: 'Chief of Staff'
              }
            }
          },
          createdAt: '2026-03-20T12:00:00.000Z',
          updatedAt: '2026-03-21T12:00:00.000Z',
          lastActionAt: '2026-03-21T12:00:00.000Z',
          lastReplyAt: '2026-03-21T12:05:00.000Z'
        }
      ],
      replyEvents: [
        {
          id: 'evt-1',
          type: 'dm_reply_received',
          timestamp: '2026-03-21T12:05:00.000Z',
          accountId: 'account-1',
          accountName: 'Account One',
          agentId: 'agent-1',
          agentName: 'Agent One',
          workflowId: 'workflow-1',
          workflowName: 'Chief of Staff Sequence',
          runId: 'run-1',
          targetId: 'target-1',
          prospectId: 'prospect-1',
          targetValue: 'Jane Doe',
          profileUrl: 'https://www.linkedin.com/in/jane-doe/',
          status: 'ok',
          metadata: {
            senderName: 'Jane Doe',
            text: 'Thanks for reaching out.',
            notificationId: 'reply:account-1:conversation-1:message-1',
            conversationUrn: 'conversation-1',
            messageUrn: 'message-1'
          }
        }
      ],
      stepOutcomeBreakdown: {
        byStepType: [
          {
            stepType: 'send_dm',
            total: 4,
            breakdown: [
              { outcomeType: 'completed', count: 3 },
              { outcomeType: 'skipped_quota_exceeded', count: 1 }
            ]
          },
          {
            stepType: 'view_profile',
            total: 10,
            breakdown: [
              { outcomeType: 'completed', count: 10 }
            ]
          }
        ],
        totals: { total: 14, completed: 13, skipped: 1, failed: 0 }
      }
    });

    assert.equal(result.fileCount, 6);
    assert.equal(result.summary.workflowRuns, 1);
    assert.equal(result.summary.prospects, 1);
    assert.equal(result.summary.dmReplies, 1);
    assert.equal(result.summary.stepOutcomeTotal, 14);

    const manifest = readJson(path.join(result.bundleDir, 'overview.json'));
    assert.equal(manifest.filters.accountId, 'account-1');
    assert.equal(manifest.counts.workflowRuns, 1);

    const workflowRunsCsv = fs.readFileSync(path.join(result.bundleDir, 'workflow-runs.csv'), 'utf8');
    const prospectsCsv = fs.readFileSync(path.join(result.bundleDir, 'prospects.csv'), 'utf8');
    const repliesCsv = fs.readFileSync(path.join(result.bundleDir, 'dm-replies.csv'), 'utf8');
    const breakdownCsv = fs.readFileSync(path.join(result.bundleDir, 'step-outcome-breakdown.csv'), 'utf8');

    assert.match(workflowRunsCsv, /Chief of Staff Sequence/);
    assert.match(prospectsCsv, /connectionAcceptances/);
    assert.match(prospectsCsv, /scoreBreakdownTotal/);
    assert.match(prospectsCsv, /Jane Doe/);
    assert.match(prospectsCsv, /91/);
    assert.match(repliesCsv, /Thanks for reaching out/);
    assert.match(breakdownCsv, /stepType/);
    assert.match(breakdownCsv, /send_dm/);
    assert.match(breakdownCsv, /view_profile/);
    assert.match(breakdownCsv, /skipped_quota_exceeded/);
  } finally {
    workspace.cleanup();
  }
});
