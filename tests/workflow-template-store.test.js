const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const WorkflowTemplateStore = require('../workflow-template-store');
const { mergeLegacyWorkflowUpdate } = require('../workflow-template-store');
const { createTempWorkspace } = require('./test-helpers');

test('WorkflowTemplateStore migrates legacy workflow files into the durable store', () => {
  const workspace = createTempWorkspace('workflow-template-store-legacy-');
  try {
    const legacyDir = workspace.path('legacy-workflows');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, '123.json'), JSON.stringify({
      id: '123',
      name: 'Legacy Workflow',
      description: 'Imported from Documents',
      profileIds: ['https://www.linkedin.com/in/jane-doe/'],
      actions: {
        viewProfile: true,
        likePosts: true,
        sendConnection: false,
        sendDm: false
      },
      status: 'pending',
      progress: {
        completed: 0,
        total: 1
      },
      created: '2026-03-20T10:00:00.000Z'
    }, null, 2));

    const store = new WorkflowTemplateStore({
      storePath: workspace.path('workflow-templates.json'),
      legacyWorkflowsDir: legacyDir
    });

    const workflows = store.getLegacyWorkflows();
    assert.equal(workflows.length, 1);
    assert.equal(workflows[0].id, '123');
    assert.equal(workflows[0].name, 'Legacy Workflow');
    assert.deepEqual(workflows[0].profileIds, ['https://www.linkedin.com/in/jane-doe/']);
    assert.equal(workflows[0].created, '2026-03-20T10:00:00.000Z');
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowTemplateStore persists and updates automation workflow templates', () => {
  const workspace = createTempWorkspace('workflow-template-store-automation-');
  try {
    const store = new WorkflowTemplateStore({
      storePath: workspace.path('workflow-templates.json'),
      legacyWorkflowsDir: workspace.path('legacy-workflows')
    });

    const saved = store.saveAutomationWorkflow({
      id: 'wf_automation_1',
      name: 'Customer Success Sequence',
      description: 'Core outreach flow',
      agentId: 'agent-1',
      target: {
        type: 'manual',
        label: 'Manual Names (2)',
        names: ['Jane Doe', 'John Doe']
      },
      steps: [
        { order: 1, type: 'view_profile', minDelayMs: 8000, maxDelayMs: 18000 },
        { order: 2, type: 'delay', delayValue: 2, delayUnit: 'days', minDelayMs: 172800000, maxDelayMs: 172800000 },
        { order: 3, type: 'send_dm', messageTemplate: 'Hello there', minDelayMs: 8000, maxDelayMs: 18000 }
      ],
      headless: true
    });

    assert.equal(saved.kind, 'automation');
    assert.equal(saved.steps.length, 3);
    assert.equal(saved.target.type, 'manual');

    const updated = store.updateAutomationWorkflow(saved.id, {
      lastRunAt: '2026-03-21T12:30:00.000Z',
      name: 'Customer Success Sequence Updated'
    });

    assert.equal(updated.name, 'Customer Success Sequence Updated');
    assert.equal(updated.lastRunAt, '2026-03-21T12:30:00.000Z');

    const loaded = store.getAutomationWorkflows();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, saved.id);
    assert.equal(loaded[0].agentId, 'agent-1');
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowTemplateStore updates legacy workflow membership in durable storage', () => {
  const workspace = createTempWorkspace('workflow-template-store-update-');
  try {
    const store = new WorkflowTemplateStore({
      storePath: workspace.path('workflow-templates.json'),
      legacyWorkflowsDir: workspace.path('legacy-workflows')
    });

    const saved = store.saveLegacyWorkflow({
      id: 'wf_legacy_1',
      name: 'Legacy Member Workflow',
      profileIds: ['https://www.linkedin.com/in/jane-doe/'],
      actions: {
        viewProfile: true
      }
    });

    const updated = store.addProfilesToLegacyWorkflow(saved.id, [
      'https://www.linkedin.com/in/jane-doe/',
      'https://www.linkedin.com/in/john-doe/'
    ]);

    assert.deepEqual(updated.profileIds, [
      'https://www.linkedin.com/in/jane-doe/',
      'https://www.linkedin.com/in/john-doe/'
    ]);
    assert.equal(updated.progress.total, 2);
  } finally {
    workspace.cleanup();
  }
});

test('WorkflowTemplateStore updates a legacy workflow in place without duplicating', () => {
  const workspace = createTempWorkspace('workflow-template-store-update-in-place-');
  try {
    const store = new WorkflowTemplateStore({
      storePath: workspace.path('workflow-templates.json'),
      legacyWorkflowsDir: workspace.path('legacy-workflows')
    });

    const saved = store.saveLegacyWorkflow({
      id: 'wf_legacy_edit_1',
      name: 'Original Workflow',
      description: 'Before edit',
      profileIds: [
        'https://www.linkedin.com/in/theo-marchetti/',
        'https://www.linkedin.com/in/nkarlsson/'
      ],
      actions: {
        viewProfile: true,
        likePosts: true,
        sendConnection: false,
        sendDm: false
      },
      settings: {
        steps: [
          { type: 'view_profile' },
          { type: 'like_posts' }
        ]
      },
      progress: {
        completed: 1,
        total: 2
      }
    });

    const updated = store.updateLegacyWorkflow(saved.id, (existing) => ({
      ...existing,
      name: 'Edited Workflow',
      actions: {
        ...existing.actions,
        likePosts: false,
        sendConnection: true
      },
      settings: {
        ...existing.settings,
        steps: [
          { type: 'view_profile' },
          { type: 'send_connection' }
        ]
      }
    }));

    assert.equal(updated.id, saved.id);
    assert.equal(updated.name, 'Edited Workflow');
    assert.equal(updated.actions.viewProfile, true);
    assert.equal(updated.actions.likePosts, false);
    assert.equal(updated.actions.sendConnection, true);
    assert.deepEqual(updated.settings.steps, [
      { type: 'view_profile' },
      { type: 'send_connection' }
    ]);

    const workflows = store.getLegacyWorkflows();
    assert.equal(workflows.length, 1, 'edit must update existing record, not create a duplicate workflow');
    assert.equal(workflows[0].id, saved.id);
    assert.equal(workflows[0].name, 'Edited Workflow');
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// mergeLegacyWorkflowUpdate — null-guard (P3 hardening)
// ---------------------------------------------------------------------------

test('mergeLegacyWorkflowUpdate: null/array actions or settings do NOT clobber existing', () => {
  const existing = {
    id: 'wf_1',
    name: 'Original',
    actions: { viewProfile: true, likePosts: true, sendConnection: false },
    settings: { steps: [{ type: 'view_profile' }], note: 'keep' }
  };

  // null must be ignored — existing preserved (not reset to all-false / {}).
  const a = mergeLegacyWorkflowUpdate(existing, { actions: null, settings: null });
  assert.deepEqual(a.actions, existing.actions, 'null actions preserves existing');
  assert.deepEqual(a.settings, existing.settings, 'null settings preserves existing');

  // array (malformed) is also ignored.
  const b = mergeLegacyWorkflowUpdate(existing, { actions: ['nope'], settings: ['nope'] });
  assert.deepEqual(b.actions, existing.actions, 'array actions preserves existing');
  assert.deepEqual(b.settings, existing.settings, 'array settings preserves existing');
});

test('mergeLegacyWorkflowUpdate: valid object partial deep-merges (omitted keys kept)', () => {
  const existing = {
    id: 'wf_1',
    name: 'Original',
    actions: { viewProfile: true, likePosts: true, sendConnection: false, sendDm: false },
    settings: { steps: [{ type: 'view_profile' }], note: 'keep' }
  };
  const merged = mergeLegacyWorkflowUpdate(existing, {
    name: 'Edited',
    actions: { likePosts: false, sendConnection: true },
    settings: { steps: [{ type: 'send_connection' }] }
  });
  assert.equal(merged.name, 'Edited');
  // viewProfile/sendDm preserved; likePosts/sendConnection overridden.
  assert.deepEqual(merged.actions, { viewProfile: true, likePosts: false, sendConnection: true, sendDm: false });
  // settings deep-merged: steps overridden, note kept.
  assert.deepEqual(merged.settings, { steps: [{ type: 'send_connection' }], note: 'keep' });
  assert.equal(merged.id, 'wf_1', 'id preserved');
});

test('mergeLegacyWorkflowUpdate: omitted actions/settings keep existing via spread; bad inputs throw', () => {
  const existing = { id: 'wf_1', actions: { viewProfile: true }, settings: { note: 'x' } };
  const merged = mergeLegacyWorkflowUpdate(existing, { name: 'Only name changed' });
  assert.deepEqual(merged.actions, { viewProfile: true });
  assert.deepEqual(merged.settings, { note: 'x' });
  assert.equal(merged.name, 'Only name changed');

  assert.throws(() => mergeLegacyWorkflowUpdate(null, {}), /Existing workflow is required/);
  assert.throws(() => mergeLegacyWorkflowUpdate({}, null), /update payload must be an object/);
  assert.throws(() => mergeLegacyWorkflowUpdate({}, ['x']), /update payload must be an object/);
});

test('mergeLegacyWorkflowUpdate: a stray updates.id cannot change the workflow identity', () => {
  const existing = { id: 'wf_keep', name: 'Original' };
  const merged = mergeLegacyWorkflowUpdate(existing, { id: 'wf_attacker', name: 'Edited' });
  assert.equal(merged.id, 'wf_keep', 'id is immutable across an update');
  assert.equal(merged.name, 'Edited');
});
