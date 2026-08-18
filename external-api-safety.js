'use strict';

/**
 * external-api-safety.js — policy for the Electron app's external HTTP API.
 *
 * The external API (`/api/call` → callRendererApiFunction → renderer
 * window.electronAPI[fn]) is a remote trigger surface for the same functions
 * the GUI buttons call. Some of those drive a real browser. This module is the
 * single source of truth for what an external API caller may invoke and under
 * what constraints.
 *
 * Invariants enforced here:
 *   1. No external-API browser action may run headless. The visible canonical
 *      worker is the only sanctioned automation path; a headless launch is
 *      more detectable and bypasses the stealth posture. We REJECT an explicit
 *      headless:true and FORCE headless:false on the payload.
 *   2. Every allowed browser action is stamped launchSource:'external_api' so
 *      the worker can assert "external launches are visible-only" at the actual
 *      browser launch (defense in depth — see account-worker-process.js).
 *   3. Legacy direct-login (automation.js) paths, the legacy send-now path, the
 *      not-yet-source-aware startWorkflow, and the generic `send` IPC escape
 *      hatch are BLOCKED entirely — they don't carry the canonical-worker
 *      guarantees and `send` would let a caller reach any VALID_SEND_CHANNEL.
 *
 * This module is pure (no I/O, no Electron deps) so the policy is one
 * testable seam. main.js calls applyExternalApiSafety in callRendererApiFunction
 * before injecting args into the renderer, and uses the filter* helpers to make
 * /api/functions and /api/schema advertise only what's actually callable.
 */

const EXTERNAL_API_LAUNCH_SOURCE = 'external_api';

// Browser-driving functions allowed via the external API — visible mode only.
// Each takes a single object payload (except runGroupWorkflow, which also has a
// positional form normalized below); applyExternalApiSafety stamps every one
// with headless:false + launchSource so the canonical worker enforces visible.
const VISIBLE_BROWSER_FUNCTIONS = Object.freeze(new Set([
  'publishLinkedInPost',
  'runGroupWorkflow',
  // Operator-grade live actions, dispatched through the same persistent-context
  // worker as workflow steps. Needed for safe API-driven live validation
  // (people search + an approved single DM).
  'sendNewDm',
  'findLinkedInProfilesBySearch'
]));

// Functions blocked from the external API. The reason code drives the error
// code returned to the caller and the discovery filtering.
const BLOCKED_FUNCTIONS = Object.freeze(new Map([
  // Legacy direct-login (automation.js subprocess) — not canonical worker.
  ['startAutomation', 'legacy_direct_login'],
  ['startNameListAutomation', 'legacy_direct_login'],
  // Legacy send-now routes through executeScheduledMessage → automation.js.
  ['sendScheduledNow', 'legacy_automation_subprocess'],
  // Launches a saved workflow whose stored headless may be true; the trampoline
  // gives the main handler no clean "from external API" signal. Blocked in v1;
  // re-enable later via a source-aware launch endpoint.
  ['startWorkflow', 'not_source_aware'],
  // Generic IPC passthrough — limited to VALID_SEND_CHANNELS, but that set
  // includes legacy browser paths (send-messages-now, open-workflow-manager),
  // so it's a classification-bypass vector. Not for external callers.
  ['send', 'generic_ipc_bypass']
]));

const BLOCKED_REASON_TO_CODE = Object.freeze({
  legacy_direct_login: 'external_api_legacy_browser_blocked',
  legacy_automation_subprocess: 'external_api_legacy_browser_blocked',
  not_source_aware: 'external_api_not_source_aware',
  generic_ipc_bypass: 'external_api_generic_send_blocked'
});

class ExternalApiSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExternalApiSafetyError';
    this.code = code;
  }
}

/**
 * @typedef {object} ExternalApiPolicy
 * @property {boolean} allowed
 * @property {boolean} forcesVisible  true for browser functions that must run headless:false + launchSource
 * @property {string|null} blockedReason
 */

/**
 * @param {string} name external API function name
 * @returns {ExternalApiPolicy}
 */
function classifyExternalApiFunction(name) {
  const fn = String(name || '').trim();
  if (BLOCKED_FUNCTIONS.has(fn)) {
    return { allowed: false, forcesVisible: false, blockedReason: BLOCKED_FUNCTIONS.get(fn) };
  }
  if (VISIBLE_BROWSER_FUNCTIONS.has(fn)) {
    return { allowed: true, forcesVisible: true, blockedReason: null };
  }
  // Read-only / store-write / no-op-stub functions: allowed as-is.
  return { allowed: true, forcesVisible: false, blockedReason: null };
}

function isHeadlessTruthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Apply external-API safety policy to a call.
 *
 * - Blocked function → throws ExternalApiSafetyError with the mapped code.
 * - Visible-browser function → normalizes args[0] to an object, REJECTS an
 *   explicit headless:true, FORCES headless:false, attaches
 *   launchSource:'external_api'. Returns the sanitized args array.
 * - Everything else → returns args unchanged.
 *
 * @param {string} name
 * @param {Array} args  the args array that will be spread into the renderer fn
 * @returns {Array} sanitized args
 * @throws {ExternalApiSafetyError}
 */
function applyExternalApiSafety(name, args = []) {
  const policy = classifyExternalApiFunction(name);

  if (!policy.allowed) {
    const code = BLOCKED_REASON_TO_CODE[policy.blockedReason] || 'external_api_blocked';
    throw new ExternalApiSafetyError(
      code,
      `Function "${name}" is blocked from the external API (${policy.blockedReason}).`
    );
  }

  if (!policy.forcesVisible) {
    return Array.isArray(args) ? args : [];
  }

  // Visible-browser function. Normalize the leading payload to an object.
  const inputArgs = Array.isArray(args) ? args.slice() : [];
  let payload = inputArgs[0];

  // runGroupWorkflow positional form: (groupId, actions, connectionMessage).
  // Collapse to the object form so launchSource always has a home and the
  // renderer bridge takes its object path.
  if (name === 'runGroupWorkflow' && (payload == null || typeof payload === 'string')) {
    payload = {
      groupId: payload || null,
      actions: inputArgs[1],
      connectionMessage: inputArgs[2]
    };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    payload = {};
  }

  if (isHeadlessTruthy(payload.headless)) {
    throw new ExternalApiSafetyError(
      'external_api_headless_forbidden',
      `Function "${name}" cannot run headless via the external API. Remove headless:true — external API browser actions are visible-only.`
    );
  }

  const sanitizedPayload = {
    ...payload,
    headless: false,
    launchSource: EXTERNAL_API_LAUNCH_SOURCE
  };

  return [sanitizedPayload];
}

/**
 * Filter the /api/functions list to only externally-callable functions.
 * @param {string[]} names
 * @returns {string[]}
 */
function filterExternalApiFunctions(names) {
  if (!Array.isArray(names)) return [];
  return names.filter((name) => classifyExternalApiFunction(name).allowed);
}

/**
 * Recursively strip every `headless` key from a value (objects + arrays),
 * returning a structurally-fresh copy. Used to scrub the advertised arg schema
 * so no external function — at any nesting depth — exposes a choosable headless.
 * Returns the input unchanged if there is nothing to strip.
 * @param {*} value
 * @returns {{ value: *, stripped: boolean }}
 */
function stripHeadlessDeep(value) {
  if (Array.isArray(value)) {
    let stripped = false;
    const next = value.map((item) => {
      const result = stripHeadlessDeep(item);
      if (result.stripped) stripped = true;
      return result.value;
    });
    return stripped ? { value: next, stripped: true } : { value, stripped: false };
  }
  if (value && typeof value === 'object') {
    let stripped = false;
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'headless') { stripped = true; continue; }
      const result = stripHeadlessDeep(child);
      if (result.stripped) stripped = true;
      next[key] = result.value;
    }
    return stripped ? { value: next, stripped: true } : { value, stripped: false };
  }
  return { value, stripped: false };
}

/**
 * Filter the /api/schema operation catalog: drop blocked functions, and strip
 * the `headless` knob from any kept entry's arg schema — at any nesting depth,
 * covering both the legacy `args` object form and the real `argsShape` array
 * form (no external function may advertise a choosable headless). Adds a
 * headlessPolicy note to visible-browser entries.
 * @param {Array<object>} catalog
 * @returns {Array<object>}
 */
function filterExternalApiCatalog(catalog) {
  if (!Array.isArray(catalog)) return [];
  return catalog
    .filter((entry) => {
      // Keep non-function meta entries (e.g. the request-shape doc) and any
      // entry whose function is allowed.
      const fn = entry && entry.function;
      if (!fn || typeof fn !== 'string') return true;
      // The request-shape doc entry uses function: 'string (required)' — keep it.
      if (fn.includes(' ')) return true;
      return classifyExternalApiFunction(fn).allowed;
    })
    .map((entry) => {
      const fn = entry && entry.function;
      if (!fn || typeof fn !== 'string' || fn.includes(' ')) return entry;
      const policy = classifyExternalApiFunction(fn);

      // Scrub headless from whichever arg-schema field the entry uses. The real
      // catalog uses `argsShape` (an array); some synthetic shapes use `args`.
      let next = entry;
      for (const field of ['args', 'argsShape']) {
        if (next[field] === undefined) continue;
        const result = stripHeadlessDeep(next[field]);
        if (result.stripped) {
          next = { ...next, [field]: result.value };
        }
      }

      if (policy.forcesVisible) {
        next = next === entry ? { ...entry } : next;
        next.headlessPolicy = 'forced-false (external API browser actions run visible-only)';
      }
      return next;
    });
}

/**
 * Filter the /api/schema examples: drop blocked-function keys, strip headless
 * from kept example payloads. Non-function meta keys (health, listFunctions)
 * are kept.
 * @param {object} examples
 * @returns {object}
 */
function filterExternalApiExamples(examples) {
  if (!examples || typeof examples !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(examples)) {
    if (!classifyExternalApiFunction(key).allowed) continue; // drop blocked fn examples
    // Strip headless from args[0] payloads if present.
    if (value && typeof value === 'object' && Array.isArray(value.body?.args)) {
      const args = value.body.args.map((arg) => {
        if (arg && typeof arg === 'object' && !Array.isArray(arg) && 'headless' in arg) {
          const next = { ...arg };
          delete next.headless;
          return next;
        }
        return arg;
      });
      out[key] = { ...value, body: { ...value.body, args } };
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = {
  EXTERNAL_API_LAUNCH_SOURCE,
  VISIBLE_BROWSER_FUNCTIONS,
  BLOCKED_FUNCTIONS,
  ExternalApiSafetyError,
  classifyExternalApiFunction,
  applyExternalApiSafety,
  filterExternalApiFunctions,
  filterExternalApiCatalog,
  filterExternalApiExamples
};
