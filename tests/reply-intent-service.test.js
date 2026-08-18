'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyIntent } = require('../agents/reply-intent-service');

test('classifyIntent returns not_interested for clear rejection language', () => {
  assert.equal(classifyIntent('No thanks, not interested right now.'), 'not_interested');
});

test('classifyIntent returns unsubscribe for unsubscribe language', () => {
  assert.equal(classifyIntent('Please unsubscribe me from this list.'), 'unsubscribe');
});

test('classifyIntent returns interested for positive interest language', () => {
  assert.equal(classifyIntent('Interested. Can you tell me more?'), 'interested');
});

test('classifyIntent returns question when message is primarily a question', () => {
  assert.equal(classifyIntent('How does this work?'), 'question');
});

test('classifyIntent returns neutral for non-matching text', () => {
  assert.equal(classifyIntent('Thanks for following up.'), 'neutral');
});

test('classifyIntent returns neutral for empty input', () => {
  assert.equal(classifyIntent(''), 'neutral');
});
