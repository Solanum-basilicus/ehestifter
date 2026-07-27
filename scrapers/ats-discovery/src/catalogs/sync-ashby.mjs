import { syncProviderCatalog, catalogSyncSummary } from './sync-provider-catalog.mjs';

export function syncAshbyCatalog(options = {}) {
  return syncProviderCatalog('ashby', options);
}

export { catalogSyncSummary };
