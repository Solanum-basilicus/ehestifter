import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProviderCatalogEnvelope } from '../src/catalogs/provider-catalog.mjs';
import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { createEmptyTenantState } from '../src/state/tenant-state.mjs';
import { buildTargetPlan } from '../src/targets/planner.mjs';
import ashby from '../src/providers/ashby.mjs';
import bamboohr from '../src/providers/bamboohr.mjs';
import icims from '../src/providers/icims.mjs';
import paylocity from '../src/providers/paylocity.mjs';

const NOW = new Date('2026-08-26T08:00:00.000Z');
const PAYLOCITY_BOARD = '73b6525a-3273-48b3-b9d8-d6479233c61c';

function envelope(provider, values) {
  return buildProviderCatalogEnvelope(provider, Buffer.from(JSON.stringify(values)), {
    fetchedAt: NOW,
  });
}

test('Issue 16 catalogs enter the existing planner path when enabled', () => {
  const discoveryPolicy = parseDiscoveryPolicy({
    schema_version: 1,
    providers: {
      ashby: { catalog_enabled: false },
      bamboohr: { catalog_enabled: true, max_normal_targets_per_run: 1 },
      icims: { catalog_enabled: true, max_normal_targets_per_run: 1 },
      paylocity: { catalog_enabled: true, max_normal_targets_per_run: 1 },
    },
  });
  const result = buildTargetPlan({
    portalConfig: { tracked_companies: [] },
    companyOverrides: { schema_version: 1, priority: {}, disabled: {} },
    discoveryPolicy,
    catalogs: {
      bamboohr: envelope('bamboohr', ['acme']),
      icims: envelope('icims', ['acme']),
      paylocity: envelope('paylocity', [{ guid: PAYLOCITY_BOARD, name: 'Acme' }]),
    },
    tenantState: createEmptyTenantState(NOW),
    providers: new Map([
      ['ashby', ashby],
      ['bamboohr', bamboohr],
      ['icims', icims],
      ['paylocity', paylocity],
    ]),
    mode: 'offline',
    generatedAt: NOW,
    catalogTargetLimit: 0,
  });
  assert.deepEqual(
    result.plan.targets.map(({ provider, tenant, targetClass }) => ({ provider, tenant, targetClass })),
    [
      { provider: 'bamboohr', tenant: 'acme', targetClass: 'normal' },
      { provider: 'icims', tenant: 'careers-acme.icims.com', targetClass: 'normal' },
      { provider: 'paylocity', tenant: PAYLOCITY_BOARD, targetClass: 'normal' },
    ],
  );
});
