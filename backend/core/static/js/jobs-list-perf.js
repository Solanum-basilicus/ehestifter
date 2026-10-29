/* Keep server timings from each list request. Do not send telemetry. */
(function (w) {
  const records = [];
  let current = null;
  let nextId = 1;
  const stages = ['list', 'status', 'compatibility', 'locations'];
  const clock = () => w.performance.now();
  const round = n => Math.round(n * 100) / 100;

  function parseServerTiming(header) {
    const fields = {};
    const labels = {};
    for (const part of String(header || '').slice(0, 4096).split(',').slice(0, 80)) {
      const numeric = part.trim().match(/^([a-z0-9_]+);dur=([0-9]+(?:\.[0-9]+)?)$/);
      const label = part.trim().match(/^([a-z0-9_]+);desc="([a-z0-9_]+)"$/);
      if (numeric) fields[numeric[1]] = Number(numeric[2]);
      else if (label) labels[label[1]] = label[2];
    }
    const services = { core: { steps: {} }, jobs: { steps: {} }, users: { steps: {} },
      enrichers: { steps: {}, gateway: { steps: {} }, users: { steps: {} } } };
    const add = (scope, key, value) => {
      if (key.startsWith('step_')) scope.steps[key.slice(5)] = value;
      else scope[key] = value;
    };
    for (const [key, value] of Object.entries({ ...fields, ...labels })) {
      if (key === 'users_cache') add(services.core, key, value);
      else if (key.startsWith('enrichers_users_')) add(services.enrichers.users, key.slice(16), value);
      else if (key.startsWith('users_')) add(services.users, key.slice(6), value);
      else if (key.startsWith('enrichers_gateway_')) add(services.enrichers.gateway, key.slice(18), value);
      else if (key.startsWith('enrichers_')) add(services.enrichers, key.slice(10), value);
      else if (key.startsWith('jobs_')) add(services.jobs, key.slice(5), value);
      else add(services.core, key, value);
    }
    return { ...fields, labels, services };
  }

  function listStart(category) {
    if (current) current.close('abandoned');
    const record = { id: nextId++, name: 'job.list.load', category,
      state: 'running', startMs: round(clock()), durationMs: null, operations: {} };
    for (const stage of stages) {
      record.operations[stage] = { state: 'pending', startMs: null, durationMs: null };
    }
    records.push(record);
    if (records.length > 30) records.shift();
    const started = clock();
    const handle = {
      start(stage) {
        const op = record.operations[stage];
        if (op && op.startMs === null) op.startMs = round(clock() - started);
      },
      response(stage, response) {
        const op = record.operations[stage];
        if (op && response?.headers) {
          op.server = parseServerTiming(response.headers.get('Server-Timing'));
        }
      },
      finish(stage, state) {
        const op = record.operations[stage];
        if (!op || op.state !== 'pending') return;
        if (op.startMs === null) op.startMs = round(clock() - started);
        op.durationMs = round(clock() - started - op.startMs);
        op.state = state || 'ok';
      },
      close(state) {
        if (record.state !== 'running') return;
        record.durationMs = round(clock() - started);
        const values = Object.values(record.operations);
        record.state = state || (values.some(op => op.state === 'error') ? 'partial' : 'completed');
        if (values.every(op => op.state === 'skipped')) record.state = 'completed';
        if (values[0].state === 'error') record.state = 'failed';
        if (current === handle) current = null;
      },
    };
    current = handle;
    return handle;
  }

  function snapshot() { return JSON.parse(JSON.stringify({ intents: records })); }
  function table() {
    const rows = records.map(record => ({
      id: record.id, category: record.category, state: record.state,
      durationMs: record.durationMs,
      operations: Object.entries(record.operations).map(([name, op]) => `${name}:${op.state}`).join(' '),
      jobsStages: Object.entries(record.operations).flatMap(([name, op]) =>
        Object.entries(op.server?.services?.jobs?.steps || {}).map(([step, ms]) =>
          `${name}.${step}=${ms}ms`)).join(' '),
    }));
    w.console.table(rows);
    return rows;
  }
  w.addEventListener('pagehide', () => current?.close('abandoned'));
  w.ehPerf = { snapshot, table, listStart };
})(window);
