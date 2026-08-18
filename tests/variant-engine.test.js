'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyVariants } = require('../automation/messaging/variant-engine');

// ---------------------------------------------------------------------------
// Basic expansion
// ---------------------------------------------------------------------------

test('applyVariants picks one variant from a two-option block', () => {
  // Use a deterministic rng that always picks the first option.
  const result = applyVariants('{Hello|Hi}', () => 0);
  assert.equal(result, 'Hello');
});

test('applyVariants picks the second variant when rng returns 0.5', () => {
  const result = applyVariants('{Hello|Hi}', () => 0.5);
  assert.equal(result, 'Hi');
});

test('applyVariants expands multiple blocks independently', () => {
  // rng sequence: first call picks index 0 from {A|B}, second picks index 1 from {C|D}
  let call = 0;
  const rng = () => (call++ === 0 ? 0 : 0.9999);
  const result = applyVariants('{A|B} and {C|D}', rng);
  assert.equal(result, 'A and D');
});

test('applyVariants supports three-option blocks', () => {
  const result = applyVariants('{one|two|three}', () => 0.666);
  // floor(0.666 * 3) = 1 → 'two'
  assert.equal(result, 'two');
});

test('applyVariants leaves non-variant single-brace tokens untouched', () => {
  // {firstName} has no pipe — must not be touched by the variant engine
  const result = applyVariants('{firstName}, hope this finds you well', () => 0);
  assert.equal(result, '{firstName}, hope this finds you well');
});

test('applyVariants leaves double-brace placeholders untouched', () => {
  const result = applyVariants('Hi {{firstName}}, {how are you|hope you are well}', () => 0);
  assert.equal(result, 'Hi {{firstName}}, how are you');
});

test('applyVariants handles an empty string gracefully', () => {
  assert.equal(applyVariants('', () => 0), '');
});

test('applyVariants returns original template unchanged when there are no variant blocks', () => {
  const template = 'Hello, just reaching out about your work at {company}.';
  assert.equal(applyVariants(template, () => 0), template);
});

test('applyVariants handles a template with only a variant block', () => {
  const result = applyVariants('{Hey there|Hi}', () => 0.9999);
  assert.equal(result, 'Hi');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('applyVariants coerces non-string input to string', () => {
  assert.equal(applyVariants(null, () => 0), '');
  assert.equal(applyVariants(undefined, () => 0), '');
  assert.equal(applyVariants(42, () => 0), '42');
});

test('applyVariants uses Math.random by default without throwing', () => {
  // Just verify it does not throw and returns a string.
  const result = applyVariants('{A|B|C}');
  assert.ok(['A', 'B', 'C'].includes(result), `Expected one of A/B/C, got "${result}"`);
});

test('applyVariants clamps the selected index to the last variant when rng returns 1.0', () => {
  // rng = 1.0 would produce floor(1.0 * 2) = 2 without a clamp, which is out of range.
  const result = applyVariants('{alpha|beta}', () => 1.0);
  assert.equal(result, 'beta');
});

test('applyVariants supports adjacent variant blocks with no separator', () => {
  let call = 0;
  const rng = () => (call++ === 0 ? 0 : 0.9999);
  const result = applyVariants('{A|B}{C|D}', rng);
  assert.equal(result, 'AD');
});

test('applyVariants preserves surrounding text exactly', () => {
  const result = applyVariants('Hi {there|friend}, wanted to reach out.', () => 0);
  assert.equal(result, 'Hi there, wanted to reach out.');
});

test('applyVariants preserves newlines in surrounding text', () => {
  const result = applyVariants('{Hello|Hi},\n\nHope this finds you well.', () => 0);
  assert.equal(result, 'Hello,\n\nHope this finds you well.');
});
