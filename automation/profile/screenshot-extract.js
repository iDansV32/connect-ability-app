// Screenshot the LinkedIn profile top-card and OCR it as a fallback / supplement
// to the DOM-based extractor. Pure local pipeline using tesseract.js — no
// network calls. Designed to fill in gaps when DOM selectors return null.
//
// Usage:
//   const { captureAndExtract } = require('./screenshot-extract');
//   const result = await captureAndExtract(page, profileUrl, { outDir, prospectId });
//   // result: { screenshotPath, ocrText, parsed: { name, title, company, location } }

const fs = require('fs');
const path = require('path');
const { getConnectAbilityAppStateDir } = require('../../connect-documents');

// Single source of truth for the app-state directory lives in
// connect-documents.js — that one already branches on process.platform for
// macOS / Windows / Linux. Don't duplicate it here.
const DEFAULT_OUT_DIR = path.join(getConnectAbilityAppStateDir(), 'profile-screenshots');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeSlug(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'profile';
}

// Locate the top-card region: the main column down to roughly where the
// "About" section starts. We use a defensive approach — try a known selector
// first, fall back to the top portion of <main>.
async function findTopCardClip(page) {
  try {
    const handle = await page.$('main section:first-of-type');
    if (handle) {
      const box = await handle.boundingBox();
      if (box && box.width > 200 && box.height > 100) {
        // Limit height so we don't capture deep sections.
        return {
          x: Math.max(0, Math.floor(box.x)),
          y: Math.max(0, Math.floor(box.y)),
          width: Math.floor(Math.min(box.width, 900)),
          height: Math.floor(Math.min(box.height, 480)),
        };
      }
    }
  } catch (_) {}

  // Fallback: top-left portion of the viewport's <main>.
  try {
    const mainHandle = await page.$('main');
    if (mainHandle) {
      const box = await mainHandle.boundingBox();
      if (box) {
        return {
          x: Math.max(0, Math.floor(box.x)),
          y: Math.max(0, Math.floor(box.y)),
          width: Math.floor(Math.min(box.width, 900)),
          height: 460,
        };
      }
    }
  } catch (_) {}

  return null;
}

async function captureTopCard(page, outputPath) {
  const clip = await findTopCardClip(page);
  if (clip) {
    await page.screenshot({ path: outputPath, clip, type: 'png' });
  } else {
    // Last resort: full viewport.
    await page.screenshot({ path: outputPath, fullPage: false, type: 'png' });
  }
  return outputPath;
}

// Parse OCR text into best-effort {name, title, company, location}.
// The top-card layout from top to bottom (in 2026 LinkedIn) is roughly:
//   1. Avatar
//   2. NAME (large)
//   3. PRONOUNS (small, optional)
//   4. HEADLINE  e.g. "VP RevOps at Paloma"
//   5. LOCATION  e.g. "San Francisco, California, United States"
//   6. CONTACT INFO link
//   7. CURRENT COMPANY pill (sometimes with logo)
//
// OCR will produce noisy lines. We strip noise and pick the strongest
// signals from the top ~10 lines.
function parseOcrText(rawText) {
  if (!rawText) return { name: null, title: null, company: null, location: null };

  const lines = rawText.split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    // Drop UI noise we frequently see in OCR
    .filter(l => !/^(skip|home|my network|jobs|messaging|notifications|for business|try premium|advertise|me|sign in|join now|see (more|all|posts|less))$/i.test(l))
    .filter(l => !/^\d+(st|nd|rd|th)? (degree|connection|follower)/i.test(l))
    .filter(l => !/^(more|message|connect|follow|share|save|copy)$/i.test(l));

  // Within the top 12 cleaned lines, find:
  //   name      → first short line of mostly letters (2-5 words, no punctuation noise)
  //   headline  → line containing " at " or longest descriptive line under 140 chars
  //   location  → line with " · " or matching "City, State/Country"
  const candidates = lines.slice(0, 14);

  let name = null;
  let headline = null;
  let location = null;

  for (const line of candidates) {
    if (!name && isLikelyName(line)) {
      name = cleanName(line);
      continue;
    }
    if (!headline && isLikelyHeadline(line)) {
      headline = line;
      continue;
    }
    if (!location && isLikelyLocation(line)) {
      location = line;
    }
  }

  // If we still don't have a headline, take the longest line in the top 8
  // that wasn't picked as name/location.
  if (!headline) {
    headline = candidates
      .filter(l => l !== name && l !== location && l.length >= 12 && l.length <= 140)
      .sort((a, b) => b.length - a.length)[0] || null;
  }

  let title = null;
  let company = null;
  if (headline) {
    // Headline patterns: "Title at Company", "Title @ Company", "Title | Company"
    const m = /^(.+?)\s+(?:at|@|\|)\s+(.+)$/i.exec(headline);
    if (m) {
      title = m[1].trim();
      company = m[2].trim().replace(/\s+[•·]\s+.*$/, '');
    } else {
      title = headline;
    }
  }

  return {
    name: name || null,
    title: title || null,
    company: company || null,
    location: location || null,
  };
}

function isLikelyName(line) {
  if (!line) return false;
  if (line.length > 50 || line.length < 3) return false;
  // Disallow lines that contain digits or " at " (those are headlines, not names)
  if (/\d/.test(line)) return false;
  if (/\bat\b|\@|\|/.test(line)) return false;
  if (/,/.test(line)) return false;
  // 1-5 words, each word looks like a name (capitalized, no special chars)
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5) return false;
  // Most words should start with an uppercase letter or be entirely letters/dots/hyphens.
  const looksLikeWord = (w) => /^[A-Z][\p{L}.\-']*$|^[\p{L}.\-']+$/u.test(w);
  return words.filter(looksLikeWord).length >= Math.max(1, Math.floor(words.length * 0.7));
}

function cleanName(raw) {
  return raw
    .replace(/,.*$/, '')
    .replace(/\(.*?\)/g, '')
    .replace(/^(Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.)\s+/i, '')
    .replace(/\s+(Jr\.?|Sr\.?|I{1,3}|IV|V|MD|PhD|JD|DDS|CPA)\b.*$/i, '')
    .trim();
}

function isLikelyHeadline(line) {
  if (!line) return false;
  if (line.length < 6 || line.length > 200) return false;
  // Headline rarely contains a comma as a position separator
  if (/\s+(at|@|\|)\s+/i.test(line)) return true;
  // Or it has commercial words
  if (/\b(engineer|manager|director|founder|head of|lead|developer|designer|operator|partner|chief|vp|cto|ceo|coo|cfo|owner|consultant|writer|product|sales|marketing|advisor|coach|investor|recruiter)\b/i.test(line)) return true;
  return false;
}

function isLikelyLocation(line) {
  if (!line) return false;
  if (line.length > 100) return false;
  // City, State / Country pattern, or a "Contact info"-adjacent line
  if (/,\s+[A-Z][a-z]+/.test(line) && !/\bat\b/i.test(line)) return true;
  // "San Francisco Bay Area" style without comma
  if (/\b(area|region|metropolitan|metro)\b/i.test(line)) return true;
  return false;
}

// Main entrypoint: capture, OCR, parse. Best-effort — never throws.
async function captureAndExtract(page, profileUrl, options = {}) {
  const outDir = options.outDir || DEFAULT_OUT_DIR;
  ensureDir(outDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slugSource = options.prospectId
    || (profileUrl ? profileUrl.replace(/^.*\/in\//, '').replace(/[\/?#].*$/, '') : 'profile');
  const filename = `${safeSlug(slugSource)}-${stamp}.png`;
  const screenshotPath = path.join(outDir, filename);

  let ocrText = null;
  let parsed = { name: null, title: null, company: null, location: null };

  try {
    await captureTopCard(page, screenshotPath);
  } catch (error) {
    return { screenshotPath: null, ocrText: null, parsed, error: error.message || String(error) };
  }

  if (options.runOcr !== false) {
    try {
      // Lazy-require so the worker only pulls in tesseract.js when the
      // fallback path actually fires.
      const Tesseract = require('tesseract.js');
      const res = await Tesseract.recognize(screenshotPath, 'eng', { logger: () => {} });
      ocrText = (res && res.data && res.data.text) || '';
      parsed = parseOcrText(ocrText);
    } catch (error) {
      return { screenshotPath, ocrText: null, parsed, error: `OCR failed: ${error.message || String(error)}` };
    }
  }

  return { screenshotPath, ocrText, parsed };
}

module.exports = {
  captureAndExtract,
  captureTopCard,
  parseOcrText,
  DEFAULT_OUT_DIR,
};
