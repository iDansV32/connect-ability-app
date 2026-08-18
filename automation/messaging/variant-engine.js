'use strict';

/**
 * Lightweight message variant engine.
 *
 * Supports spintax-style blocks: {option A|option B|option C}
 * Each block is replaced by one randomly chosen option at call time, giving
 * every sent message a slightly different surface — effective camouflage
 * against platform-side duplicate-detection heuristics.
 *
 * Rules:
 *  - A block must contain at least one pipe (|) to be treated as a variant.
 *  - Nested blocks are not supported; inner braces inside a variant block are
 *    treated as literal characters.
 *  - Blocks without a pipe are left untouched (e.g. {firstName} placeholders).
 *  - An empty variant string ("option A||option C") is allowed and selectable.
 *
 * @example
 *   applyVariants('Hi {there|friend}, hope {this finds you well|you are doing great}!')
 *   // might return: 'Hi friend, hope this finds you well!'
 *
 * @param {string}   template  - Message template, possibly containing {a|b} blocks.
 * @param {function} [rng]     - Optional RNG (default Math.random). Must return [0, 1).
 * @returns {string}
 */
function applyVariants(template, rng = Math.random) {
  if (typeof template !== 'string') return String(template ?? '');

  // Match { ... | ... } — requires at least one pipe, no nested braces.
  return template.replace(/\{([^{}]*\|[^{}]*)\}/g, (_match, group) => {
    const variants = group.split('|');
    const idx = Math.min(variants.length - 1, Math.floor(rng() * variants.length));
    return variants[idx];
  });
}

/**
 * Produce a stable, short fingerprint for a message template or resolved text.
 *
 * Normalisation strategy (targeted, not broad):
 *   1. Replace email addresses with a placeholder token.
 *   2. Replace URLs with a placeholder token.
 *   3. Replace {{placeholder}} and {placeholder} template tokens (single-word,
 *      no pipe) with a placeholder token so pre- and post-personalisation text
 *      produce the same key.
 *   4. Collapse whitespace, lowercase.
 *
 * Title-cased words (e.g. "Loved", "Saw") are intentionally NOT replaced.
 * A previous version used `/\b[A-Z][a-z]+/g` which collapsed genuinely
 * different copy into the same bucket.
 *
 * @param {string} text - Template or resolved message text.
 * @returns {string} - 8-character hex fingerprint (e.g. "a3f1bc09").
 */
function computeVariantKey(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return 'empty';
  }

  const normalized = text
    .replace(/\S+@\S+\.\S+/g, '_email_')                   // emails
    .replace(/https?:\/\/\S+/g, '_url_')                    // URLs
    .replace(/\{\{\s*\w+\s*\}\}/g, '_tok_')                 // {{placeholder}}
    .replace(/\{(\w+)\}/g, (_m, inner) =>                   // {word} but not {a|b}
      inner.includes('|') ? _m : '_tok_'
    )
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  // djb2 hash → 8 hex chars
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

module.exports = { applyVariants, computeVariantKey };
