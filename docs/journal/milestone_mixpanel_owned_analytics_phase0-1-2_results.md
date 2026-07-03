# Project Journal: Owned Analytics Event Log with Mixpanel Export — Phases 0–2

## Summary

Phases 0 through 2 established the Analytics bounded context for Ehestifter and proved the full owned-event-log-to-Mixpanel pipeline.

The implemented shape is:

```text
Product/service producer
  -> Analytics Cloud Run service
  -> Azure SQL owned analytics tables
  -> Mixpanel EU /import export through scheduled dispatcher
```

The system now has:

- a new Dockerized `backend/analytics` Flask/Gunicorn service,
- Azure SQL-owned event and dispatch tables,
- a restricted Analytics SQL runtime user,
- application-level `x-functions-key` auth with separate keys per producer,
- pseudonymous stable Mixpanel `distinct_id` generation,
- event allowlist and forbidden-property validation,
- Mixpanel `/import` dispatcher with retry/dead/sent state tracking,
- GCP Cloud Run deployment for `ehestifter-analytics`,
- GCP Cloud Scheduler calling dispatch every minute,
- Mixpanel export enabled and validated.

The implementation deliberately avoids browser-to-Mixpanel tracking. Mixpanel is an export sink, not the source of truth.

---

## Phase 0 — Mixpanel, GCP, and secrets readiness

### Decisions confirmed

- Analytics runtime uses GCP Cloud Run, not Azure Functions.
- GCP project/region/service:

```text
project: ehestifter-gcp
region: europe-west3
service: ehestifter-analytics
```

- Mixpanel project uses EU Data Residency.
- Mixpanel API base URL:

```text
https://api-eu.mixpanel.com
```

- Mixpanel export uses service-account credentials stored in GCP Secret Manager.
- Analytics keeps distinct service keys rather than one shared key.
- Initial export flag is disabled until pipeline validation:

```env
ANALYTICS_MIXPANEL_EXPORT_ENABLED=0
```

### Secret Manager names

Secret names were adjusted for easier management and consistency:

```text
analytics-distinct-id-salt
analytics-sql-connection-string
analytics-function-key-core
analytics-function-key-jobs
analytics-function-key-users
analytics-function-key-enrichers
analytics-function-key-scheduler
analytics-function-key-operator
analytics-mixpanel-project-id
analytics-mixpanel-service-account-username
analytics-mixpanel-service-account-password
```

### Phase 0 outcome

Completed:

- Mixpanel EU project created.
- Mixpanel service account created.
- Mixpanel project ID, username, and password stored in Secret Manager.
- Analytics function keys created and stored per producer.
- Distinct ID salt created and stored.
- SQL connection string secret created with a temporary value pending restricted SQL user setup.

---

## Phase 1 — Analytics service skeleton, schema, restricted SQL user

### Database setup

Created the Analytics-owned SQL tables:

```text
dbo.AnalyticsEvents
dbo.AnalyticsDispatch
```

`dbo.AnalyticsEvents` is the canonical owned event log.  
`dbo.AnalyticsDispatch` stores Mixpanel-specific delivery/outbox state.

Key storage behavior:

- accepted events insert one row into `dbo.AnalyticsEvents`,
- accepted events create one `pending` row in `dbo.AnalyticsDispatch`,
- export-disabled mode still creates pending dispatch rows so export can resume later.

### Restricted SQL runtime user

Created restricted Analytics SQL runtime user:

```text
analytics_runtime_user
```

Validated that the user can:

- `SELECT`, `INSERT`, `UPDATE` on `dbo.AnalyticsEvents`,
- `SELECT`, `INSERT`, `UPDATE` on `dbo.AnalyticsDispatch`.

Validated that the user cannot:

- read non-Analytics domain tables such as Jobs tables,
- delete from Analytics tables,
- use broad `db_datareader` or `db_datawriter` privileges.

After validation, `analytics-sql-connection-string` was updated in Secret Manager to use the restricted runtime user.

### Service skeleton

Added `backend/analytics` as a small Flask/Gunicorn service.

Core files added:

```text
backend/analytics/Dockerfile
backend/analytics/requirements.txt
backend/analytics/requirements-dev.txt
backend/analytics/app/main.py
backend/analytics/app/config.py
backend/analytics/app/auth.py
backend/analytics/app/db.py
backend/analytics/app/validation.py
backend/analytics/app/distinct_id.py
backend/analytics/app/routes/events.py
backend/analytics/app/routes/diagnostics.py
backend/analytics/tests/...
infrastucture/database/schema/25_analytics.sql25_analytics.sql
```

Implemented endpoints:

```text
GET  /ping
POST /analytics/events
GET  /analytics/dispatch/status
```

`POST /analytics/dispatch/run` initially returned a Phase 2 placeholder.

### Auth behavior

Implemented application-level `x-functions-key` auth.

Producer mapping:

```text
analytics-function-key-core       -> sourceDomain=core
analytics-function-key-jobs       -> sourceDomain=jobs
analytics-function-key-users      -> sourceDomain=users
analytics-function-key-enrichers  -> sourceDomain=enrichers
analytics-function-key-scheduler  -> dispatch/status only, no ingest
analytics-function-key-operator   -> diagnostics/manual operations
```

Validated:

- Jobs key can emit Jobs events.
- Jobs key cannot spoof Users events.
- Scheduler key cannot ingest events.
- Producer keys cannot call diagnostics/dispatch-only routes.

### Validation and privacy guardrails

Implemented v1 event allowlist:

```text
Job Creation Started
Job Duplicate Checked
Job List Viewed
Job Detail Viewed
Job Search Performed
Job Created
Job Creation Failed
Job Updated
Job Deleted
Job Status Changed
CV Updated
Compatibility Requested
Compatibility Completed
Compatibility Failed
```

Implemented forbidden-property rejection for sensitive or unwanted fields, including:

```text
email
display_name
name
telegram_account_id
telegram_username
cv_text
cv_plaintext
cv_delta
cv_length
job_title
job_name
company_name
job_description
description
summary
raw_url
url
external_id
provider_external_id
link_code
function_key
access_token
token
password
cookie
exception
stack_trace
```

Forbidden keys are checked recursively inside nested properties.

### Local Docker validation

Validated local container startup:

```text
GET /ping -> {"service":"analytics","status":"ok"}
```

Validated event ingestion:

- valid Jobs event accepted,
- duplicate `producerEventId` returned the existing event ID and `idempotent=true`,
- forbidden source/key combinations rejected,
- forbidden properties rejected,
- one `AnalyticsEvents` row inserted,
- one `AnalyticsDispatch` row inserted with `Sink='mixpanel'` and `Status='pending'`.

### Tests

Added pytest-based smoke tests with two modes:

- local mode by default,
- prod mode with explicit `--analytics-target=prod` and environment-supplied Cloud Run URL/keys.

Tests cover:

- `/ping`,
- valid ingest,
- ingest idempotency,
- dispatch/status auth,
- scheduler-key ingest rejection,
- source-domain/key mismatch,
- unknown event rejection,
- forbidden property rejection,
- nested forbidden property rejection,
- Users `CV Updated` acceptance,
- optional DB assertion that inserted event has a pending dispatch row.

Phase 1 test run passed.

---

## Phase 2A — Mixpanel dispatcher implementation and local validation

### Dispatcher implementation

Added Mixpanel export path while keeping export disabled by default.

Files added:

```text
backend/analytics/app/mixpanel_mapper.py
backend/analytics/app/mixpanel_client.py
backend/analytics/app/dispatch.py
backend/analytics/app/routes/dispatch.py
backend/analytics/tests/test_03_dispatch_endpoint.py
backend/analytics/tests/test_04_dispatch_unit.py
```

Implemented endpoint:

```text
POST /analytics/dispatch/run
```

Auth behavior:

- scheduler key can call dispatch,
- operator key can call dispatch for manual validation,
- producer keys cannot call dispatch.

### Export-disabled behavior

When:

```env
ANALYTICS_MIXPANEL_EXPORT_ENABLED=0
```

Dispatch returns without touching Mixpanel:

```json
{
  "attempted": 0,
  "sent": 0,
  "retry": 0,
  "dead": 0,
  "skipped": 0,
  "exportEnabled": false
}
```

Pending rows remain pending.

### Mixpanel mapping

Stored Analytics events are mapped to Mixpanel `/import` payloads:

```json
{
  "event": "Job Status Changed",
  "properties": {
    "time": 1780000000,
    "distinct_id": "u_...",
    "$insert_id": "Analytics EventId GUID",
    "schema_version": 1,
    "source_domain": "jobs",
    "source_surface": "web",
    "subject_type": "job",
    "subject_id": "...",
    "ip": 0,
    "job_id": "...",
    "new_status": "Applied"
  }
}
```

Important mapping rules:

- raw internal `UserId` is not exported,
- null fields are dropped,
- `ip` is set to `0`,
- `$insert_id` uses the Analytics `EventId`,
- missing `DistinctId` marks row dead before Mixpanel call.

### Retry/dead/sent behavior

Implemented delivery state transitions:

```text
2xx                     -> sent
400 validation error    -> dead
401 / 403               -> retry with longer backoff
429                     -> retry
500 / 502 / 503 / 504   -> retry
network timeout/error   -> retry
mapping error           -> dead
```

### Unit tests with monkeypatch

Added unit-style tests using pytest monkeypatch to avoid real SQL and real Mixpanel calls.

Covered:

- export disabled does not touch SQL/Mixpanel,
- Mixpanel `200` marks dispatch rows sent,
- Mixpanel `400` marks dispatch rows dead,
- Mixpanel `429` marks dispatch rows retry,
- missing `distinct_id` marks row dead without calling Mixpanel.

All local dispatcher tests passed.

### First real Mixpanel validation

Temporarily enabled local export with small batch size. Initial dispatch failed with:

```text
http_401: Not a valid service account username
```

Cause: Mixpanel username/password issue. Fixed credentials.

Retried one event:

```json
{
  "attempted": 1,
  "dead": 0,
  "exportEnabled": true,
  "retry": 0,
  "sent": 1,
  "skipped": 0
}
```

Confirmed exported event appeared in Mixpanel.

After validation, local `.env.local` was restored to:

```env
ANALYTICS_MIXPANEL_EXPORT_ENABLED=0
MIXPANEL_BATCH_SIZE=500
```

Tests passed after restore.

---

## Phase 2B — Cloud Run deployment and Cloud Scheduler

### Cloud Run deployment

Deployed Analytics service to Cloud Run:

```text
project: ehestifter-gcp
region: europe-west3
service: ehestifter-analytics
url: https://ehestifter-analytics-3oexx5jr2q-ey.a.run.app
```

Image deployed:

```text
europe-west3-docker.pkg.dev/ehestifter-gcp/ehestifter/ehestifter-analytics:phase-2b-20260702-150813
```

Runtime service account:

```text
ehestifter-analytics-runtime@ehestifter-gcp.iam.gserviceaccount.com
```

Runtime env state after deployment:

```env
ANALYTICS_COLLECTION_ENABLED=1
ANALYTICS_MIXPANEL_EXPORT_ENABLED=0
ANALYTICS_ALLOW_UNKNOWN_EVENTS=0
MIXPANEL_API_BASE_URL=https://api-eu.mixpanel.com
MIXPANEL_STRICT=1
MIXPANEL_BATCH_SIZE=500
MIXPANEL_MAX_ATTEMPTS=8
```

Runtime secrets are mapped from the `analytics-*` Secret Manager names.

Validated Cloud Run revision:

- latest created revision equals latest ready revision,
- 100% traffic to latest revision,
- dedicated runtime service account is used,
- env and secret refs are present.

### Cloud Run smoke validation

Validated:

```text
GET /ping -> ok
producer key cannot call dispatch -> 403
```

Initial SQL-touching routes failed with `internal_error`. Cloud Run logs showed Azure SQL firewall rejection:

```text
Cannot open server 'eperidbserver' requested by the login.
Client with IP address '34.96.39.23' is not allowed to access the server.
```

### Network/firewall decision

Proper best-practice fix would be static Cloud Run outbound IP using VPC egress + Cloud NAT, then allow only that IP in Azure SQL firewall.

Decision for this hobby-budget milestone:

- avoid the recurring cost/complexity of static NAT egress,
- accept broader Azure SQL firewall rules for selected Google Cloud IP ranges,
- rely on strong SQL authentication and the restricted `analytics_runtime_user`,
- document this as a budget-driven tradeoff, not best-practice networking.

Rationale:

- project monthly upkeep is already dominated by Azure SQL,
- Analytics runtime SQL user has very narrow permissions,
- existing dev access already uses broad ISP-related firewall ranges,
- exact Cloud Run default egress IP is not stable enough to maintain as a single rule.

Mitigations retained:

- `analytics_runtime_user` only has access to Analytics tables,
- no `DELETE`,
- no broad table roles,
- no use of this SQL login by other services,
- strong random SQL password,
- function keys and Mixpanel credentials remain in Secret Manager.

After firewall broadening, Cloud Run status worked:

```json
{
  "collectionEnabled": true,
  "dead": 0,
  "failedRetryable": 0,
  "lastSuccessfulDispatchAtUtc": "2026-07-02T12:47:14Z",
  "mixpanelExportEnabled": false,
  "pending": 15,
  "sentLast24h": 1
}
```

### Prod pytest validation

Ran pytest suite against Cloud Run with export disabled.

Result:

```text
16 passed
```

### Cloud Run Mixpanel export validation

Enabled export:

```env
ANALYTICS_MIXPANEL_EXPORT_ENABLED=1
```

Ran one manual dispatch:

```json
{
  "attempted": 1,
  "dead": 0,
  "exportEnabled": true,
  "retry": 0,
  "sent": 1,
  "skipped": 0
}
```

Confirmed event reached Mixpanel.

### Cloud Scheduler

Created and enabled Cloud Scheduler job:

```text
name: ehestifter-analytics-dispatch
location: europe-west3
schedule: * * * * *
time zone: Etc/UTC
method: POST
uri: https://ehestifter-analytics-3oexx5jr2q-ey.a.run.app/analytics/dispatch/run
attempt deadline: 60s
retry count: 1
```

Scheduler calls dispatch with scheduler-specific `x-functions-key`.

The scheduler key was accidentally exposed in CLI output during job describe. It was rotated immediately:

- new Secret Manager version added for `analytics-function-key-scheduler`,
- Cloud Run updated to consume latest scheduler key,
- Cloud Scheduler job header updated with the new key,
- future `gcloud scheduler jobs describe` should use a format that does not print headers.

Safe Scheduler describe command:

```bash
gcloud scheduler jobs describe ehestifter-analytics-dispatch \
  --project ehestifter-gcp \
  --location europe-west3 \
  --format='yaml(name,state,schedule,timeZone,attemptDeadline,retryConfig,httpTarget.uri,httpTarget.httpMethod,status,lastAttemptTime,scheduleTime)'
```

Final Scheduler status:

```text
state: ENABLED
status: {}
lastAttemptTime: 2026-07-02T14:42:03Z
next scheduleTime: 2026-07-02T14:43:00Z
```

Final Analytics dispatch status:

```json
{
  "collectionEnabled": true,
  "dead": 0,
  "failedRetryable": 0,
  "lastSuccessfulDispatchAtUtc": "2026-07-02T14:34:03Z",
  "mixpanelExportEnabled": true,
  "pending": 0,
  "sentLast24h": 20
}
```

Cloud Run logs looked clean.

---

## Current steady-state after Phase 2

Analytics service is deployed and active.

```text
Cloud Run service: ehestifter-analytics
URL: https://ehestifter-analytics-3oexx5jr2q-ey.a.run.app
Runtime: GCP Cloud Run, europe-west3
SQL storage: Azure SQL
Mixpanel endpoint: https://api-eu.mixpanel.com/import
Scheduler: ehestifter-analytics-dispatch, every minute
Export enabled: yes
Collection enabled: yes
```

Expected runtime behavior:

1. Producers call `POST /analytics/events` with their service-specific key.
2. Analytics validates key, source domain, event name, schema version, and properties.
3. Analytics stores canonical event in `dbo.AnalyticsEvents`.
4. Analytics creates pending Mixpanel dispatch row in `dbo.AnalyticsDispatch`.
5. Cloud Scheduler calls `POST /analytics/dispatch/run` every minute.
6. Dispatcher sends due events to Mixpanel EU `/import`.
7. Dispatch rows become `sent`, `retry`, or `dead`.

---

## Important operational notes

### Do not print Scheduler headers

Avoid plain:

```bash
gcloud scheduler jobs describe ehestifter-analytics-dispatch ...
```

because it prints HTTP headers, including `x-functions-key`.

Use the safe formatted command instead:

```bash
gcloud scheduler jobs describe ehestifter-analytics-dispatch \
  --project ehestifter-gcp \
  --location europe-west3 \
  --format='yaml(name,state,schedule,timeZone,attemptDeadline,retryConfig,httpTarget.uri,httpTarget.httpMethod,status,lastAttemptTime,scheduleTime)'
```

### Disable Mixpanel export

```bash
gcloud run services update ehestifter-analytics \
  --project ehestifter-gcp \
  --region europe-west3 \
  --update-env-vars "ANALYTICS_MIXPANEL_EXPORT_ENABLED=0"
```

This stops outbound Mixpanel calls but keeps owned event collection active.

### Disable collection

```bash
gcloud run services update ehestifter-analytics \
  --project ehestifter-gcp \
  --region europe-west3 \
  --update-env-vars "ANALYTICS_COLLECTION_ENABLED=0"
```

This stops accepting/storing new analytics events.

### Check status

```bash
ANALYTICS_URL="https://ehestifter-analytics-3oexx5jr2q-ey.a.run.app"

curl -s "$ANALYTICS_URL/analytics/dispatch/status" \
  -H "x-functions-key: $(gcloud secrets versions access latest --project ehestifter-gcp --secret analytics-function-key-operator)"
```

### Run dispatch manually

```bash
ANALYTICS_URL="https://ehestifter-analytics-3oexx5jr2q-ey.a.run.app"

curl -s -X POST "$ANALYTICS_URL/analytics/dispatch/run" \
  -H "x-functions-key: $(gcloud secrets versions access latest --project ehestifter-gcp --secret analytics-function-key-operator)"
```

### Run prod smoke tests

```bash
cd backend/analytics

ANALYTICS_TEST_TARGET=prod \
ANALYTICS_PROD_BASE_URL="https://ehestifter-analytics-3oexx5jr2q-ey.a.run.app" \
ANALYTICS_FUNCTION_KEY_JOBS="$(gcloud secrets versions access latest --project ehestifter-gcp --secret analytics-function-key-jobs)" \
ANALYTICS_FUNCTION_KEY_USERS="$(gcloud secrets versions access latest --project ehestifter-gcp --secret analytics-function-key-users)" \
ANALYTICS_FUNCTION_KEY_SCHEDULER="$(gcloud secrets versions access latest --project ehestifter-gcp --secret analytics-function-key-scheduler)" \
ANALYTICS_FUNCTION_KEY_OPERATOR="$(gcloud secrets versions access latest --project ehestifter-gcp --secret analytics-function-key-operator)" \
python -m pytest --analytics-target=prod -s
```

---

## Open follow-up items

1. Begin Phase 3: Web Core route-level events.
2. Start Phase 3 narrowly with:
   - `Job Creation Started`,
   - `Job Duplicate Checked`.
3. Do not wire every producer at once.
4. Later update `system-design.md` once the milestone stabilizes and Analytics becomes part of steady-state architecture.