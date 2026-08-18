const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreProspect,
  scoreProspects,
  normalizeLeadScoringConfig
} = require('../agents/lead-score-service');

test('scoreProspect uses agent persona titles and search keywords for title matching', () => {
  const agent = {
    personaTitles: ['Chief of Staff'],
    searchKeywords: ['strategy and operations']
  };

  const strong = scoreProspect({
    id: 'prospect-1',
    title: 'Chief of Staff',
    metadata: { connectionDegree: '2nd' }
  }, agent);
  const weak = scoreProspect({
    id: 'prospect-2',
    title: 'Account Executive',
    metadata: { connectionDegree: '2nd' }
  }, agent);

  assert.ok(strong.score > weak.score);
  assert.equal(strong.scoreBreakdown.factors.titleMatch.matchedKeyword, 'Chief of Staff');
});

test('scoreProspect honors preferred seniority from agent metadata', () => {
  const agent = {
    metadata: {
      leadScoring: {
        preferredSeniority: ['director', 'vp']
      }
    }
  };

  const director = scoreProspect({
    title: 'Director of Customer Success'
  }, agent);
  const analyst = scoreProspect({
    title: 'Customer Success Analyst'
  }, agent);

  assert.ok(director.score > analyst.score);
  assert.equal(director.scoreBreakdown.factors.seniority.value, 'director');
});

test('scoreProspect applies configured company size range when company size is present', () => {
  const agent = {
    metadata: {
      leadScoring: {
        companySize: { min: 50, max: 500 }
      }
    }
  };

  const inRange = scoreProspect({
    metadata: { companySize: '51-200' }
  }, agent);
  const farOutside = scoreProspect({
    metadata: { companySize: '5001-10000' }
  }, agent);

  assert.ok(inRange.score > farOutside.score);
  assert.equal(inRange.scoreBreakdown.factors.companySize.value, 126);
});

test('scoreProspect gives better defaults to closer connection degrees', () => {
  const agent = {};

  const firstDegree = scoreProspect({
    metadata: { connectionDegree: '1st' }
  }, agent);
  const thirdDegree = scoreProspect({
    metadata: { connectionDegree: '3rd' }
  }, agent);

  assert.ok(firstDegree.score > thirdDegree.score);
  assert.equal(firstDegree.scoreBreakdown.factors.connectionDegree.value, '1st');
});

test('normalizeLeadScoringConfig supports per-agent title keyword overrides', () => {
  const agent = {
    personaTitles: ['Head of Sales'],
    searchKeywords: ['sales ops'],
    metadata: {
      leadScoring: {
        titleKeywords: ['Head of AI']
      }
    }
  };

  const config = normalizeLeadScoringConfig(agent);
  assert.deepEqual(config.titleKeywords, ['Head of AI', 'Head of Sales', 'sales ops']);

  const scored = scoreProspect({
    title: 'Head of AI'
  }, agent);
  assert.equal(scored.scoreBreakdown.factors.titleMatch.matchedKeyword, 'Head of AI');
});

test('scoreProspects scores each prospect without mutating the input list', () => {
  const prospects = [
    { id: 'prospect-1', title: 'Chief of Staff' },
    { id: 'prospect-2', title: 'Office Manager' }
  ];
  const scored = scoreProspects(prospects, { personaTitles: ['Chief of Staff'] });

  assert.equal(scored.length, 2);
  assert.equal(scored[0].prospect.id, 'prospect-1');
  assert.equal(prospects[0].score, undefined);
});
