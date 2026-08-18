const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentSearchPresets } = require('../agent-search-service');

test('buildAgentSearchPresets generates deduped title and keyword combinations', () => {
  const presets = buildAgentSearchPresets({
    id: 'agent-1',
    name: 'People SDR',
    niche: 'B2B SaaS',
    personaTitles: ['Chief of Staff', 'Head of People'],
    searchKeywords: ['customer success', 'customer success']
  });

  assert.ok(presets.length >= 4);
  assert.equal(presets[0].agentId, 'agent-1');
  assert.ok(presets.some((preset) => preset.query === 'Chief of Staff'));
  assert.ok(presets.some((preset) => preset.query === 'Head of People customer success'));
  assert.equal(new Set(presets.map((preset) => preset.query.toLowerCase())).size, presets.length);
});

test('buildAgentSearchPresets falls back to keyword and niche searches when titles are missing', () => {
  const presets = buildAgentSearchPresets({
    id: 'agent-2',
    name: 'CS Agent',
    niche: 'Customer Success',
    personaTitles: [],
    searchKeywords: ['renewals']
  });

  assert.equal(presets[0].query, 'renewals');
  assert.ok(presets.some((preset) => preset.query === 'renewals Customer Success'));
});
