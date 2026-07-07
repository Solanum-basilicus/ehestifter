# Project Journal: Owned Analytics Event Log with Mixpanel Export — Phases 3–6

## Summary

Phases 3 through 6 connected real Ehestifter product actions to the owned Analytics pipeline established in Phases 0 through 2.

The resulting live event flow is:

```text
Web Core / Jobs / Users / Enrichment Core
  -> Analytics Cloud Run service
  -> Azure SQL owned analytics event log
  -> Mixpanel EU /import export through scheduled dispatcher
```

The implementation remains server-side only:

- Browser JavaScript does not call Analytics directly.
- Browser JavaScript does not receive Mixpanel tokens or service account credentials.
- Mixpanel remains an export sink, not the source of truth.
- Analytics ingestion is best-effort and should not block normal product success.
- Producer services can disable event emission with `ANALYTICS_COLLECTION_ENABLED=0`.
- Mixpanel export can be disabled centrally without stopping owned SQL collection.

---

## Phase 3 — Web Core route-level events

### Implemented

Added a small Web Core analytics helper:

```text
backend/core/helpers/analytics.py
```

The helper emits server-side Analytics events to:

```text
POST /analytics/events
```

using the Core-specific Analytics function key.

Implemented Web Core events:

```text
Job Creation Started
Job Duplicate Checked
Job List Viewed
Job Detail Viewed
Job Search Performed
```

### Behavior

The Web Core helper:

- uses `sourceDomain=core`,
- uses `sourceSurface=web`,
- uses short timeout from `ANALYTICS_EMIT_TIMEOUT_SECONDS`,
- logs Analytics failures as warnings,
- does not let Analytics failures abort product route handling,
- does not expose Analytics or Mixpanel credentials to browser code.

`Job Creation Started`, `Job Duplicate Checked`, and final job creation share a create-flow correlation ID where practical.

### Privacy behavior

`Job Duplicate Checked` deliberately does not send:

```text
raw URL
external ID
job title/name
company name
description
```

It sends only safe duplicate-check properties such as:

```text
duplicate_found
provider
provider_tenant
identity_inferred
```

`Job Search Performed` sends only safe behavioral metadata such as:

```text
category
has_search_term
```

It does not send the raw search term.

### Validation

Observed in Mixpanel:

```text
Job Creation Started
Job Duplicate Checked
Job List Viewed
Job Detail Viewed
Job Search Performed
```

The observed Core events used a stable pseudonymous `distinct_id` and did not contain forbidden PII/free-text fields.

---

## Phase 4 — Jobs domain web events

### Implemented

Added a Jobs-domain analytics helper:

```text
backend/jobs/helpers/analytics.py
```

The helper emits server-side Analytics events using the Jobs-specific Analytics function key.

Web Core now marks Jobs calls with:

```text
X-Source-Surface: web
```

This lets Jobs emit only web-originated v1 analytics events and skip Telegram/bot/system-originated calls.

Implemented Jobs events:

```text
Job Created
Job Creation Failed
Job Updated
Job Deleted
Job Status Changed
```

### Behavior

The Jobs helper:

- uses `sourceDomain=jobs`,
- uses `sourceSurface=web`,
- emits only when the request is marked as web-originated,
- uses a short timeout,
- performs no retry,
- logs Analytics failures without failing product actions.

`Job Created` is emitted after successful create commit.

Safe properties include:

```text
job_id
creation_source
dedupe_result
provider
provider_tenant
```

`Job Creation Failed` is emitted for failed create attempts that reach Jobs. It sends a safe enum-like `failure_kind`, not raw exception text or validation body.

`Job Updated` is emitted after successful update commit.

Safe properties include:

```text
job_id
provider
provider_tenant
work_mode
```

`Job Deleted` is emitted after successful logical delete commit.

Safe properties include:

```text
job_id
```

`Job Status Changed` is emitted after successful status write commit.

Safe properties include:

```text
job_id
new_status
is_final_status
```

`new_status` uses the existing canonical Jobs status labels, and `is_final_status` uses the existing Jobs final-status constants.

### Privacy behavior

Jobs events deliberately do not send:

```text
job title/name
company name
job description
raw URL
external ID
email
name
raw exception text
```

### Validation

Observed in Mixpanel:

```text
Job Created
Job Updated
Job Deleted
Job Status Changed
```

Example validated status event properties included:

```text
job_id
new_status
is_final_status
source_domain=jobs
source_surface=web
subject_type=job
```

`Job Creation Failed` was implemented but not manually forced during validation. It should be covered in a later validation pass or when a safe failure case is convenient.

---

## Phase 5 — Users and Enrichment events

## Users

### Implemented

Added a Users-domain analytics helper:

```text
backend/users/helpers/analytics.py
```

Web Core now marks Users calls with:

```text
X-Source-Surface: web
```

Implemented Users event:

```text
CV Updated
```

`CV Updated` is emitted after successful preferences/CV update commit.

Safe properties include:

```text
cv_version_id
```

The event uses:

```text
sourceDomain=users
sourceSurface=web
subjectType=cv
subjectId=<cv_version_id>
```

### Privacy behavior

`CV Updated` deliberately does not send:

```text
CV plaintext
CV Quill Delta
CV length
CV blob path
CV text blob path
email
name
Telegram account ID
```

### Validation

Observed in Mixpanel:

```text
CV Updated
```

The observed event included only `cv_version_id` as the CV-specific property.

---

## Enrichment Core

### Implemented

Added an Enrichment Core analytics helper:

```text
backend/enrichers/helpers/analytics.py
```

Web Core now marks Enrichment Core requests with:

```text
X-Source-Surface: web
```

Implemented Enrichment events:

```text
Compatibility Requested
Compatibility Completed
Compatibility Failed
```

### Behavior

`Compatibility Requested` is emitted after an enrichment run is created.

Safe properties include:

```text
job_id
run_id
enricher_type
```

It uses:

```text
sourceDomain=enrichers
sourceSurface=web
subjectType=enrichment_run
```

`Compatibility Completed` is emitted after worker/Gateway completion transitions a run to a successful terminal state.

Safe properties include:

```text
job_id
run_id
enricher_type
score
```

It uses:

```text
sourceDomain=enrichers
sourceSurface=worker
subjectType=enrichment_run
```

`Compatibility Failed` is emitted after worker/Gateway completion transitions a run to a failed terminal state.

Safe properties include:

```text
job_id
run_id
enricher_type
failure_stage
```

`failure_stage` is derived from a safe enum-like error code. Raw error message text is not sent.

The completion route emits only for actual new terminal completion outcomes. Stale or already-terminal completion callbacks do not emit another event.

### Privacy behavior

Enrichment events deliberately do not send:

```text
worker prompt
CV text
job description
job title/name
company name
compatibility summary
raw error message
exception text
```

### Validation

Observed in Mixpanel:

```text
Compatibility Requested
Compatibility Completed
```

`Compatibility Failed` was implemented but not manually forced during validation. It should be covered in a later validation pass when a safe failure case is convenient.

A GUID casing mismatch was observed between `Compatibility Requested` and `Compatibility Completed`; `get_run_analytics_context` was adjusted to normalize GUID fields through `_clean_uuid`, so future completion/failure events should use the same lowercase GUID style as request events.

---

## Phase 6 — Validation and handoff

### Observed event coverage

Observed in Mixpanel:

```text
Job Creation Started
Job Duplicate Checked
Job List Viewed
Job Detail Viewed
Job Search Performed
Job Created
Job Updated
Job Deleted
Job Status Changed
CV Updated
Compatibility Requested
Compatibility Completed
```

Implemented but not manually forced:

```text
Job Creation Failed
Compatibility Failed
```

### Identity validation

Observed events for the same logged-in user shared a stable pseudonymous Mixpanel `distinct_id`.

Other recent `distinct_id` values were expected and likely came from the analytics test suite or manual producer tests.

### Privacy validation

Observed Mixpanel event JSON did not contain forbidden PII/free-text fields such as:

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

### Analytics dispatch validation

Final dispatch status after validation:

```json
{
  "collectionEnabled": true,
  "dead": 0,
  "failedRetryable": 0,
  "lastSuccessfulDispatchAtUtc": "2026-07-06T15:29:02Z",
  "mixpanelExportEnabled": true,
  "pending": 0,
  "sentLast24h": 71
}
```

This indicates:

- collection is enabled,
- Mixpanel export is enabled,
- no pending dispatch rows remain,
- no retryable failures are present,
- no dead dispatch rows are present,
- events are actively being dispatched.

### Cloud Scheduler validation

Safe Scheduler describe output showed:

```text
name: projects/ehestifter-gcp/locations/europe-west3/jobs/ehestifter-analytics-dispatch
schedule: * * * * *
timeZone: Etc/UTC
state: ENABLED
status: {}
lastAttemptTime: 2026-07-06T15:41:01.438556Z
scheduleTime: 2026-07-06T15:42:00.647708Z
retryConfig:
  retryCount: 1
  minBackoffDuration: 30s
  maxBackoffDuration: 300s
  maxDoublings: 5
  maxRetryDuration: 0s
```

This confirms the Scheduler job is enabled and invoking the dispatch endpoint.

### Runtime behavior

Analytics remains best-effort from producers:

- product actions should continue if Analytics is disabled or temporarily unavailable,
- producer helpers use short timeouts,
- producer helpers log warnings without failing the product route,
- Mixpanel export is handled asynchronously by the Analytics dispatch outbox.

Validation was completed with collection and export re-enabled.

---

## Operational notes

### Disable Mixpanel export only

```bash
gcloud run services update ehestifter-analytics \
  --project ehestifter-gcp \
  --region europe-west3 \
  --update-env-vars "ANALYTICS_MIXPANEL_EXPORT_ENABLED=0"
```

This stops outbound Mixpanel export but keeps owned Analytics SQL collection active.

### Disable central Analytics collection

```bash
gcloud run services update ehestifter-analytics \
  --project ehestifter-gcp \
  --region europe-west3 \
  --update-env-vars "ANALYTICS_COLLECTION_ENABLED=0"
```

This stops accepting/storing new analytics events centrally.

### Disable producer emission

Each producer also has its own `ANALYTICS_COLLECTION_ENABLED` setting. It can be set to `0` on:

```text
Azure WebApp: ehestifter
Azure Function App: ehestifter-jobs
Azure Function App: ehestifter-users
Azure Function App: ehestifter-enrichers
```

to stop that service from attempting Analytics calls.

### Safe Scheduler inspection

Do not run an unformatted `gcloud scheduler jobs describe`, because it may print HTTP headers including `x-functions-key`.

Use:

```bash
gcloud scheduler jobs describe ehestifter-analytics-dispatch \
  --project ehestifter-gcp \
  --location europe-west3 \
  --format='yaml(name,state,schedule,timeZone,attemptDeadline,retryConfig,httpTarget.uri,httpTarget.httpMethod,status,lastAttemptTime,scheduleTime)'
```

---

## Current status

The Owned Analytics Event Log with Mixpanel Export milestone is functionally complete.

Known caveats:

1. `Job Creation Failed` was implemented but not manually forced.
2. `Compatibility Failed` was implemented but not manually forced.

Next documentation step:

- merge the stabilized Analytics architecture into `system-design.md`,
- then retire or archive the temporary milestone document once the master design is updated.