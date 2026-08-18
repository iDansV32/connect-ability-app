'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('module');

const ORCHESTRATOR_PATH = require.resolve('../automation/messaging/orchestrator');
const orchestratorRequire = createRequire(ORCHESTRATOR_PATH);
const VERIFICATION_PATH = orchestratorRequire.resolve('../runtime/verification');

function createHarness(options = {}) {
  const restoredModules = new Map();
  const spies = {
    navigateToProfileCalls: [],
    openDrawerConversationCalls: [],
    sendMessageCalls: [],
    verifyMessageSentCalls: 0,
    closeMessageWindowCalls: 0,
    updateMessageQuotaCalls: [],
    storeProfileActionCalls: [],
    personalizeMessageCalls: []
  };

  const defaultProfileDetails = options.profileDetails || {
    firstName: 'Jane',
    lastName: 'Doe',
    fullName: 'Jane Doe',
    title: 'Engineer',
    position: 'Engineer',
    company: 'Acme',
    profileUrl: options.profileUrl || 'https://www.linkedin.com/in/jane-doe/'
  };

  installStub('../util/log', {
    logAction() {},
    logError() {}
  }, restoredModules);
  installStub('../human/delay', {
    randomDelay: async () => {}
  }, restoredModules);
  installStub('./navigator', {
    navigateToProfile: async (...args) => {
      spies.navigateToProfileCalls.push(args);
      return options.navigateToProfileResult ?? true;
    },
    openMessageInterface: async () => options.openMessageInterfaceResult ?? true,
    openDrawerConversation: async (...args) => {
      spies.openDrawerConversationCalls.push(args);
      return options.openDrawerConversationResult ?? false;
    }
  }, restoredModules);
  installStub('./composer', {
    personalizeMessage: (template, profileDetails) => {
      spies.personalizeMessageCalls.push({ template, profileDetails });
      return String(template || '')
        .replace(/\{firstName\}/g, String(profileDetails?.firstName || ''))
        .replace(/\{\{\s*firstName\s*\}\}/g, String(profileDetails?.firstName || ''));
    }
  }, restoredModules);
  installStub('./sender', {
    sendMessage: async (...args) => {
      spies.sendMessageCalls.push(args);
      return options.sendMessageResult ?? true;
    },
    verifyMessageSent: async () => {
      spies.verifyMessageSentCalls += 1;
      return options.verifyMessageSentResult ?? true;
    },
    closeMessageWindow: async () => {
      spies.closeMessageWindowCalls += 1;
      return true;
    }
  }, restoredModules);
  installStub('../profile/extract', {
    extractProfileDetails: async () => defaultProfileDetails
  }, restoredModules);
  installStub('../profile/storage', {
    storeProfileAction: (...args) => {
      spies.storeProfileActionCalls.push(args);
    },
    getStoredProfileDetails: () => options.storedProfileDetails ?? null
  }, restoredModules);
  installStub('./history', {
    hasRecentMessage: async () => options.hasRecentMessage ?? false
  }, restoredModules);
  installStub('./quota', {
    canConsumeMessageQuota: () => options.quotaState || {
      allowed: true,
      exceeded: [],
      quota: {
        daily: { used: 0, limit: 150 },
        weekly: { used: 0, limit: 750 }
      }
    },
    updateMessageQuota: (...args) => {
      spies.updateMessageQuotaCalls.push(args);
    }
  }, restoredModules);
  installStub('../network/tracer', {
    traceAction: async (_page, _name, _metadata, fn) => fn()
  }, restoredModules);

  if (!restoredModules.has(VERIFICATION_PATH)) {
    restoredModules.set(
      VERIFICATION_PATH,
      Object.prototype.hasOwnProperty.call(require.cache, VERIFICATION_PATH) ? require.cache[VERIFICATION_PATH] : null
    );
  }

  delete require.cache[VERIFICATION_PATH];
  delete require.cache[ORCHESTRATOR_PATH];
  const orchestrator = require(ORCHESTRATOR_PATH);

  function restore() {
    delete require.cache[VERIFICATION_PATH];
    delete require.cache[ORCHESTRATOR_PATH];
    for (const [resolvedPath, previousEntry] of restoredModules.entries()) {
      if (previousEntry) {
        require.cache[resolvedPath] = previousEntry;
      } else {
        delete require.cache[resolvedPath];
      }
    }
  }

  return {
    orchestrator,
    spies,
    restore
  };
}

function installStub(request, exportsValue, restoredModules) {
  const resolvedPath = orchestratorRequire.resolve(request);
  if (!restoredModules.has(resolvedPath)) {
    restoredModules.set(
      resolvedPath,
      Object.prototype.hasOwnProperty.call(require.cache, resolvedPath) ? require.cache[resolvedPath] : null
    );
  }

  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue
  };
}

test('sendLinkedInMessage blocks templates that require firstName when profile details do not provide it', async () => {
  const harness = createHarness({
    profileDetails: {
      firstName: '',
      lastName: 'Doe',
      fullName: 'Doe',
      title: 'Engineer',
      position: 'Engineer',
      company: 'Acme'
    }
  });

  try {
    const result = await harness.orchestrator.sendLinkedInMessage(
      {},
      'https://www.linkedin.com/in/jane-doe/',
      'Hello {firstName}'
    );

    assert.equal(result.success, false);
    assert.equal(result.reason, 'missing_template_fields');
    assert.deepEqual(result.missingFields, ['firstname']);
    assert.equal(harness.spies.personalizeMessageCalls.length, 0);
    assert.equal(harness.spies.sendMessageCalls.length, 0);
  } finally {
    harness.restore();
  }
});

test('sendLinkedInMessage navigates a supplied profile URL instead of searching its slug in the drawer', async () => {
  const harness = createHarness();

  try {
    const result = await harness.orchestrator.sendLinkedInMessage(
      {},
      'https://www.linkedin.com/in/madison-dans-3928f6710/',
      'Hello Madison',
      {
        useMessagingDrawer: false,
        recipientName: 'madison dans 3928f6710'
      }
    );

    assert.equal(result.success, true);
    assert.equal(harness.spies.navigateToProfileCalls.length, 1);
    assert.equal(harness.spies.openDrawerConversationCalls.length, 0);
  } finally {
    harness.restore();
  }
});
