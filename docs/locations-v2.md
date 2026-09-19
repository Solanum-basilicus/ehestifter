# Locations v2

Status: additive foundation from issue #20. Locations v1 is still the active API and UI model.

## Purpose

Locations v2 gives Ehestifter stable geographic IDs and precomputed search facts. It does not make location mandatory.

A job can have no normalized location. This is valid. A later matching flow must treat insufficient location evidence as `unknown`. User preferences decide if an unknown result is acceptable.

Work arrangement and geography are separate data:

- `JobOfferings.RemoteType` keeps `Remote`, `Hybrid`, `On-Site`, or `Unknown`.
- Locations v2 stores normalized geographic claims.
- Explicit work-time constraints use a separate table.

Do not infer `RemoteType = Remote` from missing or unresolved geography.

## Canonical IDs

Locations v2 uses these IDs:

- city: `geonames:<id>`;
- first-level administrative region: `geonames:<id>`;
- country: `iso3166:<alpha2>`;
- UN geographic region: `m49:<code>`.

The model has no named business-region type. ATS Discovery can approximate terms such as `EEA`, `EU`, `DACH`, or `EMEA` with the best useful set of countries or UN M49 regions before it sends normalized data to Jobs.

The legacy pseudo-country `EU` maps to `m49:150` (`Europe`) during v1 backfill. This mapping is intentionally broad.

## Reference data

The catalog builder is `tools/build_locations_v2_catalog.py`.

Primary sources:

- GeoNames `cities500.zip`: https://download.geonames.org/export/dump/cities500.zip
- GeoNames `admin1CodesASCII.txt`: https://download.geonames.org/export/dump/admin1CodesASCII.txt
- GeoNames `timeZones.txt`: https://download.geonames.org/export/dump/timeZones.txt
- UN M49 overview: https://unstats.un.org/unsd/methodology/m49/overview
- current Web Core geography file, used only for legacy country-name aliases.

GeoNames data is CC BY 4.0. UN M49 is the geographic hierarchy source.

The generated catalog keeps these useful fields for cities:

- GeoNames ID;
- canonical name;
- a safe ASCII alias when it differs from the canonical name;
- country;
- first-level administrative region when known;
- population;
- latitude and longitude;
- IANA timezone ID;
- UTC offsets for the catalog reference year;
- canonical ancestors.

The builder keeps duplicate place names. It does not collapse same-name cities by population.

Population is presentation metadata. A future global autocomplete can use it to rank comparable prefix matches. Population must not resolve an ambiguous migration automatically.

The generated catalog is gzip-compressed reference data. Runtime services must not call GeoNames or UN M49.

## Hierarchy

The catalog stores the parent chain for each location.

Example:

`Hallbergmoos -> Bavaria -> Germany -> Western Europe -> Europe -> World`

Jobs also stores the upward closure as query facts. This lets SQL use indexed equality checks instead of recursive geographic queries.

The matching direction is important:

- for on-site and hybrid jobs, a specific job can satisfy a broader user selector;
- a broad job value does not prove a more specific on-site or hybrid location;
- for remote scope, a broad job scope can contain a more specific user selector.

Issue #21 will implement these query rules.

## Geographic UTC facts

The catalog calculates UTC offsets from IANA timezone rules for one reference year.

A timezone that uses standard time and daylight-saving time has both offsets. For example, a Berlin place normally has `60` and `120` minute facts.

The builder checks the full reference year. It does not use only January and July samples.

Country offsets use all GeoNames timezone IDs for that country. UN region offsets are the union of their countries. Administrative-region offsets are the union of catalog cities in that region.

These are geographic facts. They do not mean that the employer requires work at those hours.

## Explicit work-time constraints

`dbo.JobOfferingWorkTimeConstraintsV2` stores only explicit job-description requirements.

Each row has:

- `OffsetRangeStartMinutes`;
- `OffsetRangeEndMinutes`.

A single offset is a range with equal endpoints. For example, UTC+4 is `[240, 240]`.

No row means that no explicit work-time restriction is stored.

Do not derive work-time rows from job geography. For example, a Berlin job does not get a CET/CEST work-time requirement unless the job description states such a requirement.

A future user preference can use negative work-time ranges to reject explicit incompatible hour requirements. Positive work-time preferences are not part of issue #20.

## SQL storage

Issue #20 adds these tables:

- `dbo.JobOfferingLocationsV2`: direct normalized location claims;
- `dbo.JobOfferingLocationFactsV2`: direct claims plus geographic ancestors for indexed matching;
- `dbo.JobOfferingLocationUtcOffsetsV2`: derived geographic UTC-offset facts;
- `dbo.JobOfferingWorkTimeConstraintsV2`: explicit work-time ranges.

Locations v1 stays in `dbo.JobOfferingLocations` and remains authoritative until issue #21.

There is no v2 resolution-state table. If no useful v2 geographic row exists, later eligibility evaluation can return `unknown`.

## Legacy backfill

The internal maintenance endpoint is:

`POST /internal/jobs/locations-v2:backfill`

Body:

```json
{
  "limit": 100,
  "afterJobId": null,
  "dryRun": true
}
```

The endpoint processes active jobs that have Locations v1 rows. It is bounded to 500 jobs per request and returns `nextAfterJobId` and `hasMore`.

Backfill rules are conservative:

1. Resolve country from the ISO code first, then from a unique catalog name/alias.
2. Resolve the administrative region inside that country when present.
3. Resolve the city inside the country and resolved administrative region.
4. If a city is ambiguous, do not select the largest city.
5. If a city cannot be resolved but the administrative region can, store the region.
6. If only the country is reliable, store the country.
7. If the country cannot be resolved, store no false geographic fact.

The response reports fallback and unresolved source counts.

The endpoint replaces only legacy-generated v2 projections. If it detects a direct v2 row with no `SourceLocationV1Id`, it treats the job as native v2 data and skips that job.

The endpoint is idempotent for the same catalog and Locations v1 data.

## Deployment rule for issue #20

Issue #20 does not add a v1-to-v2 shadow write.

The intended hobby-project rollout is:

1. deploy the additive schema and catalog;
2. run and inspect a dry backfill;
3. run the backfill;
4. implement issues #21 and #19;
5. pause or avoid ATS Discovery ingestion during the final switch window;
6. run a final full backfill from the start;
7. switch to Locations v2 with issue #21.

Jobs that are created between the first and final backfill are picked up by the final run.

Do not use the legacy backfill to overwrite native v2 jobs after the cutover.

## Unknown data

Unknown data is a supported state, not a normalization error that Jobs must guess away.

Examples:

- a user manually creates a job and omits location;
- ATS Discovery finds no location evidence;
- ATS Discovery cannot normalize available evidence;
- legacy data is too ambiguous to map safely.

Issue #8 will define user controls for how Open Opportunities handles unknown work arrangement and unknown geographic eligibility.
