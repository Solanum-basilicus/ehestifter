const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const base = fs.readFileSync(path.join(root, 'templates/base.html'), 'utf8');
const block = base.match(/<!-- User-bar cold-start helper -->\s*<script>([\s\S]*?)<\/script>/);
assert.ok(block, 'User header script must be present');
const headerSource = block[1].replaceAll('{{ url_for(\'me\') }}', '/me');

function setup(perfFile) {
  const listeners = {};
  const events = [];
  let requests = 0;
  let fail = false;
  const link = {
    textContent: '', href: '', classList: { remove() {} },
    removeAttribute(name) { delete this[name]; },
    insertAdjacentElement() {},
  };
  const document = {
    readyState: 'loading',
    getElementById: name => (name === 'user-link' ? link : null),
    createElement: () => ({ style: {} }),
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const window = {
    document, performance: { now: () => 10 },
    addEventListener() {}, dispatchEvent: event => events.push(event),
    console: { table() {} },
    fetchWithRetry: async (_url, _attempts, _delay, _options, onResponse) => {
      requests++;
      if (fail) throw Error('failed');
      if (onResponse) onResponse({ headers: { get: () => 'core;dur=12' } });
      return { name: 'Test User', id: 42 };
    },
  };
  if (perfFile) {
    const source = fs.readFileSync(path.join(root, 'static/js', perfFile), 'utf8');
    vm.runInNewContext(source, { window }, { filename: perfFile });
  }
  vm.runInNewContext(headerSource, { window, document, CustomEvent: class {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  } }, { filename: 'base.html user script' });
  return { window, link, events, listeners, get requests() { return requests; }, setFail: value => { fail = value; } };
}

for (const [name, file] of [
  ['job list', 'jobs-list-perf.js'],
  ['job details', 'job-intents.js'],
  ['other page', null],
]) {
  test(`user header initializes with ${name} diagnostics`, async () => {
    const testPage = setup(file);
    await testPage.listeners.DOMContentLoaded();
    assert.equal(testPage.requests, 1);
    assert.equal(testPage.link.textContent, 'To profile: Test User');
    assert.equal(testPage.link.href, '/me');
    assert.equal(testPage.window.CURRENT_USER_ID, '42');
    assert.equal(testPage.events[0].type, 'user-hydrated');
    if (file === 'job-intents.js') {
      const user = testPage.window.ehPerf.snapshot().intents[0].operations.user;
      assert.equal(user.state, 'ok');
      assert.equal(user.server.core, 12);
    }
  });
}

test('a failed user request can be retried on the list page', async () => {
  const page = setup('jobs-list-perf.js');
  page.setFail(true);
  await page.listeners.DOMContentLoaded();
  assert.match(page.link.textContent, /User info unavailable/);
  page.setFail(false);
  await page.window.initUser();
  assert.equal(page.requests, 2);
  assert.equal(page.window.CURRENT_USER_ID, '42');
});
