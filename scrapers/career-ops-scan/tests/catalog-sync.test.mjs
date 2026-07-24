import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  catalogSyncSummary,
  syncAshbyCatalog,
} from '../src/catalogs/sync-ashby.mjs';

function responseFor(body, { status = 200 } = {}) {
  const bytes = Buffer.from(body, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  };
}

async function withTempDir(worker) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ashby-sync-'));
  try {
    return await worker(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('sync writes a valid envelope and creates missing directories', async () => {
  await withTempDir(async (directory) => {
    const outputPath = path.join(directory, 'nested', 'ashby.json');
    const source = '["n8n","acme"]';
    const catalog = await syncAshbyCatalog({
      outputPath,
      fetchImpl: async () => responseFor(source),
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    });

    const persisted = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.deepEqual(persisted, catalog);
    assert.equal(catalog.fetchedAtUtc, '2026-07-20T12:00:00.000Z');
    assert.equal(
      catalog.rawSha256,
      createHash('sha256').update(source).digest('hex'),
    );
  });
});

test('sync forwards request headers and source URL', async () => {
  await withTempDir(async (directory) => {
    let request = null;
    const sourceUrl = 'https://example.invalid/catalog.json';
    const catalog = await syncAshbyCatalog({
      outputPath: path.join(directory, 'ashby.json'),
      sourceUrl,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return responseFor('["n8n"]');
      },
    });

    assert.equal(request.url, sourceUrl);
    assert.equal(request.options.headers.accept, 'application/json');
    assert.match(request.options.headers['user-agent'], /ATS-Discovery/);
    assert.equal(catalog.source.url, sourceUrl);
  });
});

test('successful refresh replaces a previous catalog', async () => {
  await withTempDir(async (directory) => {
    const outputPath = path.join(directory, 'ashby.json');
    await writeFile(outputPath, '{"old":true}\n');

    await syncAshbyCatalog({
      outputPath,
      fetchImpl: async () => responseFor('["new-tenant"]'),
    });

    const persisted = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.deepEqual(persisted.items.map((item) => item.tenant), ['new-tenant']);
    assert.equal(persisted.old, undefined);
  });
});

for (const scenario of [
  {
    name: 'HTTP failure',
    fetchImpl: async () => responseFor('unavailable', { status: 503 }),
    pattern: /HTTP 503/,
  },
  {
    name: 'transport failure',
    fetchImpl: async () => {
      const error = new Error('network down');
      error.code = 'ENETUNREACH';
      throw error;
    },
    pattern: /network down/,
  },
  {
    name: 'invalid JSON',
    fetchImpl: async () => responseFor('not json'),
    pattern: /not valid JSON/,
  },
  {
    name: 'non-array JSON',
    fetchImpl: async () => responseFor('{"n8n":true}'),
    pattern: /root must be a JSON array/,
  },
  {
    name: 'all-invalid catalog',
    fetchImpl: async () => responseFor('["bad/name",null]'),
    pattern: /contains no valid items/,
  },
]) {
  test(`${scenario.name} preserves previous catalog bytes exactly`, async () => {
    await withTempDir(async (directory) => {
      const outputPath = path.join(directory, 'ashby.json');
      const previous = Buffer.from('{"previous":"exact bytes"}\n');
      await writeFile(outputPath, previous);

      await assert.rejects(
        syncAshbyCatalog({
          outputPath,
          fetchImpl: scenario.fetchImpl,
        }),
        scenario.pattern,
      );

      assert.deepEqual(await readFile(outputPath), previous);
    });
  });
}

test('timeout aborts the request and preserves the previous catalog', async () => {
  await withTempDir(async (directory) => {
    const outputPath = path.join(directory, 'ashby.json');
    const previous = Buffer.from('{"previous":true}\n');
    await writeFile(outputPath, previous);

    const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('request aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });

    await assert.rejects(
      syncAshbyCatalog({
        outputPath,
        fetchImpl,
        timeoutMs: 5,
      }),
      /request aborted/,
    );
    assert.deepEqual(await readFile(outputPath), previous);
  });
});


test('oversized catalog is rejected before replacing the previous catalog', async () => {
  await withTempDir(async (directory) => {
    const outputPath = path.join(directory, 'ashby.json');
    const previous = Buffer.from('{"previous":true}\n');
    await writeFile(outputPath, previous);

    await assert.rejects(
      syncAshbyCatalog({
        outputPath,
        maxBytes: 5,
        fetchImpl: async () => responseFor('["n8n"]'),
      }),
      /exceeds maximum size/,
    );
    assert.deepEqual(await readFile(outputPath), previous);
  });
});

test('writer failure is surfaced without claiming success', async () => {
  await assert.rejects(
    syncAshbyCatalog({
      outputPath: '/unused/ashby.json',
      fetchImpl: async () => responseFor('["n8n"]'),
      writeCatalog: async () => {
        throw new Error('disk full');
      },
    }),
    /disk full/,
  );
});

test('catalogSyncSummary contains only operator-facing metadata', async () => {
  const catalog = await syncAshbyCatalog({
    outputPath: '/ignored/ashby.json',
    fetchImpl: async () => responseFor('["n8n"]'),
    writeCatalog: async () => {},
  });
  assert.deepEqual(Object.keys(catalogSyncSummary(catalog)).sort(), [
    'acceptedItemCount',
    'duplicateItemCount',
    'fetchedAtUtc',
    'provider',
    'rawSha256',
    'rejectedItemCount',
    'sourceItemCount',
  ]);
});
