import {
  CATALOG_PROVIDER_IDS,
  CATALOG_SOURCES,
  buildProviderCatalogEnvelope,
} from './provider-catalog.mjs';
import { writeJsonAtomic } from '../io/atomic-json.mjs';

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function syncProviderCatalog(provider, {
  outputPath,
  sourceUrl = CATALOG_SOURCES[provider]?.url,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 30_000,
  maxBytes = 20 * 1024 * 1024,
  writeCatalog = writeJsonAtomic,
} = {}) {
  if (!CATALOG_PROVIDER_IDS.includes(provider)) throw new Error(`Unsupported catalog provider: ${provider}`);
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error(`${provider} catalog outputPath is required`);
  if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) throw new Error(`${provider} catalog sourceUrl is required`);
  let parsedSourceUrl;
  try {
    parsedSourceUrl = new URL(sourceUrl);
  } catch {
    throw new Error(`${provider} catalog sourceUrl must be a valid URL`);
  }
  if (parsedSourceUrl.protocol !== 'https:') {
    throw new Error(`${provider} catalog sourceUrl must use HTTPS`);
  }
  if (typeof fetchImpl !== 'function') throw new Error(`${provider} catalog fetch implementation is required`);
  if (typeof now !== 'function') throw new Error(`${provider} catalog clock must be a function`);
  if (typeof writeCatalog !== 'function') throw new Error(`${provider} catalog writer must be a function`);
  positiveInteger(timeoutMs, `${provider} catalog timeoutMs`);
  positiveInteger(maxBytes, `${provider} catalog maxBytes`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(sourceUrl, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'Ehestifter-ATS-Discovery/phase-5b',
      },
      redirect: 'error',
    });
    if (!response || typeof response.arrayBuffer !== 'function') {
      throw new Error(`${provider} catalog fetch returned an invalid response`);
    }
    if (!response.ok) throw new Error(`${provider} catalog fetch failed: HTTP ${response.status ?? 'unknown'}`);
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`${provider} catalog exceeds maximum size of ${maxBytes} bytes`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`${provider} catalog exceeds maximum size of ${maxBytes} bytes`);
    const catalog = buildProviderCatalogEnvelope(provider, bytes, { fetchedAt: now(), sourceUrl });
    await writeCatalog(outputPath, catalog);
    return catalog;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncAllProviderCatalogs({
  outputPaths,
  writeCatalog = writeJsonAtomic,
  ...options
} = {}) {
  if (typeof writeCatalog !== 'function') {
    throw new Error('catalog writer must be a function');
  }
  const staged = [];
  // Fetch and validate every provider before mutating any destination. This
  // prevents a late malformed source from creating a mixed refresh snapshot.
  for (const provider of CATALOG_PROVIDER_IDS) {
    const outputPath = outputPaths?.[provider];
    const catalog = await syncProviderCatalog(provider, {
      ...options,
      outputPath,
      writeCatalog: async () => {},
    });
    staged.push({ provider, outputPath, catalog });
  }
  // Each destination replacement is atomic. A storage failure can still leave
  // a partial multi-file commit, which is reported loudly and is documented as
  // an operator retry condition; no cross-file transaction is claimed.
  for (const item of staged) {
    await writeCatalog(item.outputPath, item.catalog);
  }
  return staged.map((item) => item.catalog);
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
