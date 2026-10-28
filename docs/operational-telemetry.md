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
