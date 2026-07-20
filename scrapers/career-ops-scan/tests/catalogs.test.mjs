import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASHBY_CATALOG_SOURCE,
  buildAshbyCatalogEnvelope,
  validateAshbyCatalogEnvelope,
  validateAshbyTenant,
} from '../src/catalogs/ashby-catalog.mjs';

test('validateAshbyTenant accepts and trims safe identifiers', () => {
  assert.deepEqual(validateAshbyTenant('  n8n  '), {
    ok: true,
    reason: null,
    tenant: 'n8n',
  });
  assert.equal(validateAshbyTenant('company_name-1.0~').ok, true);
});

test('validateAshbyTenant rejects unsafe tenant values', () => {
  const cases = [
    [null, 'not_string'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['.', 'reserved_path_segment'],
    ['..', 'reserved_path_segment'],
    ['https://jobs.ashbyhq.com/n8n', 'url_scheme'],
    ['company name', 'whitespace'],
    ['company/name', 'url_delimiter'],
    ['company\\name', 'url_delimiter'],
    ['company?query', 'url_delimiter'],
    ['company#fragment', 'url_delimiter'],
    ['company%2Fname', 'unsafe_character'],
    ['x'.repeat(201), 'too_long'],
  ];

  for (const [value, reason] of cases) {
    assert.equal(
      validateAshbyTenant(value).reason,
      reason,
      `unexpected validation result for ${String(value)}`,
    );
  }
});

test('catalog envelope validates, rejects, deduplicates case-insensitively, and sorts', () => {
  const raw = Buffer.from(
    '["n8n","  acme  ","N8N","bad/name",42]',
    'utf8',
  );
  const catalog = buildAshbyCatalogEnvelope(raw, {
    fetchedAt: new Date('2026-07-20T10:00:00.000Z'),
  });

  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.provider, 'ashby');
  assert.equal(catalog.fetchedAtUtc, '2026-07-20T10:00:00.000Z');
  assert.deepEqual(catalog.source, ASHBY_CATALOG_SOURCE);
  assert.equal(
    catalog.rawSha256,
    createHash('sha256').update(raw).digest('hex'),
  );
  assert.equal(catalog.sourceItemCount, 5);
  assert.equal(catalog.acceptedItemCount, 2);
  assert.equal(catalog.rejectedItemCount, 2);
  assert.equal(catalog.duplicateItemCount, 1);
  assert.deepEqual(catalog.tenants, ['acme', 'n8n']);
  assert.deepEqual(
    catalog.rejections.map(({ index, reason }) => ({ index, reason })),
    [
      { index: 3, reason: 'url_delimiter' },
      { index: 4, reason: 'not_string' },
    ],
  );
});

test('SHA-256 is based on exact source bytes, not parsed values', () => {
  const first = buildAshbyCatalogEnvelope(Buffer.from('["n8n"]'));
  const second = buildAshbyCatalogEnvelope(Buffer.from('[ "n8n" ]'));

  assert.deepEqual(first.tenants, second.tenants);
  assert.notEqual(first.rawSha256, second.rawSha256);
});

test('catalog envelope can record an overridden source URL', () => {
  const catalog = buildAshbyCatalogEnvelope(Buffer.from('["n8n"]'), {
    sourceUrl: 'https://example.invalid/ashby.json',
  });
  assert.equal(catalog.source.url, 'https://example.invalid/ashby.json');
  assert.equal(catalog.source.repository, ASHBY_CATALOG_SOURCE.repository);
});

test('catalog parser rejects invalid JSON, non-array roots, and all-invalid catalogs', () => {
  assert.throws(
    () => buildAshbyCatalogEnvelope(Buffer.from('not json')),
    /not valid JSON/,
  );
  assert.throws(
    () => buildAshbyCatalogEnvelope(Buffer.from('{"tenant":"n8n"}')),
    /root must be a JSON array/,
  );
  assert.throws(
    () => buildAshbyCatalogEnvelope(Buffer.from('["bad/name", null]')),
    /contains no valid tenants/,
  );
});

test('catalog parser rejects an invalid fetchedAt clock', () => {
  assert.throws(
    () => buildAshbyCatalogEnvelope(Buffer.from('["n8n"]'), {
      fetchedAt: 'not-a-date',
    }),
    /fetchedAt must be a valid date/,
  );
});

test('persisted catalog envelope validation accepts a generated envelope', () => {
  const catalog = buildAshbyCatalogEnvelope(Buffer.from('["n8n","acme"]'));
  assert.equal(validateAshbyCatalogEnvelope(catalog), catalog);
});

test('persisted catalog envelope validation rejects tampering and truncation', () => {
  const catalog = buildAshbyCatalogEnvelope(Buffer.from('["n8n","acme"]'));

  assert.throws(
    () => validateAshbyCatalogEnvelope({ ...catalog, provider: 'lever' }),
    /provider must be "ashby"/,
  );
  assert.throws(
    () => validateAshbyCatalogEnvelope({ ...catalog, rawSha256: 'bad' }),
    /rawSha256/,
  );
  assert.throws(
    () => validateAshbyCatalogEnvelope({
      ...catalog,
      tenants: ['n8n'],
    }),
    /acceptedItemCount/,
  );
  assert.throws(
    () => validateAshbyCatalogEnvelope({
      ...catalog,
      acceptedItemCount: 2,
      tenants: ['n8n', 'N8N'],
    }),
    /duplicate tenants/,
  );
  assert.throws(
    () => validateAshbyCatalogEnvelope({
      ...catalog,
      source: { ...catalog.source, license: 'MIT' },
    }),
    /source.license is invalid/,
  );
  assert.throws(
    () => validateAshbyCatalogEnvelope({
      ...catalog,
      sourceItemCount: catalog.sourceItemCount + 1,
    }),
    /item counts are inconsistent/,
  );
});
