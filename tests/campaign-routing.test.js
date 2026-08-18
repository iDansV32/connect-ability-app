const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAMPAIGN_MANAGED_STEP_TYPES,
  CAMPAIGN_RUNS_FEATURE_FLAG,
  hasCampaignManagedStep,
  isCampaignRunsEnabled,
  shouldRouteWorkflowToCampaignController
} = require('../campaign-routing');

test('campaign routing helper recognizes campaign-managed steps', () => {
  assert.equal(hasCampaignManagedStep([{ type: 'send_dm' }]), false);
  assert.equal(hasCampaignManagedStep([{ type: 'apollo_enroll_sequence' }]), true);
  assert.equal(CAMPAIGN_MANAGED_STEP_TYPES.has('apollo_enroll_sequence'), true);
});

test('campaign routing helper respects the feature flag boundary', () => {
  assert.equal(isCampaignRunsEnabled({ [CAMPAIGN_RUNS_FEATURE_FLAG]: 'true' }), true);
  assert.equal(isCampaignRunsEnabled({ [CAMPAIGN_RUNS_FEATURE_FLAG]: 'false' }), false);

  assert.equal(
    shouldRouteWorkflowToCampaignController({
      env: { [CAMPAIGN_RUNS_FEATURE_FLAG]: 'false' },
      steps: [{ type: 'apollo_enroll_sequence' }]
    }),
    false
  );

  assert.equal(
    shouldRouteWorkflowToCampaignController({
      env: { [CAMPAIGN_RUNS_FEATURE_FLAG]: 'true' },
      steps: [{ type: 'send_dm' }]
    }),
    false
  );

  assert.equal(
    shouldRouteWorkflowToCampaignController({
      env: { [CAMPAIGN_RUNS_FEATURE_FLAG]: 'true' },
      steps: [{ type: 'send_dm' }, { type: 'apollo_enroll_sequence' }]
    }),
    true
  );
});
