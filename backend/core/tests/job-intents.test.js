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
