'use strict';

function getErrorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    return `${error.name || 'Error'}: ${error.message || ''}`.trim();
  }
  return String(error);
}

function isTargetClosedError(error) {
  const text = getErrorText(error);
  if (!text) return false;

  return [
    /target page, context or browser has been closed/i,
    /target closed/i,
    /browser has been closed/i,
    /page has been closed/i,
    /context or browser has been closed/i,
    /most likely the page has been closed/i
  ].some((pattern) => pattern.test(text));
}

function isChildProcessActive(child) {
  return Boolean(child && typeof child.kill === 'function' && !child.killed && child.exitCode == null);
}

function terminateChildProcess(child, options = {}) {
  const {
    signal = 'SIGTERM',
    forceKillAfterMs = 1500,
    scheduleFn = setTimeout,
    clearFn = clearTimeout
  } = options;

  if (!isChildProcessActive(child)) {
    return false;
  }

  let forceTimer = null;
  const clearTimer = () => {
    if (forceTimer) {
      clearFn(forceTimer);
      forceTimer = null;
    }
  };

  if (typeof child.once === 'function') {
    child.once('exit', clearTimer);
    child.once('close', clearTimer);
  }

  try {
    child.kill(signal);
  } catch (_) {
    clearTimer();
    return false;
  }

  if (forceKillAfterMs > 0) {
    forceTimer = scheduleFn(() => {
      if (!isChildProcessActive(child)) {
        return;
      }
      try {
        child.kill('SIGKILL');
      } catch (_) {}
    }, forceKillAfterMs);
    if (forceTimer && typeof forceTimer.unref === 'function') {
      forceTimer.unref();
    }
  }

  return true;
}

module.exports = {
  isChildProcessActive,
  isTargetClosedError,
  terminateChildProcess
};
