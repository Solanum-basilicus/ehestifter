import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  syncAllProviderCatalogs,
  syncProviderCatalog,
} from '../src/catalogs/sync-provider-catalog.mjs';

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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phase5b-sync-'));
  try { return await worker(directory); } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('generic synchronizer writes each provider to its own file', async () => {
  await temp(async (directory) => {
    const catalog = await syncProviderCatalog('workday', {
      outputPath: path.join(directory, 'workday.json'),
      fetchImpl: async () => response('["tsys|wd1|TSYS"]'),
    });
    assert.equal(catalog.provider, 'workday');
    const persisted = JSON.parse(await readFile(path.join(directory, 'workday.json'), 'utf8'));
    assert.equal(persisted.items[0].host, 'tsys.wd1.myworkdayjobs.com');
  });
});

test('catalog sync all uses provider-specific source URLs and output files', async () => {
  await temp(async (directory) => {
    const requested = [];
    const bodies = {
      ashby: '["n8n"]',
      greenhouse: '["celonis"]',
      lever: '["rainfocus"]',
      workday: '["tsys|wd1|TSYS"]',
    };
    const outputPaths = Object.fromEntries(
      Object.keys(bodies).map((provider) => [provider, path.join(directory, `${provider}.json`)]),
    );
    const results = await syncAllProviderCatalogs({
      outputPaths,
      fetchImpl: async (url) => {
        const provider = Object.keys(bodies).find((item) => url.includes(`/${item}_companies.json`));
        requested.push(provider);
        return response(bodies[provider]);
      },
    });
    assert.deepEqual(requested, ['ashby', 'greenhouse', 'lever', 'workday']);
    assert.deepEqual(results.map((item) => item.provider), requested);
    for (const provider of requested) {
      const persisted = JSON.parse(await readFile(outputPaths[provider], 'utf8'));
      assert.equal(persisted.provider, provider);
    }
  });
});

test('unsupported catalog providers fail before network or filesystem work', async () => {
  let fetched = false;
  await assert.rejects(
    syncProviderCatalog('bamboohr', {
      outputPath: '/tmp/unused.json',
      fetchImpl: async () => { fetched = true; return response('[]'); },
    }),
    /Unsupported catalog provider/,
  );
  assert.equal(fetched, false);
});

test('catalog sync all validates every source before writing any destination', async () => {
  const writes = [];
  const bodies = {
    ashby: '["n8n"]',
    greenhouse: '["celonis"]',
    lever: '["rainfocus"]',
    workday: '{"not":"an array"}',
  };
  await assert.rejects(
    syncAllProviderCatalogs({
      outputPaths: Object.fromEntries(
        Object.keys(bodies).map((provider) => [provider, `/catalogs/${provider}.json`]),
      ),
      fetchImpl: async (url) => {
        const provider = Object.keys(bodies).find((item) => url.includes(`/${item}_companies.json`));
        return response(bodies[provider]);
      },
      writeCatalog: async (...args) => { writes.push(args); },
    }),
    /workday catalog root must be a JSON array/,
  );
  assert.deepEqual(writes, []);
});

test('catalog synchronization refuses non-HTTPS source overrides before fetching', async () => {
  let fetched = false;
  await assert.rejects(
    syncProviderCatalog('greenhouse', {
      outputPath: '/tmp/unused-greenhouse.json',
      sourceUrl: 'http://example.test/greenhouse.json',
      fetchImpl: async () => { fetched = true; return response('["acme"]'); },
    }),
    /sourceUrl must use HTTPS/,
  );
  assert.equal(fetched, false);
});
