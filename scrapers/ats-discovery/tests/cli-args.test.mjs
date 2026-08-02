import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, usageText } from '../src/cli-args.mjs';

test('parses catalog sync ashby independently from scan commands', () => {
  assert.deepEqual(parseArgs(['catalog', 'sync', 'ashby']), {
    command: 'catalog-sync',
    provider: 'ashby',
  });
});

test('parses all supported catalog providers and rejects unsupported commands', () => {
  for (const provider of ['greenhouse', 'lever', 'workday', 'all']) {
    assert.deepEqual(parseArgs(['catalog', 'sync', provider]), {
      command: 'catalog-sync', provider,
    });
  }
  assert.throws(
    () => parseArgs(['catalog', 'refresh', 'ashby']),
    /Expected "catalog sync ashby\|greenhouse\|lever\|workday\|all"/g,
  );
  assert.throws(
    () => parseArgs(['catalog', 'sync', 'ashby', '--offline']),
    /Expected "catalog sync ashby\|greenhouse\|lever\|workday\|all"/g,
  );
});

test('parses offline and preflight scans', () => {
  assert.deepEqual(parseArgs(['scan', 'tracked', '--offline']), {
    command: 'scan',
    source: 'tracked',
    mode: 'offline',
    maxCreate: null,
    catalogTargets: null,
    noProgress: false,
  });
  assert.deepEqual(parseArgs(['scan', 'tracked', '--preflight']), {
    command: 'scan',
    source: 'tracked',
    mode: 'preflight',
    maxCreate: null,
    catalogTargets: null,
    noProgress: false,
  });
});

test('parses bounded import scan', () => {
  assert.deepEqual(
    parseArgs(['scan', 'tracked', '--import', '--max-create', '3']),
    {
      command: 'scan',
      source: 'tracked',
      mode: 'import',
      maxCreate: 3,
      catalogTargets: null,
      noProgress: false,
    },
  );
});

test('requires exactly one scan mode', () => {
  assert.throws(
    () => parseArgs(['scan', 'tracked']),
    /Choose one of/,
  );
  assert.throws(
    () => parseArgs(['scan', 'tracked', '--offline', '--preflight']),
    /Choose exactly one mode/,
  );
});

test('requires max-create only for import', () => {
  assert.throws(
    () => parseArgs(['scan', 'tracked', '--import']),
    /requires --max-create/,
  );
  assert.throws(
    () => parseArgs(['scan', 'tracked', '--offline', '--max-create', '1']),
    /valid only with --import/,
  );
});

test('validates max-create strictly', () => {
  for (const value of ['0', '-1', '1.5', '01', 'nope']) {
    assert.throws(
      () => parseArgs(['scan', 'tracked', '--import', '--max-create', value]),
      /positive integer/,
    );
  }
});

test('help is recognized without entering scan or sync orchestration', () => {
  assert.deepEqual(parseArgs(['--help']), { command: 'help' });
  assert.deepEqual(parseArgs(['scan', 'tracked', '-h']), { command: 'help' });
  assert.match(usageText(), /catalog sync ashby/);
  assert.match(usageText(), /scan tracked --import --max-create N/);
});

test('unknown top-level command fails clearly', () => {
  assert.throws(
    () => parseArgs(['discover', 'ashby']),
    /Expected "scan tracked" or "catalog sync <provider\|all>"/,
  );
});


test('parses explicit live catalog targets and no-progress', () => {
  assert.deepEqual(
    parseArgs([
      'scan', 'tracked', '--preflight',
      '--catalog-targets', '25', '--no-progress',
    ]),
    {
      command: 'scan',
      source: 'tracked',
      mode: 'preflight',
      maxCreate: null,
      catalogTargets: 25,
      noProgress: true,
    },
  );
  assert.deepEqual(
    parseArgs([
      'scan', 'tracked', '--import', '--max-create', '2',
      '--catalog-targets', '100',
    ]),
    {
      command: 'scan',
      source: 'tracked',
      mode: 'import',
      maxCreate: 2,
      catalogTargets: 100,
      noProgress: false,
    },
  );
});

test('catalog target count is explicit, positive, and live-only', () => {
  for (const value of ['0', '-1', '1.5', '01', 'nope']) {
    assert.throws(
      () => parseArgs([
        'scan', 'tracked', '--preflight', '--catalog-targets', value,
      ]),
      /positive integer/,
    );
  }
  assert.throws(
    () => parseArgs([
      'scan', 'tracked', '--offline', '--catalog-targets', '10',
    ]),
    /valid only with --preflight or --import/,
  );
});

test('no-progress may be supplied once', () => {
  assert.throws(
    () => parseArgs([
      'scan', 'tracked', '--offline', '--no-progress', '--no-progress',
    ]),
    /only once/,
  );
});

test('parses Lever description repair as dry-run by default', () => {
  assert.deepEqual(
    parseArgs([
      'repair',
      'lever-description',
      'https://jobs.lever.co/acme/posting-id',
    ]),
    {
      command: 'repair-lever-description',
      postingUrl: 'https://jobs.lever.co/acme/posting-id',
      apply: false,
    },
  );
});

test('parses explicit Lever description repair apply intent', () => {
  assert.deepEqual(
    parseArgs([
      'repair',
      'lever-description',
      'https://jobs.eu.lever.co/acme/posting-id',
      '--apply',
    ]),
    {
      command: 'repair-lever-description',
      postingUrl: 'https://jobs.eu.lever.co/acme/posting-id',
      apply: true,
    },
  );
  assert.throws(
    () => parseArgs(['repair', 'lever-description']),
    /Expected "repair lever-description/,
  );
  assert.throws(
    () => parseArgs([
      'repair', 'lever-description',
      'https://jobs.lever.co/acme/id', '--force',
    ]),
    /Unknown argument/,
  );
});
