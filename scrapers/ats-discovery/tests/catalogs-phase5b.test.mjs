import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOG_PROVIDER_IDS,
  buildProviderCatalogEnvelope,
  catalogItemToPortalEntry,
  validateProviderCatalogEnvelope,
  validateWorkdayCatalogItem,
} from '../src/catalogs/provider-catalog.mjs';

test('Phase 5B catalog providers are explicit and bounded', () => {
  assert.deepEqual(CATALOG_PROVIDER_IDS, ['ashby', 'greenhouse', 'lever', 'workday']);
});

test('Greenhouse and Lever accept compact slugs and richer objects', () => {
  const greenhouse = buildProviderCatalogEnvelope(
    'greenhouse',
    Buffer.from(JSON.stringify(['celonis', { name: 'Acme', slug: 'acme' }, 'CELONIS'])),
  );
  assert.equal(greenhouse.acceptedItemCount, 2);
  assert.equal(greenhouse.duplicateItemCount, 1);
  assert.deepEqual(greenhouse.items.map((item) => item.tenant), ['acme', 'celonis']);
  assert.equal(greenhouse.items[0].careersUrl, 'https://job-boards.greenhouse.io/acme');

  const lever = buildProviderCatalogEnvelope(
    'lever',
    Buffer.from(JSON.stringify([{ name: 'Rainfocus', tenant: 'rainfocus' }])),
  );
  assert.equal(lever.items[0].careersUrl, 'https://jobs.lever.co/rainfocus');
});

test('unsafe compact catalog entries are rejected rather than interpolated into URLs', () => {
  const catalog = buildProviderCatalogEnvelope(
    'greenhouse',
    Buffer.from(JSON.stringify(['good', 'https://evil.test/x', 'bad/name', 'bad name'])),
  );
  assert.equal(catalog.acceptedItemCount, 1);
  assert.equal(catalog.rejectedItemCount, 3);
  assert.deepEqual(catalog.items.map((item) => item.tenant), ['good']);
});

test('Workday compact triples normalize to structured same-host targets', () => {
  const result = validateWorkdayCatalogItem('tsys|wd1|TSYS');
  assert.equal(result.ok, true);
  assert.deepEqual(result.item, {
    tenant: 'tsys',
    instance: 'wd1',
    site: 'TSYS',
    host: 'tsys.wd1.myworkdayjobs.com',
    careersUrl: 'https://tsys.wd1.myworkdayjobs.com/TSYS',
  });
  const entry = catalogItemToPortalEntry('workday', result.item);
  assert.equal(entry.provider_tenant, 'tsys.wd1.myworkdayjobs.com/TSYS');
  assert.equal(entry.workday_tenant, 'tsys');
});

test('Workday richer objects validate host consistency and safe site paths', () => {
  const catalog = buildProviderCatalogEnvelope('workday', Buffer.from(JSON.stringify([
    {
      name: 'Meredith',
      slug: 'meredith|wd5|ext',
      tenant: 'meredith',
      site: 'ext',
      host: 'meredith.wd5.myworkdayjobs.com',
    },
    { tenant: 'evil', instance: 'wd1', site: '../admin' },
    { tenant: 'acme', instance: 'wd3', site: 'External', host: 'other.wd3.myworkdayjobs.com' },
  ])));
  assert.equal(catalog.acceptedItemCount, 1);
  assert.equal(catalog.rejectedItemCount, 2);
  assert.deepEqual(catalog.rejections.map((item) => item.reason), ['site_unsafe', 'host_mismatch']);
});

test('persisted provider catalogs reject provider swaps and item tampering', () => {
  const catalog = buildProviderCatalogEnvelope('lever', Buffer.from('["rainfocus"]'));
  assert.equal(validateProviderCatalogEnvelope('lever', catalog), catalog);
  assert.throws(
    () => validateProviderCatalogEnvelope('greenhouse', catalog),
    /provider is invalid/,
  );
  assert.throws(
    () => validateProviderCatalogEnvelope('lever', {
      ...catalog,
      items: [{ tenant: 'bad/name', careersUrl: 'https://jobs.lever.co/bad/name' }],
    }),
    /invalid item/,
  );
});

test('legacy Ashby schema remains readable during migration', () => {
  const legacy = {
    schemaVersion: 1,
    provider: 'ashby',
    fetchedAtUtc: '2026-07-20T00:00:00.000Z',
    source: {
      repository: 'Feashliaa/job-board-aggregator',
      path: 'data/ashby_companies.json',
      url: 'https://example.test/ashby.json',
      license: 'CC BY-NC 4.0',
    },
    rawSha256: 'a'.repeat(64),
    sourceItemCount: 1,
    acceptedItemCount: 1,
    rejectedItemCount: 0,
    duplicateItemCount: 0,
    rejections: [],
    tenants: ['n8n'],
  };
  const validated = validateProviderCatalogEnvelope('ashby', legacy);
  assert.equal(validated.schemaVersion, 2);
  assert.equal(validated.items[0].careersUrl, 'https://jobs.ashbyhq.com/n8n');
});

test('richer Workday records cannot contradict their compact identity', () => {
  const catalog = buildProviderCatalogEnvelope('workday', Buffer.from(JSON.stringify([
    { slug: 'acme|wd3|External', tenant: 'other', instance: 'wd3', site: 'External' },
    { slug: 'acme|wd3|External', tenant: 'acme', instance: 'wd2', site: 'External' },
    { slug: 'acme|wd3|External', tenant: 'acme', instance: 'wd3', site: 'Careers' },
    { slug: 'acme|wd3|External', tenant: 'acme', instance: 'wd3', site: 'External' },
  ])));
  assert.equal(catalog.acceptedItemCount, 1);
  assert.deepEqual(catalog.rejections.map((item) => item.reason), [
    'tenant_mismatch', 'instance_mismatch', 'site_mismatch',
  ]);
});

test('optional company names are bounded and cannot inject controls into artifacts', () => {
  const catalog = buildProviderCatalogEnvelope('greenhouse', Buffer.from(JSON.stringify([
    { slug: 'good', name: 'Good Company' },
    { slug: 'control', name: 'Bad\u0000Name' },
    { slug: 'huge', name: 'x'.repeat(301) },
  ])));
  assert.equal(catalog.items.find((item) => item.tenant === 'good').name, 'Good Company');
  assert.equal('name' in catalog.items.find((item) => item.tenant === 'control'), false);
  assert.equal('name' in catalog.items.find((item) => item.tenant === 'huge'), false);
});

test('persisted catalogs require an HTTPS source URL and nonempty source ref', () => {
  const catalog = buildProviderCatalogEnvelope('lever', Buffer.from('["rainfocus"]'));
  assert.throws(
    () => validateProviderCatalogEnvelope('lever', {
      ...catalog,
      source: { ...catalog.source, url: 'http://example.test/catalog.json' },
    }),
    /must use HTTPS/,
  );
  assert.throws(
    () => validateProviderCatalogEnvelope('lever', {
      ...catalog,
      source: { ...catalog.source, ref: '' },
    }),
    /source.ref must be non-empty/,
  );
});
