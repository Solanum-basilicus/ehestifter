# Performance diagnostics: Jobs page and compatibility submission

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
   `server.services.enrichers` for compatibility requests.
5. Compare a fresh request with a warm one. Note `cache`,
   `jobs_catalog_cache`, `jobs_process_first`, `enrichers_process_first`, and
   `enrichers_gateway_process_first`, if present. Different requests can hit
   different processes. An ordinary cache hit does not contact Jobs.

The main detail path includes `job_row`, `legacy_locations`, `catalog_load`,
`locations_v2`, `work_time`, and `serialize`. When the catalog is loaded in that
request, `catalog_parse` and `catalog_index` are nested inside `catalog_load`.
On a cache hit, the nested parse/index stages are absent. During an error, a
stage that fails records elapsed time when its context exits, provided the
service returns an HTTP response with timing headers.

The current browser implementation shows only the last response header for an
operation with several browser retries. Core measures each Jobs attempt it
makes; its `attempts` and `retry_wait` help identify retry overhead. Client
network or browser DOM time is outside Core `core` duration.

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

## Interpretation

- All durations are milliseconds and use monotonic clocks *within one process*.
  There are no comparable timestamps across machines.
- Parent times include child times. Do not sum `core + enrichers_http`,
  `enrichers_app + gateway_http`, or `catalog_load + catalog_parse`.
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

Deploy Gateway first (both Cloud Run and Azure, if both are in use), then
Enrichers, Jobs, and Web Core. These headers are additive. A newly deployed
caller must tolerate an older downstream service that has no timing header.
Check a successful and failed endpoint response in each service. Check the
first request after idle and repeat on the same and a different job.

The runtime integration tests for Azure Functions call the production
endpoints from the development node. Run them according to each service's
existing test procedure after deployment. They must not require timing values
that are stable across runs. A regression in the request body or status code
is a release blocker.
