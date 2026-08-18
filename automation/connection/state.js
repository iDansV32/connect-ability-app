function readConnectionState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('main') || document.body;
    const elements = Array.from(root.querySelectorAll('button, a, [role="button"], [role="menuitem"]'));
    const texts = elements
      .map((element) => {
        const text = (element.textContent || '').trim().toLowerCase();
        const aria = (element.getAttribute('aria-label') || '').trim().toLowerCase();
        return `${text} ${aria}`.trim();
      })
      .filter(Boolean);

    const matches = (pattern) => texts.some((text) => pattern.test(text));
    const hasConnectAction = matches(/\b(connect|invite|add)\b/);
    const hasPendingAction = matches(/\bpending\b/);
    const hasMessageAction = matches(/\bmessage\b/);
    const hasRemoveConnectionAction = matches(/\b(remove connection|disconnect)\b/);

    return {
      pending: hasPendingAction,
      connected: hasRemoveConnectionAction || (hasMessageAction && !hasConnectAction && !hasPendingAction),
      following: matches(/\bfollowing\b/),
      canConnect: hasConnectAction && !hasPendingAction
    };
  }).catch(() => ({
    pending: false,
    connected: false,
    following: false,
    canConnect: false
  }));
}

module.exports = {
  readConnectionState
};
