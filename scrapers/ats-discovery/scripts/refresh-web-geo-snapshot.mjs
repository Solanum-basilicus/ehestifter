#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = {
    source: null,
    output: null,
    manifest: null,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--check') args.check = true;
    else if (value === '--source') args.source = argv[++index];
    else if (value === '--output') args.output = argv[++index];
    else if (value === '--manifest') args.manifest = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.source || !args.output || !args.manifest) {
    throw new Error('Required: --source PATH --output PATH --manifest PATH [--check]');
  }
  return args;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function normalizeSource(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.countries)) {
    throw new Error('Web geography source has no countries array');
  }
  if (!data.cities || typeof data.cities !== 'object' || Array.isArray(data.cities)) {
    throw new Error('Web geography source has no cities object');
  }

  const countries = data.countries.map((item) => ({
    name: cleanText(item?.name),
    code: cleanText(item?.code).toUpperCase(),
    priority: item?.priority === true,
  }));
  const codes = new Set();
  for (const country of countries) {
    if (country.name === '' || !/^[A-Z]{2}$/u.test(country.code)) {
      throw new Error(`Invalid country entry: ${JSON.stringify(country)}`);
    }
    if (codes.has(country.code)) throw new Error(`Duplicate country code: ${country.code}`);
    codes.add(country.code);
  }

  const cities = {};
  for (const code of [...codes].sort()) {
    const rawCities = data.cities[code];
    if (!Array.isArray(rawCities)) {
      cities[code] = [];
      continue;
    }
    const unique = new Map();
    for (const rawCity of rawCities) {
      const city = cleanText(rawCity);
      if (city === '') continue;
      const key = city.normalize('NFKC').toLocaleLowerCase('en');
      if (!unique.has(key)) unique.set(key, city);
    }
    cities[code] = [...unique.values()];
  }

  return { schemaVersion: 1, countries, cities };
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, filePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRaw = await readFile(args.source);
  const sourceData = JSON.parse(sourceRaw.toString('utf8'));
  const snapshot = normalizeSource(sourceData);
  const outputRaw = `${JSON.stringify(snapshot)}\n`;
  const scriptPath = fileURLToPath(import.meta.url);
  const generatorRaw = await readFile(scriptPath);
  const manifest = {
    schemaVersion: 1,
    sourcePath: 'backend/core/static/data/geo.sample8.json',
    sourceSha256: sha256(sourceRaw),
    generatorPath: 'scrapers/ats-discovery/scripts/refresh-web-geo-snapshot.mjs',
    generatorSha256: sha256(generatorRaw),
    snapshotPath: 'scrapers/ats-discovery/src/locations/data/web-geo.generated.json',
    snapshotSha256: sha256(outputRaw),
    countries: snapshot.countries.length,
    cities: Object.values(snapshot.cities).reduce((sum, items) => sum + items.length, 0),
  };
  const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;

  if (args.check) {
    const [currentOutput, currentManifest] = await Promise.all([
      readFile(args.output, 'utf8'),
      readFile(args.manifest, 'utf8'),
    ]);
    if (currentOutput !== outputRaw || currentManifest !== manifestRaw) {
      throw new Error('ATS geography snapshot is stale; run tools/refresh_ats_geo_snapshot.py');
    }
    console.log(`ATS geography snapshot is current (${manifest.countries} countries, ${manifest.cities} cities).`);
    return;
  }

  await atomicWrite(args.output, outputRaw);
  await atomicWrite(args.manifest, manifestRaw);
  console.log(`Refreshed ${path.relative(process.cwd(), args.output)} (${manifest.countries} countries, ${manifest.cities} cities).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
