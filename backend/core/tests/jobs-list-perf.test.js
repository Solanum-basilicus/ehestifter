const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/jobs-list-perf.js'), 'utf8');

function setup() {
  let time = 0;
  const window = {
    performance: { now: () => time },
    addEventListener() {},
    console: { table() {} },
  };
  vm.runInNewContext(source, { window });
  return { perf: window.ehPerf, advance: value => { time += value; } };
}

test('list metrics include nested Jobs and Core stages', () => {
  const { perf, advance } = setup();
  const run = perf.listStart('open');
  run.start('list');
  run.response('list', { headers: { get: () => (
    'core;dur=350, jobs_step_count_query;dur=200, jobs_step_page_query;dur=90, ' +
    'jobs_country_lookup_source;desc="index", cache;desc="bypass"'
  ) } });
  advance(400);
  run.finish('list', 'ok');
  run.finish('locations', 'skipped');
  run.start('status');
  run.start('compatibility');
  advance(20);
  run.finish('status', 'ok');
  run.finish('compatibility', 'ok');
  run.close();
  const intent = perf.snapshot().intents[0];
  assert.equal(intent.state, 'completed');
  assert.equal(intent.operations.list.server.services.jobs.steps.count_query, 200);
  assert.equal(intent.operations.list.server.services.jobs.steps.page_query, 90);
  assert.equal(intent.operations.list.server.services.jobs.country_lookup_source, 'index');
  assert.equal(intent.operations.list.server.services.core.cache, 'bypass');
  assert.equal(intent.operations.locations.state, 'skipped');
});

test('new list request abandons the earlier record', () => {
  const { perf } = setup();
  perf.listStart('my').start('list');
  const other = perf.listStart('all');
  other.start('list');
  other.finish('list', 'error');
  other.close();
  const intents = perf.snapshot().intents;
  assert.equal(intents[0].state, 'abandoned');
  assert.equal(intents[1].state, 'failed');
});
