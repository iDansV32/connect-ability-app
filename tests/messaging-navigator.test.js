'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('module');

const NAVIGATOR_PATH = require.resolve('../automation/messaging/navigator');
const navigatorRequire = createRequire(NAVIGATOR_PATH);

function installStub(request, exportsValue, restoredModules) {
  const resolvedPath = navigatorRequire.resolve(request);
  restoredModules.set(
    resolvedPath,
    Object.prototype.hasOwnProperty.call(require.cache, resolvedPath) ? require.cache[resolvedPath] : null
  );
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue
  };
}

function loadNavigator() {
  const restoredModules = new Map();
  installStub('../util/log', { logAction() {}, logError() {} }, restoredModules);
  installStub('../human/delay', { randomDelay: async () => {}, getTypingDelay: () => 0 }, restoredModules);
  installStub('../human/scroll', { humanScroll: async () => {} }, restoredModules);
  installStub('../mouse/move-naturally', { moveMouseNaturally: async () => {} }, restoredModules);
  installStub('../mouse/stealth-click', { stealthClick: async (_page, handle) => handle.click() }, restoredModules);

  delete require.cache[NAVIGATOR_PATH];
  const navigator = require(NAVIGATOR_PATH);

  return {
    navigator,
    restore() {
      delete require.cache[NAVIGATOR_PATH];
      for (const [resolvedPath, previousEntry] of restoredModules.entries()) {
        if (previousEntry) require.cache[resolvedPath] = previousEntry;
        else delete require.cache[resolvedPath];
      }
    }
  };
}

test('openMessageInterface closes a popup tab spawned by the profile Message button', async () => {
  const harness = loadNavigator();
  const listeners = new Map();
  let popupCloseCalls = 0;
  let selectorCalls = 0;

  const popup = {
    close: async () => {
      popupCloseCalls += 1;
    }
  };
  const button = {
    click: async () => {
      listeners.get('popup')?.(popup);
    }
  };
  const page = {
    $: async () => {
      selectorCalls += 1;
      return selectorCalls === 1 ? null : button;
    },
    on: (event, listener) => listeners.set(event, listener),
    off: (event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }
  };

  try {
    assert.equal(await harness.navigator.openMessageInterface(page), true);
    assert.equal(popupCloseCalls, 1);
    assert.equal(listeners.has('popup'), false);
  } finally {
    harness.restore();
  }
});
