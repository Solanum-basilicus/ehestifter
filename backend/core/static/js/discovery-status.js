(function (w) {
  const CHANGE_EVENT = 'ehestifter:discovery-readiness-changed';

  function buildView(status) {
    if (!status || typeof status !== 'object') {
      return { state: 'unavailable', label: 'Unavailable', actions: [] };
    }
    if (status.enabled === true) {
      return { state: 'enabled', label: 'Enabled', actions: [] };
    }

    const reasons = Array.isArray(status.reasons) ? status.reasons : [];
    const actions = [];
    if (reasons.includes('no_usable_cv')) {
      actions.push({ label: 'add CV content', href: '#prefs' });
    }
    if (reasons.includes('no_positive_title')) {
      actions.push({ label: 'add at least one positive title rule', href: '#discovery-prefs' });
    }
    if (reasons.includes('invalid_preferences')) {
      actions.push({ label: 'fix discovery preferences', href: '#discovery-prefs' });
    }
    if (!actions.length) {
      actions.push({ label: 'check profile requirements', href: null });
    }
    return { state: 'disabled', label: 'Disabled', actions };
  }

  function render(target, status) {
    const view = buildView(status);
    target.replaceChildren();
    target.dataset.state = view.state;
    target.append(document.createTextNode(view.label));
    if (!view.actions.length) return;

    target.append(document.createTextNode(' — '));
    view.actions.forEach((action, index) => {
      if (index > 0) target.append(document.createTextNode(' and '));
      if (action.href) {
        const link = document.createElement('a');
        link.href = action.href;
        link.textContent = action.label;
        target.append(link);
      } else {
        target.append(document.createTextNode(action.label));
      }
    });
  }

  async function refresh() {
    const target = document.getElementById('discovery-readiness');
    if (!target) return;
    target.textContent = 'Loading…';
    target.dataset.state = 'loading';
    try {
      const status = await w.fetchWithRetry('/ui/users/discovery-status', 3, 500);
      render(target, status);
    } catch {
      render(target, null);
    }
  }

  function init() {
    if (!document.getElementById('discovery-readiness')) return;
    document.addEventListener(CHANGE_EVENT, refresh);
    refresh();
  }

  w.DiscoveryStatus = Object.freeze({ CHANGE_EVENT, buildView, refresh });
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', init);
  }
})(window);
