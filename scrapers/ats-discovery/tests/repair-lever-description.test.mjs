import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLeverPostingUrl,
  repairLeverDescription,
} from '../src/maintenance/repair-lever-description.mjs';

const URL = 'https://jobs.lever.co/360learning/7c97a721-9d46-4568-a803-a11a7f669a5b';

function jobsClient({ before = '<p>Short.</p>' } = {}) {
  const updates = [];
  return {
    updates,
    async existsByUrl(url) {
      assert.equal(url, URL);
      return {
        exists: true,
        id: 'job-guid',
        identity: {
          provider: 'lever',
          providerTenant: '360learning',
          externalId: '7c97a721-9d46-4568-a803-a11a7f669a5b',
        },
      };
    },
    async getJob(id) {
      assert.equal(id, 'job-guid');
      return { Description: before };
    },
    async updateJobDescription(id, description) {
      updates.push({ id, description });
      return { responseStatus: 200 };
    },
  };
}

function posting() {
  return {
    text: 'Implementation Manager',
    descriptionPlain: 'Full introduction.',
    lists: [{
      text: 'Responsibilities',
      content: '<ul><li>Lead implementation</li></ul>',
    }],
    additionalPlain: 'Closing.',
  };
}

test('repair URL parsing supports global and EU Lever hosts only', () => {
  assert.deepEqual(parseLeverPostingUrl(URL), {
    sourceUrl: URL,
    site: '360learning',
    postingId: '7c97a721-9d46-4568-a803-a11a7f669a5b',
    apiUrl: 'https://api.lever.co/v0/postings/360learning/7c97a721-9d46-4568-a803-a11a7f669a5b',
  });
  assert.equal(
    parseLeverPostingUrl('https://jobs.eu.lever.co/acme/abc').apiUrl,
    'https://api.eu.lever.co/v0/postings/acme/abc',
  );
  assert.throws(
    () => parseLeverPostingUrl('https://evil.example/acme/abc'),
    /Unsupported Lever posting host/,
  );
  assert.throws(
    () => parseLeverPostingUrl('https://jobs.lever.co/acme'),
    /posting-id/,
  );
});

test('repair defaults to dry-run and does not update Jobs', async () => {
  const client = jobsClient();
  const calls = [];
  const result = await repairLeverDescription({
    postingUrl: URL,
    jobsClient: client,
    async fetchJson(url, options) {
      calls.push({ url, options });
      return posting();
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.lever\.co\/v0\/postings/);
  assert.deepEqual(calls[0].options, { redirect: 'error' });
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, true);
  assert.equal(result.applied, false);
  assert.equal(client.updates.length, 0);
  assert.ok(result.afterDescriptionLength > result.beforeDescriptionLength);
});

test('repair applies a description-only Jobs update with explicit --apply intent', async () => {
  const client = jobsClient();
  const result = await repairLeverDescription({
    postingUrl: URL,
    apply: true,
    jobsClient: client,
    async fetchJson() { return posting(); },
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.applied, true);
  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0].id, 'job-guid');
  assert.match(client.updates[0].description, /Responsibilities/);
  assert.match(client.updates[0].description, /Lead implementation/);
});

test('repair skips PUT when the stored description is already current', async () => {
  const expected = '<p>Full introduction.</p><p>Responsibilities</p><p>- Lead implementation</p><p>Closing.</p>';
  const client = jobsClient({ before: expected });
  const result = await repairLeverDescription({
    postingUrl: URL,
    apply: true,
    jobsClient: client,
    async fetchJson() { return posting(); },
  });

  assert.equal(result.changed, false);
  assert.equal(result.applied, false);
  assert.equal(client.updates.length, 0);
});

test('repair rejects identity mismatches before reading or updating the job', async () => {
  const client = jobsClient();
  client.existsByUrl = async () => ({
    exists: true,
    id: 'job-guid',
    identity: {
      provider: 'greenhouse',
      providerTenant: '360learning',
      externalId: '7c97a721-9d46-4568-a803-a11a7f669a5b',
    },
  });

  await assert.rejects(
    repairLeverDescription({
      postingUrl: URL,
      jobsClient: client,
      async fetchJson() { return posting(); },
    }),
    /provider is not lever/,
  );
});
