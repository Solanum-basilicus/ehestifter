(function (w) {
  async function fetchWithRetry(url, attempts = 4, baseDelay = 750, init = {}, onResponse = null) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, init));
        if (typeof onResponse === 'function') onResponse(r);
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

  // Job lists must not repeat failed requests. A second request can load SQL again.
  async function fetchJsonOnce(url, init = {}, onResponse = null) {
    const response = await fetch(url, Object.assign({ credentials: 'same-origin' }, init));
    if (typeof onResponse === 'function') onResponse(response);
    let data;
    try {
      data = await response.json();
    } catch (_) {
      if (!response.ok) throw new Error(`Jobs request failed (HTTP ${response.status})`);
      throw new Error('Jobs service returned an invalid response');
    }
    if (!response.ok) {
      throw new Error((data && data.message) || `Jobs request failed (HTTP ${response.status})`);
    }
    return data;
  }

  // Expose both a simple global and a namespaced variant
  if (typeof w.fetchWithRetry !== 'function') w.fetchWithRetry = fetchWithRetry;
  w.Net = w.Net || {};
  w.Net.fetchJsonOnce = fetchJsonOnce;
  if (typeof w.Net.fetchWithRetry !== 'function') w.Net.fetchWithRetry = fetchWithRetry;
})(window);
