const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFetch(fetchMock) {
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'net-utils.js'), 'utf8');
  vm.runInNewContext(source, { window, fetch: fetchMock, setTimeout, Math, Promise });
  return window.Net;
}

test('jobs list request makes one fetch on success', async () => {
  const calls = [];
  const net = loadFetch(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  });
  const result = await net.fetchJsonOnce('/ui/jobs');
  assert.equal(result.items.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, 'same-origin');
});

test('jobs list request does not retry after HTTP 504', async () => {
  let calls = 0;
  const net = loadFetch(async () => {
    calls += 1;
    return { ok: false, status: 504, json: async () => ({ message: 'The jobs search took too long.' }) };
  });
  await assert.rejects(net.fetchJsonOnce('/ui/jobs'), /The jobs search took too long/);
  assert.equal(calls, 1);
});

test('jobs list request does not retry a network error', async () => {
  let calls = 0;
  const net = loadFetch(async () => {
    calls += 1;
    throw new Error('Network error');
  });
  await assert.rejects(net.fetchJsonOnce('/ui/jobs'), /Network error/);
  assert.equal(calls, 1);
});

test('jobs list request reports HTTP failure when the body is not JSON', async () => {
  let calls = 0;
  const net = loadFetch(async () => {
    calls += 1;
    return { ok: false, status: 502, json: async () => { throw new Error('Bad JSON'); } };
  });
  await assert.rejects(net.fetchJsonOnce('/ui/jobs'), /HTTP 502/);
  assert.equal(calls, 1);
});

test('description search is absent from the UI dropdown', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
  const search = html.match(/<select id="searchField"[\s\S]*?<\/select>/);
  assert.ok(search);
  assert.doesNotMatch(search[0], /value="description"/);
});
