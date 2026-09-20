# Locations v2

Status: issue #21 adds native API and query support. Locations v1 stays the default active model until the operator changes `LOCATIONS_ACTIVE_MODEL`.

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

Jobs also stores the upward closure as query facts. Each fact keeps the ID of the direct v2 location that produced it. This branch identity is required when one job has alternative locations. It lets one valid branch pass even when another branch is excluded. SQL can use indexed equality checks instead of recursive geographic queries.

The matching direction is important:

- for on-site and hybrid jobs, a specific job can satisfy a broader user selector;
- a broad job value does not prove a more specific on-site or hybrid location;
- for remote scope, a broad job scope can contain a more specific user selector.

Issue #21 implements these query rules.

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

The model uses these tables:

- `dbo.JobOfferingLocationsV2`: direct normalized location claims;
- `dbo.JobOfferingLocationFactsV2`: one direct branch plus its geographic ancestors;
- `dbo.JobOfferingLocationUtcOffsetsV2`: derived UTC offsets for one direct branch;
- `dbo.JobOfferingWorkTimeConstraintsV2`: explicit job-level work-time ranges.

Migration `28_locations_v2_branch_facts.sql` rebuilds the two derived fact tables with `DirectLocationV2Id`. It does not change direct v2 rows or Locations v1 rows.

Locations v1 stays in `dbo.JobOfferingLocations`. The active read/filter model is selected with `LOCATIONS_ACTIVE_MODEL=v1|v2`. The default is `v1`.

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

## Native Jobs API contract

Jobs create and update accept `locationsV2` and `workTimeConstraintsV2`. A location input contains only canonical identity:

```json
{
  "locationsV2": [
    {"kind": "city", "locationId": "geonames:2950159"}
  ],
  "workTimeConstraintsV2": [
    {"offsetRangeStartMinutes": 0, "offsetRangeEndMinutes": 240}
  ]
}
```

Jobs validates the canonical ID against its local catalog. Jobs derives display text, country code, catalog version, ancestor facts, and geographic UTC facts. Callers must not send those derived values as authoritative input.

Locations v1 and Locations v2 writes are independent:

- a v1-only payload writes only v1;
- a v2-only payload writes only v2;
- a payload with both writes both from their own values;
- on update, an omitted location field is unchanged;
- on update, an explicit empty array clears that representation.

There is no v2-to-v1 shadow write. If an operator returns to v1 after native v2-only jobs exist, those jobs can have no visible location in v1 mode. This is an accepted rollback limitation.

Jobs reads return both representations when they exist. The response also returns `activeLocationModel`. Web uses that value for location presentation.

Issue #8 adds the manual selector contract owned by Jobs:

```text
GET  /jobs/locations/search?q=<text>&limit=<n>
POST /jobs/locations/lookup
POST /jobs/locations/coverage
```

Search returns small user-facing records with canonical identity plus derived
presentation fields such as country name and administrative-region context.
Lookup resolves already-selected canonical IDs and reports missing IDs without
changing them. Both endpoints use the generated read-only
`locations-v2.search.sqlite3` selector index, so interactive requests do not
load the full catalog. The index is built from the canonical catalog and must
have the same `catalogVersion` as the packaged manifest. It is not a second
geography source.

Coverage is an on-demand explanation endpoint for the Web preference editor. It
uses country-to-global-region relationships generated into the same selector
index and returns a country-level view with `included`, `partial`, and `excluded`
states plus narrower city/admin exceptions. It does not add polygon/map boundary
data or load the full catalog on the interactive path. Web Core proxies these
endpoints.
Web Core uses lookup before it saves discovery preferences. Users does not copy
or query the location catalog.

Search ranking can use population to order otherwise comparable same-name city
results. Population is presentation metadata only. It must never silently
change a selected canonical identity or resolve an ambiguous ingestion claim.

## Open Opportunities eligibility contract

Jobs exposes `POST /jobs/open/query`. Core exposes `POST /ui/jobs/open/query`. Core passes the authenticated user ID in the normal Jobs header. The request body carries normalized eligibility criteria. Jobs does not call Users and does not read Users storage.

Example:

```json
{
  "limit": 25,
  "offset": 0,
  "eligibility": {
    "remote": {
      "includeLocations": [
        {"kind": "country", "locationId": "iso3166:DE"}
      ],
      "excludeLocations": [],
      "utcOffsetRanges": [
        {"startMinutes": 60, "endMinutes": 120}
      ],
      "excludeWorkTimeRanges": [
        {"startMinutes": -480, "endMinutes": -420}
      ],
      "allowUnknownLocation": false
    }
  }
}
```

The supported work-arrangement groups are `remote`, `hybrid`, `onSite`, and `unknown`. If an eligibility object is present, an omitted group is not eligible. An empty eligibility object matches no work arrangement. A null or omitted eligibility value adds no location restriction.

For on-site and hybrid jobs, a branch matches a positive selector when the branch or one of its ancestors equals the selector. For remote jobs, positive matching also accepts a broader direct job scope that contains the user selector. Negative location checks use the same direct branch as the positive and UTC checks. A negative specific place does not reject a broader remote scope only because that scope contains the place.

`allowUnknownLocation` applies when geographic criteria exist and the job has no direct v2 geography. Explicit work-time exclusions are job-level checks. No work-time row means that no explicit work-time restriction is known, so there is nothing to reject.

The eligibility SQL uses direct rows, branch-aware facts, UTC facts, and work-time ranges. It does not parse location text, calculate hierarchy, calculate timezone rules, or call an LLM. Jobs expands remote selector ancestry from the local catalog before it builds the SQL predicate.

When `LOCATIONS_ACTIVE_MODEL=v1`, the structured endpoint still works as an Open Opportunities query, but it does not apply v2 eligibility. The response reports `locationEligibilityApplied: false`. This behavior is the rollback switch for the read-time filter.

## Issue #21 cutover

Apply migration 28 before the issue #21 Jobs code. Migration 28 drops and recreates only the two derived fact tables, so these tables are empty after the migration. Run the complete v1-to-v2 backfill before v2 is enabled.

Keep `LOCATIONS_ACTIVE_MODEL=v1` until native producers are ready. Before the production switch:

1. pause or avoid ATS ingestion for the short cutover window;
2. run the full v1-to-v2 backfill from the start;
3. verify fallback and unresolved counts;
4. deploy or enable native v2 producers;
5. set `LOCATIONS_ACTIVE_MODEL=v2`;
6. monitor the list, detail, and Open Opportunities paths;
7. set the value back to `v1` if a blocking problem occurs.
