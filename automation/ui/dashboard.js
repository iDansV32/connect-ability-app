// ui/dashboard.js
const { logAction, logError } = require('../util/log');

async function createProfileDashboard(page) {
  // Placeholder minimal shell (the full UI can be expanded as needed)
  try {
    await page.evaluate(() => {
      const root = document.createElement('div');
      root.id = 'ca-dashboard-root';
      root.style.cssText = 'position:fixed;bottom:16px;right:16px;width:420px;height:520px;background:#fff;border:1px solid #ddd;border-radius:12px;z-index:999999;box-shadow:0 8px 24px rgba(0,0,0,.12);overflow:hidden;';
      root.innerHTML = '<iframe title="Dashboard" style="width:100%;height:100%;border:0"></iframe>';
      document.body.appendChild(root);
    });
    logAction('createProfileDashboard mounted');
    return true;
  } catch (e) {
    logError('createProfileDashboard failed', e);
    return false;
  }
}

async function renderWorkflowDashboard(page) {
  // Minimal placeholder
  return createProfileDashboard(page);
}

async function openWorkflowManager(page) {
  return createProfileDashboard(page);
}

async function openProfileDashboard(page) {
  return createProfileDashboard(page);
}

module.exports = { createProfileDashboard, renderWorkflowDashboard, openWorkflowManager, openProfileDashboard };
