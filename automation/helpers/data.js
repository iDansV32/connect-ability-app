// ============================================
// FILE: helpers/data.js
// ============================================
// helpers/data.js
function sanitizeText(text) {
  if (!text) return '';
  return text.trim().replace(/\s+/g, ' ');
}

function extractNumbers(text) {
  const match = text.match(/\d+/g);
  return match ? match.map(Number) : [];
}

function parseConnectionCount(text) {
  const cleaned = text.replace(/[^\d]/g, '');
  return parseInt(cleaned) || 0;
}

module.exports = {
  sanitizeText,
  extractNumbers,
  parseConnectionCount
};