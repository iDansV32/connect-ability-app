'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ActivityEventStore = require('../activity-event-store');
const { _private: mcpPrivate } = require('../connect-mcp-server');
const { _private: runtimeLogPrivate } = require('../runtime-log-store');
const { TELEMETRY_RETENTION_DECLARATIONS } = require('../telemetry-retention-policy');

const RETENTION_DOC_PATH = path.join(__dirname, '..', 'docs', 'telemetry-retention.md');

function declarationCoversEvent(declaration, eventType) {
  if (Array.isArray(declaration.eventTypes) && declaration.eventTypes.includes(eventType)) {
    return true;
  }

  if (Array.isArray(declaration.eventPrefixes)) {
    return declaration.eventPrefixes.some((prefix) => eventType.startsWith(prefix));
  }

  return false;
}

test('telemetry retention declarations cover every allowed activity event type', () => {
  const uncovered = [...ActivityEventStore.ALLOWED_EVENT_TYPES].filter((eventType) => {
    return !TELEMETRY_RETENTION_DECLARATIONS.some((declaration) => declarationCoversEvent(declaration, eventType));
  });

  assert.deepEqual(
    uncovered,
    [],
    `Every activity event type must map to a declared telemetry retention class. Uncovered: ${uncovered.join(', ')}`
  );
});

test('telemetry retention declarations are all represented in the policy doc', () => {
  const docText = fs.readFileSync(RETENTION_DOC_PATH, 'utf8');

  for (const declaration of TELEMETRY_RETENTION_DECLARATIONS) {
    assert.match(
      docText,
      new RegExp(escapeRegExp(declaration.docLabel)),
      `Expected retention doc to include row for: ${declaration.docLabel}`
    );
  }
});

test('every enforced retention class has a live prune owner', () => {
  const pruneOwnerChecks = {
    activity_events: () => typeof ActivityEventStore.prototype.pruneRetainedRawEvents === 'function',
    mcp_audit_log: () => typeof mcpPrivate.prunePlatformWriteAuditLog === 'function',
    runtime_logs: () => typeof runtimeLogPrivate.pruneLogFile === 'function'
  };

  for (const declaration of TELEMETRY_RETENTION_DECLARATIONS) {
    if (!declaration.enforcedPruneOwner) {
      continue;
    }

    const check = pruneOwnerChecks[declaration.enforcedPruneOwner];
    assert.equal(
      typeof check,
      'function',
      `Missing prune owner check for declaration ${declaration.id}`
    );
    assert.equal(
      check(),
      true,
      `Declared retention class ${declaration.id} must have a live prune owner`
    );
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
