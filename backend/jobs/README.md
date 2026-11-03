# Jobs API: SQL connections and request diagnostics

The Jobs Function App owns the Jobs SQL domain. It uses the existing `get_connection()`
API. A Python worker process has one small SQL connection pool. The pool is not
shared between workers or scaled-out Function App instances.

## Pool policy (issue #50)

| App setting | Default | Allowed | Purpose |
| --- | --- | --- | --- |
| `JOBS_SQL_POOL_ENABLED` | `true` | `true`/`1`/`yes` or `false`/`0`/`no` | Enable the application pool |
| `JOBS_SQL_POOL_SIZE` | `4` | 1–16 | Maximum physical connections, including opens in progress, per Python process |
| `JOBS_SQL_POOL_IDLE_SECONDS` | `120` | 1–600 | Discard a connection on its next checkout if its idle age reached this limit |
| `JOBS_SQL_POOL_VALIDATE_SECONDS` | `30` | 0–600 | Validate an idle connection on checkout after this idle age |
| `JOBS_SQL_POOL_WAIT_SECONDS` | `2` | 0–30 | Maximum wait for an available pool slot |

The app pool disables `pyodbc.pooling` **before the first SQL connection** in
this worker. When `JOBS_SQL_POOL_ENABLED=false`, each request uses the previous
connect/close flow and the driver's default ODBC pooling policy. Changing
settings restarts the Functions worker. Do not toggle this flag inside a live
worker. A non-default setting that cannot be parsed fails startup instead of
silently using an unbounded pool.

Connections are exclusive leases. `conn.close()` returns a lease once. The
request wrapper also returns any lease that a route did not close. A rollback
and timeout reset occur before an idle connection becomes available again.
Connections with failed rollback are closed, not reused. A stale idle
connection is checked with `SELECT 1` (query timeout 2 seconds) and replaced
only **before** application SQL runs. The pool does not retry application SQL or
an uncertain write. `Connection.timeout` is reset to zero between requests;
a route that needs a SQL statement timeout must set it on each request.

Expiry is **lazy**: there is no background cleanup thread. An idle connection
may remain physically open beyond `JOBS_SQL_POOL_IDLE_SECONDS` until the next
checkout or process shutdown. This avoids background timers and telemetry.

Effective SQL upper bound from this app is roughly:

`JOBS_SQL_POOL_SIZE × FUNCTIONS_WORKER_PROCESS_COUNT × active Functions instances`

This does not include other services, the Functions host, or ODBC connections
outside the Jobs app. Monitor actual Azure SQL sessions before increasing
worker count or pool size. The cap is per process, not global.

References:
- [Azure Functions remote connections](https://learn.microsoft.com/en-us/azure/azure-functions/manage-connections)
- [pyodbc pooling behavior](https://github.com/mkleehammer/pyodbc/wiki/The-pyodbc-Module#pooling)

## Diagnostics

`Server-Timing` includes existing `app`, `dbconn`, `sql`, and `sql_count` plus
`db_open`, `db_pool_wait`, `db_validate`, and `db_pool` (`new`, `hit`,
`replaced`, or `disabled`). `dbconn` means total acquisition latency. It may
include pool waiting, validation, and physical connection establishment.
`db_pool` is the last connection checkout action in the request if multiple
connections are acquired. The validation `SELECT 1` is measured in
`db_validate`; it is not included in application `sql_count` or `sql`. These fields are response headers, not App Insights
custom metrics.

The Jobs request wrapper returns `x-correlation-id` for all normal responses.
For HTTP 500 with a captured SQL error, it returns fixed
`x-jobs-failure-stage` and `x-jobs-failure-category` headers, plus a validated
five-character SQLSTATE when available. The failure-only `jobs_request_failure`
Application Insights trace includes no SQL text, exception body, URL, user ID,
connection string, or credentials. Normal responses add no application trace.
Failures that occur before the route runs cannot carry these headers.

ATS Discovery sends a new correlation UUID for every Jobs HTTP attempt.
`summary.json.preflightHttpDiagnostics` counts HTTP statuses, recovered retries,
SQLSTATEs, pool actions, and p50/p95 connection/SQL timings. Successful single
attempts contribute aggregate measurements only. Only failed attempts and
recovered requests store attempt details in the plaintext `preflight-results`
artifact and journal. Raw Jobs error bodies are not stored. The complete run
folder remains private because other scanner artifacts contain job data.

For a failing `failedAttempts[].correlationId`:

```kusto
AppTraces
| where TimeGenerated >= ago(7d)
| where Message has "jobs_request_failure"
| where Message has "00000000-0000-0000-0000-000000000000"
| project TimeGenerated, SeverityLevel, Message, _ResourceId
| order by TimeGenerated desc
```

If no trace is found, check requests rejected by the Functions host and SQL
resource metrics. Absence of an application trace does not prove that the SQL
pool failed. Compare equivalent GET `/jobs/exists` requests and their `dbconn`
latency before and after deployment. Check full UTC days of billable `AppTraces`
volume before relaxing any telemetry controls. See
[`docs/operational-telemetry.md`](../../docs/operational-telemetry.md).

## Test and deployment

From `backend/jobs` run the **offline unit tests** with:

```sh
python -m pytest tests_unit
```

Use the installed service dependencies (`azure-functions`, `pyodbc`). The
`tests` directory contains production integration tests; run it from the
local development node **after** deploying Jobs. Deploy Jobs before updating
ATS Discovery, then inspect its next complete preflight summary.

To roll back connection reuse, set `JOBS_SQL_POOL_ENABLED=false` in the Jobs
Function App, restart, and verify timing and failures. Reverting the code also
removes the extra diagnostic headers. No SQL migration is required.
