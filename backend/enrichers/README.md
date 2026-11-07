# Enrichers SQL connection reuse

Enrichers uses one small SQL pool per Python worker. Each SQL lease belongs to one
caller. An HTTP request can have several leases. A timer must close each lease.

The pool does not change SQL transactions, subject locks, run decisions, Service
Bus dispatch, or SQL retry rules. It does not repeat a SQL operation after a
failure. A failed request after dispatch can still have an uncertain outcome.

## Configuration

| App setting | Default | Allowed values |
| --- | ---: | --- |
| `ENRICHERS_SQL_POOL_ENABLED` | `true` | `true/false`, `1/0`, `yes/no` |
| `ENRICHERS_SQL_POOL_SIZE` | `4` | 1 to 16 |
| `ENRICHERS_SQL_POOL_IDLE_SECONDS` | `120` | 1 to 600 |
| `ENRICHERS_SQL_POOL_VALIDATE_SECONDS` | `30` | 0 to 600 |
| `ENRICHERS_SQL_POOL_WAIT_SECONDS` | `2` | 0 to 30 |

The SQL connection timeout stays at five seconds. The idle validation query
uses a two-second query timeout. An idle connection is checked after the
validation interval and removed after the idle limit. An idle connection is
not closed by a background worker; it is removed at the next checkout.

The limits apply to each Python worker, not the entire Function App. SQL
connection capacity can grow with worker count and scale-out. The pool disables
pyodbc driver-manager pooling at module import time. This assumes that no
other module creates an ODBC connection before this module loads.

Set `ENRICHERS_SQL_POOL_ENABLED=false` and restart Enrichers to disable the
application pool. Keep the normal SQL connection string and functions unchanged.

## Use and cleanup

`helpers.db.get_connection()` returns a connection adapter with the same
`cursor()`, `commit()`, `rollback()`, `close()`, and `autocommit` operations used
by the current service. `close()` returns a healthy lease to the pool. It
rolls back outstanding work and resets the connection query timeout. A broken
connection is closed instead. The HTTP timing wrapper releases any unclosed
lease when a request ends. Timers must close their leases explicitly.

`dispatch_projections` now returns the SQL selection lease after its lock
transaction commits and before it calls Jobs. It gets a new lease for each
status update. The application lock still covers selection only. It does not
reserve each selected row while network calls run; concurrent timers can
select the same due rows, as before.

## Low-volume diagnostics

HTTP responses include fixed `Server-Timing` metrics `sql`, `sql_count`,
`dbconn`, `db_open`, `db_validate`, and `db_pool_wait`. The last SQL checkout
appears in `db_pool`. For accurate totals when a request makes more than one
SQL checkout, use `db_pool_hit`, `db_pool_new`, `db_pool_replaced`, and
`db_pool_disabled`. These are counts stored as bounded description values.

ATS Discovery collects these counts and its allowlisted timing fields in
`summary.json.compatibilityHttpDiagnostics`. It records them in the scanner's
private JSON artifacts; it does not send successful SQL metrics to Application
Insights. The summary shows checkout totals and successful request p50/p95.
An HTTP request is not the same as a SQL checkout. A pool hit is not proof of
SQL query success or enrichment run completion.

The existing compatibility route logs one safe failure record when a stage
fails. Other HTTP SQL failures add a fixed failure stage/category/SQLSTATE
where the route returns HTTP 500 and a SQL failure was observed. No SQL
text, connection string, HTTP body, or exception text is added to these
records. The timer also uses fixed error text for Jobs delivery failures.

## Validation

1. Run offline unit tests: `python -m pytest -q backend/enrichers/tests_unit`.
2. Deploy Enrichers first. Run its existing production integration tests from
   the local dev node after deployment, not from an automated unit-test job.
3. Deploy ATS Discovery. Compare scanner runs with similar workloads.
4. Check `compatibilityHttpDiagnostics.poolLeases`,
   `successfulRequestTiming.dbconn`, and `sqlStateCounts`. Confirm no new
   `db_connection_pool_wait` failures and no increase in Pending run counts.
5. Compare full-day Application Insights ingestion against the telemetry
   budget. Inspect SQL connection limits if scale-out changes.

Do not use production to test deliberate transaction failures or forced SQL
connection outages. The local pool tests use fakes.

Run creation uses `SET NOCOUNT ON` while it gets the SQL subject lock. Its SQL
batch restores `NOCOUNT OFF` before it returns. If the batch fails before the
reset, the lease is invalidated and the physical connection is discarded.
This protects row-count checks in other Enrichers operations.
