import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASHBY_CATALOG_SOURCE,
  buildAshbyCatalogEnvelope,
  validateAshbyTenant,
} from '../src/catalogs/ashby-catalog.mjs';

test(
  'validateAshbyTenant accepts and trims a safe tenant',
  () => {
    assert.deepEqual(
      validateAshbyTenant('  n8n  '),
      {
        ok: true,
        reason: null,
        tenant: 'n8n',
      },
    );
  },
);

test(
  'validateAshbyTenant rejects unsafe tenant values',
  () => {
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
    ];

    for (const [value, reason] of cases) {
      assert.equal(
        validateAshbyTenant(value).reason,
        reason,
        `unexpected result for ${String(value)}`,
      );
    }
  },
);

test(
  'buildAshbyCatalogEnvelope validates, deduplicates, and sorts',
  () => {
    const raw = Buffer.from(
      '["n8n","  acme  ","n8n","bad/name",42]',
      'utf8',
    );

    const catalog = buildAshbyCatalogEnvelope(
      raw,
      {
        fetchedAt: new Date(
          '2026-07-17T10:00:00.000Z',
        ),
      },
    );

    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.provider, 'ashby');
    assert.equal(
      catalog.fetchedAtUtc,
      '2026-07-17T10:00:00.000Z',
    );

    assert.deepEqual(
      catalog.source,
      ASHBY_CATALOG_SOURCE,
    );

    assert.equal(
      catalog.rawSha256,
      '89d9021e17392cbf710416505356624afa7c689c483fafbe7ffe2d27697ef391',
    );

    assert.equal(catalog.sourceItemCount, 5);
    assert.equal(catalog.acceptedItemCount, 2);
    assert.equal(catalog.rejectedItemCount, 2);
    assert.equal(catalog.duplicateItemCount, 1);

    assert.deepEqual(
      catalog.tenants,
      [
        'acme',
        'n8n',
      ],
    );

    assert.deepEqual(
      catalog.rejections.map(
        ({ index, reason }) => ({
          index,
          reason,
        }),
      ),
      [
        {
          index: 3,
          reason: 'url_delimiter',
        },
        {
          index: 4,
          reason: 'not_string',
        },
      ],
    );
  },
);

test(
  'buildAshbyCatalogEnvelope rejects a non-array root',
  () => {
    assert.throws(
      () => buildAshbyCatalogEnvelope(
        Buffer.from('{"tenant":"n8n"}'),
      ),
      /root must be a JSON array/,
    );
  },
);

test(
  'buildAshbyCatalogEnvelope rejects invalid JSON',
  () => {
    assert.throws(
      () => buildAshbyCatalogEnvelope(
        Buffer.from('not json'),
      ),
      /not valid JSON/,
    );
  },
);

test(
  'buildAshbyCatalogEnvelope rejects an all-invalid catalog',
  () => {
    assert.throws(
      () => buildAshbyCatalogEnvelope(
        Buffer.from(
          '["bad/name","company name",null]',
        ),
      ),
      /contains no valid tenants/,
    );
  },
);
