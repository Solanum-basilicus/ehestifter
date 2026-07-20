import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, usageText } from '../src/cli-args.mjs';

test('parses catalog sync ashby independently from scan commands', () => {
  assert.deepEqual(parseArgs(['catalog', 'sync', 'ashby']), {
    command: 'catalog-sync',
    provider: 'ashby',
  });
});

test('rejects unsupported catalog commands and providers', () => {
  assert.throws(
    () => parseArgs(['catalog', 'sync', 'greenhouse']),
    /Only "catalog sync ashby"/,
  );
  assert.throws(
    () => parseArgs(['catalog', 'refresh', 'ashby']),
    /Only "catalog sync ashby"/,
  );
  assert.throws(
    () => parseArgs(['catalog', 'sync', 'ashby', '--offline']),
    /Only "catalog sync ashby"/,
  );
});

test('parses offline and preflight scans', () => {
  assert.deepEqual(parseArgs(['scan', 'tracked', '--offline']), {
    command: 'scan',
    source: 'tracked',
    mode: 'offline',
    maxCreate: null,
  });
  assert.deepEqual(parseArgs(['scan', 'tracked', '--preflight']), {
    command: 'scan',
    source: 'tracked',
    mode: 'preflight',
    maxCreate: null,
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
    /Expected "scan tracked" or "catalog sync ashby"/,
  );
});
