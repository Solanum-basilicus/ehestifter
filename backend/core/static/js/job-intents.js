/* Browser-only Jobs diagnostics. No requests or persistent storage. */
(function (w) {
  const records = [];
  let nextId = 1;
  const clock = () => w.performance.now();
  const round = (n) => Math.round(n * 100) / 100;
  const running = new Map();

  function begin(name, operations, startMs) {
    const item = {
      id: nextId++, name, state: 'running',
      startMs: startMs === undefined ? clock() : startMs,
      durationMs: null, operations: {}
    };
    for (const operation of operations) {
      item.operations[operation] = { state: 'pending', startMs: null, durationMs: null };
    }
    records.push(item);
    running.set(item.id, item);
    if (records.length > 50) records.shift();
    return item.id;
  }

  function startOperation(id, name) {
    const item = running.get(id);
    if (!item) return;
    const op = item.operations[name];
    if (op && op.state === 'pending' && op.startMs === null) op.startMs = clock();
  }

  function parseServerTiming(header) {
    const fields = {};
    const labels = {};
    // A bounded parser for fixed metric names. No free-form metadata is stored.
    for (const part of String(header || '').slice(0, 4096).split(',').slice(0, 55)) {
      const numeric = part.trim().match(/^([a-z0-9_]+);dur=([0-9]+(?:\.[0-9]+)?)$/);
      if (numeric) {
        const value = Number(numeric[2]);
        if (Number.isFinite(value)) fields[numeric[1]] = value;
        continue;
      }
      const label = part.trim().match(/^([a-z0-9_]+);desc="([a-z0-9_]+)"$/);
      if (label) labels[label[1]] = label[2];
    }
    const services = { core: { steps: {} }, jobs: { steps: {} }, enrichers: { steps: {}, gateway: { steps: {} } } };
    function addMetric(scope, key, value) {
      if (key.startsWith('step_')) scope.steps[key.slice(5)] = value;
      else scope[key] = value;
    }
    for (const [key, value] of Object.entries({ ...fields, ...labels })) {
      if (key.startsWith('enrichers_gateway_')) addMetric(services.enrichers.gateway, key.slice(18), value);
      else if (key.startsWith('enrichers_')) addMetric(services.enrichers, key.slice(10), value);
      else if (key.startsWith('jobs_')) addMetric(services.jobs, key.slice(5), value);
      else addMetric(services.core, key, value);
    }
    // Keep the previous flat numeric API for existing console usage.
    return { ...fields, labels, services };
  }

  function captureResponse(id, name, response) {
    const item = running.get(id);
    if (!item || !item.operations[name] || !response || !response.headers) return;
    const header = response.headers.get('Server-Timing') || '';
    if (header) item.operations[name].server = parseServerTiming(header);
  }

  function finishOperation(id, name, state) {
    const item = running.get(id);
    if (!item) return;
    const op = item.operations[name];
    if (!op || op.state !== 'pending') return;
    const end = clock();
    op.startMs = op.startMs === null ? item.startMs : op.startMs;
    op.durationMs = round(end - op.startMs);
    op.state = state === 'error' ? 'error' : 'ok';
    if (Object.values(item.operations).every(value => value.state !== 'pending')) {
      finish(id);
    }
  }

  function finish(id, override) {
    const item = running.get(id);
    if (!item) return;
    item.durationMs = round(clock() - item.startMs);
    const all = Object.values(item.operations);
    const errors = all.filter(op => op.state === 'error').length;
    item.state = override || (errors === 0 ? 'completed' :
      errors === all.length ? 'failed' : 'partial');
    if (item.state === 'partial' && item.operations.details?.state === 'error') {
      item.state = 'failed';
    }
    running.delete(id);
  }

  const pageId = begin('job.details.load',
    ['html', 'user', 'details', 'status', 'history', 'compatibility'], 0);

  function pageStart(name) { startOperation(pageId, name); }
  function pageFinish(name, state) { finishOperation(pageId, name, state); }
  function pageResponse(name, response) { captureResponse(pageId, name, response); }
  function action(name) {
    const id = begin(name, ['action']);
    startOperation(id, 'action');
    return {
      response: (response) => captureResponse(id, 'action', response),
      finish: (state) => finishOperation(id, 'action', state),
    };
  }

  // Export copies so callers cannot change active measurements.
  function snapshot() { return JSON.parse(JSON.stringify({ intents: records })); }
  function table() {
    const rows = records.map(r => ({
      id: r.id, intent: r.name, state: r.state, durationMs: r.durationMs,
      operations: Object.entries(r.operations).map(([k, v]) => `${k}:${v.state}`).join(' '),
      slowestStages: Object.entries(r.operations).flatMap(([operation, data]) => {
        const services = data.server?.services;
        if (!services) return [];
        const stages = [
          ...Object.entries(services.jobs.steps).map(([name, ms]) => [`${operation}.jobs.${name}`, ms]),
          ...Object.entries(services.enrichers.steps).map(([name, ms]) => [`${operation}.enrichers.${name}`, ms]),
          ...Object.entries(services.enrichers.gateway.steps).map(([name, ms]) => [`${operation}.gateway.${name}`, ms])
        ];
        return stages.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, ms]) => `${name}=${ms}ms`);
      }).join(' ')
    }));
    w.console.table(rows);
    return rows;
  }
  function settleHtml() { pageFinish('html', 'ok'); }
  if (w.document.readyState === 'loading') {
    w.document.addEventListener('DOMContentLoaded', settleHtml, { once: true });
  } else {
    settleHtml();
  }
  w.addEventListener('pagehide', () => {
    for (const id of Array.from(running.keys())) finish(id, 'abandoned');
  });
  w.ehPerf = { snapshot, table, pageStart, pageFinish, pageResponse, action };
})(window);
