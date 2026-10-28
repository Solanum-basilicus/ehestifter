const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'job-intents.js'), 'utf8');

function setup() {
  let time = 100;
  let onHide;
  const win = {
    performance: { now: () => time },
    console: { table: () => {} },
    document: { readyState: 'loading', addEventListener: (event, handler) => {
      if (event === 'DOMContentLoaded') win.ready = handler;
    } },
    addEventListener: (name, callback) => { if (name === 'pagehide') onHide = callback; },
  };
  vm.runInNewContext(script, { window: win }, { filename: 'job-intents.js' });
  return { perf: win.ehPerf, advance: (ms) => { time += ms; }, ready: () => win.ready(), hide: () => onHide() };
}

test('page readiness waits for all first-load operations', () => {
  const { perf, advance, ready } = setup();
  advance(10);
  ready();
  for (const name of ['user', 'details', 'status', 'history']) {
    perf.pageStart(name);
    advance(20);
    perf.pageFinish(name, 'ok');
  }
  assert.equal(perf.snapshot().intents[0].state, 'running');
  perf.pageStart('compatibility');
  advance(200);
  perf.pageFinish('compatibility', 'error');
  const page = perf.snapshot().intents[0];
  assert.equal(page.state, 'partial');
  assert.equal(page.operations.compatibility.state, 'error');
});

test('two actions overlap page load and each has its own duration', () => {
  const { perf, advance } = setup();
  const a = perf.action('job.status.change');
  advance(150);
  const b = perf.action('job.compatibility.run');
  advance(20);
  a.finish('ok');
  advance(35);
  b.finish('error');
  const [page, first, second] = perf.snapshot().intents;
  assert.equal(page.state, 'running');
  assert.equal(first.durationMs, 170);
  assert.equal(first.state, 'completed');
  assert.equal(second.durationMs, 55);
  assert.equal(second.state, 'failed');
});

test('response server timing is associated with its operation only', () => {
  const { perf } = setup();
  const a = perf.action('job.status.change');
  a.response({ headers: { get: () => 'core;dur=120.2, jobs_sql;dur=58, cache;desc="miss"' } });
  a.finish('ok');
  const record = perf.snapshot().intents[1];
  assert.equal(record.operations.action.server.core, 120.2);
  assert.equal(record.operations.action.server.jobs_sql, 58);
  assert.equal(record.operations.action.server.cache, undefined);
});

test('navigation marks pending instances abandoned', () => {
  const { perf, hide } = setup();
  perf.action('job.status.change');
  hide();
  assert.deepEqual(Array.from(perf.snapshot().intents, it => it.state), ['abandoned', 'abandoned']);
});

test('nested service steps and cold-start hints are kept with the intended operation', () => {
  const { perf } = setup();
  const run = perf.action('job.compatibility.run');
  run.response({ headers: { get: () => [
    'core;dur=9000', 'enrichers_http;dur=8700', 'enrichers_app;dur=1100',
    'enrichers_unattributed;dur=7600', 'enrichers_process_first;desc="1"',
    'enrichers_step_run_create;dur=200', 'enrichers_step_gateway_dispatch;dur=550',
    'enrichers_gateway_step_servicebus_send;dur=150',
    'enrichers_gateway_process_first;desc="1"'
  ].join(', ') } });
  run.finish('ok');
  const server = perf.snapshot().intents[1].operations.action.server;
  assert.equal(server.enrichers_unattributed, 7600);
  assert.equal(server.labels.enrichers_process_first, '1');
  assert.equal(server.services.enrichers.steps.run_create, 200);
  assert.equal(server.services.enrichers.gateway.steps.servicebus_send, 150);
  assert.equal(server.services.enrichers.gateway.process_first, '1');
  assert.ok(perf.table()[1].slowestStages.includes('gateway.servicebus_send'));
});

test('catalog cache labels and stage durations are available together', () => {
  const { perf } = setup();
  perf.pageStart('details');
  perf.pageResponse('details', { headers: { get: () =>
    'core;dur=5000, jobs_step_catalog_load;dur=4300, jobs_step_catalog_parse;dur=1800, jobs_step_catalog_index;dur=2500, jobs_catalog_cache;desc="miss", cache;desc="miss", jobs_sql_count;desc="4"' } });
  perf.pageFinish('details', 'ok');
  const server = perf.snapshot().intents[0].operations.details.server;
  assert.equal(server.services.jobs.steps.catalog_index, 2500);
  assert.equal(server.services.jobs.catalog_cache, 'miss');
  assert.equal(server.labels.cache, 'miss');
  assert.equal(server.jobs_sql_count, undefined);
  assert.equal(server.labels.jobs_sql_count, '4');
});
