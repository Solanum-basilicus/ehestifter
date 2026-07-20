import { ASHBY_CATALOG_SOURCE, buildAshbyCatalogEnvelope } from './ashby-catalog.mjs';
import { writeJsonAtomic } from '../io/atomic-json.mjs';

function normalizeTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Ashby catalog timeoutMs must be a positive integer');
  }
  return timeoutMs;
}

export async function syncAshbyCatalog({
  outputPath,
  sourceUrl = ASHBY_CATALOG_SOURCE.url,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 30_000,
  maxBytes = 10 * 1024 * 1024,
  writeCatalog = writeJsonAtomic,
} = {}) {
  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    throw new Error('Ashby catalog outputPath is required');
  }
  if (typeof sourceUrl !== 'string' || sourceUrl.trim() === '') {
    throw new Error('Ashby catalog sourceUrl is required');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Ashby catalog fetch implementation is required');
  }
  if (typeof now !== 'function') {
    throw new Error('Ashby catalog clock must be a function');
  }
  if (typeof writeCatalog !== 'function') {
    throw new Error('Ashby catalog writer must be a function');
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Ashby catalog maxBytes must be a positive integer');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), normalizeTimeout(timeoutMs));

  try {
    const response = await fetchImpl(sourceUrl, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'Ehestifter-ATS-Discovery/phase-2',
      },
    });

    if (!response || typeof response.arrayBuffer !== 'function') {
      throw new Error('Ashby catalog fetch returned an invalid response');
    }
    if (!response.ok) {
      throw new Error(
        `Ashby catalog fetch failed: HTTP ${response.status ?? 'unknown'}`,
      );
    }

    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `Ashby catalog exceeds maximum size of ${maxBytes} bytes`,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error(
        `Ashby catalog exceeds maximum size of ${maxBytes} bytes`,
      );
    }
    const catalog = buildAshbyCatalogEnvelope(bytes, {
      fetchedAt: now(),
      sourceUrl,
    });

    // No destination mutation happens before the complete envelope is valid.
    await writeCatalog(outputPath, catalog);
    return catalog;
  } finally {
    clearTimeout(timer);
  }
}

export function catalogSyncSummary(catalog) {
  return {
    provider: catalog.provider,
    fetchedAtUtc: catalog.fetchedAtUtc,
    rawSha256: catalog.rawSha256,
    sourceItemCount: catalog.sourceItemCount,
    acceptedItemCount: catalog.acceptedItemCount,
    rejectedItemCount: catalog.rejectedItemCount,
    duplicateItemCount: catalog.duplicateItemCount,
  };
}
