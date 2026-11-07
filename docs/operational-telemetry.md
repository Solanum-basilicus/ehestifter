# Low-volume operational telemetry

## Scope and goal

Azure Application Insights is a failure signal, not a business event store or a
performance history store. Normal operation should use **less than 1 GB of
billable ingestion per 30 days** across the existing workspace. Use **25 MB/day**
as the working threshold. This is a target, not a hard limit. Verify it with
Azure billing and the `Usage` table after deployment.

- Business actions and their history stay in the owning domain stores and the
  existing Analytics service.
- Detailed performance measurements stay in the browser and `Server-Timing`
  diagnostics. They are not exported to Application Insights.
- Azure keeps unexpected warnings, errors, exceptions, and low-rate execution
  aggregates. Routine success messages and normal individual executions are
  not required in Application Insights.
- Do not add a queue, background task, or in-memory log-message accumulator.
  A Function App can scale to zero before an in-memory batch is published.

## Current implementation

### Web Core (`backend/core`)

The default `CORE_LOG_LEVEL` is `WARNING`. `DEBUG`, `INFO`, `WARNING`, `ERROR`,
and `CRITICAL` are allowed, without case sensitivity. An invalid setting falls
back to `WARNING`. The root logger threshold is set even if the host has already
installed logging handlers. Web Core no longer adds a second handler to its
application logger.

The setting filters Python `logging` records. It does **not** necessarily filter
all telemetry that App Service auto-instrumentation exports. App Service
instrumentation and Application Insights request/metric collection must be
checked separately if ingestion remains high.

### Azure Functions (`jobs`, `users`, `enrichers`)

Each `host.json` specifies:

| Setting | Normal behavior |
| --- | --- |
| `logging.logLevel.default=Warning` | Filter routine worker and host traces |
| `logging.logLevel.Function=Warning` | Filter routine function user traces and execution-start messages |
| `logging.logLevel.Host.Results=Error` | Do not store successful execution request records; failed executions remain |
| `logging.logLevel.Host.Aggregator=Information` | Keep aggregated invocation counts/durations |
| `aggregator.flushTimeout=00:05:00` | Prefer five-minute execution aggregates over the default 30-second interval |
| `aggregator.batchSize=1000` | Flush sooner when the invocation count reaches 1,000 |
| `samplingSettings.excludedTypes=Request;Exception` | Do not sample the remaining failed-execution requests or exceptions |
| `samplingSettings.maxTelemetryItemsPerSecond=5` | Reduce burst sampling target; **not** a volume or cost cap |
| `enablePerformanceCountersCollection=false` | Avoid Application Insights performance-counter collection |

`aggregator` is a **top-level** `host.json` object. `Host.Aggregator` is a
logging category. They control different parts of the runtime.

Consequences:
- The Azure Functions Monitor tab will not show successful executions as
  individual records.
- Function dependency telemetry and custom metrics can be reduced by the
  `Function` log threshold.
- The execution aggregator gives interval totals, not exact event-level history.
- Application code that catches a failure and returns a response can be
  classified as a successful function execution. Its error log must remain
  visible. This configuration is not a substitute for application error handling.
- Live Metrics and any independent SDK instrumentation may follow separate
  rules. Do not assume all telemetry obeys `host.json`.

The Azure Gateway is an inactive rollback runtime. This change does not edit
its `host.json`: such an edit would also trigger the active Cloud Run Gateway
deployment workflow. Review its telemetry policy only if the Azure fallback
becomes active.

## Deployment and verification

**Before deployment**

1. In Azure App Service `ehestifter` and each Function App, inspect app settings
   for existing logging overrides and Application Insights configuration. Any
   `AzureFunctionsJobHost__logging__*` setting can override `host.json`.
2. Keep a copy of the previous settings. Do not change connection strings.
3. Use the original pre-deployment `Usage` data as baseline: October 21-27,
   2026 had about 1.67 GB, including 1.44 GB in `AppTraces`.

**After each service deployment**

1. Confirm a normal request, an expected client error, and a real application
   failure path. Check that failure logs reach Application Insights. Do not
   deliberately make an unhandled exception in the shared production environment.
2. For Functions, check `AppMetrics` for `Host.Aggregator` data after at least
   one flush interval. The Functions Monitor tab should show fewer successful
   request records by design.
3. Compare full UTC days only. Azure ingestion and billing data can arrive
   late. Check for a change in active application traffic before attributing
   a volume change to the new settings.
4. Run the existing production integration tests **after** the relevant
   deployment, from the local dev node. Unit tests run locally and must not
   contact production.
5. If the target is not met, identify the remaining tables and resources
   before changing other instrumentation settings.

Workspace query (billable megabytes per day; UTC):

```kusto
Usage
| where StartTime >= ago(7d)
| where IsBillable == true
| summarize MB = round(sum(Quantity), 1) by Day = startofday(StartTime), DataType
| order by Day asc, MB desc
```

`Usage.Quantity` is in decimal MB. It is useful for trends; billing amounts
and usage allowance must still be checked in Cost Management.

Workspace query (billable traces by Application Insights resource and severity):

```kusto
AppTraces
| where TimeGenerated >= ago(7d)
| summarize Records = count(), MB = round(sum(_BilledSize) / 1000000.0, 1)
    by _ResourceId, SeverityLevel
| order by MB desc
```

Workspace query (other volume, including requests, metrics and counters):

```kusto
union withsource=Table AppRequests, AppMetrics, AppPerformanceCounters, AppExceptions
| where TimeGenerated >= ago(7d)
| summarize MB = round(sum(_BilledSize) / 1000000.0, 1)
    by Table, _ResourceId
| order by MB desc
```

If a table does not exist, query the available tables separately. App Service
request and metric auto-instrumentation can account for residual ingestion that
is **not** controlled by Web Core's Python root logger. Check its source before
disabling anything. Use native Azure resource metrics where adequate.

## Temporary diagnostic mode

A configuration change restarts the affected service. Make changes to **one**
service only. Record the time and old value first. Restore the old value
promptly after diagnosis.

- **Web Core**: set `CORE_LOG_LEVEL=INFO` (or `DEBUG` only when needed) in the
  App Service application settings. Remove the setting or set it to `WARNING`
  to return to normal mode.
- **Azure Functions**: set
  `AzureFunctionsJobHost__logging__logLevel__Function=Information` in the
  relevant Function App application settings. To see successful individual
  invocations temporarily, also set
  `AzureFunctionsJobHost__logging__logLevel__Host.Results=Information`.
  Remove the temporary keys to return to `host.json` defaults. For runtime
  categories outside `Function`, use an explicit override only after checking
  the table's category.
- Do not add a second telemetry exporter or enable unsampled `DEBUG` records
  across all services. Avoid logging bodies, access tokens, personal data,
  or HTTP authorization headers.

Azure Functions documentation:
- [Configure monitoring](https://learn.microsoft.com/en-us/azure/azure-functions/configure-monitoring)
- [host.json settings and aggregation](https://learn.microsoft.com/en-us/azure/azure-functions/functions-host-json)
- [Override host.json with application settings](https://learn.microsoft.com/en-us/azure/azure-functions/functions-host-json#override-hostjson-values)

Azure App Service:
- [Monitor App Service, including Python autoinstrumentation](https://learn.microsoft.com/en-us/azure/app-service/monitor-app-service)

## Compatibility request failures (issue #41)

ATS Discovery sends a new UUID in `x-correlation-id` for each HTTP attempt to
`POST /enrichment/runs`. Local `compatibility-results.json` uses schema version 2.
Each pair has a stable SHA-256 `pairKey` from the lower-case job and user IDs.
It does not contain the raw pair IDs, CV version, candidate URL, response body,
or exception text. A hash is a link key, **not** anonymous data if the original
IDs are available. Other scanner artifacts can still contain user identifiers
or job data; keep the complete run directory private.

Each request result includes `requestDiagnostics` with the final correlation ID,
HTTP status, attempt count, and total elapsed milliseconds. `failedAttempts`
contains only failed attempts and has one correlation ID per attempt. Server
failure headers and bounded `Server-Timing` fields are copied through fixed
allowlists. Normal successful requests do not store a full attempt trace.

`summary.json` includes `compatibilityHttpDiagnostics`. It separates final
request failures, retry recoveries, and HTTP 201 responses that had a server
failure while the new run remained Pending. A successful submission **does not**
mean the worker completed the compatibility run. A `mark_queued` HTTP 500 can
occur **after** dispatch. Do not assume it is safe to send another request
outside the existing automatic reuse and bounded retry rules.

Enrichment Core sends fixed `x-enrichment-failure-stage` and
`x-enrichment-failure-category` headers for failures in this route. When the
SQL driver gives a valid SQLSTATE, it also sends `x-enrichment-failure-sqlstate`.
It writes **one ERROR trace per caught failure**, with fixed path/stage/category,
a safe SQLSTATE, the request correlation ID, and the Enrichment run ID if known.
The normal route does not write a request-body or success trace. HTTP 201 with
a snapshot or dispatch failure still has an error trace and diagnostic headers.
No extra Application Insights SDK, log sink, or new Azure service is required.

To find a failed attempt in Enrichers Application Insights, replace the UUID
with the `failedAttempts[].correlationId` value in the local run artifact:

```kusto
AppTraces
| where TimeGenerated >= ago(7d)
| where Message has "enrichment_run_failure"
| where Message has "00000000-0000-0000-0000-000000000000"
| project TimeGenerated, SeverityLevel, Message, _ResourceId
| order by TimeGenerated desc
```

This query does not recover errors that Azure rejects before the Python route
runs. A missing trace does not prove that the request reached Enrichment Core.
Keep `Host.Results=Error` and `Function=Warning` in normal operation. Check
billable `AppTraces` after deployment as described above.

If the selected Gateway returns a non-success response, the diagnostic also
contains a fixed `gateway_http_4xx` or `gateway_http_5xx` category, a numeric
upstream status, and `primary` or `alternative` as the target. The raw Gateway
response body is not stored in an exception.

## Jobs SQL checkout and preflight requests (issue #50)

The Jobs Python worker keeps up to four exclusive SQL leases by default. On
request end it rolls back any unfinished transaction and returns each lease.
Idle checkout can validate a connection before a job SQL statement. The pool
has a two-second checkout wait. Connection-opening timeout remains five
seconds. These are starting values, not measured optimums.

`Server-Timing` adds `db_open`, `db_pool_wait`, `db_validate`, and an allowlisted
`db_pool` action. The old `dbconn` value now includes acquisition and pool wait
rather than necessarily a new physical SQL connection. Normal HTTP responses
create no new application logs or custom metrics. A Jobs HTTP 500 caused by a
recorded SQL error has safe failure headers and one `jobs_request_failure` error
trace with the request correlation UUID. Some older Jobs routes still emit
exception logs on other error paths; this change does not remove all existing
exception logging across the service.

The scanner sends `x-correlation-id` for each Jobs HTTP attempt. Its
`preflight-results` JSON keeps only failed or recovered attempt diagnostics,
without response body, exception text, connection string, or secret. The new
`summary.json.preflightHttpDiagnostics` includes status/category totals,
SQLSTATE counts, pool actions, and connection/SQL latency p50/p95. Successful
single-attempt detail stays in memory only while the summary is built; it is
not written per candidate. Existing preflight error counters and behavior do
not change. Other scanner artifacts still contain job URLs and identities.

Match `preflight.requestDiagnostics.failedAttempts[].correlationId` to Jobs
Application Insights:

```kusto
AppTraces
| where TimeGenerated >= ago(7d)
| where Message has "jobs_request_failure"
| where Message has "00000000-0000-0000-0000-000000000000"
| project TimeGenerated, SeverityLevel, Message, _ResourceId
| order by TimeGenerated desc
```

If a failure has no server diagnostic fields, it may have occurred in the
Functions gateway or before Python started. Do not infer its SQL cause.
Do not compare different scanner populations as a controlled before-and-after
measurement. See `backend/jobs/README.md` for settings and scope.

## Enrichers SQL pool diagnostics (follow-up to issues #41 and #50)

Enrichers uses a process-local SQL pool. It reports only allowlisted
`Server-Timing` metrics on normal HTTP responses. It does not write a trace for
successful SQL checkouts. `dbconn` includes waiting, opening, and validation.
`db_pool` is the last checkout for that HTTP request. **Use** the
`db_pool_hit`, `db_pool_new`, `db_pool_replaced`, and `db_pool_disabled` counters
for the complete number of SQL checkouts. One Enrichment run request can use
several SQL connections in sequence. The scanner aggregates these counters in
`summary.json.compatibilityHttpDiagnostics.poolLeases`. The same summary has
`successfulRequestTiming` p50/p95 in milliseconds and bounded SQLSTATE counts.

The scanner reads only fixed timing keys and fixed pool actions. Success data
is kept in local JSON artifacts, not sent to Application Insights. Do not add
HTTP bodies, SQL statements, full error messages, credentials, user IDs, CV
text, or other unbounded request fields to these diagnostics.

SQL pool settings, fallback, and validation steps are in
`backend/enrichers/README.md`. A timer does not return Server-Timing; its
connections still use the same worker-local pool and the explicit close path.
