# Performance diagnostics: Jobs, Users, and compatibility submission

## Purpose

Measure existing work. Do not use these measurements to change response bodies,
timeouts, retries, SQL statements, cache rules, or dispatch order. Collection is
in memory for one request or browser page. No historical data is stored.

## Inspect a slow job detail page

1. Open a job details page, then open browser DevTools.
2. In **Network**, inspect the HTML, `/ui/jobs/{id}`, status, history, and
   `/ui/enrichment/subjects/{id}/latest` requests. Note total request time.
3. In **Console**, run `ehPerf.table()` to identify the slow intent and stages.
4. Run `ehPerf.snapshot()` to inspect exact step durations and labels. Read
   `server.services.jobs.steps` for the Jobs detail stages and
   `server.services.enrichers` for compatibility requests. Read
   `server.services.users` for a direct Users API call and
   `server.services.enrichers.users` for the CV snapshot subcall.
5. Compare a fresh request with a warm one. Note `cache`,
   `jobs_catalog_cache`, `jobs_process_first`, `enrichers_process_first`, and
   `enrichers_gateway_process_first`, if present. Different requests can hit
   different processes. An ordinary cache hit does not contact Jobs.

The main detail path includes `job_row`, `legacy_locations`, `locations_v2`,
`work_time`, and `serialize`. If the full catalog is loaded, `catalog_parse`
and `catalog_index` are nested inside `catalog_load`. On a cache hit, the
nested parse/index stages are absent. During an error, a stage that fails
records elapsed time when its context exits, provided the service returns an
HTTP response with timing headers.

For Jobs GET-by-ID with the v2 model, `locations_v2` now includes the SQL read
and the nested `location_lookup` step. `jobs_location_display=index` means that
the packaged SQLite search index supplied the presentation. `fallback` means
that the index read failed and Jobs used the full catalog. `stored` means the
request did not need presentation lookup (v1 model or no v2 rows). On the
normal index path, `catalog_load` and `catalog_cache` are absent. A fallback
can report `catalog_load`, `catalog_parse`, `catalog_index`, and
`catalog_cache`. Do not add nested stages when calculating total time.
Jobs keeps canonical validation on write; the display index does not validate
stored IDs. An unknown ID retains its stored fields and catalog version.

The current browser implementation shows only the last response header for an
operation with several browser retries. Core measures each Jobs attempt it
makes; its `attempts` and `retry_wait` help identify retry overhead. Client
network or browser DOM time is outside Core `core` duration.

## Inspect job lists (issue #40)

1. Open **My Jobs**, **All Jobs**, or **Open Opportunities**. In browser
   DevTools, run `ehPerf.snapshot()` after the status changes to **Ready**.
   Each category/filter/page change creates a new `job.list.load` intent.
2. Inspect `operations.list.server.services.jobs.steps`. In Jobs, `count_query`
   and `page_query` are separate SQL operations. The Open Opportunities list also
   has `location_hydration`, `location_v2_query`, and `location_lookup`.
   Country filters add `country_lookup` and `country_lookup_source=index`.
3. Inspect `operations.status`, `operations.compatibility`, and
   `operations.locations` for their own Core and Jobs server metrics. Location
   hydration is skipped on Open Opportunities, which includes locations in the
   list response. An empty list skips all three bulk requests.
4. In Core, inspect `identity`, `cache_get`, `cache_put`, `analytics`,
   `response_build`, `jobs_http`, and `jobs_unattributed`. Bulk requests also
   report `body_parse` and `identity`. `jobs_app`, `jobs_sql`, and `jobs_dbconn`
   are Jobs measurements, not additional Core work.
5. To bypass only the Core **job-list** memo cache during an experiment, set
   `EHESTIFTER_JOBS_LIST_CACHE_ENABLED=false` in the Web Core environment, then
   restart or redeploy Core to apply the setting. `cache=bypass` and
   `list_cache_enabled=0` appear on responses. Unset the variable or set it to
   `true` to restore the default 30-second cache. This does not disable the
   Jobs catalog/index cache or the Users session cache.

The list first renders cards, then reads status, compatibility, and (for My/All)
locations. **Ready** appears after those bulk requests settle and the UI has
applied their data or fallback states. Browser elapsed time includes retries
and rendering. Use it for request order, not as a substitute for the service
step durations. A browser retry can replace the previous `Server-Timing` sample
for that operation. `job.list.load` records are bounded and stored only in the
current browser page; no new logging or analytics events are sent.

The Jobs indexed presentation uses the same packaged SQLite index as job
GET-by-ID. It looks up canonical IDs, leaves missing IDs stored, and preserves
stored catalog versions and SQL row order. A new generated table contains the
exact country aliases used by the list filter. Rebuild the index using
`python tools/build_locations_v2_catalog.py --index-only` for this change.
An old index without the new table uses the full catalog fallback for country
filters. No canonical write validation is changed. `location_display=fallback`
and `country_lookup_source=fallback` indicate an index failure. A fallback may
reintroduce multi-second catalog parsing, so treat repeated fallbacks as a
problem to fix, not as acceptable warm performance.

The COUNT query remains part of the list endpoint. Moving it to a later
request is a separate design decision because it changes pagination and total
count behavior. Page changes keep the previous cards visible during loading,
but hide the old pagination controls and count until the new list arrives.

## Inspect compatibility-run submission

1. Click **Run compatibility** on a job details page.
2. Inspect the `job.compatibility.run` intent in `ehPerf.snapshot()`.
3. Compare `enrichers_http` and `enrichers_app` in the action's `server`
   fields. `enrichers_unattributed` is the HTTP time minus measured handler time
   when both exist, with negative differences rounded up to zero.
4. Inspect `server.services.enrichers.steps`. It separates `run_create`,
   `analytics`, `job_snapshot`, `cv_snapshot`, `snapshot_validate`,
   `blob_upload`, `snapshot_path_update`, `gateway_dispatch`, `mark_queued`,
   and `run_readback`. Only executed stages are present.
5. Inspect `server.services.enrichers.gateway.steps` and its `http`, `app`,
   `unattributed`, `process_age`, and `process_first` values. The `servicebus_*`
   stages show dispatch work within Gateway, when Gateway returned its header.

Successful queue submission is **not** successful LLM processing. A dispatch
failure can leave the run Pending while Enrichers returns 201; the timing
record still shows Gateway HTTP time if it was attempted. A missing Gateway
handler time after an HTTP timeout is expected.

## Inspect Users timing (issue #36)

1. On a job details page, inspect the `user` operation in `job.details.load`.
   The Core `/ui/users/me` response reports `users_cache;desc="hit|miss"`.
   A cache hit has no new Users HTTP call. On a miss, use
   `server.services.users` to inspect `http`, `app`, `dbconn`, `sql`,
   `sql_count`, and `process_first` when the Users API returns them.
2. On the profile page or in DevTools, inspect Core responses from
   `/ui/users/cv`, `/ui/users/discovery-preferences`, and other Users routes.
   These also forward measured Users headers. The job detail browser snapshot
   does not automatically record all profile-page operations.
3. Submit a compatibility run. In `job.compatibility.run`, read
   `server.services.enrichers.steps.cv_snapshot` for the full Enrichers
   CV stage. Read `server.services.enrichers.users` for its nested Users call.
   `http` includes the httpx client setup, response, and teardown. The
   `unattributed` value is the non-negative `http - app` difference when
   Users returns an `app` measurement.
4. For direct CV reads, inspect `cv_lookup`, `blob_client`,
   `blob_download`, `cv_convert`, and `serialize` when present. For a CV
   update, inspect `blob_upload` and `analytics`. For discovery-eligible,
   inspect `discovery_query`, `profile_normalize`, `cv_batch_download`,
   and `readiness`. SQL and DB connection times are separate metrics.

Users emits `app`, `dbconn`, `sql`, `sql_count`, `process_age`, and
`process_first` for all handled HTTP routes. More steps appear only when the
work takes place. The `blob_client` stage measures local credential and Blob
service-client construction. Authentication and HTTP transport for the first
Blob operation may run later in `blob_download` or `blob_upload`. For a batch,
`cv_batch_download` contains all Blob downloads and decode work; each
`blob_download` stage is a child of that work. The Blob helpers do not make
extra calls to collect timing data.

A retry can contact more than one Users worker. Core adds request-attempt
`users_http`, `users_app`, SQL counts, and stage durations. It keeps the last
reported process age and retains `process_first=1` if any attempt reports it.
The browser records the last HTTP response from its own retry loop; it does
not merge browser retries. A Users error generated by the Functions host
before Python route entry can have no Users timing header.

Only fixed metric names and numeric or fixed-label values are passed between
services. Downstream headers are parsed with length and field limits. Headers
must not contain user IDs, CV text, Blob paths, SQL text, or credentials. No
SQL, Blob, or analytics write is added for timing.

## Interpretation

- All durations are milliseconds and use monotonic clocks *within one process*.
  There are no comparable timestamps across machines.
- Parent times include child times. Do not sum `core + enrichers_http`,
  `enrichers_app + gateway_http`, `cv_snapshot + users_http`,
  `cv_batch_download + blob_download`, or `catalog_load + catalog_parse`.
- `dbconn` and `sql` are subtotals of handler time, not SQL Server CPU.
- `process_first=1` means first **measured** request in the current worker
  process. Core preserves the flag if any Jobs retry reports a first request,
  and it reports the last observed downstream process age. A ping or concurrent request can take that place. `process_age`
  measures time since module import; preloading can affect it.
- `unattributed` is **not** measured platform startup. It can include network,
  routing, HTTP serialization, and initialization before the handler starts.
- When a response is missing an upstream `Server-Timing` header, the caller
  measures its HTTP duration but cannot break it down.
- Stage names are allowlisted, and they contain no descriptions, queries,
  identifiers, CV text, or user information.

## After deployment

For issue #36, deploy Users, then Enrichers, then Web Core. The existing
Gateway and Jobs diagnostics do not need a new deployment. These headers are additive. A newly deployed
caller must tolerate an older downstream service that has no timing header.
Check a successful and failed endpoint response in each service. Check the
first request after idle and repeat on the same and a different job.

The runtime integration tests for Azure Functions call the production
endpoints from the development node. Run them according to each service's
existing test procedure after deployment. They must not require timing values
that are stable across runs. A regression in the request body or status code
is a release blocker.
