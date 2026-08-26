import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOG_SOURCE_QUALITY,
  CATALOG_SOURCES,
  buildProviderCatalogEnvelope,
  catalogItemToPortalEntry,
  validateCatalogSourceQuality,
} from '../src/catalogs/provider-catalog.mjs';
import { parseDiscoveryPolicy, getProviderPolicy } from '../src/policy/discovery-policy.mjs';
import bamboohr from '../src/providers/bamboohr.mjs';
import icims from '../src/providers/icims.mjs';
import paylocity from '../src/providers/paylocity.mjs';

const PAYLOCITY_BOARD = '73b6525a-3273-48b3-b9d8-d6479233c61c';

function envelope(provider, values) {
  return buildProviderCatalogEnvelope(provider, Buffer.from(JSON.stringify(values)));
}

test('BambooHR catalog identity matches the provider tenant contract', () => {
  const catalog = envelope('bamboohr', ['Acme']);
  assert.deepEqual(catalog.items, [{
    tenant: 'acme',
    careersUrl: 'https://acme.bamboohr.com/careers',
  }]);
  const entry = catalogItemToPortalEntry('bamboohr', catalog.items[0]);
  assert.equal(entry.provider_tenant, 'acme');
  assert.equal(bamboohr.tenant(entry), entry.provider_tenant);
});

test('iCIMS source slugs become full provider tenant hosts', () => {
  const catalog = envelope('icims', ['acme']);
  assert.deepEqual(catalog.items, [{
    tenant: 'careers-acme.icims.com',
    careersUrl: 'https://careers-acme.icims.com',
  }]);
  const entry = catalogItemToPortalEntry('icims', catalog.items[0]);
  assert.equal(entry.provider_tenant, 'careers-acme.icims.com');
  assert.equal(icims.tenant(entry), entry.provider_tenant);
});

test('iCIMS full host overrides keep their exact provider identity', () => {
  const entry = catalogItemToPortalEntry('icims', {
    tenant: 'external-acme.icims.com',
    careersUrl: 'https://external-acme.icims.com',
  });
  assert.equal(entry.provider_tenant, 'external-acme.icims.com');
  assert.equal(icims.tenant(entry), entry.provider_tenant);
});

test('Paylocity catalog GUID becomes the board provider tenant', () => {
  const catalog = envelope('paylocity', [{
    guid: PAYLOCITY_BOARD.toUpperCase(),
    name: 'Acme',
    jobs: 3,
  }]);
  assert.deepEqual(catalog.items, [{
    tenant: PAYLOCITY_BOARD,
    careersUrl: `https://recruiting.paylocity.com/Recruiting/Jobs/All/${PAYLOCITY_BOARD}`,
    name: 'Acme',
  }]);
  const entry = catalogItemToPortalEntry('paylocity', catalog.items[0]);
  assert.equal(entry.provider_tenant, PAYLOCITY_BOARD);
  assert.equal(paylocity.tenant(entry), entry.provider_tenant);
});

test('new catalog normalizers reject unsafe or conflicting identities', () => {
  const bamboo = envelope('bamboohr', ['good', 'bad_name', '-bad']);
  assert.equal(bamboo.acceptedItemCount, 1);
  assert.deepEqual(bamboo.rejections.map((item) => item.reason), [
    'tenant_unsafe',
    'tenant_unsafe',
  ]);

  const icimsCatalog = envelope('icims', ['good', '-careers-bad', 'bad_name']);
  assert.equal(icimsCatalog.acceptedItemCount, 1);
  assert.deepEqual(icimsCatalog.rejections.map((item) => item.reason), [
    'slug_unsafe',
    'slug_unsafe',
  ]);

  const paylocityCatalog = envelope('paylocity', [
    { guid: PAYLOCITY_BOARD, name: 'Good' },
    { guid: 'not-a-uuid', name: 'Bad' },
    {
      tenant: PAYLOCITY_BOARD,
      careersUrl: 'https://recruiting.paylocity.com/Recruiting/Jobs/All/03950a95-b278-4adf-9e56-296ee2c0058a',
    },
  ]);
  assert.equal(paylocityCatalog.acceptedItemCount, 1);
  assert.deepEqual(paylocityCatalog.rejections.map((item) => item.reason), [
    'paylocity_uuid',
    'tenant_url_mismatch',
  ]);
});

test('Issue 16 catalogs use the approved upstream files and license', () => {
  assert.equal(CATALOG_SOURCES.bamboohr.path, 'data/bamboohr_companies.json');
  assert.equal(CATALOG_SOURCES.icims.path, 'data/icims_companies.json');
  assert.equal(CATALOG_SOURCES.paylocity.path, 'data/paylocity_companies_clean.json');
  for (const provider of ['bamboohr', 'icims', 'paylocity']) {
    assert.equal(CATALOG_SOURCES[provider].repository, 'Feashliaa/job-board-aggregator');
    assert.equal(CATALOG_SOURCES[provider].license, 'CC BY-NC 4.0');
    assert.equal(CATALOG_SOURCES[provider].ref, 'main');
  }
});

test('Issue 16 catalogs have source quality limits', () => {
  assert.deepEqual(CATALOG_SOURCE_QUALITY.bamboohr, {
    minimumSourceItems: 9000,
    minimumAcceptanceRatio: 0.99,
  });
  assert.deepEqual(CATALOG_SOURCE_QUALITY.icims, {
    minimumSourceItems: 8000,
    minimumAcceptanceRatio: 0.99,
  });
  assert.deepEqual(CATALOG_SOURCE_QUALITY.paylocity, {
    minimumSourceItems: 8000,
    minimumAcceptanceRatio: 0.99,
  });

  const tiny = envelope('bamboohr', ['acme']);
  assert.throws(
    () => validateCatalogSourceQuality('bamboohr', tiny),
    /below minimum 9000/,
  );
});

test('old policy does not enable Issue 16 catalogs', () => {
  const policy = parseDiscoveryPolicy({
    schema_version: 1,
    providers: {
      ashby: { catalog_enabled: true, max_normal_targets_per_run: 1 },
    },
  });
  for (const provider of ['bamboohr', 'icims', 'paylocity']) {
    assert.equal(getProviderPolicy(policy, provider).catalogEnabled, false);
    assert.equal(getProviderPolicy(policy, provider).maxNormalTargetsPerRun, 0);
  }
});
