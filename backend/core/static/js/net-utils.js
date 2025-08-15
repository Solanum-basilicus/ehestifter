(function (w) {
  async function fetchWithRetry(url, attempts = 4, baseDelay = 750, init = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, init));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json(); // JSON-only, matches current callers' expectations
      } catch (e) {
        lastErr = e;
        const jitter = Math.random() * 250;
        const delay = baseDelay * Math.pow(2, i) + jitter;
        await new Promise(res => setTimeout(res, delay));
      }
    }
    throw lastErr;
  }

  // Expose both a simple global and a namespaced variant
  if (typeof w.fetchWithRetry !== 'function') w.fetchWithRetry = fetchWithRetry;
  w.Net = w.Net || {};
  if (typeof w.Net.fetchWithRetry !== 'function') w.Net.fetchWithRetry = fetchWithRetry;
})(window);