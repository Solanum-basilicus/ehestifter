
# Enrichment System Design (v1)

This document describes the architecture, responsibilities, data model, and flows
for the **Enrichment Core + Worker Gateway + Local GPT Worker** system.

It is intended as a long‑term reference during implementation and iteration.

---

## 1. Goals

### Functional
- Compute enrichment results (starting with compatibility score) for `(userId, jobId)`
- Track run lifecycle, status, and history
- Show latest result by default, history on demand
- Allow manual re‑run from UI

### Non‑functional
- Low cost (Azure Service Bus Basic + StorageV2)
- Clear bounded contexts
- External worker fully decoupled from internal domains
- Safe against duplication and stale work

---

## 2. Bounded Contexts

### 2.1 Enrichment Core (Azure Function App)

**Owns**
- EnrichmentRun lifecycle
- Run history and latest-result queries
- Idempotency and anti‑duplication rules
- Building input snapshots (job + CV)

**Does NOT**
- Talk to Service Bus
- Issue SAS tokens
- Expose APIs to the worker

**Storage**
- Azure SQL
- Azure Blob (input snapshots)

---

### 2.2 Worker Gateway (Azure Function App)

**Owns**
- Service Bus Basic integration
- Worker‑facing HTTPS APIs
- Leasing model and corruption protection
- Bridging worker results back to Enrichment Core

**Does NOT**
- Decide when a run should exist
- Store enrichment history

---

### 2.3 Local GPT Worker

**Owns**
- Polling SB queue
- Leasing work from Gateway
- Computing score + summary
- Submitting results

**Does NOT**
- Call Jobs domain
- Access SQL or internal APIs

---

## 3. Identity Model

- `subjectKey = "{jobId}:{userId}"`
- One **active** run per `(subjectKey, enricherType)`
- New run **supersedes** older queued/in‑flight runs

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

| Column | Type |
|------|------|
| RunId | UNIQUEIDENTIFIER (PK) |
| EnricherType | NVARCHAR(128) |
| SubjectKey | NVARCHAR(256) |
| JobId | UNIQUEIDENTIFIER |
| UserId | UNIQUEIDENTIFIER |
| Status | NVARCHAR(32) |
| RequestedAt | DATETIMEOFFSET |
| QueuedAt | DATETIMEOFFSET |
| LeasedAt | DATETIMEOFFSET |
| LeaseUntil | DATETIMEOFFSET |
| LeaseToken | UNIQUEIDENTIFIER |
| CVVersionId | UNIQUEIDENTIFIER |
| InputSnapshotBlobPath | NVARCHAR(500) |
| Score | FLOAT |
| Summary | NVARCHAR(2000) |
| ErrorCode | NVARCHAR(64) |
| ErrorMessage | NVARCHAR(1024) |

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
- User “rerun” button

Behavior:
- Supersede existing active run
- Create input snapshot
- Ask Gateway to dispatch

#### GET /enrichment/subjects/{jobId}/{userId}/latest
Returns latest run (any status).

#### GET /enrichment/subjects/{jobId}/{userId}/history
Returns paginated history.

#### POST /enrichment/runs/{runId}/complete
Called by Gateway only.

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

---

## 9. Leasing Model

- Worker must lease before computing
- Lease has TTL (e.g. 60 min)
- Superseded runs cannot be leased
- Prevents stale SB messages from causing corruption

---

## 10. Anti‑duplication Strategy

- Only one active run per `(subjectKey, enricherType)`
- New run marks older ones as `Superseded`
- Gateway refuses to lease superseded runs

---

## 11. UI Mapping

- Default widget shows **latest run**
- Status displayed even if failed or running
- “Show history” loads full run list
- Manual rerun creates new run

---

## 12. Security

- Worker:
  - Service Bus **Listen** only
  - No direct SQL access
  - No broad Blob access
- Gateway:
  - Validates leaseToken
  - Ensures run is still latest
- Worker auth:
  - API key or AAD (upgrade later)

---

## 13. Offline Worker Support

- SB messages can wait for hours
- Leasing prevents expired SAS issues
- Old messages safely ignored

---

## 14. Future Extensions

- More enrichers (`salary.v1`, `seniority.v1`, etc.)
- Move to SB Standard if sessions/topics needed
- Add recompute policies per enricher
- Add observability dashboards

---

## 15. Implementation Order

1. CV normalization at ingestion
2. SQL schema migration
3. Enrichment Core APIs
4. Worker Gateway APIs
5. Local worker loop
6. Cleanup + expiry jobs

---

**End of document**
