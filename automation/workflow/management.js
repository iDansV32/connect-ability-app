// workflow/management.js
const { logAction, logError } = require('../util/log');
const WorkflowTemplateStore = require('../../workflow-template-store');

const workflowTemplateStore = new WorkflowTemplateStore();

function readWorkflow(id) {
  return workflowTemplateStore.getLegacyWorkflow(id);
}

async function createWorkflow(profileIds, workflowName, steps) {
  try {
    const workflow = workflowTemplateStore.saveLegacyWorkflow({
      name: workflowName,
      status: 'pending',
      profileIds,
      settings: {
        steps: Array.isArray(steps) ? steps : []
      },
      progress: { completed: 0, total: profileIds.length }
    });
    logAction(`Workflow created in durable store (${workflow.id})`);
    return workflow;
  } catch (e) { logError('createWorkflow failed', e); return null; }
}

async function startWorkflow(id) {
  try {
    const workflow = workflowTemplateStore.updateLegacyWorkflow(id, {
      status: 'running',
      startedAt: new Date().toISOString()
    });
    if (!workflow) return false;
    logAction(`Starting workflow ${id}`);
    return true;
  } catch (e) {
    logError('startWorkflow failed', e);
    return false;
  }
}
async function pauseWorkflow(id) {
  try {
    const workflow = workflowTemplateStore.updateLegacyWorkflow(id, {
      status: 'paused',
      pausedAt: new Date().toISOString()
    });
    if (!workflow) return false;
    logAction(`Pausing workflow ${id}`);
    return true;
  } catch (e) {
    logError('pauseWorkflow failed', e);
    return false;
  }
}
async function deleteWorkflow(id) {
  try {
    workflowTemplateStore.deleteWorkflow(id);
    logAction(`Deleted workflow ${id}`);
    return true;
  } catch (e) { return false; }
}

module.exports = { createWorkflow, startWorkflow, pauseWorkflow, deleteWorkflow };
