import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scannerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const generator = path.join(scannerRoot, 'scripts', 'refresh-web-geo-snapshot.mjs');

function runGenerator(args) {
  return spawnSync(process.execPath, [generator, ...args], {
    encoding: 'utf8',
  });
}

test('geo snapshot generator writes deterministic output and detects drift', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ats-geo-'));
  const source = path.join(directory, 'source.json');
  const output = path.join(directory, 'snapshot.json');
  const manifest = path.join(directory, 'manifest.json');
  await writeFile(source, JSON.stringify({
    countries: [
      { name: 'Germany', code: 'de', priority: true },
      { name: 'United States', code: 'US', priority: false },
    ],
    cities: {
      DE: ['Berlin', 'Berlin', ' Munich '],
      US: ['Washington'],
    },
  }), 'utf8');

  const args = ['--source', source, '--output', output, '--manifest', manifest];
  const generated = runGenerator(args);
  assert.equal(generated.status, 0, generated.stderr);
  const firstSnapshot = await readFile(output, 'utf8');
  const firstManifest = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(firstManifest.countries, 2);
  assert.equal(firstManifest.cities, 3);
  assert.deepEqual(JSON.parse(firstSnapshot).cities.DE, ['Berlin', 'Munich']);

  const checked = runGenerator([...args, '--check']);
  assert.equal(checked.status, 0, checked.stderr);

  await writeFile(source, JSON.stringify({
    countries: [{ name: 'Germany', code: 'DE', priority: true }],
    cities: { DE: ['Berlin'] },
  }), 'utf8');
  const stale = runGenerator([...args, '--check']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /snapshot is stale/u);
});
