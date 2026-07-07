# Milestone Design: Career-Ops Powered Multi-User Job Discovery for Ehestifter

## 1. Goal

Add automatic job discovery to Ehestifter by reusing Career-Ops[https://github.com/santifer/career-ops] discovery/scanning capabilities while preserving Ehestifter as the system of record and preserving the existing Ehestifter UX.

The target end-state is:

1. A run-to-completion discovery process periodically selects eligible Ehestifter users.
2. For each eligible user, discovery runs serially and produces candidate job postings.
3. Candidates are sanity-checked, normalized, deduplicated through Ehestifter Jobs API, and imported as shared job offerings.
4. Compatibility enrichment is requested per `(jobId, userId)`.
5. The existing “Open opportunities” UX shows relevant imported jobs once they pass existing compatibility-score filtering.
6. Users still manually choose whether to apply, ignore, or update status.
7. Career-Ops CV generation, application automation, and application tracking remain out of scope.

This milestone replaces the uncertain “find a source” phase of the vendor-agnostic import milestone, but keeps the same important boundary: Sourcer/Discovery produces normalized candidates; Ehestifter APIs own persistence, dedupe, enrichment, and UX.

---

## 2. Main design decisions

## 2.1 Career-Ops is a discovery engine, not the product backend

Use Career-Ops-derived functionality for:

* source configuration,
* portal scanning,
* provider-specific fetching,
* title/location/content filtering,
* optional liveness verification,
* candidate discovery.

Do not use Career-Ops for:

* CV generation,
* CV tailoring,
* PDF generation,
* application submission,
* email generation,
* application tracking as source of truth,
* replacing Ehestifter status or compatibility flows.

Ehestifter remains responsible for:

* job storage,
* canonical identity,
* duplicate handling,
* user-specific status,
* compatibility scoring,
* presentation in Open opportunities.

## 2.2 Multi-user by default, serial execution initially

The design should not bake in single-user assumptions.

Base behavior:

1. Discovery asks Users domain for discovery-eligible users.
2. Users domain returns users with usable CVs, excluding configured test users.
3. Discovery processes one user at a time.
4. For each user, discovery imports shared jobs and requests compatibility for that user.
5. No parallel user execution in the base milestone.

Reason:

* simple logs,
* easy debugging,
* fewer duplicate races,
* low blast radius,
* compatible with Cloud Run Job / local Docker run-to-completion execution.

Parallelism can be added later once idempotency and cost are understood.

## 2.3 Jobs are global; compatibility is per user

A discovered job should be created once as a shared `JobOffering`.

For each eligible user:

* duplicate job creation should resolve to the existing shared job,
* compatibility should still be requested for that user if needed,
* user status must not be set automatically,
* imported jobs must not accidentally become `Applied`.

This preserves the existing Ehestifter model where the stored job is shared, while status and compatibility are user-specific.

## 2.4 Wrapper vs fork is undecided until a spike

Do not commit immediately to a wrapper, fork, or vendored extraction.

Run an explicit approach-validation spike first.

Candidate approaches:

### Option A — Pure wrapper

```text
career-ops upstream checkout
  -> run scan.mjs
  -> parse data/pipeline.md + data/scan-history.tsv
  -> normalize to Ehestifter batch JSON
```

Pros:

* easiest to keep Career-Ops updated,
* minimal changes to upstream code,
* fastest first experiment.

Cons:

* markdown/TSV parsing may be brittle,
* output may omit fields useful to Ehestifter,
* hard to access provider-native metadata.

### Option B — Thin upstream-compatible patch

```text
career-ops scan.mjs --json-output /data/ehestifter-candidates.json
  -> normalize to Ehestifter batch JSON
```

Pros:

* still close to upstream,
* cleaner output,
* easier validation,
* likely best medium-term shape if patch is small.

Cons:

* requires maintaining a small patch,
* upstream changes may occasionally break it.

### Option C — Vendor/extract provider layer

```text
workers/discovery/providers/*
  -> Ehestifter-owned scanner runner
  -> Ehestifter batch JSON
```

Pros:

* full control over output contract,
* easier API integration,
* no markdown/TSV translation.

Cons:

* more maintenance,
* loses easy upstream updates,
* higher initial cost.

Initial preference:

* Try Option A only as a smoke test.
* Prefer Option B if `scan.mjs` can expose useful JSON with a small patch.
* Use Option C only if upstream output is too weak or unstable.

---

## 3. Scope

## 3.1 In scope

* local Docker-based discovery runner,
* Career-Ops scan spike,
* source configuration for a small controlled source list,
* approach-validation spike for wrapper vs patch vs extraction,
* Users internal endpoint for discovery eligibility,
* per-user run orchestration,
* per-user discovery state/checkpoints,
* candidate normalization,
* duplicate check using Jobs API,
* job creation using Jobs API,
* compatibility request per imported/existing candidate and user,
* dry-run mode,
* import summary,
* basic quarantine/reject handling,
* later Cloud Run Job deployment if local run is stable.

## 3.2 Out of scope

* Career-Ops CV generation,
* Career-Ops automatic application flow,
* application submission,
* browser automation that logs into third-party sites,
* direct SQL writes to Jobs, Users, or Enrichment tables,
* direct writes to compatibility projection tables,
* fuzzy duplicate matching beyond canonical identity,
* per-user discovery preference UI,
* large-scale parallel scraping,
* production crawler framework,
* source-specific provenance UI,
* Synapse / Parquet archival.

---

## 4. Existing constraints to preserve

Ehestifter’s existing vendor-agnostic import milestone already established the right ownership boundaries: Sourcers find and normalize jobs, Importer validates and calls Jobs APIs, Jobs owns final create/dedupe/persistence/UX visibility, and Enrichment Core owns enrichment booking and projection dispatch.

Preserve these rules:

* do not bypass Jobs API,
* do not bypass Users API for user/CV facts,
* do not bypass Enrichment Core for compatibility,
* do not write compatibility scores directly,
* do not create user statuses automatically,
* do not treat provider identity as optional.

---

## 5. New or changed components

## 5.1 Discovery runner

Suggested repo path:

```text
workers/discovery
```

Responsibilities:

1. Load runner config.
2. Acquire a global run lock.
3. Ask Users domain for discovery-eligible users.
4. For each eligible user:

   * load or initialize per-user discovery state,
   * optionally refresh Career-Ops profile/workspace if CV changed,
   * run Career-Ops scan or adapter,
   * normalize candidates,
   * reject low-quality candidates,
   * call Jobs `/jobs/exists`,
   * call Jobs `POST /jobs` for missing jobs,
   * request compatibility for this user,
   * update per-user checkpoint.
5. Write run summary.
6. Exit.

Non-responsibilities:

* no direct SQL,
* no direct Blob CV reads unless explicitly approved,
* no direct compatibility projection writes,
* no user-facing web server in base milestone.

## 5.2 Users discovery eligibility endpoint

Add an internal Users-domain endpoint:

```text
GET /users/internal/discovery-eligible
```

Auth:

```text
x-functions-key
```

Base response shape:

```json
{
  "schemaVersion": 1,
  "users": [
    {
      "userId": "GUID",
      "cvVersionId": "GUID",
      "cvLastUpdatedUtc": "2026-07-07T10:00:00Z",
      "hasCvPlainText": true,
      "discoveryEnabled": true,
      "excludedReason": null
    }
  ]
}
```

Base eligibility rule:

```text
eligible = has usable plaintext CV AND user is not in configured test-user exclusion list
```

Implementation note:

* For base milestone, prefer an environment/config exclusion list over adding a full user-preferences UI.
* Later, add explicit `DiscoveryEnabled` user preference if needed.

## 5.3 Existing Users CV snapshot endpoint

Discovery should not receive CV text by default unless the approach-validation spike proves it is actually needed.

The existing CV snapshot endpoint already returns plaintext CV for enrichment use. If discovery needs CV text for per-user Career-Ops profile initialization, use the existing Users-owned contract rather than reading blob storage directly.

Preferred base behavior:

* use `cvVersionId` and `cvLastUpdatedUtc` for eligibility and checkpointing,
* use manually configured title/location filters for scanning,
* let Enrichment Core consume CV text during compatibility as it already does.

Optional later behavior:

* generate per-user discovery search profile from CV plaintext,
* store only derived, non-sensitive search filters in discovery state.

## 5.4 Jobs API usage

For each normalized candidate:

1. Check duplicate:

```text
HEAD /jobs/exists?provider=...&providerTenant=...&externalId=...
```

or:

```text
GET /jobs/exists?provider=...&providerTenant=...&externalId=...
```

2. If missing, create through:

```text
POST /jobs
```

Headers:

```text
x-functions-key: <jobs-key>
X-Actor-Type: system
```

Payload shape should match current Jobs validation, especially locations:

```json
{
  "url": "https://origin-job-link",
  "applyUrl": "https://origin-job-link",
  "foundOn": "career-ops",
  "provider": "workday",
  "providerTenant": "contoso",
  "externalId": "12345",
  "hiringCompanyName": "Contoso GmbH",
  "postingCompanyName": null,
  "title": "Senior Project Manager",
  "remoteType": "Hybrid",
  "description": "...",
  "locations": [
    {
      "countryName": "Germany",
      "countryCode": "DE",
      "cityName": "Munich",
      "region": "Bavaria"
    }
  ]
}
```

Important correction from the previous vendor-agnostic milestone:

* use `countryName`, `countryCode`, `cityName`, and `region`,
* not `country`, `city`, and `displayText`.

The current Jobs create path validates payload, deduces provider identity from URL when possible, requires `externalId` and `hiringCompanyName`, and treats duplicate provider identity as an existing job lookup rather than creating another row.

## 5.5 Enrichment API usage

For every candidate that should be visible to a user, request compatibility for:

```text
(jobId, userId)
```

Use an existing Enrichment Core request endpoint if available.

If no clean internal/system endpoint exists, add one:

```text
POST /enrichers/internal/compatibility:request
```

Auth:

```text
x-functions-key
```

Payload:

```json
{
  "jobOfferingId": "GUID",
  "userId": "GUID",
  "source": "discovery",
  "reason": "new_candidate"
}
```

Rules:

* Enrichment Core still fetches Jobs and Users snapshots.
* Gateway still dispatches work.
* Compatibility worker still computes score.
* Jobs still stores projection.
* Discovery runner does not write score or summary.

## 5.6 Discovery state storage

Base local mode:

```text
/data/state/users/<userId>.json
/data/runs/<runId>/summary.json
/data/runs/<runId>/candidates.json
```

Cloud Run Job mode needs durable state because the container filesystem is ephemeral.

Preferred Cloud Run Job state backend:

```text
Azure Blob Storage
```

Suggested paths:

```text
/discovery/state/global-lock.json
/discovery/state/users/<userId>.json
/discovery/runs/YYYY/MM/DD/<runId>/summary.json
/discovery/runs/YYYY/MM/DD/<runId>/candidates.json
/discovery/runs/YYYY/MM/DD/<runId>/rejected.json
```

Reason:

* cheap,
* already aligned with Ehestifter storage choices,
* no new SQL migration for discovery state,
* works from local Docker and GCP Cloud Run Job.

Avoid direct Azure SQL state in the base milestone.

---

## 6. Per-user checkpoint model

Each user checkpoint should include:

```json
{
  "schemaVersion": 1,
  "userId": "GUID",
  "lastSuccessfulRunAtUtc": "2026-07-07T10:00:00Z",
  "lastCvVersionId": "GUID",
  "lastCvLastUpdatedUtc": "2026-07-07T09:00:00Z",
  "lastDiscoveryConfigHash": "sha256",
  "lastCareerOpsUpstreamRef": "git-sha-or-version",
  "lastRunId": "2026-07-07T10-00-00Z",
  "lastOutcome": {
    "rawFound": 42,
    "validCandidates": 18,
    "created": 6,
    "existing": 9,
    "compatibilityRequested": 15,
    "rejected": 3
  }
}
```

CV-change behavior:

```text
if user is new:
  initialize user discovery workspace/profile
  run discovery

if cvVersionId changed since checkpoint:
  refresh user discovery workspace/profile if profile generation is implemented
  run discovery
  request compatibility for imported/existing candidates encountered in this run

if cvVersionId unchanged:
  run normal incremental discovery
```

Important nuance:

* CV change should not bypass Jobs dedupe.
* CV change should not create duplicate jobs.
* CV change may justify requesting compatibility again for candidates encountered in the run.
* A broader “refresh compatibility for all open jobs after CV change” is useful but can be a separate milestone unless trivial.

---

## 7. Career-Ops data-quality spike

## 7.1 Purpose

Validate whether Career-Ops scanner output contains enough data for meaningful Ehestifter imports before committing to wrapper, patch, or extraction.

This spike must happen before building the full importer/orchestrator.

## 7.2 Tasks

1. Pin a specific Career-Ops upstream commit.
2. Create a tiny `portals.yml` with 5-10 sources.
3. Use source types likely to produce structured data:

   * Greenhouse,
   * Lever,
   * Ashby,
   * Workday if supported,
   * one corporate/static parser if easy.
4. Run:

```bash
node scan.mjs --dry-run
node scan.mjs --verify
```

5. Inspect native outputs:

   * `data/pipeline.md`,
   * `data/scan-history.tsv`,
   * provider-return objects, if accessible.
6. Add a temporary logging/export patch if needed to inspect raw provider fields.
7. For each provider/source, record whether it returns:

   * stable origin URL,
   * title,
   * company,
   * location,
   * description,
   * salary,
   * source/provider identifier,
   * any external job ID.
8. Check whether canonical identity can be derived for each candidate.
9. Check whether a job detail fetch is needed to obtain description.
10. Decide Option A, B, or C.

## 7.3 Acceptance criteria

The spike is successful if:

* at least one source/provider produces stable origin URLs,
* at least one source/provider produces enough fields for Ehestifter create,
* canonical identity can be derived without random IDs or title hashes,
* description availability is understood,
* there is a documented recommendation: wrapper, JSON patch, or provider extraction.

The spike fails usefully if:

* Career-Ops finds jobs but does not expose enough structured data,
* descriptions are too often missing for compatibility,
* provider identity cannot be mapped reliably,
* output parsing is too brittle.

Failure outcome is acceptable; it means do not overbuild on the wrong integration point.

---

## 8. Normalized candidate schema

Discovery runner should produce an intermediate batch file before API calls.

```json
{
  "schemaVersion": 2,
  "source": "career-ops",
  "sourceRunId": "2026-07-07T10-00-00Z",
  "userId": "GUID",
  "cvVersionId": "GUID",
  "generatedAtUtc": "2026-07-07T10:05:00Z",
  "jobs": []
}
```

Candidate item:

```json
{
  "url": "https://origin-job-link",
  "applyUrl": "https://origin-job-link",
  "foundOn": "career-ops",
  "provider": "greenhouse",
  "providerTenant": "example-company",
  "externalId": "123456",
  "title": "Senior Product Manager",
  "hiringCompanyName": "Example Company",
  "postingCompanyName": null,
  "remoteType": "Hybrid",
  "description": "Full job description if available",
  "locations": [
    {
      "countryName": "Germany",
      "countryCode": "DE",
      "cityName": "Berlin",
      "region": null
    }
  ],
  "sourceMeta": {
    "careerOpsSource": "greenhouse",
    "careerOpsCompany": "Example Company",
    "rawLocation": "Berlin, Germany",
    "verifiedLive": true,
    "descriptionSource": "provider-list-api",
    "fetchedAtUtc": "2026-07-07T10:03:00Z"
  }
}
```

Required before calling Jobs API:

* `url`
* `provider`
* `providerTenant`, empty string allowed
* `externalId`
* `title`
* `hiringCompanyName`

Strongly preferred before requesting compatibility:

* `description`

Candidate handling:

```text
missing identity -> reject
missing company -> reject
missing title -> reject
missing description -> import allowed, compatibility optional based on config
unsupported location shape -> import without locations or reject, depending config
```

Base default:

```text
import missing-description jobs: yes
request compatibility for missing-description jobs: no, unless description can be fetched
```

Reason:

* URL/title/company jobs are still useful in Open opportunities if compatibility can later be computed.
* Compatibility from empty descriptions is likely poor.

---

## 9. Sanity check and dedupe flow

For every candidate row:

```text
validate normalized schema
derive canonical identity
call /jobs/exists
if exists:
  record existing jobId
  maybe request compatibility for this user
if missing:
  POST /jobs
  record returned jobId
  request compatibility for this user
if Jobs API returns duplicate during create:
  treat as existing success
if Jobs API returns 400:
  reject row with reason
if Jobs API times out or 5xx:
  transient failure
```

The explicit `/jobs/exists` call is still useful even though `POST /jobs` is idempotent because:

* it reduces unnecessary writes/history noise,
* it lets discovery summarize duplicates clearly,
* it prevents low-quality rows from reaching create,
* it supports preflight validation before import.

Final create must still be idempotent because a duplicate can appear between check and create.

---

## 10. Open opportunities behavior

Assumption confirmed:

* Open opportunities can show jobs not sourced by the current user.
* Visibility is constrained by compatibility score to avoid flooding the user.

Milestone implication:

* Import alone is not enough.
* For each eligible user, discovery must request compatibility for imported/existing candidate jobs.
* A newly imported job may not appear immediately until compatibility completes.
* If compatibility score is below the existing threshold, the job should remain hidden or low-priority according to current UI behavior.

Discovery runner should not implement UI filtering itself.

---

## 11. Runtime infrastructure

## 11.1 Phase 1: local Docker

Start locally.

Reasons:

* easier to debug Career-Ops scanner behavior,
* easier to inspect Playwright/liveness behavior,
* no unexpected Cloud Run cost,
* no cloud scheduling complexity,
* source config will change frequently.

Container shape:

```text
workers/discovery image
  Node.js runtime
  Career-Ops upstream checkout or vendored folder
  Ehestifter adapter code
  portals.yml
  /data mounted writable
  Jobs API key
  Users API key
  Enrichers API key if compatibility request is enabled
```

No Azure SQL credentials, no GitHub token, no Docker socket.

## 11.2 Phase 2: GCP Cloud Run Job

Move to Cloud Run Job after local runs are stable.

Reason:

* discovery is run-to-completion batch work,
* Cloud Run Jobs run container tasks and exit rather than serving requests,
* they can be executed manually, scheduled, or used in workflows.

Suggested execution model:

```text
Cloud Scheduler
  -> Cloud Run Job
  -> Users API
  -> Career-Ops scan per user
  -> Jobs API
  -> Enrichment Core API
  -> Azure Blob state
  -> exit
```

Cloud Scheduler can execute Cloud Run Jobs on a schedule.

Base Cloud Run settings:

```text
region: europe-west3
task count: 1
parallelism: 1
max retries: low, e.g. 0-1 initially
timeout: 30-60 minutes
schedule: once daily initially
```

Secrets:

```text
GCP Secret Manager:
  EHESTIFTER_USERS_FUNCTION_KEY
  EHESTIFTER_JOBS_FUNCTION_KEY
  EHESTIFTER_ENRICHERS_FUNCTION_KEY
  DISCOVERY_AZURE_STORAGE_CONNECTION_STRING or SAS
```

---

## 12. Configuration

Example runner config:

```json
{
  "ehestifter": {
    "usersBaseUrl": "https://ehestifter-users.azurewebsites.net/api",
    "jobsBaseUrl": "https://ehestifter-jobs.azurewebsites.net/api",
    "enrichersBaseUrl": "https://ehestifter-enrichers.azurewebsites.net/api"
  },
  "discovery": {
    "excludedUserIds": ["TEST-USER-GUID"],
    "processUsersSequentially": true,
    "maxUsersPerRun": 5,
    "maxCandidatesPerUser": 50,
    "maxCreatesPerUser": 20,
    "requestCompatibility": true,
    "requestCompatibilityForExistingCandidates": true,
    "requestCompatibilityWithoutDescription": false
  },
  "careerOps": {
    "upstreamRef": "pinned-git-sha",
    "portalsTemplatePath": "/config/portals.yml",
    "verifyLiveUrls": true,
    "throttleVerify": true,
    "headedFallback": false
  },
  "state": {
    "backend": "local-file-or-azure-blob",
    "basePath": "/data/discovery"
  }
}
```

---

## 13. Observability

Each run writes a summary:

```json
{
  "runId": "2026-07-07T10-00-00Z",
  "startedAtUtc": "2026-07-07T10:00:00Z",
  "finishedAtUtc": "2026-07-07T10:30:00Z",
  "eligibleUsers": 2,
  "processedUsers": 2,
  "users": [
    {
      "userId": "GUID",
      "cvVersionChanged": true,
      "rawFound": 42,
      "normalized": 24,
      "rejected": 8,
      "existing": 10,
      "created": 6,
      "compatibilityRequested": 16,
      "compatibilitySkipped": 0
    }
  ],
  "global": {
    "rawFound": 42,
    "normalized": 24,
    "created": 6,
    "existing": 10,
    "rejected": 8,
    "transientFailures": 0
  }
}
```

Reject reasons:

```text
missing_url
missing_title
missing_company
missing_provider
missing_external_id
unsupported_provider
bad_location_shape
missing_description
jobs_exists_400
jobs_create_400
jobs_api_timeout
enrichment_request_failed
source_blocked_or_antibot
```

Never log:

* function keys,
* CV plaintext,
* raw auth tokens,
* cookies,
* raw browser session data,
* compatibility summaries.

---

## 14. Safety and legal posture

Sane defaults:

* use public ATS APIs and public company career pages first,
* avoid authenticated scraping,
* keep per-source enable flags,
* use low scan frequency,
* use liveness verification with throttling,
* disable noisy or blocked sources,
* do not try to bypass anti-bot systems aggressively.

Career-Ops supports verification with Playwright and throttled verification flags; use these conservatively.

---

## 15. Phase plan

## Phase 0 — Career-Ops approach-validation spike

Goal:

Decide wrapper vs JSON patch vs provider extraction.

Tasks:

1. Pin Career-Ops upstream.
2. Create tiny source config.
3. Run scanner locally.
4. Inspect available fields.
5. Check whether meaningful Ehestifter create payloads can be produced.
6. Check whether description is available often enough.
7. Check whether canonical identity can be derived.
8. Produce a short decision note.

Acceptance criteria:

* chosen integration approach is documented,
* at least 10 valid candidate rows can be normalized,
* limitations are clear before API integration begins.

## Phase 1 — Discovery runner skeleton

Goal:

Create `workers/discovery` with local Docker execution and dry-run output.

Tasks:

1. Add Dockerfile / compose entry.
2. Add config loader.
3. Add Career-Ops invocation wrapper.
4. Add normalized JSON writer.
5. Add validation and rejection reasons.
6. Add fixture tests for supported providers.

Acceptance criteria:

* `discovery-runner scan --dry-run` produces normalized candidates,
* no Ehestifter APIs are called,
* invalid rows are rejected cleanly.

## Phase 2 — Users eligibility endpoint

Goal:

Let discovery find users without hardcoding one active user.

Tasks:

1. Add `GET /users/internal/discovery-eligible`.
2. Return user ID, CV version ID, CV last updated timestamp, and eligibility flags.
3. Exclude configured test users.
4. Do not return CV plaintext in this endpoint.
5. Add minimal diagnostics.

Acceptance criteria:

* endpoint returns all eligible users,
* users without CV are excluded,
* test user is excluded,
* no CV plaintext is leaked through eligibility endpoint.

## Phase 3 — Jobs import integration

Goal:

Create missing shared jobs through Jobs API.

Tasks:

1. Add Jobs client.
2. Implement `/jobs/exists` preflight.
3. Implement `POST /jobs`.
4. Use system actor headers.
5. Treat duplicate-on-create as success.
6. Preserve idempotency.
7. Write run summary.

Acceptance criteria:

* new jobs are created,
* existing jobs are recognized,
* replay does not duplicate jobs,
* no status is set,
* jobs appear as shared opportunities after compatibility allows them.

## Phase 4 — Compatibility request integration

Goal:

Request per-user compatibility for candidates.

Tasks:

1. Inspect existing Enrichment Core request API.
2. Reuse existing endpoint or add a narrow internal/system endpoint.
3. Request compatibility for new jobs.
4. Request compatibility for existing candidate jobs when configured.
5. Do not block import success on compatibility failure.
6. Confirm scores appear through existing Jobs projection UX.

Acceptance criteria:

* compatibility is requested for `(jobId, userId)`,
* Enrichment Core owns lifecycle,
* worker owns scoring,
* Jobs owns projection,
* user sees compatible jobs through Open opportunities.

## Phase 5 — Per-user checkpointing

Goal:

Make repeated runs stable and CV-aware.

Tasks:

1. Store per-user checkpoint.
2. Detect new users.
3. Detect CV version changes.
4. Record last successful run.
5. Record source config hash.
6. Add global run lock.

Acceptance criteria:

* new users are initialized,
* CV changes are detected,
* repeated runs are understandable,
* overlapping runs are prevented or safely skipped.

## Phase 6 — Cloud Run Job deployment

Goal:

Run discovery periodically without local machine dependency.

Tasks:

1. Build Cloud Run Job image.
2. Push to Artifact Registry.
3. Configure secrets in GCP Secret Manager.
4. Configure Azure Blob state backend.
5. Configure Cloud Scheduler trigger.
6. Run manually first.
7. Enable conservative schedule.

Acceptance criteria:

* job runs to completion,
* logs show summary,
* state persists across runs,
* no secrets are logged,
* no always-on instance is needed.

## Phase 7 — Source growth

Goal:

Expand discovery sources only after end-to-end stability.

Tasks:

1. Add more providers/sources gradually.
2. Track rejection rate by source.
3. Disable noisy sources.
4. Add provider-specific identity mappers where needed.
5. Add detail fetchers where descriptions are missing but source is valuable.

Acceptance criteria:

* second source does not require importer redesign,
* source quality is observable,
* false positives stay manageable,
* cost stays low.

---

## 16. Acceptance criteria for the whole milestone

Milestone is complete when:

1. Career-Ops-derived discovery runs locally in Docker.
2. Wrapper vs patch vs extraction decision is documented.
3. Discovery eligibility is user-based, not hardcoded to one user.
4. Users with CVs are discovered, test users are excluded.
5. Candidate jobs are normalized into Ehestifter-compatible payloads.
6. Candidates are checked through `/jobs/exists` before create.
7. Missing jobs are created through `POST /jobs`.
8. Replays are safe.
9. No automatic `Applied` status is created.
10. Compatibility is requested per `(jobId, userId)`.
11. Compatible imported jobs appear in Open opportunities using existing UX behavior.
12. CV generation and automatic applications remain unused.
13. Cloud Run Job deployment is either working or explicitly deferred with a documented local Docker runbook.

---

## 17. Recommended next coding-agent task

Implement Phase 0 only:

```text
Create a local Career-Ops approach-validation spike for Ehestifter discovery. Pin Career-Ops upstream, run a tiny source config, inspect raw scanner outputs, and produce docs/discovery/career-ops-spike.md with a decision between pure wrapper, JSON-output patch, and provider extraction. Do not call Ehestifter APIs yet.
```

The spike should answer:

1. Does Career-Ops output include enough data for `POST /jobs`?
2. How often is description present?
3. Can provider identity be derived reliably?
4. Is parsing `pipeline.md` acceptable, or do we need JSON export?
5. Which providers should be supported first?
