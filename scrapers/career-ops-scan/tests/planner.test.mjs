import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAshbyCatalogEnvelope } from '../src/catalogs/ashby-catalog.mjs';
import {
  buildTargetPlan,
  buildTargetPlanFromFiles,
  PHASE2_MAX_NORMAL_ASHBY_TARGETS,
} from '../src/targets/planner.mjs';

function provider(id, hostFragment) {
  return {
    id,
    detect(entry) {
      return String(entry.careers_url ?? '').includes(hostFragment);
    },
    async fetch() {
      return [];
    },
  };
}

function providers() {
  return new Map([
    ['ashby', provider('ashby', 'ashbyhq.com')],
    ['greenhouse', provider('greenhouse', 'greenhouse.io')],
    ['lever', provider('lever', 'lever.co')],
  ]);
}

function portalConfig() {
  return {
    title_filter: { positive: ['Product Manager'] },
    tracked_companies: [
      {
        name: 'Celonis',
        careers_url: 'https://job-boards.greenhouse.io/celonis',
        enabled: true,
      },
      {
        name: 'n8n',
        careers_url: 'https://jobs.ashbyhq.com/n8n',
        enabled: true,
      },
      {
        name: 'Rainfocus',
        careers_url: 'https://jobs.lever.co/rainfocus',
        enabled: true,
      },
    ],
  };
}

function overrides({ priority = [], disabled = [] } = {}) {
  return {
    schema_version: 1,
    priority: { ashby: priority },
    disabled: { ashby: disabled },
  };
}

function policy(max = 100, enabled = true) {
  return {
    schema_version: 1,
    providers: {
      ashby: {
        catalog_enabled: enabled,
        max_normal_targets_per_run: max,
      },
    },
  };
}

function catalog(tenants) {
  return buildAshbyCatalogEnvelope(
    Buffer.from(JSON.stringify(tenants)),
    { fetchedAt: new Date('2026-07-20T12:00:00.000Z') },
  );
}

function build(options = {}) {
  return buildTargetPlan({
    portalConfig: options.portalConfig ?? portalConfig(),
    companyOverrides: options.companyOverrides ?? overrides(),
    discoveryPolicy: options.discoveryPolicy ?? policy(),
    ashbyCatalog: Object.hasOwn(options, 'ashbyCatalog')
      ? options.ashbyCatalog
      : catalog(['alpha', 'beta', 'gamma']),
    providers: options.providers ?? providers(),
    mode: options.mode ?? 'offline',
    generatedAt: new Date('2026-07-20T13:00:00.000Z'),
  });
}

test('tracked companies become priority targets in configured order', () => {
  const result = build({ mode: 'preflight', ashbyCatalog: null });
  assert.deepEqual(
    result.plan.targets.map((target) => target.name),
    ['Celonis', 'n8n', 'Rainfocus'],
  );
  assert.deepEqual(
    result.plan.targets.map((target) => target.targetClass),
    ['priority', 'priority', 'priority'],
  );
  assert.deepEqual(
    result.plan.targets.map((target) => target.provider),
    ['greenhouse', 'ashby', 'lever'],
  );
});

test('explicit Ashby priorities are appended after tracked priorities', () => {
  const result = build({
    companyOverrides: overrides({ priority: ['explicit-company'] }),
    mode: 'preflight',
    ashbyCatalog: null,
  });
  assert.deepEqual(
    result.plan.targets.map((target) => target.name),
    ['Celonis', 'n8n', 'Rainfocus', 'explicit-company'],
  );
  assert.equal(result.plan.targets.at(-1).reason, 'operator_priority');
});

test('disabled Ashby tenant wins over tracked priority', () => {
  const result = build({
    companyOverrides: overrides({ disabled: ['n8n'] }),
    mode: 'preflight',
    ashbyCatalog: null,
  });
  assert.equal(result.plan.targets.some((target) => target.tenant === 'n8n'), false);
  assert.equal(result.plan.counts.disabledRemoved, 1);
});

test('disabled Ashby tenant wins over explicit priority', () => {
  const result = build({
    companyOverrides: overrides({
      priority: ['blocked'],
      disabled: ['blocked'],
    }),
    mode: 'preflight',
    ashbyCatalog: null,
  });
  assert.equal(result.plan.targets.some((target) => target.tenant === 'blocked'), false);
});

test('disabled Ashby tenant is omitted from catalog normals', () => {
  const result = build({
    companyOverrides: overrides({ disabled: ['beta'] }),
  });
  assert.equal(result.plan.targets.some((target) => target.tenant === 'beta'), false);
});

test('duplicate priorities are emitted once', () => {
  const result = build({
    companyOverrides: overrides({ priority: ['n8n', 'N8N'] }),
    mode: 'preflight',
    ashbyCatalog: null,
  });
  assert.equal(
    result.plan.targets.filter((target) => target.tenant.toLowerCase() === 'n8n').length,
    1,
  );
  assert.equal(result.plan.counts.deduplicated >= 1, true);
});

test('catalog duplicate of priority is omitted', () => {
  const result = build({
    ashbyCatalog: catalog(['n8n', 'alpha']),
  });
  assert.equal(
    result.plan.targets.filter((target) => target.tenant.toLowerCase() === 'n8n').length,
    1,
  );
  assert.equal(
    result.plan.targets.find((target) => target.tenant === 'n8n').targetClass,
    'priority',
  );
});

test('normal catalog targets are capped by policy', () => {
  const tenants = Array.from({ length: 20 }, (_, index) => `tenant-${index}`);
  const result = build({
    discoveryPolicy: policy(7),
    ashbyCatalog: catalog(tenants),
  });
  assert.equal(result.plan.counts.normal, 7);
  assert.equal(
    result.plan.targets.filter((target) => target.targetClass === 'normal').length,
    7,
  );
});

test('all priority targets precede all normal targets', () => {
  const result = build();
  const classes = result.plan.targets.map((target) => target.targetClass);
  const firstNormal = classes.indexOf('normal');
  assert.equal(classes.slice(0, firstNormal).every((value) => value === 'priority'), true);
  assert.equal(classes.slice(firstNormal).every((value) => value === 'normal'), true);
});

test('catalog ordering is deterministic and not alphabetical prefix order', () => {
  const tenants = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  const first = build({ ashbyCatalog: catalog(tenants) });
  const second = build({ ashbyCatalog: catalog([...tenants].reverse()) });
  const firstNormals = first.plan.targets
    .filter((target) => target.targetClass === 'normal')
    .map((target) => target.tenant);
  const secondNormals = second.plan.targets
    .filter((target) => target.targetClass === 'normal')
    .map((target) => target.tenant);

  assert.deepEqual(firstNormals, secondNormals);
  assert.notDeepEqual(firstNormals, [...tenants].sort());
});

test('offline mode includes catalog targets and catalog provenance', () => {
  const result = build({ ashbyCatalog: catalog(['alpha']) });
  const target = result.plan.targets.find((item) => item.tenant === 'alpha');
  assert.equal(target.targetClass, 'normal');
  assert.equal(target.reason, 'ashby_catalog');
  assert.equal(target.catalogRef, 'ashby');
  assert.match(result.plan.catalogs.ashby.rawSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.plan.catalogs.ashby.acceptedItemCount, 1);
});

for (const mode of ['preflight', 'import']) {
  test(`${mode} mode excludes normal catalog targets and does not require catalog`, () => {
    const result = build({ mode, ashbyCatalog: null });
    assert.equal(result.plan.counts.normal, 0);
    assert.equal(result.plan.catalogs.ashby, null);
    assert.equal(
      result.plan.targets.every((target) => target.targetClass === 'priority'),
      true,
    );
  });
}

test('catalog-disabled offline policy does not require a catalog', () => {
  const result = build({
    discoveryPolicy: policy(100, false),
    ashbyCatalog: null,
  });
  assert.equal(result.plan.counts.normal, 0);
});

test('catalog-enabled offline planning fails clearly without catalog', () => {
  assert.throws(
    () => build({ ashbyCatalog: null }),
    /Run "catalog sync ashby" first/,
  );
});

test('invalid operator tenant fails rather than silently weakening disabled policy', () => {
  assert.throws(
    () => build({
      companyOverrides: overrides({ disabled: ['bad/name'] }),
      mode: 'preflight',
      ashbyCatalog: null,
    }),
    /company overrides.disabled.ashby\[0\] is invalid/,
  );
});

test('Phase 2 refuses a normal-target cap above the milestone hard maximum', () => {
  assert.equal(PHASE2_MAX_NORMAL_ASHBY_TARGETS, 100);
  assert.throws(
    () => build({ discoveryPolicy: policy(101) }),
    /must be an integer from 1 to 100/,
  );
});

test('unresolvable tracked companies become planning rejections without stopping valid targets', () => {
  const config = portalConfig();
  config.tracked_companies.splice(1, 0, {
    name: 'Unknown',
    careers_url: 'https://unknown.example/jobs',
    enabled: true,
  });
  const result = build({
    portalConfig: config,
    mode: 'preflight',
    ashbyCatalog: null,
  });
  assert.equal(result.planningRejections.length, 1);
  assert.equal(result.planningRejections[0].reason, 'provider_not_resolved');
  assert.equal(result.plan.counts.priority, 3);
});

test('runtime provider objects are excluded from serializable plan targets', () => {
  const result = build();
  assert.equal(result.runtimeTargets[0]._provider.id, 'greenhouse');
  assert.equal('_provider' in result.plan.targets[0], false);
});

test('file-backed planner reads configs and catalog but skips catalog read in preflight', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-files-'));
  try {
    const portalsPath = path.join(directory, 'portals.yml');
    const overridesPath = path.join(directory, 'overrides.yml');
    const policyPath = path.join(directory, 'policy.yml');
    const catalogPath = path.join(directory, 'missing-catalog.json');

    // JSON is valid YAML, making the fixture exact and easy to inspect.
    await writeFile(portalsPath, JSON.stringify(portalConfig()));
    await writeFile(overridesPath, JSON.stringify(overrides()));
    await writeFile(policyPath, JSON.stringify(policy()));

    const result = await buildTargetPlanFromFiles({
      portalsPath,
      companyOverridesPath: overridesPath,
      discoveryPolicyPath: policyPath,
      ashbyCatalogPath: catalogPath,
      providers: providers(),
      mode: 'preflight',
    });
    assert.equal(result.plan.counts.priority, 3);
    assert.equal(result.plan.counts.normal, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
