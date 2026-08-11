import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOG_SOURCE_QUALITY,
  buildProviderCatalogEnvelope,
  catalogItemToPortalEntry,
  validateCatalogSourceQuality,
} from '../src/catalogs/provider-catalog.mjs';
import { syncProviderCatalog } from '../src/catalogs/sync-provider-catalog.mjs';
import personio from '../src/providers/personio.mjs';
import smartrecruiters from '../src/providers/smartrecruiters.mjs';
import softgarden from '../src/providers/softgarden.mjs';
import successfactors from '../src/providers/successfactors.mjs';

function response(body) {
  const bytes = Buffer.from(body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.length) },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

async function temp(worker) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-issue4-'));
  try { return await worker(directory); } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('CSV catalogs support BOM, CRLF, quoted commas, escaped quotes, and embedded newlines', () => {
  const catalog = buildProviderCatalogEnvelope(
    'personio',
    Buffer.from('\uFEFFname,slug,url\r\n"Acme, GmbH",acme,https://acme.jobs.personio.com\r\n"Quoted ""Name""\nGroup",quoted,https://quoted.jobs.personio.de\r\n'),
  );
  assert.equal(catalog.acceptedItemCount, 2);
  assert.equal(catalog.items.find((item) => item.tenant === 'acme').name, 'Acme, GmbH');
  assert.equal('name' in catalog.items.find((item) => item.tenant === 'quoted'), false);
});

test('CSV catalogs reject unexpected headers and malformed quoting', () => {
  assert.throws(
    () => buildProviderCatalogEnvelope(
      'personio',
      Buffer.from('slug,name,url\nacme,Acme,https://acme.jobs.personio.com\n'),
    ),
    /header must be exactly: name,slug,url/,
  );
  assert.throws(
    () => buildProviderCatalogEnvelope(
      'personio',
      Buffer.from('name,slug,url\n"Acme,acme,https://acme.jobs.personio.com\n'),
    ),
    /unterminated quoted field/,
  );
});

test('CSV rows with the wrong column count are rejected without shifting fields', () => {
  const catalog = buildProviderCatalogEnvelope(
    'personio',
    Buffer.from(
      'name,slug,url\n'
      + 'Acme,acme,https://acme.jobs.personio.com\n'
      + 'Bad,bad,https://bad.jobs.personio.com,extra\n',
    ),
  );
  assert.equal(catalog.acceptedItemCount, 1);
  assert.equal(catalog.rejectedItemCount, 1);
  assert.equal(catalog.rejections[0].reason, 'csv_column_count');
});

test('Personio catalog identity agrees with the provider tenant contract', () => {
  const catalog = buildProviderCatalogEnvelope(
    'personio',
    Buffer.from('name,slug,url\nAcme,Acme,https://acme.jobs.personio.de\n'),
  );
  const entry = catalogItemToPortalEntry('personio', catalog.items[0]);
  assert.equal(entry.provider_tenant, 'acme');
  assert.equal(entry.careers_url, 'https://acme.jobs.personio.de');
  assert.equal(personio.tenant(entry), entry.provider_tenant);
});

test('SmartRecruiters validates slug against URL case-insensitively and preserves provider identity', () => {
  const catalog = buildProviderCatalogEnvelope(
    'smartrecruiters',
    Buffer.from('name,slug,url\nIOTA GROUP,iotagroup,https://careers.smartrecruiters.com/IOTAGROUP/iota\n'),
  );
  const entry = catalogItemToPortalEntry('smartrecruiters', catalog.items[0]);
  assert.equal(entry.provider_tenant, 'IOTAGROUP');
  assert.equal(entry.careers_url, 'https://careers.smartrecruiters.com/IOTAGROUP');
  assert.equal(smartrecruiters.tenant(entry), entry.provider_tenant);
});

test('Softgarden converts the upstream career hostname to the existing provider hostname', () => {
  const catalog = buildProviderCatalogEnvelope(
    'softgarden',
    Buffer.from('name,slug,url\nABEKING,abeking,https://abeking.career.softgarden.de/\n'),
  );
  const entry = catalogItemToPortalEntry('softgarden', catalog.items[0]);
  assert.equal(entry.careers_url, 'https://abeking.softgarden.io/');
  assert.equal(entry.provider_tenant, 'abeking');
  assert.equal(softgarden.tenant(entry), entry.provider_tenant);
});

test('catalog normalizers reject identities that cannot satisfy provider tenant contracts', () => {
  const personio = buildProviderCatalogEnvelope(
    'personio',
    Buffer.from(
      'name,slug,url\n'
      + 'Good,good,https://good.jobs.personio.com\n'
      + 'Mismatch,other,https://different.jobs.personio.com\n'
      + 'Unsafe,bad_name,\n',
    ),
  );
  assert.equal(personio.acceptedItemCount, 1);
  assert.deepEqual(
    personio.rejections.map((item) => item.reason),
    ['tenant_url_mismatch', 'tenant_unsafe'],
  );

  const smartrecruiters = buildProviderCatalogEnvelope(
    'smartrecruiters',
    Buffer.from(
      'name,slug,url\n'
      + 'Good,good,https://careers.smartrecruiters.com/good\n'
      + 'Mismatch,other,https://careers.smartrecruiters.com/different\n'
      + 'Unsafe,bad~tenant,\n',
    ),
  );
  assert.equal(smartrecruiters.acceptedItemCount, 1);
  assert.deepEqual(
    smartrecruiters.rejections.map((item) => item.reason),
    ['tenant_url_mismatch', 'unsafe_character'],
  );

  const softgarden = buildProviderCatalogEnvelope(
    'softgarden',
    Buffer.from(
      'name,slug,url\n'
      + 'Good,good,https://good.career.softgarden.de/\n'
      + 'Mismatch,other,https://different.career.softgarden.de/\n'
      + 'Unsafe,bad_name,\n',
    ),
  );
  assert.equal(softgarden.acceptedItemCount, 1);
  assert.deepEqual(
    softgarden.rejections.map((item) => item.reason),
    ['tenant_url_mismatch', 'tenant_unsafe'],
  );
});

test('SuccessFactors uses URL identity instead of non-unique upstream slugs', () => {
  const catalog = buildProviderCatalogEnvelope(
    'successfactors',
    Buffer.from(
      'name,slug,url\n'
      + 'Company A,careers,https://careers.company-a.example\n'
      + 'Company B,careers,https://careers.company-b.example/Brand/search\n',
    ),
  );
  assert.equal(catalog.acceptedItemCount, 2);
  assert.deepEqual(
    catalog.items.map((item) => item.tenant),
    ['careers.company-a.example', 'careers.company-b.example/Brand'],
  );
  for (const item of catalog.items) {
    const entry = catalogItemToPortalEntry('successfactors', item);
    assert.equal(successfactors.tenant(entry), entry.provider_tenant);
  }
});

test('SuccessFactors rejects query-qualified identities that the current provider cannot preserve', () => {
  const catalog = buildProviderCatalogEnvelope(
    'successfactors',
    Buffer.from(
      'name,slug,url\n'
      + 'Safe,careers,https://careers.safe.example\n'
      + 'Legacy A,career,https://career5.successfactors.eu/career?company=A\n'
      + 'Legacy B,career,https://career5.successfactors.eu/career?company=B\n',
    ),
  );
  assert.equal(catalog.acceptedItemCount, 1);
  assert.equal(catalog.rejectedItemCount, 2);
  assert.deepEqual(
    catalog.rejections.map((item) => item.reason),
    ['query_identity_unsupported', 'query_identity_unsupported'],
  );
});

test('new upstream CSV catalogs have conservative catastrophe guards', () => {
  assert.deepEqual(CATALOG_SOURCE_QUALITY.personio, {
    minimumSourceItems: 1000,
    minimumAcceptanceRatio: 0.98,
  });
  assert.equal(CATALOG_SOURCE_QUALITY.successfactors.minimumSourceItems, 1000);
  assert.equal(CATALOG_SOURCE_QUALITY.successfactors.minimumAcceptanceRatio, 0.85);
});

test('source quality rejects both collapsed sources and excessive normalization loss', () => {
  const catalog = buildProviderCatalogEnvelope(
    'personio',
    Buffer.from('name,slug,url\nAcme,acme,https://acme.jobs.personio.com\n'),
  );
  assert.throws(
    () => validateCatalogSourceQuality('personio', catalog),
    /below minimum 1000/,
  );
  const mixed = buildProviderCatalogEnvelope(
    'personio',
    Buffer.from(
      'name,slug,url\n'
      + 'Acme,acme,https://acme.jobs.personio.com\n'
      + 'Bad,bad,https://evil.example\n',
    ),
  );
  assert.throws(
    () => validateCatalogSourceQuality('personio', mixed, {
      minimumSourceItems: 1,
      minimumAcceptanceRatio: 0.75,
    }),
    /acceptance ratio 0\.5000 is below minimum 0\.7500/,
  );

  const duplicateCollapse = buildProviderCatalogEnvelope(
    'personio',
    Buffer.from(
      'name,slug,url\n'
      + Array.from(
        { length: 20 },
        (_, index) => `Acme ${index},acme,https://acme.jobs.personio.com`,
      ).join('\n'),
    ),
  );
  assert.equal(duplicateCollapse.acceptedItemCount, 1);
  assert.equal(duplicateCollapse.duplicateItemCount, 19);
  assert.throws(
    () => validateCatalogSourceQuality('personio', duplicateCollapse, {
      minimumSourceItems: 1,
      minimumAcceptanceRatio: 0.75,
    }),
    /acceptance ratio 0\.0500 is below minimum 0\.7500/,
  );
});

test('quality-gate failure preserves the previous catalog bytes exactly', async () => {
  await temp(async (directory) => {
    const outputPath = path.join(directory, 'personio.json');
    const previous = Buffer.from('{"previous":"keep me"}\n');
    await writeFile(outputPath, previous);
    await assert.rejects(
      syncProviderCatalog('personio', {
        outputPath,
        fetchImpl: async () => response(
          'name,slug,url\nAcme,acme,https://acme.jobs.personio.com\n',
        ),
      }),
      /below minimum 1000/,
    );
    assert.deepEqual(await readFile(outputPath), previous);
  });
});

test('CSV synchronization requests CSV-compatible content types', async () => {
  let accept = null;
  await temp(async (directory) => {
    await syncProviderCatalog('personio', {
      outputPath: path.join(directory, 'personio.json'),
      sourceQuality: false,
      fetchImpl: async (_url, options) => {
        accept = options.headers.accept;
        return response('name,slug,url\nAcme,acme,https://acme.jobs.personio.com\n');
      },
    });
  });
  assert.match(accept, /text\/csv/);
});
