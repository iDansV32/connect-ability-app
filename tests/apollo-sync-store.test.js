const test = require('node:test');
const assert = require('node:assert/strict');

const ApolloSyncStore = require('../apollo-sync-store');
const { createTempWorkspace } = require('./test-helpers');

test('ApolloSyncStore preserves config and upserts bindings and sync records', () => {
  const workspace = createTempWorkspace('apollo-sync-store-');
  try {
    const store = new ApolloSyncStore({
      storePath: workspace.path('apollo-sync.json')
    });

    const config = store.saveConfig({
      enabled: true,
      defaultSequenceId: 'seq-1',
      defaultSequenceName: 'Outbound Sequence',
      defaultEmailAccountId: 'email-1'
    });
    assert.equal(config.defaultSequenceId, 'seq-1');

    const binding = store.saveBinding({
      targetType: 'workflow',
      targetId: 'wf-1',
      targetName: 'Chief of Staff',
      sequenceId: 'seq-1',
      sequenceName: 'Outbound Sequence'
    });
    assert.equal(binding.targetId, 'wf-1');

    const updatedBinding = store.saveBinding({
      targetType: 'workflow',
      targetId: 'wf-1',
      targetName: 'Chief of Staff Updated',
      sequenceId: 'seq-2',
      sequenceName: 'Follow-Up Sequence'
    });
    assert.equal(updatedBinding.id, binding.id);
    assert.equal(updatedBinding.sequenceId, 'seq-2');

    const record = store.upsertSyncRecord({
      prospectId: 'prospect-1',
      sequenceId: 'seq-2',
      targetType: 'workflow',
      targetId: 'wf-1',
      status: 'enrolled',
      apolloContactId: 'contact-1'
    });
    assert.equal(record.status, 'enrolled');

    const loadedRecord = store.getSyncRecord('prospect-1', 'seq-2');
    assert.equal(loadedRecord.apolloContactId, 'contact-1');
    assert.equal(store.listBindings({ targetType: 'workflow' }).length, 1);
  } finally {
    workspace.cleanup();
  }
});
