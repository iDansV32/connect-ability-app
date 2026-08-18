'use strict';

const LEGACY_DIRECT_LOGIN_ENV = 'CONNECT_ALLOW_LEGACY_DIRECT_LOGIN';

function normalizeLegacyDirectLoginEntryPoint(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function parseLegacyDirectLoginAllowList(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return { allowAll: false, entries: new Set() };
  }

  if (/^(1|true|yes|all)$/i.test(raw)) {
    return { allowAll: true, entries: new Set() };
  }

  const entries = new Set(
    raw
      .split(',')
      .map((entry) => normalizeLegacyDirectLoginEntryPoint(entry))
      .filter(Boolean)
  );
  return {
    allowAll: entries.has('all'),
    entries
  };
}

function isLegacyDirectLoginAllowed(entryPoint, env = process.env) {
  const normalizedEntryPoint = normalizeLegacyDirectLoginEntryPoint(entryPoint);
  const { allowAll, entries } = parseLegacyDirectLoginAllowList(env?.[LEGACY_DIRECT_LOGIN_ENV]);
  if (allowAll) {
    return true;
  }
  return normalizedEntryPoint ? entries.has(normalizedEntryPoint) : false;
}

function buildLegacyDirectLoginError(entryPoint, env = process.env) {
  const normalizedEntryPoint = normalizeLegacyDirectLoginEntryPoint(entryPoint) || 'legacy-direct-login';
  const mode = String(env?.CONNECT_MODE || 'customer').trim().toLowerCase() || 'customer';
  return new Error(
    `Legacy direct-login path "${normalizedEntryPoint}" is disabled in ${mode} mode. `
    + `Use the worker-owned runtime path instead. `
    + `Set ${LEGACY_DIRECT_LOGIN_ENV}=1 or ${LEGACY_DIRECT_LOGIN_ENV}=${normalizedEntryPoint} `
    + 'for emergency-only use.'
  );
}

function assertLegacyDirectLoginAllowed(entryPoint, options = {}) {
  const env = options.env || process.env;
  if (isLegacyDirectLoginAllowed(entryPoint, env)) {
    if (typeof options.onAllowed === 'function') {
      options.onAllowed({
        entryPoint: normalizeLegacyDirectLoginEntryPoint(entryPoint),
        envVar: LEGACY_DIRECT_LOGIN_ENV
      });
    }
    return true;
  }
  throw buildLegacyDirectLoginError(entryPoint, env);
}

module.exports = {
  LEGACY_DIRECT_LOGIN_ENV,
  normalizeLegacyDirectLoginEntryPoint,
  parseLegacyDirectLoginAllowList,
  isLegacyDirectLoginAllowed,
  buildLegacyDirectLoginError,
  assertLegacyDirectLoginAllowed
};
