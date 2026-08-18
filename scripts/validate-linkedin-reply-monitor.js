const fs = require('fs');
const path = require('path');
const LinkedInReplyMonitor = require('../linkedin-reply-monitor');
const ActivityEventStore = require('../activity-event-store');
const SdrAgentManager = require('../sdr-agent-manager');
const { resolveLinkedInAccountCredentials } = require('../linkedin-credential-store');
const {
  getConnectAbilityAppStateDir,
  readJsonFile
} = require('../connect-documents');

function getAccountsPath() {
  return path.join(getConnectAbilityAppStateDir(), 'linkedin-accounts.json');
}

function readLinkedInAccounts() {
  const store = readJsonFile(getAccountsPath(), { accounts: [] });
  return Array.isArray(store.accounts) ? store.accounts : [];
}

async function readLinkedInAccountsWithCredentials() {
  const accounts = readLinkedInAccounts();
  const resolved = await Promise.all(accounts.map(async (account) => {
    const credentials = await resolveLinkedInAccountCredentials(account).catch(() => null);
    if (!credentials?.password) {
      return null;
    }
    return {
      ...account,
      password: credentials.password
    };
  }));

  return resolved.filter(Boolean);
}

async function main() {
  const eventStore = new ActivityEventStore();
  const agentManager = new SdrAgentManager();
  const notifications = [];
  const recordedEvents = [];
  const monitor = new LinkedInReplyMonitor({
    readAccounts: readLinkedInAccountsWithCredentials,
    readAgents: () => agentManager.getAllAgents(),
    recordEvent: (event) => {
      const appended = eventStore.append(event);
      recordedEvents.push(appended);
      return appended;
    },
    notify: (notification) => {
      notifications.push(notification);
    }
  });

  const accountsBefore = readLinkedInAccounts().map((account) => ({
    id: account.id,
    name: account.name,
    email: account.email
  }));
  const stateBefore = monitor.getState();
  const stateAfter = await monitor.pollAll();
  const statePath = monitor.statePath;
  const eventsPath = eventStore.eventsPath;

  console.log(JSON.stringify({
    accounts: accountsBefore,
    statePath,
    eventsPath,
    stateBefore,
    stateAfter,
    notifications,
    recordedEvents,
    files: {
      stateExists: fs.existsSync(statePath),
      eventsExists: fs.existsSync(eventsPath)
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
