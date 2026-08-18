#!/usr/bin/env node

'use strict';

require('dotenv').config();

const http = require('http');
const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SdrAgentManager = require('./sdr-agent-manager');
const WorkflowTemplateStore = require('./workflow-template-store');
const WorkflowRunManager = require('./workflow-run-manager');
const ProspectQueueStore = require('./prospect-queue-store');
const GroupDataStore = require('./group-data-store');
const ScheduledPostStore = require('./scheduled-post-store');
const ActivityEventStore = require('./activity-event-store');
const ActivityAnalyticsService = require('./activity-analytics');
const LinkedInReplyMonitor = require('./linkedin-reply-monitor');
const LinkedInAccountHealthStore = require('./linkedin-account-health-store');
const RuntimeLogStore = require('./runtime-log-store');
const AgentPersonaStore = require('./agent-persona-store');
const DailyReportService = require('./daily-report-service');
const ReportScheduleStore = require('./report-schedule-store');
const ApolloSyncStore = require('./apollo-sync-store');
const ApolloSyncService = require('./apollo-sync-service');
const EmailFinderService = require('./agents/email-finder-service');
const { createApolloProvider, createNullProvider } = require('./enrichment/email-finder-provider');
const {
  appendJsonLine,
  ensureParentDirectory,
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath
} = require('./connect-documents');
const { openDatabase, closeDatabase } = require('./storage/sqlite-db');
const SqliteWorkflowRepository = require('./storage/sqlite-workflow-repository');
const SqliteScheduledPostRepository = require('./storage/sqlite-scheduled-post-repository');
// Shared DNC policy: same evaluator the action-router uses on the canonical
// workflow path, so MCP one-shot calls and durable workflow steps stay
// bit-for-bit consistent on suppression decisions.
const { resolveDoNotContactSummary } = require('./automation/safety/do-not-contact');
const { resolveSecret } = require('./automation/safety/secret-source');
const { resolveLinkedInAccountCredentials } = require('./linkedin-credential-store');
const { createLinkedInScheduledPostSession } = require('./linkedin-remote-scheduled-post-session');
const { syncScheduledPostsForAccount } = require('./scheduled-post-sync');
const { buildImmediateOneShotRunInput } = require('./mcp-one-shot-run');

const SERVER_VERSION = '1.0.0';
const SERVER_NAME = 'connect-ability';
const DEFAULT_PORT = Number(process.env.CONNECT_API_PORT || process.env.PORT || 3030);
const DEFAULT_PLATFORM_WRITE_RATE_LIMIT_PER_MINUTE = 10;
const PLATFORM_WRITE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PLATFORM_WRITE_AUDIT_RETENTION_DAYS = 365;
const PLATFORM_WRITE_AUDIT_RETENTION_MS = PLATFORM_WRITE_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const TOOL_WRITE_ACCESS = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  PLATFORM_WRITE: 'platform_write'
});
const PLATFORM_WRITE_TOOL_NAMES = new Set([
  'run_linkedin_action',
  'save_scheduled_posts',
  'enrich_prospect_email',
  'call_apollo_api',
  'create_apollo_account',
  'update_apollo_account',
  'update_apollo_contact_stages',
  'update_apollo_contact_owners',
  'bulk_create_apollo_contacts',
  'bulk_update_apollo_contacts',
  'create_apollo_deal',
  'update_apollo_deal',
  'create_apollo_task',
  'bulk_create_apollo_tasks',
  'create_apollo_call_record',
  'update_apollo_call_record',
  'update_apollo_sequence_contact_status',
  'activate_apollo_sequence',
  'sync_prospects_to_apollo_sequence',
  'sync_workflow_to_apollo_sequence',
  'sync_group_to_apollo_sequence'
]);
// Tools whose backing store is workflow_runs/workflow_jobs (read or write).
// When the canonical SQLite backend is unavailable, MCP must refuse these to
// prevent split-brain state: writing to a JSON workflow repo the Electron
// scheduler never reads, or returning stale/empty list views while the GUI
// app is operating on a SQLite DB it can't see.
//
// Policy: when sqliteAvailable is false, MCP is read-only for non-runs tools
// (platform writes blocked) and these tools are blocked entirely. See
// authorizeToolCall and filterToolsByPolicy.
const CANONICAL_BACKEND_TOOL_NAMES = new Set([
  'run_linkedin_action',
  'list_workflow_runs',
  'get_workflow_run',
  'list_workflow_jobs',
  'cancel_workflow_run'
]);

// Scheduled-post backend tools: depend on stores.posts being a usable store.
// In a full-JSON deployment (no SQLite at all) these still work — JSON store
// is the canonical backend in that mode. The gate only fires in the
// partial-bind state: SQLite is up but the scheduled-post repo specifically
// failed to bind, so stores.posts is null. The handlers already refuse via
// requirePostsBackend; this set makes the discovery surface match.
//
// save_scheduled_posts is intentionally NOT here — it's already in
// PLATFORM_WRITE_TOOL_NAMES, which is gated by the broader sqliteAvailable
// flag. Putting it here too would double-gate without changing behavior.
const POSTS_BACKEND_TOOL_NAMES = new Set([
  'list_scheduled_posts'
]);
// Local-state writes are tagged for schema/reporting clarity only.
// Enforcement currently applies only to platform writes.
const INTERNAL_WRITE_TOOL_TAGS = new Set([
  'save_agent',
  'delete_agent',
  'save_workflow_template',
  'delete_workflow_template',
  'cancel_workflow_run',
  'configure_apollo_integration',
  'save_apollo_binding',
  'delete_apollo_binding',
  'write_agent_persona',
  'schedule_daily_report',
  'delete_report_schedule'
]);

function isTruthyEnvFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ─── Tool definitions (static schema, shared by HTTP /api/schema and MCP tools/list) ─────

const TOOL_DEFS = [
  {
    name: 'list_agents',
    description: 'List all SDR agents. Returns agent names, IDs, status, niche, and persona metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Filter by LinkedIn account ID' }
      }
    }
  },
  {
    name: 'get_agent',
    description: 'Get a single SDR agent by ID.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'Agent ID' } },
      required: ['agentId']
    }
  },
  {
    name: 'save_agent',
    description: [
      'Create or update an SDR agent. Omit id to create a new agent.',
      'Store persona fields in metadata: soul (core essence), personality (communication style),',
      'replyStyle (how to respond to DM replies), contentTone (array of tone tags).'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Agent ID (omit to create new)' },
        name: { type: 'string', description: 'Agent display name (required)' },
        accountId: { type: 'string', description: 'LinkedIn account ID to bind this agent to' },
        accountName: { type: 'string', description: 'LinkedIn account display name' },
        niche: { type: 'string', description: 'Content niche / industry focus (max 240 chars)' },
        personaTitles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target job titles to prospect (e.g. ["Chief of Staff", "CoS"])'
        },
        searchKeywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'LinkedIn search keywords for prospect discovery'
        },
        connectionNoteTemplate: {
          type: 'string',
          description: 'Connection request note template (max 500 chars)'
        },
        dmTemplatePrimary: {
          type: 'string',
          description: 'Primary outreach DM template (max 1200 chars)'
        },
        dmTemplateFollowUp: {
          type: 'string',
          description: 'Follow-up DM template (max 1200 chars)'
        },
        contentPillars: {
          type: 'array',
          items: { type: 'string' },
          description: 'Content topic pillars (e.g. ["offsite ROI", "team culture", "remote work"])'
        },
        postCadence: {
          type: 'string',
          description: 'Post frequency: daily, weekly, biweekly, etc.'
        },
        timezone: {
          type: 'string',
          description: 'Agent timezone (e.g. America/New_York). Default: America/Chicago'
        },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'draft', 'archived'],
          description: 'Agent status. Default: active'
        },
        metadata: {
          type: 'object',
          description: 'Persona and campaign metadata',
          properties: {
            soul: { type: 'string', description: 'Core personality essence (e.g. "warm but direct, never salesy")' },
            personality: { type: 'string', description: 'Communication style description' },
            replyStyle: { type: 'string', description: 'How to respond to DM replies (e.g. "witty, 2-3 sentences, always ends with a question")' },
            contentTone: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tone tags for content generation (e.g. ["professional", "funny", "witty"])'
            }
          }
        }
      },
      required: ['name']
    }
  },
  {
    name: 'delete_agent',
    description: 'Delete an SDR agent by ID.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId']
    }
  },
  {
    name: 'list_workflow_templates',
    description: 'List automation workflow templates. Filter by agentId to see templates for a specific agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Filter by agent ID (optional)' }
      }
    }
  },
  {
    name: 'get_workflow_template',
    description: 'Get a single workflow template by ID.',
    inputSchema: {
      type: 'object',
      properties: { templateId: { type: 'string' } },
      required: ['templateId']
    }
  },
  {
    name: 'save_workflow_template',
    description: [
      'Create or update an automation workflow TEMPLATE (definition only — does NOT execute anything or queue any LinkedIn actions).',
      'To actually perform a LinkedIn action against a profile, use run_linkedin_action instead.',
      'Step types: view_profile, like_posts, follow_profile, unfollow_profile, endorse_skills, comment_on_post, send_connection, send_dm, delay.',
      'Use delay steps between actions (delayValue: 24, delayUnit: "hours" for 24h waits).',
      'Example sequence: view_profile → delay 24h → view_profile → delay 24h → like_posts → delay 24h → send_dm.',
      'comment_on_post requires a commentTemplate field on the step (max 1200 chars).'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Template ID (omit to create new)' },
        name: { type: 'string', description: 'Template name' },
        agentId: { type: 'string', description: 'Agent this workflow belongs to' },
        description: { type: 'string' },
        steps: {
          type: 'array',
          description: 'Ordered workflow steps',
          items: {
            type: 'object',
            properties: {
              order: { type: 'number', description: 'Step order (1-based)' },
              type: {
                type: 'string',
                enum: ['view_profile', 'like_posts', 'follow_profile', 'unfollow_profile', 'endorse_skills', 'comment_on_post', 'send_connection', 'send_dm', 'delay']
              },
              delayValue: { type: 'number', description: 'Delay amount (e.g. 24 for 24 hours)' },
              delayUnit: { type: 'string', description: 'Delay unit: hours, minutes, days' },
              messageTemplate: {
                type: 'string',
                description: 'Message text for send_dm or send_connection steps (max 1200 chars)'
              },
              commentTemplate: {
                type: 'string',
                description: 'Comment text for comment_on_post steps (max 1200 chars)'
              }
            },
            required: ['type']
          }
        },
        target: {
          type: 'object',
          description: 'Workflow target configuration',
          properties: {
            type: { type: 'string', enum: ['group', 'profiles', 'manual'] },
            label: { type: 'string', description: 'Human-readable target label' },
            profileUrls: { type: 'array', items: { type: 'string' }, description: 'LinkedIn profile URLs (for type: profiles)' },
            names: { type: 'array', items: { type: 'string' }, description: 'Names to search (for type: manual)' }
          }
        },
        status: { type: 'string', enum: ['draft', 'active', 'paused', 'archived'] }
      },
      required: ['name']
    }
  },
  {
    name: 'delete_workflow_template',
    description: 'Delete a workflow template by ID.',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string' } },
      required: ['workflowId']
    }
  },
  {
    name: 'list_workflow_runs',
    description: 'List workflow execution runs with status, target counts, and summary stats. Filter by accountId, agentId, status, or limit.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Filter by LinkedIn account ID' },
        agentId: { type: 'string', description: 'Filter by agent ID' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'waiting', 'completed', 'failed', 'paused', 'cancelled'],
          description: 'Filter by run status'
        },
        limit: { type: 'number', description: 'Max results to return' }
      }
    }
  },
  {
    name: 'get_workflow_run',
    description: 'Get a single workflow run with its targets and per-step summary.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId']
    }
  },
  {
    name: 'list_workflow_jobs',
    description: 'List step-level jobs for a workflow run. Each job represents one action on one prospect.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run ID (omit to get all pending jobs across all runs)' } }
    }
  },
  {
    name: 'cancel_workflow_run',
    description: 'Cancel a running or queued workflow run and all its pending jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        reason: { type: 'string', description: 'Cancellation reason (optional)' }
      },
      required: ['runId']
    }
  },
  {
    name: 'list_prospects',
    description: 'List prospects in the queue with their state, metrics, workflow assignment, and persisted lead score/breakdown. Filter by accountId, agentId, state, or workflowId.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        agentId: { type: 'string' },
        state: {
          type: 'string',
          enum: ['discovered', 'queued', 'active', 'completed', 'failed', 'responded', 'paused', 'archived']
        },
        workflowId: { type: 'string' },
        limit: { type: 'number', description: 'Max results' }
      }
    }
  },
  {
    name: 'get_prospect',
    description: 'Get a single prospect by ID with full metrics, history, workflow progress, and persisted lead score/breakdown.',
    inputSchema: {
      type: 'object',
      properties: { prospectId: { type: 'string' } },
      required: ['prospectId']
    }
  },
  {
    name: 'enrich_prospect_email',
    description: [
      'Find an email address for a prospect using the configured email finder provider (e.g. Apollo).',
      'Pass a prospectId to enrich an existing prospect, or pass raw person fields (firstName, lastName, domain, linkedinProfileUrl) for a standalone lookup.',
      'Returns the found email, status, provider, confidence, and provenance metadata.',
      'Does not overwrite an existing prospect email unless overwrite: true is set.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        prospectId: { type: 'string', description: 'Prospect ID to enrich (optional if raw fields provided)' },
        firstName: { type: 'string', description: 'First name for lookup' },
        lastName: { type: 'string', description: 'Last name for lookup' },
        fullName: { type: 'string', description: 'Full name (used if firstName/lastName not provided)' },
        companyName: { type: 'string', description: 'Company name' },
        domain: { type: 'string', description: 'Company domain (e.g. acme.com)' },
        linkedinProfileUrl: { type: 'string', description: 'LinkedIn profile URL' },
        overwrite: { type: 'boolean', description: 'Overwrite existing email on prospect (default: false)' }
      }
    }
  },
  {
    name: 'list_groups',
    description: 'List saved groups with their member counts. Use this before syncing a group to Apollo.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_apollo_integration',
    description: 'Get Apollo integration status, saved defaults, active bindings, and recent sync results. Never returns the raw API key.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'configure_apollo_integration',
    description: [
      'Configure the Apollo integration.',
      'Stores the Apollo API key securely in the system keychain and saves non-secret defaults such as defaultSequenceId and defaultEmailAccountId.',
      'Pass clearApiKey: true to remove the stored Apollo API key.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', description: 'Apollo API key (stored securely in keychain)' },
        clearApiKey: { type: 'boolean', description: 'Delete the stored Apollo API key' },
        enabled: { type: 'boolean', description: 'Whether Apollo syncing is enabled' },
        defaultSequenceId: { type: 'string', description: 'Default Apollo sequence ID' },
        defaultSequenceName: { type: 'string', description: 'Optional display name for the default sequence' },
        defaultEmailAccountId: { type: 'string', description: 'Default Apollo sending email account ID' },
        defaultEmailAccountLabel: { type: 'string', description: 'Optional label for the default sending account' }
      }
    }
  },
  {
    name: 'list_apollo_sequences',
    description: 'Search Apollo sequences that prospects can be enrolled into.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search query for Apollo sequence names' },
        limit: { type: 'number', description: 'Max sequences to return (default 100)' }
      }
    }
  },
  {
    name: 'list_apollo_email_accounts',
    description: 'List Apollo sending email accounts available for sequence enrollment.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_apollo_api_capabilities',
    description: 'List the Apollo public API categories and example endpoints that can be reached through this MCP.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'call_apollo_api',
    description: [
      'Call any Apollo public REST API endpoint under /api/v1 using the saved Apollo API key.',
      'Use this when you need an Apollo endpoint that does not yet have a dedicated MCP wrapper.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET)' },
        path: { type: 'string', description: 'Apollo API path like /contacts/search or a full https://api.apollo.io/api/v1/... URL' },
        query: { type: 'object', description: 'Optional query-string parameters' },
        body: { type: 'object', description: 'Optional JSON request body' }
      },
      required: ['path']
    }
  },
  {
    name: 'search_apollo_people',
    description: [
      'Run Apollo People API Search with prompt-friendly filters.',
      'Use filters for any raw Apollo People Search parameters, or use convenience fields like personTitles and personLocations.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional keyword query' },
        page: { type: 'number', description: 'Result page number (default 1)' },
        limit: { type: 'number', description: 'Results per page, max 100' },
        personTitles: { type: 'array', items: { type: 'string' } },
        personLocations: { type: 'array', items: { type: 'string' } },
        organizationNames: { type: 'array', items: { type: 'string' } },
        organizationLocations: { type: 'array', items: { type: 'string' } },
        personSeniorities: { type: 'array', items: { type: 'string' } },
        filters: { type: 'object', description: 'Raw Apollo People Search filters to merge into the query' }
      }
    }
  },
  {
    name: 'search_apollo_contacts',
    description: 'Search Apollo contacts by name, email, LinkedIn URL, or company to check if someone already exists as a contact.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        name: { type: 'string' },
        email: { type: 'string' },
        linkedinUrl: { type: 'string' },
        company: { type: 'string' },
        limit: { type: 'number', description: 'Max contacts to return, default 25' }
      }
    }
  },
  {
    name: 'search_apollo_accounts',
    description: 'Search Apollo accounts/organizations by keyword or raw Apollo account filters.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        page: { type: 'number' },
        limit: { type: 'number', description: 'Max results per page, default 25' },
        filters: { type: 'object', description: 'Raw Apollo account search filters' }
      }
    }
  },
  {
    name: 'get_apollo_account',
    description: 'Get a single Apollo account by account ID.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' }
      },
      required: ['accountId']
    }
  },
  {
    name: 'create_apollo_account',
    description: 'Create an Apollo account using the public Accounts API.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'object', description: 'Raw Apollo account payload' }
      },
      required: ['account']
    }
  },
  {
    name: 'update_apollo_account',
    description: 'Update an Apollo account by account ID.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        patch: { type: 'object', description: 'Raw Apollo account patch payload' }
      },
      required: ['accountId', 'patch']
    }
  },
  {
    name: 'list_apollo_users',
    description: 'List Apollo users in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'list_apollo_labels',
    description: 'List Apollo labels/lists available in the workspace.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_apollo_fields',
    description: 'List Apollo fields/custom fields available in the workspace.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_apollo_contact_stages',
    description: 'List Apollo contact stages.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'update_apollo_contact_stages',
    description: 'Bulk update Apollo contact stages using the public Contacts API.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_ids: { type: 'array', items: { type: 'string' } },
        contact_stage_id: { type: 'string' }
      },
      required: ['contact_ids', 'contact_stage_id']
    }
  },
  {
    name: 'update_apollo_contact_owners',
    description: 'Bulk update Apollo contact owners using the public Contacts API.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_ids: { type: 'array', items: { type: 'string' } },
        owner_id: { type: 'string' }
      },
      required: ['contact_ids', 'owner_id']
    }
  },
  {
    name: 'bulk_create_apollo_contacts',
    description: 'Bulk create Apollo contacts using the public Contacts API.',
    inputSchema: {
      type: 'object',
      properties: {
        contacts: { type: 'array', items: { type: 'object' } }
      },
      required: ['contacts']
    }
  },
  {
    name: 'bulk_update_apollo_contacts',
    description: 'Bulk update Apollo contacts using the public Contacts API.',
    inputSchema: {
      type: 'object',
      properties: {
        contacts: { type: 'array', items: { type: 'object' } }
      },
      required: ['contacts']
    }
  },
  {
    name: 'search_apollo_deals',
    description: 'Search Apollo deals/opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        account_id: { type: 'string' },
        owner_id: { type: 'string' },
        stage_id: { type: 'string' },
        page: { type: 'number' },
        per_page: { type: 'number' }
      }
    }
  },
  {
    name: 'get_apollo_deal',
    description: 'Get a single Apollo deal/opportunity by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string' }
      },
      required: ['opportunityId']
    }
  },
  {
    name: 'create_apollo_deal',
    description: 'Create an Apollo deal/opportunity.',
    inputSchema: {
      type: 'object',
      properties: {
        deal: { type: 'object' }
      },
      required: ['deal']
    }
  },
  {
    name: 'update_apollo_deal',
    description: 'Update an Apollo deal/opportunity by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string' },
        patch: { type: 'object' }
      },
      required: ['opportunityId', 'patch']
    }
  },
  {
    name: 'list_apollo_deal_stages',
    description: 'List Apollo deal/opportunity stages.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'search_apollo_tasks',
    description: 'Search Apollo tasks with raw Apollo task filters.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number' },
        limit: { type: 'number' },
        filters: { type: 'object' }
      }
    }
  },
  {
    name: 'create_apollo_task',
    description: 'Create an Apollo task.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'object' }
      },
      required: ['task']
    }
  },
  {
    name: 'bulk_create_apollo_tasks',
    description: 'Bulk create Apollo tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'object' } }
      },
      required: ['tasks']
    }
  },
  {
    name: 'create_apollo_call_record',
    description: 'Create an Apollo call record for an external call.',
    inputSchema: {
      type: 'object',
      properties: {
        call: { type: 'object' }
      },
      required: ['call']
    }
  },
  {
    name: 'search_apollo_calls',
    description: 'Search Apollo call records.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string' },
        contact_id: { type: 'string' },
        page: { type: 'number' },
        per_page: { type: 'number' }
      }
    }
  },
  {
    name: 'update_apollo_call_record',
    description: 'Update an Apollo call record by call ID.',
    inputSchema: {
      type: 'object',
      properties: {
        callId: { type: 'string' },
        patch: { type: 'object' }
      },
      required: ['callId', 'patch']
    }
  },
  {
    name: 'update_apollo_sequence_contact_status',
    description: 'Update the status of contacts already in an Apollo sequence using the public Sequences API.',
    inputSchema: {
      type: 'object',
      properties: {
        sequence_id: { type: 'string' },
        contact_ids: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', description: 'Apollo-specific sequence status action/payload fields are passed through as-is' }
      },
      required: ['sequence_id', 'contact_ids']
    }
  },
  {
    name: 'activate_apollo_sequence',
    description: 'Activate/approve an Apollo sequence by sequence ID.',
    inputSchema: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string' }
      },
      required: ['sequenceId']
    }
  },
  {
    name: 'list_apollo_bindings',
    description: 'List saved Apollo sequence bindings for agents, workflows, and groups.',
    inputSchema: {
      type: 'object',
      properties: {
        targetType: { type: 'string', enum: ['agent', 'workflow', 'group'] },
        targetId: { type: 'string' },
        enabled: { type: 'boolean' }
      }
    }
  },
  {
    name: 'save_apollo_binding',
    description: 'Create or update a saved Apollo binding so a specific agent, workflow, or group maps to a specific Apollo sequence.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Binding ID (omit to create or auto-upsert by targetType+targetId)' },
        targetType: { type: 'string', enum: ['agent', 'workflow', 'group'] },
        targetId: { type: 'string', description: 'Target ID to bind' },
        targetName: { type: 'string', description: 'Human-readable target name' },
        sequenceId: { type: 'string', description: 'Apollo sequence ID' },
        sequenceName: { type: 'string', description: 'Apollo sequence display name' },
        emailAccountId: { type: 'string', description: 'Optional Apollo email account ID for this binding' },
        enabled: { type: 'boolean', description: 'Whether this binding is active' }
      },
      required: ['targetType', 'targetId', 'sequenceId']
    }
  },
  {
    name: 'delete_apollo_binding',
    description: 'Delete a saved Apollo binding by its binding ID.',
    inputSchema: {
      type: 'object',
      properties: {
        bindingId: { type: 'string', description: 'Binding ID' }
      },
      required: ['bindingId']
    }
  },
  {
    name: 'sync_prospects_to_apollo_sequence',
    description: [
      'Add specific prospects to an Apollo sequence.',
      'You can target them by prospectIds, profileUrls, or names from the existing prospect queue.',
      'Use dryRun: true to preview what would sync before making Apollo API calls.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Apollo sequence ID (optional if configured by binding/default)' },
        sequenceName: { type: 'string', description: 'Optional display name for the sequence' },
        emailAccountId: { type: 'string', description: 'Optional Apollo email account ID' },
        prospectIds: { type: 'array', items: { type: 'string' } },
        profileUrls: { type: 'array', items: { type: 'string' } },
        names: { type: 'array', items: { type: 'string' } },
        agentId: { type: 'string', description: 'Optional prospect filter by agent ID' },
        workflowId: { type: 'string', description: 'Optional prospect filter by workflow ID' },
        dryRun: { type: 'boolean', description: 'Preview only, no Apollo writes' },
        force: { type: 'boolean', description: 'Re-sync even if already marked enrolled' },
        limit: { type: 'number', description: 'Max prospects to process (default: all, max 200)' }
      }
    }
  },
  {
    name: 'sync_workflow_to_apollo_sequence',
    description: 'Add all prospects currently associated with a workflow template to an Apollo sequence.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow template ID' },
        sequenceId: { type: 'string', description: 'Apollo sequence ID (optional if configured by binding/default)' },
        sequenceName: { type: 'string' },
        emailAccountId: { type: 'string' },
        dryRun: { type: 'boolean' },
        force: { type: 'boolean' },
        limit: { type: 'number' }
      },
      required: ['workflowId']
    }
  },
  {
    name: 'sync_group_to_apollo_sequence',
    description: 'Add all already-gathered prospects that match members of a saved group to an Apollo sequence.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Group ID or exact group name' },
        sequenceId: { type: 'string', description: 'Apollo sequence ID (optional if configured by binding/default)' },
        sequenceName: { type: 'string' },
        emailAccountId: { type: 'string' },
        dryRun: { type: 'boolean' },
        force: { type: 'boolean' },
        limit: { type: 'number' }
      },
      required: ['groupId']
    }
  },
  {
    name: 'get_apollo_sync_status',
    description: 'List durable Apollo sync records for prospects, workflows, or groups.',
    inputSchema: {
      type: 'object',
      properties: {
        prospectId: { type: 'string' },
        sequenceId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'matched', 'contact_created', 'enrolled', 'skipped', 'failed', 'dry_run'] },
        targetType: { type: 'string', enum: ['agent', 'workflow', 'group'] },
        targetId: { type: 'string' },
        workflowId: { type: 'string' },
        groupId: { type: 'string' },
        agentId: { type: 'string' },
        limit: { type: 'number', description: 'Max sync records to return (default 100)' }
      }
    }
  },
  {
    name: 'list_scheduled_posts',
    description: 'List scheduled LinkedIn posts. Filter by accountId, agentId, or status (pending/scheduled/published/etc).',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        agentId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'publishing', 'scheduled', 'published', 'failed', 'cancelled'] }
      }
    }
  },
  {
    name: 'save_scheduled_posts',
    description: [
      'Replace scheduled posts atomically for one account, preserving posts assigned to other LinkedIn accounts.',
      'When accountId is provided, supported scheduled text posts are immediately scheduled on LinkedIn and their LinkedIn resource keys are stored locally.',
      'Pass accountId when updating one profile so you do not overwrite another profile\'s queue.',
      'Each post needs: content (required), scheduledDate (YYYY-MM-DD), scheduledTime (HH:MM), agentId.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'LinkedIn account ID whose post list should be replaced' },
        posts: {
          type: 'array',
          description: 'Complete post list for the selected account',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Post ID (omit to auto-generate)' },
              content: { type: 'string', description: 'Post text (max 3000 chars, required)' },
              scheduledDate: { type: 'string', description: 'YYYY-MM-DD' },
              scheduledTime: { type: 'string', description: 'HH:MM (24-hour)' },
              agentId: { type: 'string', description: 'Agent ID' },
              agentName: { type: 'string' },
              accountId: { type: 'string' },
              accountName: { type: 'string' },
              postType: { type: 'string', enum: ['text', 'image'], description: 'Default: text' },
              visibility: { type: 'string', enum: ['public', 'connections', 'private'], description: 'Default: public' },
              contentPillar: { type: 'string', description: 'Content topic pillar' },
              contentAngle: { type: 'string', description: 'Angle or hook for the post' },
              contentTheme: { type: 'string', description: 'Theme or campaign this post belongs to' },
              hashtags: { type: 'array', items: { type: 'string' } },
              contentDay: { type: 'number', description: 'Day number in a content plan (1–365)' }
            },
            required: ['content']
          }
        }
      },
      required: ['posts']
    }
  },
  {
    name: 'get_analytics',
    description: 'Get activity analytics overview: totals by event type, reply rate, per-agent and per-workflow breakdown, workflow step outcome breakdown by stepType/outcomeType, account health risk metrics, conversion funnel with drop-off rates, variant attribution with reply/acceptance rates, time-to-reply and time-to-accept timing stats (count/avg/median/min/max in ms and hours), and weekly trend series for key event types.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Filter by LinkedIn account ID' },
        agentId: { type: 'string', description: 'Filter by agent ID' },
        workflowId: { type: 'string', description: 'Filter by workflow ID' },
        days: { type: 'number', description: 'Lookback window in days (default: all time)' },
        since: { type: 'string', description: 'ISO start timestamp (inclusive); overrides days when provided)' },
        until: { type: 'string', description: 'ISO end timestamp (inclusive)' }
      }
    }
  },
  {
    name: 'list_notifications',
    description: 'List DM reply notifications. Use unreadOnly: true to see unacknowledged replies.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Filter by LinkedIn account ID' },
        unreadOnly: { type: 'boolean', description: 'Return only unread notifications' },
        limit: { type: 'number', description: 'Max results (default: 50)' }
      }
    }
  },
  {
    name: 'list_linkedin_accounts',
    description: 'List all connected LinkedIn accounts with their IDs, display names, and email addresses. Use this to resolve which accountId belongs to a given name or email before creating agents, saving posts, or taking any account-specific action.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_account_health',
    description: 'Get LinkedIn account health for all accounts: cooldown status, consecutive failure count, error classification (rate_limit, challenge, auth, transient).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_runtime_logs',
    description: 'Get recent structured runtime logs. Use correlationAnyId to fetch all logs for a workflow run (matches both correlationId and rootCorrelationId).',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        correlationAnyId: { type: 'string', description: 'Match logs by correlationId OR rootCorrelationId' },
        workflowId: { type: 'string' },
        runId: { type: 'string' },
        limit: { type: 'number', description: 'Max entries (default: 500)' }
      }
    }
  },
  {
    name: 'read_agent_persona',
    description: [
      'Read persona files for an SDR agent. Returns all files as { files: { "soul.md": "...", ... }, status: { hasPersona, complete, existingFiles, missingFiles } }.',
      'Pass fileName to read a single file. Always call this before generating any agent-voiced content.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID (required)' },
        fileName: { type: 'string', description: 'Specific file to read (e.g. "soul.md"). Omit to read all files.' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'write_agent_persona',
    description: [
      'Write a persona file for an SDR agent. Creates the personas/{agentId}/ directory if needed.',
      'Standard files: soul.md, personality.md, writing-style.md, boundaries.md.',
      'Custom .md files are also supported (e.g. niche.md, objection-handling.md).',
      'Always show the drafted content to the user for approval before calling this.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID (required)' },
        fileName: { type: 'string', description: 'File name with .md extension (e.g. "soul.md")' },
        content: { type: 'string', description: 'Full markdown content to write (max 64 KB)' }
      },
      required: ['agentId', 'fileName', 'content']
    }
  },
  {
    name: 'get_agent_persona_status',
    description: 'Check which persona files exist for an agent and which standard files are missing. Returns { hasPersona, complete, existingFiles, missingFiles, standardFiles }.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'get_daily_report',
    description: [
      'Generate a structured activity report for one SDR agent.',
      'Specify a date (YYYY-MM-DD) for a midnight-to-midnight report in the given timezone,',
      'or supply from/to ISO strings for a custom range. Defaults to today in UTC.',
      'Returns summary counts + full detail arrays (profiles viewed with URLs, DMs sent/received, posts, connections, likes).'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID (required)' },
        date: { type: 'string', description: 'YYYY-MM-DD — midnight-to-midnight in timezone' },
        from: { type: 'string', description: 'Start of custom ISO range (overrides date)' },
        to: { type: 'string', description: 'End of custom ISO range (overrides date)' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. America/New_York). Default: UTC' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'list_activity_events',
    description: [
      'List raw activity events. Filter by agentId, accountId, workflowId, eventType, since/until ISO dates.',
      'eventType values: profile_viewed, dm_sent, dm_reply_received, post_published, post_liked, profile_followed,',
      'connection_requested, connection_accepted, post_liked_by_others, workflow_completed, workflow_failed.',
      'limit defaults to 500, max 2000.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        accountId: { type: 'string' },
        workflowId: { type: 'string' },
        eventType: { type: 'string', description: 'Filter to a single event type' },
        since: { type: 'string', description: 'ISO start timestamp (inclusive)' },
        until: { type: 'string', description: 'ISO end timestamp (inclusive)' },
        limit: { type: 'number', description: 'Max events to return (default 500, max 2000)' }
      }
    }
  },
  {
    name: 'schedule_daily_report',
    description: 'Schedule an automatic daily report for an agent at a specific local time. Creates or updates the schedule for that agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID (required)' },
        agentName: { type: 'string', description: 'Agent display name (for log messages)' },
        accountId: { type: 'string' },
        hour: { type: 'number', description: 'Hour in 24h format (0–23, default 18)' },
        minute: { type: 'number', description: 'Minute (0–59, default 0)' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. America/Chicago). Default: UTC' },
        enabled: { type: 'boolean', description: 'Whether the schedule is active (default true)' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'list_report_schedules',
    description: 'List all daily report schedules. Filter by agentId to see the schedule for a specific agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Filter by agent ID (optional)' }
      }
    }
  },
  {
    name: 'delete_report_schedule',
    description: 'Delete a daily report schedule by its schedule ID.',
    inputSchema: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string', description: 'Schedule ID to delete' }
      },
      required: ['scheduleId']
    }
  },
  {
    name: 'run_linkedin_action',
    description: 'Run a one-shot LinkedIn action against a profile (view_profile, send_connection, send_dm, like_posts, follow_profile). Explicit MCP actions are manual launches: they run in a visible browser, bypass account working hours, and are picked up on the next scheduler tick. Returns the runId and jobId for tracking.',
    inputSchema: {
      type: 'object',
      properties: {
        profileUrl: { type: 'string', description: 'LinkedIn profile URL (e.g. https://www.linkedin.com/in/someone)' },
        accountId: { type: 'string', description: 'LinkedIn account ID to act from (e.g. li_1700000000000_example)' },
        actionType: {
          type: 'string',
          enum: ['view_profile', 'send_connection', 'send_dm', 'like_posts', 'follow_profile'],
          description: 'Action to perform'
        },
        message: { type: 'string', description: 'For send_connection: optional connection note (max 300 chars). For send_dm: the message body.' },
        agentId: { type: 'string', description: 'Optional SDR agent ID (for persona-aware DM templates)' }
      },
      required: ['profileUrl', 'accountId', 'actionType']
    }
  }
];
const TOOL_DEFS_BY_NAME = new Map();

for (const def of TOOL_DEFS) {
  const writeAccess = PLATFORM_WRITE_TOOL_NAMES.has(def.name)
    ? TOOL_WRITE_ACCESS.PLATFORM_WRITE
    : (INTERNAL_WRITE_TOOL_TAGS.has(def.name) ? TOOL_WRITE_ACCESS.WRITE : TOOL_WRITE_ACCESS.READ);
  def.writeAccess = writeAccess;
  TOOL_DEFS_BY_NAME.set(def.name, def);
}

class ToolAccessError extends Error {
  constructor(statusCode, message, code = 'tool_access_denied') {
    super(message);
    this.name = 'ToolAccessError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function getToolDefinition(toolName) {
  return TOOL_DEFS_BY_NAME.get(String(toolName || '').trim()) || null;
}

function extractApiAuthToken(req) {
  if (!req || !req.headers) {
    return '';
  }
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const apiToken = String(req.headers['x-api-token'] || '');
  return bearer || apiToken;
}

function extractPlatformWriteToken(req) {
  if (!req || !req.headers) {
    return '';
  }
  return String(
    req.headers['x-platform-write-token']
    || req.headers['x-connect-platform-write-token']
    || ''
  ).trim();
}

function hashValue(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function secretsEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function summarizePlatformWriteArgs(toolName, args = {}) {
  const normalizedToolName = String(toolName || '').trim();
  if (normalizedToolName === 'run_linkedin_action') {
    return {
      accountId: String(args.accountId || '').trim() || null,
      actionType: String(args.actionType || '').trim() || null,
      agentId: String(args.agentId || '').trim() || null,
      profileUrlHash: hashValue(args.profileUrl)
    };
  }

  if (normalizedToolName === 'save_scheduled_posts') {
    return {
      accountId: String(args.accountId || '').trim() || null,
      postCount: Array.isArray(args.posts) ? args.posts.length : 0
    };
  }

  if (normalizedToolName === 'call_apollo_api') {
    return {
      method: String(args.method || 'GET').trim().toUpperCase() || 'GET',
      path: String(args.path || '').trim() || null
    };
  }

  return {
    accountId: String(args.accountId || '').trim() || null,
    sequenceId: String(args.sequenceId || '').trim() || null,
    bindingId: String(args.bindingId || '').trim() || null,
    dealId: String(args.dealId || '').trim() || null,
    taskId: String(args.taskId || '').trim() || null
  };
}

function appendPlatformWriteAuditEntry(toolName, args, policy, context = {}) {
  try {
    appendJsonLine(policy.auditLogPath, {
      id: `mcp-write-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      transport: context.transport || 'unknown',
      toolName: String(toolName || '').trim() || null,
      writeAccess: TOOL_WRITE_ACCESS.PLATFORM_WRITE,
      outcome: context.outcome || 'allowed',
      sourceIp: String(context.sourceIp || '').trim() || null,
      authTokenHash: hashValue(context.authToken || ''),
      platformWriteTokenHash: hashValue(context.platformWriteToken || ''),
      detail: summarizePlatformWriteArgs(toolName, args)
    });
  } catch (error) {
    process.stderr.write(`[connect-mcp-server] Failed to append platform-write audit entry: ${error.message}\n`);
  }
}

function prunePlatformWriteAuditLog(auditLogPath, options = {}) {
  const filePath = String(auditLogPath || '').trim();
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      pruned: false,
      keptCount: 0,
      removedCount: 0,
      invalidCount: 0,
      bytesFreed: 0
    };
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const cutoffMs = nowMs - PLATFORM_WRITE_AUDIT_RETENTION_MS;
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return {
      pruned: false,
      keptCount: 0,
      removedCount: 0,
      invalidCount: 0,
      bytesFreed: 0
    };
  }

  const lines = raw.split('\n');
  const keptLines = [];
  let removedCount = 0;
  let invalidCount = 0;

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      continue;
    }

    try {
      const entry = JSON.parse(trimmed);
      const timestampMs = Date.parse(entry?.timestamp);
      if (Number.isFinite(timestampMs) && timestampMs < cutoffMs) {
        removedCount += 1;
        continue;
      }
      keptLines.push(JSON.stringify(entry));
    } catch (_error) {
      invalidCount += 1;
    }
  }

  if (removedCount === 0 && invalidCount === 0) {
    return {
      pruned: false,
      keptCount: keptLines.length,
      removedCount,
      invalidCount,
      bytesFreed: 0
    };
  }

  ensureParentDirectory(filePath);
  const tempPath = `${filePath}.${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  const nextPayload = keptLines.length ? `${keptLines.join('\n')}\n` : '';
  fs.writeFileSync(tempPath, nextPayload, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);

  return {
    pruned: true,
    keptCount: keptLines.length,
    removedCount,
    invalidCount,
    bytesFreed: Math.max(0, Buffer.byteLength(raw, 'utf8') - Buffer.byteLength(nextPayload, 'utf8'))
  };
}

function enforcePlatformWriteRateLimit(policy) {
  const now = Date.now();
  const windowStart = now - PLATFORM_WRITE_RATE_LIMIT_WINDOW_MS;
  const timestamps = (policy.rateLimitState?.timestamps || [])
    .filter((timestamp) => Number(timestamp) >= windowStart);

  if (timestamps.length >= policy.rateLimitPerMinute) {
    policy.rateLimitState.timestamps = timestamps;
    throw new ToolAccessError(
      429,
      `Platform write rate limit exceeded (${policy.rateLimitPerMinute} calls per minute).`,
      'platform_write_rate_limited'
    );
  }

  timestamps.push(now);
  policy.rateLimitState.timestamps = timestamps;
}

function resolvePlatformWritePolicy(options = {}) {
  // Same resolution order as CONNECT_API_TOKEN: explicit option → secure file
  // → env (only if CONNECT_ALLOW_ENV_CREDENTIALS=1). Tests/in-process callers
  // can short-circuit by passing options.platformWriteToken directly.
  const explicitPlatformWriteToken = String(options.platformWriteToken || '').trim();
  let resolvedPlatformWriteToken = '';
  if (explicitPlatformWriteToken) {
    resolvedPlatformWriteToken = explicitPlatformWriteToken;
  } else {
    const resolved = resolveSecret({
      name: 'CONNECT_PLATFORM_WRITE_TOKEN',
      filePath: path.join(getConnectAbilityAppStateDir(), 'secrets', 'platform-write-token'),
      envVarName: 'CONNECT_PLATFORM_WRITE_TOKEN'
    });
    resolvedPlatformWriteToken = resolved ? resolved.value : '';
  }
  const policy = {
    token: resolvedPlatformWriteToken,
    allowStdioPlatformWrites: options.allowStdioPlatformWrites === true,
    // sqliteAvailable defaults to true so that callers that don't thread it
    // (legacy/older tests) preserve current behavior. The dispatch path always
    // passes the live value from stores.sqliteAvailable.
    sqliteAvailable: options.sqliteAvailable !== false,
    // postsAvailable mirrors sqliteAvailable but for the scheduled-post repo
    // specifically. Default true for backward compat. The dispatch path
    // computes it from `stores.posts !== null` so the partial-bind state
    // hides list_scheduled_posts to match handler-level refusal.
    postsAvailable: options.postsAvailable !== false,
    auditLogPath: String(options.auditLogPath || '').trim()
      || resolveInternalStatePath('mcp-platform-write-audit.jsonl'),
    rateLimitPerMinute: toPositiveInteger(
      options.platformWriteRateLimitPerMinute ?? process.env.CONNECT_PLATFORM_WRITE_RATE_LIMIT_PER_MINUTE,
      DEFAULT_PLATFORM_WRITE_RATE_LIMIT_PER_MINUTE
    ),
    rateLimitState: { timestamps: [] }
  };
  try {
    const pruneResult = prunePlatformWriteAuditLog(policy.auditLogPath);
    recordTelemetryPruneEvent(options.recordTelemetryEvent, 'telemetry_prune_completed', 'mcp_audit_log', pruneResult, {
      backend: 'jsonl'
    });
  } catch (error) {
    recordTelemetryPruneEvent(options.recordTelemetryEvent, 'telemetry_prune_failed', 'mcp_audit_log', null, {
      backend: 'jsonl',
      error: error.message || String(error)
    });
    process.stderr.write(`[connect-mcp-server] Failed to prune platform-write audit log: ${error.message}\n`);
  }
  return policy;
}

function recordTelemetryPruneEvent(recordTelemetryEvent, type, target, result, metadata = {}) {
  if (typeof recordTelemetryEvent !== 'function') {
    return;
  }

  try {
    const invalidCount = Number(result?.invalidCount || 0);
    recordTelemetryEvent({
      type,
      status: type === 'telemetry_prune_failed'
        ? 'failed'
        : (invalidCount > 0 ? 'warning' : 'ok'),
      targetValue: target,
      metadata: {
        target,
        pruned: Boolean(result?.pruned),
        keptCount: Number(result?.keptCount || 0),
        removedCount: Number(result?.removedCount || 0),
        invalidCount,
        bytesFreed: Number(result?.bytesFreed || 0),
        ...metadata
      }
    });
  } catch (error) {
    process.stderr.write(`[connect-mcp-server] Failed to record telemetry prune event: ${error.message}\n`);
  }
}

/**
 * True when this tool should be hidden from tools/list, /api/schema, and
 * /api/functions given the current policy. Each tool has at most one
 * backend dependency — workflow_runs/jobs (sqliteAvailable) OR
 * scheduled-post repo (postsAvailable). Platform writes are gated by
 * sqliteAvailable since they must converge on the same store the Electron
 * process uses (see commit 55b9b59 for the canonical-backend rationale).
 */
function isToolBackendDependent(toolName, policy) {
  if (!policy) return false;
  if (policy.sqliteAvailable === false) {
    if (CANONICAL_BACKEND_TOOL_NAMES.has(toolName)) return true;
    if (PLATFORM_WRITE_TOOL_NAMES.has(toolName)) return true;
  }
  if (policy.postsAvailable === false) {
    if (POSTS_BACKEND_TOOL_NAMES.has(toolName)) return true;
  }
  return false;
}

function filterToolDefsByPolicy(toolDefs, policy) {
  if (!policy) return toolDefs;
  if (policy.sqliteAvailable !== false && policy.postsAvailable !== false) {
    return toolDefs;
  }
  return toolDefs.filter((def) => !isToolBackendDependent(def.name, policy));
}

function filterToolNamesByPolicy(toolNames, policy) {
  if (!policy) return toolNames;
  if (policy.sqliteAvailable !== false && policy.postsAvailable !== false) {
    return toolNames;
  }
  return toolNames.filter((name) => !isToolBackendDependent(name, policy));
}

function authorizeToolCall(toolName, args, policy, context = {}) {
  const toolDef = getToolDefinition(toolName);
  if (!toolDef) {
    throw new ToolAccessError(404, `Unknown tool: ${toolName}`, 'unknown_tool');
  }

  // Canonical backend gate: tools that read or write workflow_runs require
  // SQLite. Refuse rather than silently falling back to a JSON repo the
  // Electron scheduler never sees. Applies to both read and write tools in
  // CANONICAL_BACKEND_TOOL_NAMES.
  if (CANONICAL_BACKEND_TOOL_NAMES.has(toolName) && policy && policy.sqliteAvailable === false) {
    throw new ToolAccessError(
      503,
      `Tool ${toolName} requires the canonical SQLite backend, which is unavailable.`,
      'backend_unavailable'
    );
  }

  // Scheduled-post backend gate: tools that read the scheduled-post store
  // refuse when the partial-bind state has set stores.posts to null.
  // Symmetric with the handler-level requirePostsBackend guard so discovery
  // (tools/list) and execution (authorize) give the same answer.
  if (POSTS_BACKEND_TOOL_NAMES.has(toolName) && policy && policy.postsAvailable === false) {
    throw new ToolAccessError(
      503,
      `Tool ${toolName} requires the scheduled-post backend, which is unavailable.`,
      'backend_unavailable'
    );
  }

  if (toolDef.writeAccess !== TOOL_WRITE_ACCESS.PLATFORM_WRITE) {
    return toolDef;
  }

  // Platform writes also require the canonical backend. Even tools that don't
  // directly touch workflow storage (e.g. call_apollo_api) produce activity
  // events and audit entries that must converge with the Electron process.
  // When SQLite is down, MCP becomes read-only — no platform writes allowed.
  if (policy && policy.sqliteAvailable === false) {
    throw new ToolAccessError(
      503,
      `Platform writes are disabled: the canonical SQLite backend is unavailable.`,
      'backend_unavailable'
    );
  }

  const sourceIp = String(context.req?.socket?.remoteAddress || '').trim() || null;
  const authToken = context.req ? extractApiAuthToken(context.req) : '';
  const platformWriteToken = context.req ? extractPlatformWriteToken(context.req) : '';

  try {
    if (context.transport === 'stdio') {
      // Stdio intentionally relies on explicit process-level opt-in rather than
      // a second bearer token, because the caller is already attached locally.
      if (!policy.allowStdioPlatformWrites) {
        throw new ToolAccessError(
          403,
          'Platform write tools are disabled on stdio. Set CONNECT_STDIO_PLATFORM_WRITES=1 to enable them.',
          'platform_write_stdio_disabled'
        );
      }
    } else {
      if (!policy.token) {
        throw new ToolAccessError(
          403,
          'Platform write token required. Put it in <app-state>/secrets/platform-write-token '
          + '(chmod 600), or set CONNECT_PLATFORM_WRITE_TOKEN=<value> AND CONNECT_ALLOW_ENV_CREDENTIALS=1 for a dev escape hatch. '
          + 'Send it as X-Platform-Write-Token: <value>.',
          'platform_write_token_missing'
        );
      }
      if (!secretsEqual(platformWriteToken, policy.token)) {
        throw new ToolAccessError(
          403,
          'Platform write token required for this tool. Provide X-Platform-Write-Token.',
          'platform_write_token_invalid'
        );
      }
    }

    enforcePlatformWriteRateLimit(policy);
    appendPlatformWriteAuditEntry(toolName, args, policy, {
      transport: context.transport,
      sourceIp,
      authToken,
      platformWriteToken,
      outcome: 'allowed'
    });
    return toolDef;
  } catch (error) {
    if (error instanceof ToolAccessError) {
      appendPlatformWriteAuditEntry(toolName, args, policy, {
        transport: context.transport,
        sourceIp,
        authToken,
        platformWriteToken,
        outcome: `denied:${error.code}`
      });
    }
    throw error;
  }
}

async function invokeToolHandler(toolHandlers, toolName, toolArgs = {}) {
  const handler = toolHandlers[toolName];
  if (!handler) {
    throw new ToolAccessError(404, `Unknown tool: ${toolName}`, 'unknown_tool');
  }
  return Promise.resolve(handler(toolArgs));
}

// ─── Store factory ─────────────────────────────────────────────────────────────

/**
 * Try to open the shared SQLite database for read access.
 * Returns null (with a log warning) when better-sqlite3 is unavailable or the
 * database file can't be opened.  Callers that receive null fall back to the
 * JSON-backed store paths automatically.
 *
 * @returns {import('better-sqlite3').Database|null}
 */
function tryOpenMcpDatabase() {
  try {
    return openDatabase(resolveInternalStatePath('connect-ability.db'));
  } catch (err) {
    process.stderr.write(
      `[connect-mcp-server] SQLite unavailable — analytics/health reads will use JSON files: ${err.message}\n`
    );
    return null;
  }
}

function buildDefaultStores() {
  // Open a read/write connection to the shared SQLite database.  The main app
  // process is the primary writer; this process is a concurrent reader (WAL
  // mode makes this safe).  Fall back to JSON if the database is unavailable.
  const db = tryOpenMcpDatabase();

  // Workflow runs/jobs are canonical in SQLite when the main app is using it.
  // Falling back to the JSON repo here would create a split-brain backend: MCP
  // would write workflow_runs.json that the Electron scheduler (reading SQLite)
  // never sees. When SQLite is unavailable we leave `runs` null and gate the
  // affected tools at authorize time.
  let workflowRepo = null;
  if (db) {
    try {
      workflowRepo = new SqliteWorkflowRepository(db);
    } catch (err) {
      process.stderr.write(
        `[connect-mcp-server] Failed to bind SQLite workflow repo: ${err.message}\n`
      );
      workflowRepo = null;
    }
  }

  // Scheduled posts: when SQLite is up, route the store through the SQLite
  // repo so MCP's save_scheduled_posts writes converge with the Electron
  // app's writes. If repo bind fails while the rest of SQLite is up, fail
  // closed (posts = null below) rather than silently fall back to JSON —
  // that would recreate the split-brain class of bug for scheduled posts.
  let scheduledPostRepo = null;
  if (db) {
    try {
      scheduledPostRepo = new SqliteScheduledPostRepository(db);
    } catch (err) {
      process.stderr.write(
        `[connect-mcp-server] Failed to bind SQLite scheduled-post repo: ${err.message}\n`
      );
      scheduledPostRepo = null;
    }
  }

  // The canonical-backend gate requires ALL repos to bind successfully when
  // SQLite is in use. A partial bind (e.g. workflowRepo ok, scheduledPostRepo
  // failed) would still leave one store on JSON and the other on SQLite —
  // exactly the split we're trying to prevent. Treat partial-bind the same
  // as no-SQLite-at-all: platform writes refused, canonical-backend tools
  // refused, but read-only tools that don't touch canonical state still work.
  const sqliteAvailable = db
    ? Boolean(workflowRepo && scheduledPostRepo)
    : false;

  const events = new ActivityEventStore({ db: db || undefined });

  const analytics = new ActivityAnalyticsService({ db: db || undefined });
  const prospects = new ProspectQueueStore({ db: db || undefined });
  const templates = new WorkflowTemplateStore();
  const groups = new GroupDataStore();
  const apolloSync = new ApolloSyncStore();
  const emailProvider = process.env.APOLLO_API_KEY
    ? createApolloProvider()
    : createNullProvider();
  const emailFinder = new EmailFinderService({
    provider: emailProvider,
    prospectQueueStore: prospects
  });
  return {
    agents:        new SdrAgentManager(),
    templates,
    runs:          workflowRepo ? new WorkflowRunManager({ repo: workflowRepo }) : null,
    sqliteAvailable,
    prospects,
    groups,
    // posts store policy:
    //   • repo bound        → SQLite-backed store
    //   • no db at all      → JSON-backed store (full-JSON deployment, no split risk)
    //   • db present, repo failed → null (fail closed; canonical-backend gate
    //                                refuses save_scheduled_posts; handler-level
    //                                requirePostsBackend refuses list_scheduled_posts)
    posts:         scheduledPostRepo
      ? new ScheduledPostStore({ repo: scheduledPostRepo })
      : (db ? null : new ScheduledPostStore()),
    events,
    analytics,
    monitor:       new LinkedInReplyMonitor({ db: db || undefined }),
    health:        new LinkedInAccountHealthStore({ db: db || undefined }),
    logs:          new RuntimeLogStore(),
    personas:      new AgentPersonaStore(),
    schedules:     new ReportScheduleStore(),
    reportService: new DailyReportService({ analytics, prospects }),
    emailFinder,
    apolloSync,
    apollo:        new ApolloSyncService({
      syncStore: apolloSync,
      prospects,
      templates,
      groups
    })
  };
}

function readLinkedInAccountsStore() {
  const filePath = require('path').join(getConnectAbilityAppStateDir(), 'linkedin-accounts.json');
  return readJsonFile(filePath, { accounts: [], activeAccountId: null });
}

function resolveScheduledPostsAccountId(accountId = null, posts = []) {
  const normalizedAccountId = String(accountId || '').trim();
  if (normalizedAccountId) {
    return normalizedAccountId;
  }

  const postAccountIds = Array.isArray(posts)
    ? Array.from(new Set(
      posts
        .map((post) => String(post?.accountId || '').trim())
        .filter(Boolean)
    ))
    : [];
  if (postAccountIds.length === 1) {
    return postAccountIds[0];
  }

  const accountsStore = readLinkedInAccountsStore();
  return String(accountsStore.activeAccountId || '').trim() || null;
}

function normalizeAnalyticsFilters(args = {}) {
  const normalized = {
    accountId: String(args.accountId || '').trim() || null,
    agentId: String(args.agentId || '').trim() || null,
    workflowId: String(args.workflowId || '').trim() || null,
    since: String(args.since || '').trim() || null,
    until: String(args.until || '').trim() || null
  };

  if (normalized.since) {
    return normalized;
  }

  const days = Number(args.days);
  if (Number.isFinite(days) && days > 0) {
    const now = new Date();
    normalized.until = normalized.until || now.toISOString();
    normalized.since = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000)).toISOString();
  }

  return normalized;
}

async function loadLinkedInAccountCredentialsForSync(accountId = null) {
  const normalizedAccountId = String(accountId || '').trim();
  if (!normalizedAccountId) {
    return null;
  }
  const accountsStore = readLinkedInAccountsStore();
  const account = Array.isArray(accountsStore.accounts)
    ? accountsStore.accounts.find((candidate) => String(candidate?.id || '').trim() === normalizedAccountId) || null
    : null;
  if (!account) {
    return null;
  }
  return resolveLinkedInAccountCredentials(account);
}

// ─── Tool handlers ─────────────────────────────────────────────────────────────

/**
 * Defensive guard for tool handlers that read or write workflow_runs/jobs.
 * The HTTP/stdio dispatch path already refuses these tools via authorizeToolCall
 * when stores.sqliteAvailable is false, but direct programmatic calls (tests,
 * tool composition) bypass that gate. This keeps the handler honest.
 */
function requireRunsBackend(stores, toolName) {
  if (!stores || !stores.runs || stores.sqliteAvailable === false) {
    const err = new Error(
      `Tool ${toolName} requires the canonical SQLite backend, which is unavailable.`
    );
    err.code = 'backend_unavailable';
    throw err;
  }
}

/**
 * Defensive guard for tool handlers that read or write scheduled_posts.
 *
 * Unlike requireRunsBackend, this guard does NOT refuse when stores.posts is
 * a JSON-backed store — full-JSON deployments (no SQLite at all) are
 * supported for scheduled posts. The guard fires only when stores.posts is
 * null, which happens when SQLite WAS attempted but the scheduled-post repo
 * failed to bind. In that mixed-failure state, falling back to the JSON
 * file would recreate the split-backend bug we just fixed, so the handler
 * refuses entirely.
 */
function requirePostsBackend(stores, toolName) {
  if (!stores || stores.posts === null || stores.posts === undefined) {
    const err = new Error(
      `Tool ${toolName} requires the scheduled-post backend, which is unavailable.`
    );
    err.code = 'backend_unavailable';
    throw err;
  }
}

// Tracks whether we've already warned about a prospect-store lookup failure.
// First-failure-only logging keeps the signal visible without spamming the
// stderr stream on a persistent fault. Reset is intentional: tests construct
// fresh handlers per case, but the warning state is module-scoped so a stale
// store crash doesn't keep generating noise within one process.
let _prospectLookupFailureWarned = false;

function _resetDoNotContactWarningStateForTests() {
  _prospectLookupFailureWarned = false;
}

/**
 * Look up the target profile across all accounts via getRelatedProspects and
 * return the first one that's archived or marked doNotContact. Returns null
 * when no related prospect is blocked (including the case where the profile
 * is unknown to the store entirely — DNC suppresses known opt-outs, not
 * unknown targets).
 *
 * Cross-account by design: a person who opted out via one account should not
 * be reached from a different account. This is intentionally broader than
 * the managed-elsewhere check (which IS account-pair scoped).
 *
 * Failures from the prospect store are caught and treated as "no block" so
 * that a corrupt store doesn't accidentally permit-or-deny. The first such
 * failure is logged to stderr — silent failure here is the worst case because
 * a one-shot action with no matching prospect on the action-router side could
 * slip a DNC target through. The warning gives an operator something to find.
 */
function findBlockedRelatedProspect(stores, profileUrl) {
  if (!profileUrl || !stores || !stores.prospects) return null;
  if (typeof stores.prospects.getRelatedProspects !== 'function') return null;

  let related = [];
  try {
    related = stores.prospects.getRelatedProspects({ profileUrl }) || [];
  } catch (err) {
    if (!_prospectLookupFailureWarned) {
      _prospectLookupFailureWarned = true;
      // Log a sha256 prefix of the URL instead of the raw URL: enough for an
      // operator to grep the audit log and confirm "yes, this is the call I
      // expected to see fail", without leaking the third party's profile slug
      // into stderr (or wherever stderr happens to be redirected).
      const urlHash = hashValue(profileUrl)?.slice(0, 12) || 'unhashed';
      process.stderr.write(
        `[connect-mcp-server] DNC lookup failed (profileUrlHash=${urlHash}): ${err.message}. `
        + `Falling through. Subsequent failures will be silent.\n`
      );
    }
    return null;
  }

  for (const prospect of related) {
    const summary = resolveDoNotContactSummary(prospect);
    if (summary.blocked) {
      return { summary, prospect };
    }
  }
  return null;
}

function buildDoNotContactSkipResult({ summary, prospect, profileUrl, accountId, actionType }) {
  const archived = summary.archived === true;
  return {
    ok: false,
    outcomeType: 'skipped_do_not_contact',
    reason: summary.reason,
    profileUrl,
    actionType,
    accountId,
    prospectId: prospect.id || null,
    matchedAccountId: prospect.accountId || null,
    doNotContact: summary.doNotContact === true,
    archived,
    archiveReason: summary.archiveReason || null,
    message: archived
      ? 'Blocked: target prospect is archived and marked do not contact.'
      : 'Blocked: target prospect is marked do not contact.'
  };
}

function buildToolHandlers(stores, services = {}) {
  return {
    list_agents: (args = {}) => {
      let agents = stores.agents.getAllAgents();
      if (args.accountId) {
        agents = agents.filter((agent) => agent.accountId === args.accountId);
      }
      return agents;
    },

    get_agent: ({ agentId } = {}) => {
      const agent = stores.agents.getAgent(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
      return agent;
    },

    save_agent: (agentInput = {}) => {
      const agent = stores.agents.saveAgent(agentInput);
      const personaStatus = stores.personas.getStatus(agent.id);
      return { ...agent, personaStatus };
    },

    delete_agent: ({ agentId } = {}) =>
      stores.agents.deleteAgent(agentId),

    list_workflow_templates: (args = {}) => {
      const templates = stores.templates.getAutomationWorkflows();
      if (args.agentId) return templates.filter((t) => t.agentId === args.agentId);
      return templates;
    },

    get_workflow_template: ({ templateId } = {}) => {
      const template = stores.templates.getTemplate(templateId);
      if (!template) throw new Error(`Workflow template not found: ${templateId}`);
      return template;
    },

    save_workflow_template: (workflowInput = {}) =>
      stores.templates.saveAutomationWorkflow(workflowInput),

    delete_workflow_template: ({ workflowId } = {}) =>
      stores.templates.deleteWorkflow(workflowId),

    list_workflow_runs: (args = {}) => {
      requireRunsBackend(stores, 'list_workflow_runs');
      let runs = stores.runs.getAllRuns();
      if (args.accountId) runs = runs.filter((r) => r.accountId === args.accountId);
      if (args.agentId) runs = runs.filter((r) => r.agentId === args.agentId);
      if (args.status) runs = runs.filter((r) => r.status === args.status);
      if (args.limit) runs = runs.slice(0, Number(args.limit));
      return runs;
    },

    get_workflow_run: ({ runId } = {}) => {
      requireRunsBackend(stores, 'get_workflow_run');
      const run = stores.runs.getRun(runId);
      if (!run) throw new Error(`Workflow run not found: ${runId}`);
      return run;
    },

    list_workflow_jobs: (args = {}) => {
      requireRunsBackend(stores, 'list_workflow_jobs');
      return stores.runs.getJobs(args.runId || null);
    },

    cancel_workflow_run: ({ runId, reason } = {}) => {
      requireRunsBackend(stores, 'cancel_workflow_run');
      return stores.runs.cancelRun(runId, reason || 'Cancelled via MCP');
    },

    list_prospects: (args = {}) => {
      const filters = {};
      if (args.accountId) filters.accountId = args.accountId;
      if (args.agentId) filters.agentId = args.agentId;
      if (args.state) filters.state = args.state;
      if (args.workflowId) filters.workflowId = args.workflowId;
      let prospects = stores.prospects.getAllProspects(filters);
      if (args.limit) prospects = prospects.slice(0, Number(args.limit));
      return prospects;
    },

    get_prospect: ({ prospectId } = {}) => {
      const prospect = stores.prospects.getProspect(prospectId);
      if (!prospect) throw new Error(`Prospect not found: ${prospectId}`);
      return prospect;
    },

    enrich_prospect_email: async (args = {}) => {
      if (args.prospectId) {
        return stores.emailFinder.enrichProspect(args.prospectId, {
          overwrite: args.overwrite === true,
          domain: args.domain || null
        });
      }
      // Standalone lookup without a prospect
      const enrichment = await stores.emailFinder.enrichInput({
        firstName: args.firstName || null,
        lastName: args.lastName || null,
        fullName: args.fullName || null,
        companyName: args.companyName || null,
        domain: args.domain || null,
        linkedinProfileUrl: args.linkedinProfileUrl || null
      });
      return { prospect: null, enrichment };
    },

    list_groups: () =>
      stores.groups.getAllGroups(),

    get_apollo_integration: () =>
      stores.apollo.getIntegration(),

    configure_apollo_integration: (args = {}) =>
      stores.apollo.configureIntegration(args),

    list_apollo_sequences: (args = {}) =>
      stores.apollo.listSequences(args),

    list_apollo_email_accounts: () =>
      stores.apollo.listEmailAccounts(),

    list_apollo_api_capabilities: () =>
      stores.apollo.listApiCapabilities(),

    call_apollo_api: (args = {}) =>
      stores.apollo.callApi(args),

    search_apollo_people: (args = {}) =>
      stores.apollo.searchPeople(args),

    search_apollo_contacts: (args = {}) =>
      stores.apollo.searchContacts(args),

    search_apollo_accounts: (args = {}) =>
      stores.apollo.searchAccounts(args),

    get_apollo_account: (args = {}) =>
      stores.apollo.getAccount(args),

    create_apollo_account: (args = {}) =>
      stores.apollo.createAccount(args),

    update_apollo_account: (args = {}) =>
      stores.apollo.updateAccount(args),

    list_apollo_users: (args = {}) =>
      stores.apollo.listUsers(args),

    list_apollo_labels: () =>
      stores.apollo.listLabels(),

    list_apollo_fields: () =>
      stores.apollo.listFields(),

    list_apollo_contact_stages: () =>
      stores.apollo.listContactStages(),

    update_apollo_contact_stages: (args = {}) =>
      stores.apollo.updateContactStages(args),

    update_apollo_contact_owners: (args = {}) =>
      stores.apollo.updateContactOwners(args),

    bulk_create_apollo_contacts: (args = {}) =>
      stores.apollo.bulkCreateContacts(args),

    bulk_update_apollo_contacts: (args = {}) =>
      stores.apollo.bulkUpdateContacts(args),

    search_apollo_deals: (args = {}) =>
      stores.apollo.searchDeals(args),

    get_apollo_deal: (args = {}) =>
      stores.apollo.getDeal(args),

    create_apollo_deal: (args = {}) =>
      stores.apollo.createDeal(args),

    update_apollo_deal: (args = {}) =>
      stores.apollo.updateDeal(args),

    list_apollo_deal_stages: () =>
      stores.apollo.listDealStages(),

    search_apollo_tasks: (args = {}) =>
      stores.apollo.searchTasks(args),

    create_apollo_task: (args = {}) =>
      stores.apollo.createTask(args),

    bulk_create_apollo_tasks: (args = {}) =>
      stores.apollo.bulkCreateTasks(args),

    create_apollo_call_record: (args = {}) =>
      stores.apollo.createCallRecord(args),

    search_apollo_calls: (args = {}) =>
      stores.apollo.searchCalls(args),

    update_apollo_call_record: (args = {}) =>
      stores.apollo.updateCallRecord(args),

    update_apollo_sequence_contact_status: (args = {}) =>
      stores.apollo.updateSequenceContactStatus(args),

    activate_apollo_sequence: (args = {}) =>
      stores.apollo.activateSequence(args),

    list_apollo_bindings: (args = {}) =>
      stores.apollo.listBindings(args),

    save_apollo_binding: (args = {}) =>
      stores.apollo.saveBinding(args),

    delete_apollo_binding: (args = {}) =>
      stores.apollo.deleteBinding(args),

    sync_prospects_to_apollo_sequence: (args = {}) =>
      stores.apollo.syncProspectsToSequence(args),

    sync_workflow_to_apollo_sequence: (args = {}) =>
      stores.apollo.syncWorkflowToSequence(args),

    sync_group_to_apollo_sequence: (args = {}) =>
      stores.apollo.syncGroupToSequence(args),

    get_apollo_sync_status: (args = {}) =>
      stores.apollo.listSyncStatus(args),

    list_scheduled_posts: (args = {}) => {
      requirePostsBackend(stores, 'list_scheduled_posts');
      let posts = stores.posts.getAllPosts();
      if (args.accountId) posts = posts.filter((p) => p.accountId === args.accountId);
      if (args.agentId) posts = posts.filter((p) => p.agentId === args.agentId);
      if (args.status) posts = posts.filter((p) => p.status === args.status);
      return posts;
    },

    save_scheduled_posts: async ({ accountId = null, posts = [] } = {}) => {
      requirePostsBackend(stores, 'save_scheduled_posts');
      const targetAccountId = resolveScheduledPostsAccountId(accountId, posts);
      let nextPosts = Array.isArray(posts) ? posts : [];
      let syncSummary = null;

      if (targetAccountId) {
        const createLinkedInSession = services.createScheduledPostSyncSession
          ? async () => services.createScheduledPostSyncSession(targetAccountId)
          : async () => {
              const credentials = await loadLinkedInAccountCredentialsForSync(targetAccountId);
              if (!credentials) {
                return null;
              }
              return createLinkedInScheduledPostSession(credentials);
            };

        const syncResult = await syncScheduledPostsForAccount({
          existingPosts: stores.posts.getAllPosts({ accountId: targetAccountId }),
          desiredPosts: nextPosts,
          createLinkedInSession,
          emitLog: services.emitLog || (() => {})
        });
        nextPosts = syncResult.posts;
        syncSummary = syncResult.summary;
      }

      if (targetAccountId) {
        stores.posts.replacePostsForAccount(targetAccountId, nextPosts);
      } else {
        stores.posts.replaceAllPosts(nextPosts);
      }
      return {
        saved: nextPosts.length,
        accountId: targetAccountId || null,
        syncSummary
      };
    },

    get_analytics: (args = {}) => {
      const filters = normalizeAnalyticsFilters(args);
      return {
        ...stores.analytics.getOverview(filters),
        accountHealth: stores.analytics.getAccountHealthBreakdown(filters),
        stepOutcomeBreakdown: stores.analytics.getStepOutcomeBreakdown(filters),
        funnel: stores.analytics.getFunnelAnalytics(filters),
        variantPerformance: stores.analytics.getVariantPerformance(filters),
        timeToReply: stores.analytics.getTimeToReply(filters),
        timeToAccept: stores.analytics.getTimeToAccept(filters),
        weeklyTrends: stores.analytics.getWeeklyTrends(filters)
      };
    },

    list_notifications: (args = {}) =>
      stores.monitor.getNotifications(args),

    list_linkedin_accounts: () => {
      const path = require('path');
      const filePath = path.join(getConnectAbilityAppStateDir(), 'linkedin-accounts.json');
      const data = readJsonFile(filePath, { accounts: [] });
      const accounts = (data.accounts || []).map(({ id, name, email, createdAt, updatedAt }) => ({
        id, name, email, createdAt, updatedAt
      }));
      return { accounts, activeAccountId: data.activeAccountId || null };
    },

    get_account_health: () =>
      stores.health.getAllAccountHealth(),

    get_runtime_logs: (args = {}) =>
      stores.logs.getEntries(args),

    read_agent_persona: (args = {}) => {
      const { agentId, fileName } = args;
      if (fileName) {
        const content = stores.personas.readFile(agentId, fileName);
        const status = stores.personas.getStatus(agentId);
        return { files: content !== null ? { [fileName]: content } : {}, status };
      }
      const files = stores.personas.readAll(agentId);
      const status = stores.personas.getStatus(agentId);
      return { files, status };
    },

    write_agent_persona: ({ agentId, fileName, content } = {}) =>
      stores.personas.writeFile(agentId, fileName, content),

    get_agent_persona_status: ({ agentId } = {}) =>
      stores.personas.getStatus(agentId),

    get_daily_report: (args = {}) => {
      if (!args.agentId) throw new Error('agentId is required');
      return stores.reportService.generateReport(args.agentId, {
        date: args.date,
        from: args.from,
        to: args.to,
        timezone: args.timezone
      });
    },

    list_activity_events: (args = {}) => {
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 500));
      let events = stores.analytics.getEvents({
        agentId: args.agentId || null,
        accountId: args.accountId || null,
        workflowId: args.workflowId || null,
        since: args.since || null,
        until: args.until || null
      });
      if (args.eventType) events = events.filter((e) => e.type === args.eventType);
      return events.slice(0, limit);
    },

    schedule_daily_report: (args = {}) =>
      stores.schedules.saveSchedule(args),

    list_report_schedules: (args = {}) =>
      stores.schedules.getAllSchedules(args),

    delete_report_schedule: ({ scheduleId } = {}) =>
      stores.schedules.deleteSchedule(scheduleId),

    run_linkedin_action: (args = {}) => {
      requireRunsBackend(stores, 'run_linkedin_action');
      const profileUrl = String(args.profileUrl || '').trim();
      const accountId = String(args.accountId || '').trim();
      const actionType = String(args.actionType || '').trim();
      const message = String(args.message || '').trim() || null;
      const agentId = String(args.agentId || '').trim() || null;

      if (!profileUrl) throw new Error('profileUrl is required');
      if (!accountId) throw new Error('accountId is required');

      const validActions = ['view_profile', 'send_connection', 'send_dm', 'like_posts', 'follow_profile'];
      if (!validActions.includes(actionType)) {
        throw new Error(`actionType must be one of: ${validActions.join(', ')}`);
      }

      // Do-not-contact enforcement: applies to ALL five actions including
      // view_profile (DNC means "no touch", not just "no message"). The lookup
      // is cross-account by design — a person who opted out via one account
      // should not be reached from a different one. Returns a structured skip
      // result without creating any workflow run.
      const blocked = findBlockedRelatedProspect(stores, profileUrl);
      if (blocked) {
        return buildDoNotContactSkipResult({
          summary: blocked.summary,
          prospect: blocked.prospect,
          profileUrl,
          accountId,
          actionType
        });
      }

      const accountsStore = readLinkedInAccountsStore();
      const account = Array.isArray(accountsStore.accounts)
        ? accountsStore.accounts.find((a) => String(a?.id || '').trim() === accountId)
        : null;
      const accountName = account ? String(account.name || account.email || accountId) : accountId;

      let agentName = null;
      if (agentId) {
        const agent = stores.agents.getAgent(agentId);
        agentName = agent ? agent.name : null;
      }

      const { run, jobs } = stores.runs.createRun(buildImmediateOneShotRunInput({
        actionType,
        message,
        accountId,
        accountName,
        agentId,
        agentName,
        profileUrl
      }));

      return {
        ok: true,
        runId: run.id,
        jobId: jobs[0] ? jobs[0].id : null,
        accountId,
        actionType,
        profileUrl,
        status: 'queued',
        bypassWorkingHours: true,
        headless: false,
        message: 'Action queued for immediate manual execution. The visible-browser scheduler will pick it up on its next tick (normally within 15 seconds).'
      };
    }
  };
}

// ─── Background report runner ──────────────────────────────────────────────────

function startReportRunner(stores) {
  async function run() {
    try {
      const due = stores.schedules.getSchedulesDue(new Date());
      for (const sched of due) {
        try {
          stores.reportService.generateReport(sched.agentId, { timezone: sched.timezone });
          stores.schedules.markScheduleRan(sched.id, new Date().toISOString());
          process.stderr.write(`[report-runner] Report generated for ${sched.agentName || sched.agentId}\n`);
        } catch (err) {
          process.stderr.write(`[report-runner] Error for schedule ${sched.id}: ${err.message}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[report-runner] Unexpected error: ${err.message}\n`);
    }
  }

  run(); // check immediately on startup
  return setInterval(run, 15 * 60 * 1000); // every 15 minutes
}

// ─── HTTP server ───────────────────────────────────────────────────────────────

function checkAuth(req, token) {
  // Precondition: resolveHttpAuthConfig() has already decided whether an empty
  // token is allowed. Reaching this helper with token='' means explicit
  // localhost unauthenticated mode, so requests should pass through.
  if (!token) return true;
  return extractApiAuthToken(req) === token;
}

function resolveHttpAuthConfig(token, options = {}) {
  const normalizedToken = String(token || '').trim();
  const allowUnauthenticated = options.allowUnauthenticated === true;

  if (!normalizedToken && !allowUnauthenticated) {
    throw new Error(
      'HTTP API token required. Put it in <app-state>/secrets/api-token (chmod 600), pass --token <value>, '
      + 'or set CONNECT_API_TOKEN=<value> AND CONNECT_ALLOW_ENV_CREDENTIALS=1 for a dev escape hatch. '
      + 'For explicit local-only development without auth, set CONNECT_API_ALLOW_UNAUTHENTICATED_LOCALHOST=true or pass --allow-unauthenticated-localhost.'
    );
  }

  return {
    token: normalizedToken,
    allowUnauthenticated
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

// ─── MCP SDK Streamable HTTP + legacy SSE transport ─────────────────────────

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const {
  isInitializeRequest,
  ListToolsRequestSchema,
  CallToolRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

/**
 * Create a low-level MCP Server with all TOOL_DEFS registered.
 * Uses the raw Server class (not McpServer) so we can pass JSON Schema
 * directly without requiring Zod.
 */
function createMcpServerInstance(toolHandlers) {
  const mcpServer = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFS.map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema || { type: 'object', properties: {} }
      }))
    };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    const handler = toolHandlers[name];

    if (!handler) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true
      };
    }

    try {
      const result = await Promise.resolve(handler(args));
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }]
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error.message || String(error) }) }],
        isError: true
      };
    }
  });

  return mcpServer;
}

/** Map of sessionId → transport for active MCP sessions. */
const _mcpTransports = {};

/**
 * Handle a Streamable HTTP request on /mcp (POST, GET, DELETE).
 * Stateful: session IDs are used to correlate requests.
 */
async function handleStreamableHttpRequest(req, res, body, toolHandlers) {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && _mcpTransports[sessionId]) {
      const existing = _mcpTransports[sessionId];
      if (existing instanceof StreamableHTTPServerTransport) {
        transport = existing;
      } else {
        return sendJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session uses a different transport protocol' },
          id: null
        });
      }
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          _mcpTransports[sid] = transport;
        }
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && _mcpTransports[sid]) {
          delete _mcpTransports[sid];
        }
      };
      const mcpServer = createMcpServerInstance(toolHandlers);
      await mcpServer.connect(transport);
    } else {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null
      });
    }

    await transport.handleRequest(req, res, body);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
}

/**
 * Handle a legacy SSE connection on GET /sse.
 */
async function handleSseConnect(req, res, toolHandlers) {
  const transport = new SSEServerTransport('/messages', res);
  _mcpTransports[transport.sessionId] = transport;
  res.on('close', () => {
    delete _mcpTransports[transport.sessionId];
  });
  const mcpServer = createMcpServerInstance(toolHandlers);
  await mcpServer.connect(transport);
}

/**
 * Handle a legacy SSE message on POST /messages?sessionId=<id>.
 */
async function handleSseMessage(req, res, body) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const sessionId = parsedUrl.searchParams.get('sessionId');
  const existing = sessionId ? _mcpTransports[sessionId] : null;
  if (existing instanceof SSEServerTransport) {
    await existing.handlePostMessage(req, res, body);
  } else {
    return sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'No SSE transport found for sessionId' },
      id: null
    });
  }
}

// ─── HTTP server ────────────────────────────────────────────────────────────

function sendJsonRpcError(res, statusCode, id, message) {
  return sendJson(res, statusCode, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: id ?? null
  });
}

function createHttpRequestHandler(token, toolHandlers, startedAt, options = {}) {
  const auth = resolveHttpAuthConfig(token, options);
  const platformWritePolicy = resolvePlatformWritePolicy(options);
  return async (req, res) => {
    const rawUrl = req.url || '/';
    const url = rawUrl.split('?')[0];

    if (url === '/mcp') {
      if (!checkAuth(req, auth.token)) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
      if (req.method === 'POST') {
        const body = await readBody(req).catch(() => null);
        if (body?.method === 'tools/call') {
          try {
            authorizeToolCall(body?.params?.name, body?.params?.arguments || {}, platformWritePolicy, {
              transport: 'mcp-http',
              req
            });
          } catch (error) {
            return sendJsonRpcError(res, error.statusCode || 403, body?.id, error.message || String(error));
          }
        }
        return handleStreamableHttpRequest(req, res, body, toolHandlers);
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        return handleStreamableHttpRequest(req, res, undefined, toolHandlers);
      }
      return sendJsonRpcError(res, 405, null, 'Method not allowed');
    }

    if (req.method === 'GET' && url === '/sse') {
      if (!checkAuth(req, auth.token)) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
      return handleSseConnect(req, res, toolHandlers);
    }

    if (req.method === 'POST' && url === '/messages') {
      if (!checkAuth(req, auth.token)) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
      const body = await readBody(req).catch(() => null);
      if (body?.method === 'tools/call') {
        try {
          authorizeToolCall(body?.params?.name, body?.params?.arguments || {}, platformWritePolicy, {
            transport: 'mcp-sse',
            req
          });
        } catch (error) {
          return sendJsonRpcError(res, error.statusCode || 403, body?.id, error.message || String(error));
        }
      }
      return handleSseMessage(req, res, body);
    }

    // ── Existing REST API endpoints (auth required) ──

    if (!checkAuth(req, auth.token)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    if (req.method === 'GET' && url === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        uptime: Math.floor((Date.now() - startedAt) / 1000)
      });
    }

    if (req.method === 'GET' && url === '/api/functions') {
      return sendJson(res, 200, {
        functions: filterToolNamesByPolicy(Object.keys(toolHandlers), platformWritePolicy)
      });
    }

    if (req.method === 'GET' && url === '/api/schema') {
      return sendJson(res, 200, {
        operations: filterToolDefsByPolicy(TOOL_DEFS, platformWritePolicy).map((def) => ({
          function: def.name,
          description: def.description,
          inputSchema: def.inputSchema
        }))
      });
    }

    if (req.method === 'POST' && url === '/api/call') {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }

      const functionName = String(body?.function || '');
      const rawArgs = body?.args;
      const toolArgs = Array.isArray(rawArgs) ? (rawArgs[0] || {}) : (rawArgs && typeof rawArgs === 'object' ? rawArgs : {});

      if (!toolHandlers[functionName]) {
        return sendJson(res, 404, { ok: false, error: `Unknown function: ${functionName}` });
      }

      try {
        authorizeToolCall(functionName, toolArgs, platformWritePolicy, {
          transport: 'http-rest',
          req
        });
        const result = await invokeToolHandler(toolHandlers, functionName, toolArgs);
        return sendJson(res, 200, { ok: true, result });
      } catch (error) {
        const statusCode = error instanceof ToolAccessError
          ? (error.statusCode || 403)
          : 200;
        return sendJson(res, statusCode, { ok: false, error: error.message || String(error) });
      }
    }

    sendJson(res, 404, { ok: false, error: `Not found: ${req.method} ${url}` });
  };
}

function startHttpServer(port, token, toolHandlers, startedAt, options = {}) {
  const handler = createHttpRequestHandler(token, toolHandlers, startedAt, options);
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// ─── MCP stdio protocol (JSON-RPC 2.0) ─────────────────────────────────────────

function mcpWrite(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function mcpResponse(id, result) {
  mcpWrite({ jsonrpc: '2.0', id, result });
}

function mcpError(id, code, message) {
  mcpWrite({ jsonrpc: '2.0', id, error: { code, message } });
}

function startStdio(toolHandlers, options = {}) {
  const platformWritePolicy = resolvePlatformWritePolicy(options);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (_) {
      return; // Ignore malformed lines
    }

    const { id, method, params } = msg;

    if (method === 'initialize') {
      return mcpResponse(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} }
      });
    }

    // Notification — no response
    if (method === 'notifications/initialized') return;

    if (method === 'tools/list') {
      return mcpResponse(id, {
        tools: filterToolDefsByPolicy(TOOL_DEFS, platformWritePolicy).map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema
        }))
      });
    }

    if (method === 'tools/call') {
      const toolName = String(params?.name || '');
      const toolArgs = params?.arguments || {};

      try {
        authorizeToolCall(toolName, toolArgs, platformWritePolicy, {
          transport: 'stdio'
        });
        const result = await invokeToolHandler(toolHandlers, toolName, toolArgs);
        return mcpResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        });
      } catch (error) {
        if (error instanceof ToolAccessError && error.code === 'unknown_tool') {
          return mcpError(id, -32601, error.message);
        }
        return mcpResponse(id, {
          content: [{ type: 'text', text: `Error: ${error.message || String(error)}` }],
          isError: true
        });
      }
    }

    if (method === 'ping') {
      return mcpResponse(id, {});
    }

    // Unknown method with a response id
    if (id !== undefined && id !== null) {
      mcpError(id, -32601, `Method not found: ${method}`);
    }
  });

  return () => rl.close();
}

// ─── Public API (used by tests and main) ──────────────────────────────────────

function createServer(options = {}) {
  const createServerOptions = options;
  const stores = options.stores || buildDefaultStores();
  const recordTelemetryEvent = typeof stores.events?.append === 'function'
    ? (eventInput) => stores.events.append(eventInput)
    : null;
  const toolHandlers = buildToolHandlers(stores, {
    createScheduledPostSyncSession: options.createScheduledPostSyncSession,
    emitLog: options.emitLog
  });
  const startedAt = options.startedAt || Date.now();
  let reportRunnerTimer = null;

  return {
    toolHandlers,
    toolDefs: TOOL_DEFS,

    createHttpHandler(token, options = {}) {
      return createHttpRequestHandler(
        token || '',
        toolHandlers,
        startedAt,
        {
          ...options,
          platformWriteToken: options.platformWriteToken ?? createServerOptions.platformWriteToken,
          auditLogPath: options.auditLogPath ?? createServerOptions.auditLogPath,
          recordTelemetryEvent: options.recordTelemetryEvent ?? createServerOptions.recordTelemetryEvent ?? recordTelemetryEvent,
          platformWriteRateLimitPerMinute:
            options.platformWriteRateLimitPerMinute
            ?? createServerOptions.platformWriteRateLimitPerMinute,
          sqliteAvailable: stores.sqliteAvailable !== false,
          // postsAvailable mirrors stores.posts presence so the discovery
          // filters hide list_scheduled_posts when the partial-bind state
          // left stores.posts === null. Same threading shape as sqliteAvailable.
          postsAvailable: stores.posts !== null && stores.posts !== undefined
        }
      );
    },

    startHttp(port, token, options = {}) {
      return startHttpServer(
        port !== undefined ? port : DEFAULT_PORT,
        token || '',
        toolHandlers,
        startedAt,
        {
          ...options,
          platformWriteToken: options.platformWriteToken ?? createServerOptions.platformWriteToken,
          auditLogPath: options.auditLogPath ?? createServerOptions.auditLogPath,
          recordTelemetryEvent: options.recordTelemetryEvent ?? createServerOptions.recordTelemetryEvent ?? recordTelemetryEvent,
          platformWriteRateLimitPerMinute:
            options.platformWriteRateLimitPerMinute
            ?? createServerOptions.platformWriteRateLimitPerMinute,
          sqliteAvailable: stores.sqliteAvailable !== false,
          // postsAvailable mirrors stores.posts presence so the discovery
          // filters hide list_scheduled_posts when the partial-bind state
          // left stores.posts === null. Same threading shape as sqliteAvailable.
          postsAvailable: stores.posts !== null && stores.posts !== undefined
        }
      );
    },

    startStdio(stdioOptions = {}) {
      return startStdio(toolHandlers, {
        ...stdioOptions,
        platformWriteToken: stdioOptions.platformWriteToken ?? options.platformWriteToken,
        recordTelemetryEvent: stdioOptions.recordTelemetryEvent ?? options.recordTelemetryEvent ?? recordTelemetryEvent,
        allowStdioPlatformWrites: stdioOptions.allowStdioPlatformWrites
          ?? options.allowStdioPlatformWrites
          ?? isTruthyEnvFlag(process.env.CONNECT_STDIO_PLATFORM_WRITES),
        auditLogPath: stdioOptions.auditLogPath ?? options.auditLogPath,
        platformWriteRateLimitPerMinute:
          stdioOptions.platformWriteRateLimitPerMinute
          ?? options.platformWriteRateLimitPerMinute,
        sqliteAvailable: stores.sqliteAvailable !== false
      });
    },

    startReportRunner() {
      if (stores.schedules && stores.reportService) {
        reportRunnerTimer = startReportRunner(stores);
      }
      return reportRunnerTimer;
    },

    stopReportRunner() {
      if (reportRunnerTimer) {
        clearInterval(reportRunnerTimer);
        reportRunnerTimer = null;
      }
    }
  };
}

// ─── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const stdioOnly = argv.includes('--stdio-only');
  const httpOnly = argv.includes('--http-only');

  const portIndex = argv.indexOf('--port');
  const port = portIndex >= 0 ? (Number(argv[portIndex + 1]) || DEFAULT_PORT) : DEFAULT_PORT;

  const tokenIndex = argv.indexOf('--token');
  const cliToken = tokenIndex >= 0 ? (argv[tokenIndex + 1] || '') : '';
  // Token resolution order (per CONNECT secrets hardening):
  //   1. --token CLI flag (explicit, transient)
  //   2. <app-state>/secrets/api-token  (0600 file, persistent)
  //   3. CONNECT_API_TOKEN env var      (only if CONNECT_ALLOW_ENV_CREDENTIALS=1)
  // This is the only place the API token enters the process. Adding a
  // fourth source means editing this block — there is no other fallback.
  const apiTokenFilePath = path.join(getConnectAbilityAppStateDir(), 'secrets', 'api-token');
  const resolvedApiToken = resolveSecret({
    name: 'CONNECT_API_TOKEN',
    explicit: cliToken,
    filePath: apiTokenFilePath,
    envVarName: 'CONNECT_API_TOKEN'
  });
  const token = resolvedApiToken ? resolvedApiToken.value : '';
  if (resolvedApiToken) {
    process.stderr.write(
      `[connect-mcp-server] CONNECT_API_TOKEN loaded from ${resolvedApiToken.source}\n`
    );
  }
  const allowUnauthenticatedLocalhost =
    argv.includes('--allow-unauthenticated-localhost') ||
    isTruthyEnvFlag(process.env.CONNECT_API_ALLOW_UNAUTHENTICATED_LOCALHOST);

  const server = createServer();
  server.startReportRunner();

  if (!stdioOnly) {
    try {
      const httpServer = await server.startHttp(port, token, {
        allowUnauthenticated: allowUnauthenticatedLocalhost
      });
      const address = httpServer.address();
      process.stderr.write(`[connect-mcp-server] HTTP API listening on http://127.0.0.1:${address.port}\n`);
      const shutdown = () => { httpServer.close(); process.exit(0); };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    } catch (error) {
      process.stderr.write(`[connect-mcp-server] Failed to start HTTP server on port ${port}: ${error.message}\n`);
      if (httpOnly) process.exit(1);
    }
  }

  if (!httpOnly) {
    server.startStdio();
    process.stderr.write('[connect-mcp-server] MCP stdio transport ready\n');
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[connect-mcp-server] Fatal: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  TOOL_DEFS,
  _private: {
    prunePlatformWriteAuditLog,
    authorizeToolCall,
    resolvePlatformWritePolicy,
    filterToolDefsByPolicy,
    filterToolNamesByPolicy,
    requireRunsBackend,
    requirePostsBackend,
    findBlockedRelatedProspect,
    buildDoNotContactSkipResult,
    buildImmediateOneShotRunInput,
    _resetDoNotContactWarningStateForTests,
    CANONICAL_BACKEND_TOOL_NAMES,
    POSTS_BACKEND_TOOL_NAMES,
    PLATFORM_WRITE_TOOL_NAMES,
    buildDefaultStores
  }
};
