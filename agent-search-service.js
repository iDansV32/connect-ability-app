function buildAgentSearchPresets(agent = {}, options = {}) {
  const personaTitles = normalizeStringList(agent.personaTitles, 30, 120);
  const searchKeywords = normalizeStringList(agent.searchKeywords, 40, 120);
  const niche = cleanString(agent.niche, 240) || null;
  const maxPresets = Math.max(1, Math.min(40, Number(options.maxPresets) || 18));

  const seeds = [];
  const pushSeed = (kind, parts, labelParts, priority) => {
    const query = normalizeSearchQuery(parts);
    if (!query) return;
    seeds.push({
      id: buildPresetId(agent.id, kind, query),
      kind,
      label: labelParts.filter(Boolean).join(' · ') || query,
      query,
      priority
    });
  };

  personaTitles.forEach((title, index) => {
    pushSeed('title', [title], [title], 100 - index);
  });

  personaTitles.forEach((title, titleIndex) => {
    searchKeywords.forEach((keyword, keywordIndex) => {
      pushSeed(
        'title_keyword',
        [title, keyword],
        [title, keyword],
        90 - titleIndex - keywordIndex
      );
    });
  });

  if (niche) {
    personaTitles.forEach((title, index) => {
      pushSeed('title_niche', [title, niche], [title, niche], 80 - index);
    });
  }

  if (!personaTitles.length) {
    searchKeywords.forEach((keyword, index) => {
      pushSeed('keyword', [keyword], [keyword], 70 - index);
      if (niche && normalizeComparableText(keyword) !== normalizeComparableText(niche)) {
        pushSeed('keyword_niche', [keyword, niche], [keyword, niche], 60 - index);
      }
    });
  }

  if (!personaTitles.length && !searchKeywords.length && niche) {
    pushSeed('niche', [niche], [niche], 50);
  }

  const seen = new Set();
  return seeds
    .sort((left, right) => right.priority - left.priority || left.label.localeCompare(right.label))
    .filter((preset) => {
      const key = normalizeComparableText(preset.query);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxPresets)
    .map((preset, index) => ({
      ...preset,
      order: index + 1,
      agentId: cleanString(agent.id, 160) || null,
      agentName: cleanString(agent.name, 160) || null,
      niche,
      defaultProfileLimit: 10
    }));
}

function buildPresetId(agentId, kind, query) {
  const left = cleanString(agentId, 160) || 'agent';
  const right = normalizeComparableText(query).replace(/\s+/g, '-').slice(0, 80) || 'preset';
  return `${left}:${kind}:${right}`;
}

function normalizeSearchQuery(parts = []) {
  return parts
    .flat()
    .map((part) => cleanString(part, 160))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStringList(values, maxItems, maxLength) {
  const items = Array.isArray(values) ? values : String(values || '').split(/[\n,]/g);
  const seen = new Set();
  return items
    .map((value) => cleanString(value, maxLength))
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  buildAgentSearchPresets
};
