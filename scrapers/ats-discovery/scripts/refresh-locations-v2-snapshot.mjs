import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import crypto from 'node:crypto';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(
  scriptDir,
  '../../../backend/jobs/reference/locations-v2.catalog.json.gz',
);
const outputPath = path.resolve(
  scriptDir,
  '../src/locations/data/locations-v2.generated.json.gz',
);

function compactItem(item, fields) {
  return Object.fromEntries(
    fields.filter((field) => item[field] !== undefined).map((field) => [field, item[field]]),
  );
}

function buildSnapshot(source) {
  return {
    schemaVersion: 1,
    sourceSchemaVersion: source.schemaVersion,
    catalogVersion: source.catalogVersion,
    referenceYear: source.referenceYear,
    regions: source.regions.map((item) => compactItem(item, [
      'id', 'kind', 'name', 'parentId', 'ancestors', 'utcOffsets',
    ])),
    countries: source.countries.map((item) => compactItem(item, [
      'id', 'kind', 'name', 'countryCode', 'm49Code', 'parentId', 'ancestors', 'aliases', 'utcOffsets',
    ])),
    adminRegions: source.adminRegions.map((item) => compactItem(item, [
      'id', 'kind', 'name', 'countryCode', 'admin1Code', 'parentId', 'ancestors', 'aliases', 'utcOffsets',
    ])),
    cities: source.cities.map((item) => compactItem(item, [
      'id', 'kind', 'name', 'countryCode', 'admin1Id', 'parentId', 'ancestors', 'aliases', 'population', 'utcOffsets',
    ])),
  };
}

function encode(snapshot) {
  return gzipSync(Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8'), {
    level: 9,
    mtime: 0,
  });
}

const source = JSON.parse(gunzipSync(readFileSync(sourcePath)).toString('utf8'));
const encoded = encode(buildSnapshot(source));
const check = process.argv.includes('--check');

if (check) {
  let current;
  try {
    current = readFileSync(outputPath);
  } catch {
    console.error(`Locations v2 snapshot is missing: ${outputPath}`);
    process.exitCode = 1;
    process.exit();
  }
  const expectedHash = crypto.createHash('sha256').update(encoded).digest('hex');
  const currentHash = crypto.createHash('sha256').update(current).digest('hex');
  if (expectedHash !== currentHash) {
    console.error('Locations v2 snapshot is stale. Run npm run locations-v2:refresh.');
    process.exitCode = 1;
    process.exit();
  }
  console.log(`Locations v2 snapshot is current (${source.catalogVersion}).`);
  process.exit();
}

writeFileSync(outputPath, encoded);
console.log(`Wrote ${outputPath} (${source.catalogVersion}, ${encoded.length} bytes).`);
