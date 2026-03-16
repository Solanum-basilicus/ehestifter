
# Enrichment System Design (v3)

This document describes the architecture, responsibilities, data model, and flows
for the **Enrichment Core + Worker Gateway + Local GPT Worker** system.

It is intended as a long‑term reference during implementation and iteration.

---

## 1. Goals

### Functional
- Compute enrichment results (starting with compatibility score) for `(userId, jobId)`
- Track run lifecycle, status, and history
- Show latest result by default, history on demand
- Allow manual re-run from UI
- Allow safe rescheduling of runs if Service Bus is temporarily unavailable
- After a run reaches terminal state, trigger enricher-specific postprocessing owned by Enrichment Core
- Publish derived projections to other domains through their own APIs
- Starting case: publish compatibility score so Jobs domain can expose it in job lists

### Non‑functional
- Low cost (Azure Service Bus Basic + StorageV2)
- Clear bounded contexts
- External worker fully decoupled from internal domains
- Safe against duplication and stale work
- Eventually consistent and recoverable
- Cross-domain postprocessing must be retryable and idempotent

---

## 2. Bounded Contexts

### 2.1 Enrichment Core (Azure Function App)

**Owns**
- EnrichmentRun lifecycle (inc. statuses)
- Run history and latest-result queries
- Idempotency and anti‑duplication rules
- Building input snapshots (job + CV, as `input.json`)
- Registry of enricher-specific postprocessing handlers
- Creation and retry of projection deliveries to downstream domains

**Does NOT**
- Talk to Service Bus
- Issue SAS tokens
- Expose APIs to the worker
- Read or write Jobs/Users tables directly

**Storage**
- Azure SQL
- Azure Blob (input snapshots, `enrichment` container)
- Azure SQL outbox / projection dispatch table

**Integration Pattern** 
- Calls Jobs internal API for job snapshot 
- Calls Users internal API for CV pointer 
- Downloads CV text via `CVTextBlobPath`
- Produces self-contained `input.json`
- After run completion, creates projection-dispatch records and calls owning domain APIs

---

### 2.2 Worker Gateway (Azure Function App)

**Owns**
- Service Bus Basic integration
- Worker‑facing HTTPS APIs
- Leasing model and corruption protection
- Bridging worker results back to Enrichment Core
- Pending run rescheduling

**Does NOT**
- Decide when a run should exist
- Store enrichment history
- Perform domain postprocessing

---

### 2.3 Local GPT Worker

**Owns**
- Polling SB queue
- Leasing work from Gateway
- Compute enrichment
- Submit completion

**Does NOT**
- Access SQL
- Call Jobs or Users APIs
- Read CV or Job blobs directly
- Trigger downstream domain updates

### 2.4 Downstream Domains (Jobs / Users / others)

**Own**
- Their own read/write models
- Storage of projections needed for their UX/API
- Idempotent projection application rules

**Do NOT**
- Infer enrichment lifecycle on their own
- Access Enrichment Core tables directly

---

## 3. Identity Model

- `subjectKey = "{jobId}:{userId}"`
- One **active** run per `(subjectKey, enricherType)`
- New run **supersedes** older queued/in‑flight runs
- Projection consumers must treat `runId` as idempotency key and ignore stale updates

---

## 4. CV Handling

- CV stored in original rich format (Quill HTML/Delta)
- Normalized plain‑text CV generated **once at ingestion**
- Stored paths:
  - `CVBlobPath` (rich)
  - `CVTextBlobPath` (plain text)
- Versioned via `CVVersionId`

---

## 5. SQL Schema

### 5.1 EnrichmentRun

  Column                  Type
  ----------------------- ------------------
  RunId                   UNIQUEIDENTIFIER
  EnricherType            NVARCHAR(128)
  SubjectKey              NVARCHAR(256)
  JobId                   UNIQUEIDENTIFIER
  UserId                  UNIQUEIDENTIFIER
  Status                  NVARCHAR(32)
  RequestedAt             DATETIMEOFFSET
  QueuedAt                DATETIMEOFFSET
  LeasedAt                DATETIMEOFFSET
  LeaseUntil              DATETIMEOFFSET
  LeaseToken              UNIQUEIDENTIFIER
  CVVersionId             UNIQUEIDENTIFIER
  InputSnapshotBlobPath   NVARCHAR(500)
  Score                   FLOAT
  Summary                 NVARCHAR(2000)
  ErrorCode               NVARCHAR(64)
  ErrorMessage            NVARCHAR(1024)
  UpdatedAt               DATETIMEOFFSET

Statuses:
- Pending
- Queued
- Leased
- Succeeded
- Failed
- Superseded
- Expired

Indexes:
- `(EnricherType, SubjectKey, RequestedAt DESC)`

### 5.2 EnrichmentProjectionDispatch

Tracks delivery of postprocessing actions derived from terminal runs.

 Column                  Type 
 ----------------------- -----------------
 DispatchId              UNIQUEIDENTIFIER 
 RunId                   UNIQUEIDENTIFIER 
 EnricherType            NVARCHAR(128) 
 ProjectionType          NVARCHAR(128) 
 TargetDomain            NVARCHAR(64) 
 TargetKey               NVARCHAR(256) 
 Status                  NVARCHAR(32) 
 AttemptCount            INT 
 LastAttemptAt           DATETIMEOFFSET 
 NextAttemptAt           DATETIMEOFFSET 
 PayloadJson             NVARCHAR(MAX) 
 LastError               NVARCHAR(2000) 
 CreatedAt               DATETIMEOFFSET 
 UpdatedAt               DATETIMEOFFSET 

Statuses:
- Pending
- Delivered
- Failed
- DeadLetter
- Skipped

Indexes:
- `(Status, NextAttemptAt)`
- `(RunId, ProjectionType)` unique

**Notes**
- Created by Enrichment Core when a run reaches terminal state and has registered postprocessing steps.
- Enables retry without re-opening or mutating the original run.
- `PayloadJson` is the exact body to send to the owning domain API.

---

## 6. Blob Storage Layout

Container: `enrichment`

```
enrichment/
  runs/
    {runId}/
      input.json
```

`input.json` contains:
- job snapshot (title + description)
- normalized CV text
- metadata

``` json
{
  "runId": "GUID",
  "enricherType": "compatibility.v1",
  "subjectKey": "jobId:userId",
  "jobOfferingId": "GUID",
  "userId": "GUID",
  "job": {
    "title": "...",
    "description": "..."
  },
  "cv": {
    "text": "..."
  },
  "meta": {
    "source": "core",
    "version": 1
  }
}
```

Worker must not call other domains for input data.

Retention: 30–90 days recommended.

---

## 7. Service Bus (Basic)

Queues:
- `enrichment-requests`

### Request Message
```json
{
  "runId": "GUID",
  "enricherType": "compatibility.v1",
  "subjectKey": "jobId:userId",
  "createdAt": "..."
}
```

No payload data inside SB messages.

---

## 8. APIs

### 8.1 Enrichment Core

#### POST /enrichment/runs
Creates a new run.

Triggers:
- Job creation
- web UI for a job, “run” button on enricher widget

Behavior:
- Supersede existing active run
- Create input snapshot
- Ask Gateway to dispatch

Flow: 
1. Create run (Pending) 
2. Build snapshot (Jobs + Users APIs) 
3. Upload input.json 
4. Attempt dispatch via Gateway 
5. Marks as Queued if enqueue succeeds, otherwise leave on Pending

Snapshot failures: - Transient → remain Pending - Permanent → mark
Failed

#### GET /enrichment/subjects/{jobId}/{userId}/latest
Returns latest run (any status).

#### GET /enrichment/subjects/{jobId}/{userId}/history
Returns paginated history.

#### POST /enrichment/runs/{runId}/complete
Called by Gateway after worker completion.
New behavior in v3:
1. Validate lease and latest-run rule
2. Persist terminal result on `EnrichmentRun`
3. Resolve enricher-specific postprocessing handlers
4. Create `EnrichmentProjectionDispatch` rows
5. Optionally attempt immediate delivery inline (best effort)
6. Return success to Gateway even if a projection delivery must be retried later

#### GET /enrichment/runs
Used by Gateway rescheduler.
Query params: - status (default Pending) - limit - offset

#### POST /enrichment/runs/{runId}/queued
Called by Gateway after successful enqueue.

#### GET /internal/enrichment/runs/{runId}
For gateway to requeue Pending runs

#### GET /internal/enrichment/subjects/{subjectKey}/latest-id

#### POST /internal/enrichment/runs/{runId}/lease
Used by gateway to lease run, for worker

#### GET /internal/enrichment/runs/{runId}/input
Used by gatewys to get input snapshot for a run, for worker

#### POST /internal/enrichment/postprocessing/drain
Optional internal/admin endpoint or timer-driven job.

Behavior:
- Picks `EnrichmentProjectionDispatch` rows with `Status=Pending` and `NextAttemptAt <= now`
- Calls the target domain API
- Marks row `Delivered`, `Failed`, or `DeadLetter`

**Opinion:** prefer timer/background drain over doing all projection work synchronously inside `/complete`. It keeps worker completion fast and avoids turning temporary Jobs API issues into worker-facing failures.


---

### 8.2 Worker Gateway

#### POST /gateway/dispatch (internal)
Enqueues SB request.

#### POST /work/lease (worker)
Validates:
- run exists
- run is latest active
- not already leased

Returns:
- leaseToken
- leaseUntil
- input snapshot (inline or via SAS)

#### POST /work/complete (worker)
Validates leaseToken and latest‑run rule.
Forwards result to Enrichment Core.

### 8.3 Jobs API

POST /internal/jobs/compatibility-projections:bulk-upsert
Applies compatibility projection for a job/user pairs, in bulk.

Request body:

```json
{
  "items": [
    {
      "jobId": "GUID",
      "userId": "GUID",
      "runId": "GUID",
      "enricherType": "compatibility.v1",
      "projectionType": "job-list.compatibility-score.v1",
      "status": "Succeeded",
      "score": 7.4,
      "summary": "Strong Python and Azure match.",
      "completedAt": "2026-03-16T12:34:56Z"
    }
  ]
}
```

Responce body:
```json
{
  "accepted": 1,
  "rejected": 0,
  "results": [
    {
      "runId": "GUID",
      "status": "Upserted"
    }
  ]
}

```

Rules:
- Auth: internal/function key only
- Idempotent for same `runId`
- Must ignore stale updates when stored `CompletedAt` is newer than incoming one
- For now only `status=Succeeded` updates the visible score projection
- Response should indicate whether update was `applied`, `noop`, or `stale_ignored`, for each entry.

**Jobs domain ownership**
- Jobs decides where to store the projection and how to expose it in job-list DTOs
- Enrichment Core only sends the projection intent

---

## 9. Postprocessing / Projection Flow

### 9.1 Completion to Projection Delivery

1. Worker completes run through Gateway
2. Gateway forwards to `POST /enrichment/runs/{runId}/complete`
3. Enrichment Core stores terminal result
4. Enrichment Core resolves postprocessors for `enricherType`
5. For each produced projection:
   - create `EnrichmentProjectionDispatch` row
   - target owning domain API
6. Core timer / inline best effort delivers projection
7. Owning domain stores projection idempotently

### 9.2 Compatibility Score on Jobs List

1. `compatibility.v1` run succeeds
2. Enrichment Core postprocessor creates projection:
   - `projectionType = job-list.compatibility-score.v1`
   - target domain = `jobs`
   - target key = `{jobId}:{userId}`
3. Core calls Jobs internal endpoint
4. Jobs stores latest accepted compatibility projection
5. Jobs list APIs include cached compatibility score for that user/job pair

---

## 10. Gateway Rescheduling Flow

1.  Gateway timer job calls: `GET /enrichment/runs?status=Pending`
2.  For each run:
    -   Enqueue to SB
    -   Call `/enrichment/runs/{runId}/queued`
3.  Ensures eventual consistency

---

## 11. Leasing Model

- Worker must lease before computing
- Lease has TTL (e.g. 60 min)
- Superseded runs cannot be leased
- Prevents stale SB messages from causing corruption

---

## 12. Anti‑duplication Strategy

- Only one active run per `(subjectKey, enricherType)`
- New run marks older ones as `Superseded`
- Gateway refuses to lease superseded runs

Additional projection-level rules:
- Projection dispatch row unique by `(RunId, ProjectionType)`
- Downstream domain endpoint must be idempotent by `runId`
- Downstream domain endpoint must reject stale update if a newer projection has already been applied

---

## 13. UI Mapping

- Default widget shows **latest run**
- Status displayed even if failed or running
- Jobs list can show **cached compatibility projection** without opening the job
- If no projection exists yet, list behaves as today
- “Show history” loads full run list. History comes from Enrichment Core, not Jobs
- Manual rerun creates new run

---

## 14. Security

- Worker:
  - Service Bus **Listen** only
  - No direct SQL access
  - No broad Blob access
- Gateway:
  - Validates leaseToken
  - Ensures run is still latest
- Worker auth:
  - API key (function key)

---

## 15. Offline / Retry Support

- SB messages can wait for hours
- Leasing prevents expired SAS issues
- Old messages safely ignored
- Projection delivery is separately retryable from worker completion
- Temporary downstream domain outages do not require recomputing enrichment


---

## 15. Future Extensions

- More enrichers (`salary.v1`, `seniority.v1`, etc.)
- Move to SB Standard if sessions/topics needed
- More projection types per enricher
- Users-domain projections (for example profile insights or saved-search ranking signals)
- Move projection drain to queue-based outbox if needed later
- Add recompute policies per enricher
- Add observability dashboards

---

## 16. Implementation Order

1. CV normalization at ingestion (DONE)
2. SQL schema migration (DONE)
3. Enrichment Core APIs (DONE)
4. Worker Gateway APIs (DONE)
5. Local worker loop (DONE)
6. Jobs internal compatibility projection endpoint + storage
7. Enrichment Core postprocessor registry + projection dispatch table
8. Projection drain / retry job
6. Cleanup + expiry jobs

---

**End of document**
