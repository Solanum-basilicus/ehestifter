import test from 'node:test';
import assert from 'node:assert/strict';

import bamboohr, {
  parseBambooHRResponse,
  resolveBambooHROrigin,
} from '../src/providers/bamboohr.mjs';

test('BambooHR accepts only HTTPS tenant hosts', () => {
  const entry = { careers_url: 'https://Acme.bamboohr.com/careers' };
  assert.equal(resolveBambooHROrigin(entry), 'https://acme.bamboohr.com');
  assert.equal(bamboohr.tenant(entry), 'acme');
  assert.equal(bamboohr.detect(entry).url, 'https://acme.bamboohr.com/careers/list');
  assert.equal(resolveBambooHROrigin({ careers_url: 'http://acme.bamboohr.com/careers' }), null);
  assert.equal(resolveBambooHROrigin({ careers_url: 'https://bamboohr.com/careers' }), null);
  assert.equal(resolveBambooHROrigin({ careers_url: 'https://acme.example.com/careers' }), null);
});

test('BambooHR parser maps public jobs and removes duplicate ids', () => {
  const jobs = parseBambooHRResponse({
    result: [
      {
        id: 35,
        jobOpeningName: 'Senior Product Manager',
        location: { city: 'Berlin', state: 'Berlin' },
        isRemote: true,
      },
      { id: 35, jobOpeningName: 'Duplicate' },
      { id: 36, jobOpeningName: '' },
    ],
  }, 'Acme', 'https://acme.bamboohr.com');

  assert.deepEqual(jobs, [{
    id: '35',
    title: 'Senior Product Manager',
    url: 'https://acme.bamboohr.com/careers/35',
    company: 'Acme',
    location: 'Berlin, Berlin, Remote',
  }]);
});

test('BambooHR fetch uses the public careers list endpoint', async () => {
  const calls = [];
  const jobs = await bamboohr.fetch(
    { name: 'Acme', careers_url: 'https://acme.bamboohr.com/careers' },
    {
      async fetchJson(url, options) {
        calls.push({ url: String(url), options });
        return { result: [{ id: 7, jobOpeningName: 'Engineer' }] };
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://acme.bamboohr.com/careers/list');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(jobs[0].id, '7');
});
