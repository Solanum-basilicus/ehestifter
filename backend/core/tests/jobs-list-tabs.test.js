const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const template = fs.readFileSync(path.join(__dirname, '../templates/jobs/_index_logic.html'), 'utf8');
const script = template.replace(/^<script>\s*/, '').replace(/\s*<\/script>\s*$/, '');
const SORTS = ['created_desc', 'updated_desc', 'status_progression', 'location_az', 'created_asc', 'updated_asc'];

function fakeElement() {
  const handlers = new Map();
  const attributes = new Map();
  const classes = new Set();
  const el = {
    value: '', options: [], dataset: {}, style: {}, hidden: false, innerHTML: '', textContent: '',
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, enabled) => {
        if (enabled === undefined) enabled = !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    },
    addEventListener(name, handler) { handlers.set(name, handler); },
    emit(name) { handlers.get(name)?.({ preventDefault() {}, target: el }); },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {},
  };
  return el;
}

function setup(search = '', items = []) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  const tabs = ['my', 'all', 'open'].map(cat => {
    const tab = fakeElement();
    tab.dataset.cat = cat;
    return tab;
  });
  get('sortSelect').options = SORTS.map(value => ({ value }));
  const requests = [];
  const changes = [];
  const document = {
    getElementById: get,
    querySelectorAll: selector => selector === '.tab[data-cat]' ? tabs : [],
    addEventListener(name, handler) { if (name === 'DOMContentLoaded') this.ready = handler; },
  };
  const location = { pathname: '/', search };
  const history = { replaceState(_state, _title, url) {
    const query = url.substring(url.indexOf('?'));
    location.search = query;
    changes.push(new URLSearchParams(query));
  } };
  const window = {
    ScoreThreshold: { DEFAULT: 5, read: () => 5, validScore: score => score, save() {} },
    localStorage: {},
    Net: { async fetchJsonOnce(url) {
      const params = new URL(url, 'https://jobs.test').searchParams;
      requests.push(params);
      return { items, total: items.length, minCompatibilityScore: 5, activeLocationModel: 'v1' };
    } },
    LocationDisplay: { closePopover() {}, buildPresentation: () => ({}), renderInto() {} },
    setTimeout: () => 1, clearTimeout() {},
  };
  const Status = { STATUS_OPTIONS: ['Applied'], statusKey: () => 'applied' };
  const sessionStorage = { getItem: () => null, setItem() {} };
  const fetch = async () => ({ ok: true, json: async () => ({}) });
  vm.runInNewContext(script, {
    window, document, location, history, sessionStorage, Status, fetch,
    URLSearchParams, Date, Intl, console, Math, Number, Set,
  }, { filename: '_index_logic.html' });
  document.ready();
  return {
    get, tabs, requests, changes, location,
    selectTab: category => tabs.find(tab => tab.dataset.cat === category).emit('click'),
    selectSort: sort => { get('sortSelect').value = sort; get('sortSelect').emit('change'); },
  };
}

function lastRequest(ctx) {
  return ctx.requests.at(-1);
}

test('each tab uses its own default sort', () => {
  const ctx = setup();
  assert.equal(lastRequest(ctx).get('sort'), 'status_progression');
  assert.equal(ctx.get('sortSelect').value, 'status_progression');
  ctx.selectTab('all');
  assert.equal(lastRequest(ctx).get('sort'), 'created_desc');
  ctx.selectTab('open');
  assert.equal(lastRequest(ctx).get('sort'), 'created_desc');
  ctx.selectTab('my');
  assert.equal(lastRequest(ctx).get('sort'), 'status_progression');
});

test('the selected sort stays with its tab when the user switches tabs', () => {
  const ctx = setup();
  ctx.selectSort('created_asc');
  ctx.selectTab('all');
  ctx.selectSort('location_az');
  ctx.selectTab('open');
  assert.equal(lastRequest(ctx).get('sort'), 'created_desc');
  ctx.selectTab('my');
  assert.equal(lastRequest(ctx).get('sort'), 'created_asc');
  ctx.selectTab('all');
  assert.equal(lastRequest(ctx).get('sort'), 'location_az');
  assert.equal(ctx.get('sortSelect').value, 'location_az');
});

test('a URL sort overrides only the selected tab', () => {
  const ctx = setup('?category=all&sort=updated_asc&offset=25');
  assert.equal(lastRequest(ctx).get('category'), 'all');
  assert.equal(lastRequest(ctx).get('sort'), 'updated_asc');
  assert.equal(lastRequest(ctx).get('offset'), '25');
  ctx.selectTab('my');
  assert.equal(lastRequest(ctx).get('sort'), 'status_progression');
  ctx.selectTab('all');
  assert.equal(lastRequest(ctx).get('sort'), 'updated_asc');
  assert.equal(lastRequest(ctx).get('offset'), '0');
});

test('an explicit My Jobs URL can keep the old created date sort', () => {
  const ctx = setup('?category=my&sort=created_desc');
  assert.equal(lastRequest(ctx).get('sort'), 'created_desc');
  ctx.selectTab('open');
  assert.equal(lastRequest(ctx).get('sort'), 'created_desc');
  ctx.selectTab('my');
  assert.equal(lastRequest(ctx).get('sort'), 'created_desc');
});

test('an invalid category cannot change the active tab', () => {
  const ctx = setup('?category=__proto__&sort=updated_desc');
  assert.equal(lastRequest(ctx).get('category'), 'my');
  assert.equal(lastRequest(ctx).get('sort'), 'updated_desc');
});

test('missing or invalid URL sort uses the selected tab default', () => {
  for (const search of ['?category=my', '?category=open', '?category=my&sort=unknown']) {
    const ctx = setup(search);
    const category = lastRequest(ctx).get('category');
    assert.equal(lastRequest(ctx).get('sort'), category === 'my' ? 'status_progression' : 'created_desc');
  }
});

test('My Jobs displays the status update date when available', async () => {
  const item = {
    Id: 'abc', Title: 'Engineer', HiringCompanyName: 'Company',
    FirstSeenAt: '2020-01-01T12:00:00Z', UserStatusLastUpdated: '2025-10-21T12:00:00Z',
  };
  const ctx = setup('?category=my', [item]);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ctx.get('jobs-list').innerHTML, /Status updated/);
  assert.doesNotMatch(ctx.get('jobs-list').innerHTML, /First seen/);
  ctx.selectTab('all');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ctx.get('jobs-list').innerHTML, /First seen/);
});

test('My Jobs keeps First seen if no status update date exists', async () => {
  const ctx = setup('', [{ Id: 'abc', Title: 'Engineer', FirstSeenAt: '2025-10-21T12:00:00Z' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ctx.get('jobs-list').innerHTML, /First seen/);
});
