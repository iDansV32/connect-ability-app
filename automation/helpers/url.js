// ============================================
// FILE: helpers/url.js
// ============================================
// helpers/url.js
function isLinkedInUrl(url) {
  return url && url.includes('linkedin.com');
}

function extractProfileId(url) {
  const match = url.match(/\/in\/([^\/\?]+)/);
  return match ? match[1] : null;
}

function buildSearchUrl(keyword, page = 1) {
  const encoded = encodeURIComponent(keyword);
  return `https://www.linkedin.com/search/results/people/?keywords=${encoded}&page=${page}`;
}

module.exports = {
  isLinkedInUrl,
  extractProfileId,
  buildSearchUrl
};