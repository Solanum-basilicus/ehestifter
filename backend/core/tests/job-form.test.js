const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const BERLIN = { kind: 'city', locationId: 'geonames:2950159' };
const MUNICH = { kind: 'city', locationId: 'geonames:2867714' };
const GERMANY = { kind: 'country', locationId: 'iso3166:DE' };
const REGION = { kind: 'adminRegion', locationId: 'geonames:2951839' };
const EUROPE = { kind: 'globalRegion', locationId: 'm49:150' };

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, on) { if (on) classes.add(value); else classes.delete(value); },
    };
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.append(item); }
  setAttribute(key, value) {
    this.attributes[key] = value;
    if (key === 'disabled') this.disabled = true;
  }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) {
    delete this.attributes[key];
    if (key === 'disabled') this.disabled = false;
  }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  fire(name, values = {}) {
    const event = { preventDefault() {}, ...values };
    for (const handler of this.listeners[name] || []) handler(event);
  }
  querySelectorAll(selector) {
    const children = this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]);
    return children.filter(child => selector === '.location-chip-remove' && child.className === 'location-chip-remove');
  }
  focus() {}
}

async function makeForm({ mode = 'create', initial = {}, respond } = {}) {
  const ids = ['btnSubmit', 'btnCancel', 'err', 'url', 'title', 'hiringCompanyName',
    'postingCompanyName', 'foundOn', 'atsVendor', 'provider', 'providerTenant',
    'externalId', 'descCount', 'locations', 'locationNotice', 'foundOnNuggets', 'dupBanner'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const radios = Object.fromEntries(['Remote', 'Hybrid', 'On-Site', 'Unknown'].map(value => {
    const element = new Element();
    element.value = value;
    element.checked = value === 'Unknown';
    return [value, element];
  }));
  const document = {
    getElementById: id => elements[id],
    createElement: () => new Element(),
    querySelector(selector) {
      if (selector.startsWith('#')) return elements[selector.slice(1)];
      if (selector.includes(':checked')) return Object.values(radios).find(radio => radio.checked);
      const match = selector.match(/value="([^"]+)"/);
      // A browser clears the other radio values when one is selected.
      if (match) {
        Object.values(radios).forEach(radio => { radio.checked = false; });
        return radios[match[1]];
      }
      return null;
    },
  };
  class Quill {
    constructor() { this.root = new Element(); this.clipboard = { addMatcher() {} }; }
    static import() { return class Delta {}; }
    getText() { return ''; }
    on() {}
  }
  const calls = [];
  const redirects = [];
  const window = {
    __JOB_FORM_CTX__: { mode, initial, disableAts: mode === 'edit' },
    location: { assign: url => redirects.push(url) },
    history: { back() {} },
    setTimeout,
    clearTimeout,
  };
  const sandbox = vm.createContext({
    window, document, Quill, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return respond ? respond(url, options) : { ok: true, json: async () => ({ id: 'job-1' }) };
    },
  });
  for (const name of ['location-picker.js', 'job-form.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', name), 'utf8'), sandbox);
  }
  let picker;
  const RealPicker = window.LocationPicker;
  window.LocationPicker = class extends RealPicker {
    constructor(...args) { super(...args); picker = this; }
  };
  await window.initJobForm({ mode, submitUrl: mode === 'edit' ? '/ui/jobs/job-1' : '/ui/jobs' });
  elements.url.value ||= 'https://example.test/jobs/1';
  return {
    elements, picker, calls, redirects, radios,
    async submit() {
      elements.btnSubmit.fire('click');
      await new Promise(resolve => setImmediate(resolve));
      return JSON.parse(calls.at(-1).options.body);
    },
  };
}

function value(picker) { return JSON.parse(JSON.stringify(picker.getValue())); }
function detail(selector, name, context) {
  return { ...selector, displayName: name, contextLabel: context, label: `${name}, ${context}` };
}

for (const [name, selector] of [
  ['city', BERLIN], ['country', GERMANY], ['administrative region', REGION], ['global region', EUROPE],
]) {
  test(`create sends one ${name} as identity only`, async () => {
    const form = await makeForm();
    form.picker.add(detail(selector, 'Display name', 'Display context'));
    const body = await form.submit();
    assert.deepEqual(body.locationsV2, [selector]);
    assert.equal('locations' in body, false);
    assert.equal(body.remoteType, 'Unknown');
    assert.equal(form.calls[0].options.method, 'POST');
    assert.deepEqual(form.redirects, ['/jobs/job-1']);
  });
}

test('create keeps alternative locations and does not add their parent country', async () => {
  const form = await makeForm();
  form.picker.add(detail(BERLIN, 'Berlin', 'Berlin, Germany'));
  form.picker.add(detail(MUNICH, 'Munich', 'Bavaria, Germany'));
  form.picker.add(detail(BERLIN, 'Berlin', 'Berlin, Germany'));
  assert.deepEqual((await form.submit()).locationsV2, [BERLIN, MUNICH]);
});

test('search shows the kind and hierarchy and supports keyboard selection', async () => {
  const form = await makeForm({ respond: async () => ({
    ok: true, json: async () => ({ items: [detail(BERLIN, 'Berlin', 'Berlin, Germany')] }),
  }) });
  form.picker.input.value = 'Berlin';
  await form.picker.search('Berlin');
  const option = form.picker.menu.children[0];
  assert.equal(option.children[0].children[0].textContent, 'Berlin');
  assert.equal(option.children[0].children[1].textContent, 'City');
  assert.equal(option.children[1].textContent, 'Berlin, Germany');
  form.picker.input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(value(form.picker), [BERLIN]);
  assert.match(form.calls[0].url, /^\/ui\/locations\/search\?/);
});

test('edit loads canonical selections, then removes and adds an alternative', async () => {
  const form = await makeForm({ mode: 'edit', initial: {
    id: 'job-1', url: 'https://example.test/jobs/1', remoteType: 'Hybrid',
    locationsV2: [BERLIN, MUNICH],
    locationDetails: [detail(BERLIN, 'Berlin', 'Berlin, Germany'), detail(MUNICH, 'Munich', 'Bavaria, Germany')],
    locations: [{ countryName: 'France' }],
  } });
  assert.deepEqual(value(form.picker), [BERLIN, MUNICH]);
  assert.equal(form.picker.selectedEl.children[1].children[0].textContent, 'Munich, Bavaria, Germany');
  form.picker.selectedEl.children[0].children[1].fire('click');
  form.picker.add(detail(EUROPE, 'Europe', 'World'));
  const body = await form.submit();
  assert.deepEqual(body.locationsV2, [MUNICH, EUROPE]);
  assert.equal(body.remoteType, 'Hybrid');
  assert.equal('locations' in body, false);
  assert.equal('provider' in body, false);
  assert.equal(form.calls[0].options.method, 'PUT');
});

test('edit sends an empty array after the last location is removed', async () => {
  const form = await makeForm({ mode: 'edit', initial: { id: 'job-1', locationsV2: [BERLIN] } });
  form.picker.selectedEl.children[0].children[1].fire('click');
  assert.deepEqual((await form.submit()).locationsV2, []);
});

for (const mode of ['create', 'edit']) {
  test(`${mode} accepts no canonical location and ignores legacy locations`, async () => {
    const form = await makeForm({ mode, initial: { id: 'job-1', locations: [{ countryName: 'Germany', cityName: 'Berlin' }] } });
    assert.deepEqual(value(form.picker), []);
    if (mode === 'edit') assert.match(form.elements.locationNotice.textContent, /No canonical location/);
    assert.deepEqual((await form.submit()).locationsV2, []);
  });
}

test('lookup failure keeps stored identities when another field is saved', async () => {
  const form = await makeForm({ mode: 'edit', initial: {
    id: 'job-1', locationsV2: [BERLIN, MUNICH], locationDetails: [], locationLookupFailed: true,
  } });
  assert.equal(form.picker.selectedEl.children[0].children[0].textContent, 'city: geonames:2950159');
  assert.match(form.elements.locationNotice.textContent, /labels could not be loaded/);
  form.elements.title.value = 'Changed title';
  assert.deepEqual((await form.submit()).locationsV2, [BERLIN, MUNICH]);
});

test('missing lookup result keeps the unresolved identity', async () => {
  const form = await makeForm({ mode: 'edit', initial: {
    id: 'job-1', locationsV2: [BERLIN, MUNICH], locationDetails: [detail(BERLIN, 'Berlin', 'Germany')],
  } });
  assert.match(form.elements.locationNotice.textContent, /not in the current catalog/);
  assert.deepEqual((await form.submit()).locationsV2, [BERLIN, MUNICH]);
});

test('failed save restores location controls and keeps the selections', async () => {
  let finish;
  const form = await makeForm({ respond: () => new Promise(resolve => { finish = resolve; }) });
  form.picker.add(detail(BERLIN, 'Berlin', 'Germany'));
  const submitting = form.submit();
  assert.equal(form.picker.input.disabled, true);
  assert.equal(form.picker.selectedEl.children[0].children[1].disabled, true);
  assert.equal(form.elements.btnSubmit.disabled, true);
  finish({ ok: false, status: 400, text: async () => 'Invalid canonical identity' });
  await submitting;
  assert.equal(form.picker.input.disabled, false);
  assert.equal(form.picker.selectedEl.children[0].children[1].disabled, false);
  assert.equal(form.elements.btnSubmit.disabled, false);
  assert.deepEqual(value(form.picker), [BERLIN]);
  assert.match(form.elements.err.textContent, /Invalid canonical identity/);
});
