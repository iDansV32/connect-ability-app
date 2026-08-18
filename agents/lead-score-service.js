const DEFAULT_FACTOR_WEIGHTS = Object.freeze({
  titleMatch: 0.45,
  seniority: 0.2,
  companySize: 0.15,
  connectionDegree: 0.2
});

const DEFAULT_CONNECTION_DEGREE_SCORES = Object.freeze({
  '1st': 1,
  '2nd': 0.85,
  '3rd': 0.45,
  out_of_network: 0.2,
  unknown: 0.4
});

function scoreProspect(prospect = {}, agent = {}, options = {}) {
  const config = normalizeLeadScoringConfig(agent, options.config);
  const titleFactor = scoreTitleMatch(prospect, config);
  const seniorityFactor = scoreSeniority(prospect, config);
  const companySizeFactor = scoreCompanySize(prospect, config);
  const connectionDegreeFactor = scoreConnectionDegree(prospect, config);

  const factors = {
    titleMatch: finalizeFactor(titleFactor, config.weights.titleMatch),
    seniority: finalizeFactor(seniorityFactor, config.weights.seniority),
    companySize: finalizeFactor(companySizeFactor, config.weights.companySize),
    connectionDegree: finalizeFactor(connectionDegreeFactor, config.weights.connectionDegree)
  };
  const totalWeight = Object.values(factors).reduce((sum, factor) => sum + factor.weight, 0) || 1;
  const weightedTotal = Object.values(factors).reduce((sum, factor) => sum + factor.weighted, 0) / totalWeight;

  return {
    prospectId: cleanString(prospect.id || prospect.prospectId, 160) || null,
    score: Math.max(0, Math.min(100, Math.round(weightedTotal * 100))),
    scoreBreakdown: {
      total: roundMetric(weightedTotal),
      factors
    }
  };
}

function scoreProspects(prospects = [], agent = {}, options = {}) {
  return (Array.isArray(prospects) ? prospects : [])
    .map((prospect) => ({
      prospect,
      ...scoreProspect(prospect, agent, options)
    }));
}

function normalizeLeadScoringConfig(agent = {}, override = null) {
  const metadataConfig = agent?.metadata?.leadScoring && typeof agent.metadata.leadScoring === 'object'
    ? agent.metadata.leadScoring
    : {};
  const effectiveOverride = override && typeof override === 'object' && !Array.isArray(override)
    ? override
    : {};

  return {
    weights: normalizeWeights(metadataConfig.weights, effectiveOverride.weights),
    titleKeywords: normalizeTitleKeywords(
      effectiveOverride.titleKeywords || metadataConfig.titleKeywords,
      agent
    ),
    preferredSeniority: normalizeSeniorityList(
      effectiveOverride.preferredSeniority || metadataConfig.preferredSeniority
    ),
    companySizeRange: normalizeCompanySizeRange(
      effectiveOverride.companySize || metadataConfig.companySize || null
    ),
    connectionDegreeScores: normalizeConnectionDegreeScores(
      metadataConfig.connectionDegreeScores,
      effectiveOverride.connectionDegreeScores
    )
  };
}

function scoreTitleMatch(prospect = {}, config = {}) {
  const keywords = Array.isArray(config.titleKeywords) ? config.titleKeywords : [];
  const normalizedTitle = normalizeText(prospect.title);
  if (!keywords.length) {
    return { score: 0.5, reason: 'no_title_preferences' };
  }
  if (!normalizedTitle) {
    return { score: 0.25, reason: 'missing_title' };
  }

  let bestKeyword = null;
  let bestScore = 0;
  for (const keyword of keywords) {
    const keywordTokens = tokenize(keyword);
    if (!keywordTokens.length) {
      continue;
    }
    const joinedKeyword = keywordTokens.join(' ');
    if (normalizedTitle.includes(joinedKeyword)) {
      return { score: 1, matchedKeyword: keyword };
    }

    const titleTokens = new Set(tokenize(normalizedTitle));
    const overlapCount = keywordTokens.filter((token) => titleTokens.has(token)).length;
    const overlapRatio = overlapCount / keywordTokens.length;
    if (overlapRatio > bestScore) {
      bestScore = overlapRatio;
      bestKeyword = keyword;
    }
  }

  if (bestScore >= 0.75) {
    return { score: 0.85, matchedKeyword: bestKeyword };
  }
  if (bestScore >= 0.5) {
    return { score: 0.65, matchedKeyword: bestKeyword };
  }
  return { score: 0.1, reason: 'no_title_match' };
}

function scoreSeniority(prospect = {}, config = {}) {
  const preferred = Array.isArray(config.preferredSeniority) ? config.preferredSeniority : [];
  if (!preferred.length) {
    return { score: 0.5, reason: 'no_seniority_preferences' };
  }

  const seniority = resolveProspectSeniority(prospect);
  if (!seniority) {
    return { score: 0.3, reason: 'missing_seniority' };
  }

  if (preferred.includes(seniority)) {
    return { score: 1, value: seniority };
  }

  const seniorityRank = resolveSeniorityRank(seniority);
  const bestDistance = preferred.reduce((closest, preferredValue) => {
    const distance = Math.abs(resolveSeniorityRank(preferredValue) - seniorityRank);
    return Math.min(closest, distance);
  }, Number.POSITIVE_INFINITY);

  if (bestDistance <= 1) {
    return { score: 0.7, value: seniority };
  }
  if (bestDistance <= 2) {
    return { score: 0.45, value: seniority };
  }
  return { score: 0.2, value: seniority };
}

function scoreCompanySize(prospect = {}, config = {}) {
  if (!config.companySizeRange) {
    return { score: 0.5, reason: 'no_company_size_preferences' };
  }

  const companySize = resolveProspectCompanySize(prospect);
  if (companySize === null) {
    return { score: 0.35, reason: 'missing_company_size' };
  }

  const { min, max } = config.companySizeRange;
  if (companySize >= min && companySize <= max) {
    return { score: 1, value: companySize };
  }

  const nearestBoundary = companySize < min ? min : max;
  const distance = Math.abs(companySize - nearestBoundary);
  const rangeSize = Math.max(1, max - min);
  const ratio = distance / rangeSize;
  if (ratio <= 0.5) {
    return { score: 0.65, value: companySize };
  }
  if (ratio <= 1) {
    return { score: 0.4, value: companySize };
  }
  return { score: 0.15, value: companySize };
}

function scoreConnectionDegree(prospect = {}, config = {}) {
  const connectionDegree = resolveConnectionDegree(prospect);
  const lookup = config.connectionDegreeScores || DEFAULT_CONNECTION_DEGREE_SCORES;
  const normalizedDegree = connectionDegree || 'unknown';
  return {
    score: clampUnitInterval(lookup[normalizedDegree] ?? lookup.unknown ?? DEFAULT_CONNECTION_DEGREE_SCORES.unknown),
    value: normalizedDegree
  };
}

function finalizeFactor(factor = {}, weight = 0) {
  const normalizedWeight = Math.max(0, Number(weight) || 0);
  const normalizedScore = clampUnitInterval(factor.score);
  return {
    ...factor,
    score: roundMetric(normalizedScore),
    weight: roundMetric(normalizedWeight),
    weighted: roundMetric(normalizedScore * normalizedWeight)
  };
}

function normalizeWeights(baseWeights = null, overrideWeights = null) {
  const raw = {
    ...DEFAULT_FACTOR_WEIGHTS,
    ...(baseWeights && typeof baseWeights === 'object' && !Array.isArray(baseWeights) ? baseWeights : {}),
    ...(overrideWeights && typeof overrideWeights === 'object' && !Array.isArray(overrideWeights) ? overrideWeights : {})
  };
  return {
    titleMatch: clampWeight(raw.titleMatch, DEFAULT_FACTOR_WEIGHTS.titleMatch),
    seniority: clampWeight(raw.seniority, DEFAULT_FACTOR_WEIGHTS.seniority),
    companySize: clampWeight(raw.companySize, DEFAULT_FACTOR_WEIGHTS.companySize),
    connectionDegree: clampWeight(raw.connectionDegree, DEFAULT_FACTOR_WEIGHTS.connectionDegree)
  };
}

function normalizeTitleKeywords(value, agent = {}) {
  const directKeywords = Array.isArray(value) ? value : [];
  return dedupeStrings([
    ...directKeywords,
    ...(Array.isArray(agent.personaTitles) ? agent.personaTitles : []),
    ...(Array.isArray(agent.searchKeywords) ? agent.searchKeywords : [])
  ], 40, 120);
}

function normalizeSeniorityList(value) {
  return dedupeStrings(Array.isArray(value) ? value : [], 10, 40)
    .map((entry) => normalizeSeniority(entry))
    .filter(Boolean);
}

function normalizeCompanySizeRange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const min = Math.max(0, Number(value.min) || 0);
  const maxCandidate = Math.max(0, Number(value.max) || 0);
  const max = maxCandidate >= min ? maxCandidate : min;
  if (!min && !max) {
    return null;
  }
  return { min, max: Math.max(min, max) };
}

function normalizeConnectionDegreeScores(baseScores = null, overrideScores = null) {
  const raw = {
    ...DEFAULT_CONNECTION_DEGREE_SCORES,
    ...(baseScores && typeof baseScores === 'object' && !Array.isArray(baseScores) ? baseScores : {}),
    ...(overrideScores && typeof overrideScores === 'object' && !Array.isArray(overrideScores) ? overrideScores : {})
  };
  return {
    '1st': clampUnitInterval(raw['1st']),
    '2nd': clampUnitInterval(raw['2nd']),
    '3rd': clampUnitInterval(raw['3rd']),
    out_of_network: clampUnitInterval(raw.out_of_network),
    unknown: clampUnitInterval(raw.unknown)
  };
}

function resolveProspectSeniority(prospect = {}) {
  const explicit = normalizeSeniority(prospect?.metadata?.seniority || prospect?.seniority);
  if (explicit) {
    return explicit;
  }

  const title = normalizeText(prospect.title);
  if (!title) {
    return null;
  }
  if (/\b(founder|co founder|co-founder|owner|president|chief|cmo|cro|cso|cto|ceo|coo|cfo)\b/.test(title)) {
    return 'executive';
  }
  if (/\b(vice president|vp|svp|avp)\b/.test(title)) {
    return 'vp';
  }
  if (/\b(director|head)\b/.test(title)) {
    return 'director';
  }
  if (/\b(manager|lead)\b/.test(title)) {
    return 'manager';
  }
  if (/\b(associate|specialist|coordinator|analyst|engineer|recruiter|consultant)\b/.test(title)) {
    return 'ic';
  }
  return null;
}

function resolveSeniorityRank(value) {
  const seniority = normalizeSeniority(value);
  const ranks = {
    ic: 1,
    manager: 2,
    director: 3,
    vp: 4,
    executive: 5
  };
  return ranks[seniority] || 0;
}

function normalizeSeniority(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  if (normalized.includes('executive') || /\b(founder|owner|president|chief|cmo|cro|cso|cto|ceo|coo|cfo)\b/.test(normalized)) {
    return 'executive';
  }
  if (normalized.includes('vice president') || /\bvp\b/.test(normalized) || normalized.includes('svp') || normalized.includes('avp')) {
    return 'vp';
  }
  if (normalized.includes('director') || normalized.includes('head')) {
    return 'director';
  }
  if (normalized.includes('manager') || normalized.includes('lead')) {
    return 'manager';
  }
  if (normalized.includes('associate') || normalized.includes('specialist') || normalized.includes('coordinator') || normalized.includes('analyst') || normalized.includes('engineer') || normalized.includes('consultant')) {
    return 'ic';
  }
  return '';
}

function resolveProspectCompanySize(prospect = {}) {
  const raw = prospect?.metadata?.companySize ?? prospect?.companySize;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, raw);
  }

  const text = cleanString(raw, 80);
  if (!text) {
    return null;
  }

  const compact = text.replace(/,/g, '');
  const exact = Number(compact);
  if (Number.isFinite(exact) && exact > 0) {
    return exact;
  }

  const rangeMatch = compact.match(/(\d+)\s*-\s*(\d+)/);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return Math.round((min + max) / 2);
    }
  }

  const plusMatch = compact.match(/(\d+)\s*\+/);
  if (plusMatch) {
    const min = Number(plusMatch[1]);
    if (Number.isFinite(min)) {
      return min;
    }
  }

  return null;
}

function resolveConnectionDegree(prospect = {}) {
  const raw = cleanString(prospect?.metadata?.connectionDegree || prospect?.connectionDegree, 80).toLowerCase();
  if (!raw) {
    return '';
  }
  if (raw.includes('1st') || raw.includes('first')) {
    return '1st';
  }
  if (raw.includes('2nd') || raw.includes('second')) {
    return '2nd';
  }
  if (raw.includes('3rd') || raw.includes('third')) {
    return '3rd';
  }
  if (raw.includes('out')) {
    return 'out_of_network';
  }
  return '';
}

function dedupeStrings(values, maxItems, maxLength) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => cleanString(value, maxLength))
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .filter(Boolean);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function clampWeight(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
}

function clampUnitInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numeric));
}

function roundMetric(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

module.exports = {
  scoreProspect,
  scoreProspects,
  normalizeLeadScoringConfig,
  _private: {
    normalizeConnectionDegreeScores,
    normalizeCompanySizeRange,
    normalizeLeadScoringConfig,
    normalizeSeniority,
    resolveConnectionDegree,
    resolveProspectCompanySize,
    resolveProspectSeniority,
    resolveSeniorityRank,
    scoreCompanySize,
    scoreConnectionDegree,
    scoreSeniority,
    scoreTitleMatch
  }
};
