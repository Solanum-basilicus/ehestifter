import { getDefaultLocationsV2Catalog } from './locations-v2-catalog.mjs';

function toLegacy(item) {
  if (!item) return null;
  return {
    countryCode: item.countryCode,
    regionName: item.name,
    locationId: item.id,
    aliases: [item.name, ...(item.aliases ?? [])],
  };
}

export function resolveAdministrativeRegion(
  value,
  { countryCode = null, allowAmbiguous = false } = {},
) {
  return toLegacy(getDefaultLocationsV2Catalog().resolveAdminRegion(value, {
    countryCode,
    allowAmbiguous,
  }));
}

export function findAdministrativeRegionMentions(value, { countryCode = null } = {}) {
  return getDefaultLocationsV2Catalog()
    .findAdminRegionMentions(value, { countryCode })
    .map(toLegacy);
}

export function administrativeRegionEntries() {
  throw new Error('administrativeRegionEntries is no longer a scanner-owned contract');
}
