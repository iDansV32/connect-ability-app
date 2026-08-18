'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readConnectionState } = require('../automation/connection/state');

function makeFakeElement(textContent = '', ariaLabel = '') {
  return {
    textContent,
    getAttribute(name) {
      return name === 'aria-label' ? ariaLabel : '';
    }
  };
}

function makeFakePage(elements) {
  return {
    async evaluate(fn) {
      const originalDocument = global.document;
      const root = {
        querySelectorAll() {
          return elements;
        }
      };
      global.document = {
        querySelector(selector) {
          return selector === 'main' ? root : null;
        },
        body: root
      };

      try {
        return fn();
      } finally {
        global.document = originalDocument;
      }
    }
  };
}

test('readConnectionState ignores non-action connection-count copy when detecting connected profiles', async () => {
  const state = await readConnectionState(makeFakePage([
    makeFakeElement('Message', 'Message Sam Okonkwo'),
    makeFakeElement('500+ connections')
  ]));

  assert.equal(state.connected, true);
  assert.equal(state.canConnect, false);
  assert.equal(state.pending, false);
});

test('readConnectionState detects a real connect action by button text or aria-label', async () => {
  const state = await readConnectionState(makeFakePage([
    makeFakeElement('', 'Invite Sam Okonkwo to connect'),
    makeFakeElement('Message', 'Message Sam Okonkwo')
  ]));

  assert.equal(state.connected, false);
  assert.equal(state.canConnect, true);
  assert.equal(state.pending, false);
});
