const CAMPAIGN_RUNS_FEATURE_FLAG = 'ENABLE_CAMPAIGN_RUNS';
const CAMPAIGN_MANAGED_STEP_TYPES = new Set(['apollo_enroll_sequence']);

function isEnvTrue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isCampaignRunsEnabled(env = process.env) {
  return isEnvTrue(env?.[CAMPAIGN_RUNS_FEATURE_FLAG]);
}

function hasCampaignManagedStep(steps = []) {
  if (!Array.isArray(steps)) {
    return false;
  }

  return steps.some((step) => CAMPAIGN_MANAGED_STEP_TYPES.has(String(step?.type || '').trim().toLowerCase()));
}

function shouldRouteWorkflowToCampaignController(options = {}) {
  return isCampaignRunsEnabled(options.env || process.env) && hasCampaignManagedStep(options.steps);
}

module.exports = {
  CAMPAIGN_MANAGED_STEP_TYPES,
  CAMPAIGN_RUNS_FEATURE_FLAG,
  hasCampaignManagedStep,
  isCampaignRunsEnabled,
  shouldRouteWorkflowToCampaignController
};
