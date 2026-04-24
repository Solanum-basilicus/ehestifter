# Milestone Design: Vendor-Agnostic Automatic Job Sourcing

## 1. Goal

Implement the first usable automatic sourcing pipeline for Ehestifter using a **vendor-agnostic Sourcer -> Filesystem -> Universal Importer** model.

This milestone replaces the earlier assumption that one provider-specific importer should own the whole ingestion path.

The target end-state is:

1. One or many Sourcers obtain jobs from external sources.
2. Sourcers normalize jobs into Ehestifter-ready payloads.
3. Sourcers write **batch JSON files** into storage.
4. Universal Importer consumes files and creates shared jobs in Jobs domain as `system` actor.
5. Imported jobs appear in existing UX.
6. Existing enrichment subsystem reacts asynchronously.

---

## 2. Scope boundaries and stretch goals

### 2.1 In scope

- provider-specific or strategy-specific sourcers,
- normalized filesystem handoff contract,
- batch-file ingestion model,
- universal importer,
- create-through-existing Jobs endpoint,
- canonical identity derived from origin link,
- importer checkpointing and diagnostics,
- preserving downstream enrichment ownership boundaries.

### 2.2 Out of scope for base milestone

- production crawler framework,
- bulk Jobs DB writes bypassing APIs,
- fuzzy dedup beyond canonical identity,
- Synapse / Parquet analytics,
- ranking engine for source quality,
- perfect remote classification,
- source-specific UI provenance features.

### 2.3 Stretch goals

- multiple concurrent sourcers,
- source priority model,
- fuzzy duplicate guardrail,
- importer parallel workers,
- per-source throttling policy,
- user-facing source preferences,
- provenance/history UI.

---

## 3. Existing system constraints that shape design

The design must preserve current ownership boundaries:

- Jobs owns job records, statuses, compatibility projections.
- Users owns user profile / CV / enrichment eligibility later.
- Enrichment Core owns compatibility run booking and lifecycle.
- Browser create flows must stay fast.
- Cross-domain writes happen through owner APIs.
- Canonical identity remains `(Provider, ProviderTenant, ExternalId)`.

---

## 4. Target architecture

## 4.1 Components

### New

- Sourcer(s)
- Universal Importer
- Shared normalized storage contract

### Reused

- Jobs `POST /jobs`
- Jobs `GET/HEAD /jobs/exists`
- Existing canonical identity logic
- Existing enrichment subsystem
- Azure Storage account

## 4.2 Ownership split

### Sourcer owns

- talking to provider / site / API,
- pagination,
- fetch windows,
- retries against source,
- normalization,
- origin link extraction,
- canonical identity preparation,
- batch file creation.

### Importer owns

- scanning filesystem,
- reading batch files,
- schema validation,
- calling Jobs APIs,
- checkpointing,
- poison-file handling,
- diagnostics,
- archive / processed movement.

### Jobs owns

- final create semantics,
- canonical identity enforcement,
- deduplication,
- persistence,
- visibility in UX.

### Enrichment Core owns

- detecting new jobs,
- selecting users,
- booking compatibility runs,
- projection dispatch.

Importer does **not** book enrichments.

---

## 5. Filesystem handoff contract

## 5.1 Batch-file model (chosen)

One file contains many normalized jobs.

Reason:

- fewer storage transactions,
- easier replay,
- easier source writes,
- lower Azure cost,
- importer can process rows individually.

## 5.2 Path layout

Recommended:

- `/normalized/<source>/YYYY/MM/DD/<runId>.json`
- `/processed/<source>/YYYY/MM/DD/<runId>.json`
- `/failed/<source>/YYYY/MM/DD/<runId>.json`
- `/quarantine/<source>/YYYY/MM/DD/<runId>.json`
- `/checkpoints/importer/state.json`

## 5.3 Batch file schema

```json
{
  "schemaVersion": 1,
  "source": "example-source",
  "sourceRunId": "2026-04-24T10-00Z-page-window-1",
  "generatedAtUtc": "2026-04-24T10:03:00Z",
  "jobs": []
}
```

## 5.4 Job item schema

```json
{
  "url": "https://origin-job-link",
  "applyUrl": "https://origin-job-link",
  "title": "Senior Project Manager",
  "description": "...",
  "hiringCompanyName": "Contoso GmbH",
  "postingCompanyName": null,
  "provider": "workday",
  "providerTenant": "contoso",
  "externalId": "12345",
  "locations": [
    {
      "country": "Germany",
      "region": "Bavaria",
      "city": "Munich",
      "displayText": "Munich"
    }
  ],
  "remoteType": "hybrid",
  "sourceMeta": {
    "fetchedAtUtc": "2026-04-24T09:58:00Z",
    "sourceListingId": "abc123"
  }
}
```

## 5.5 Required fields

Required per job:

- title
n- provider
- providerTenant (empty string allowed)
- externalId
- url or applyUrl

If canonical identity is absent, sourcer output is invalid.

---

## 6. Sourcer specification

## 6.1 Sourcer responsibilities

Each sourcer must:

1. Acquire jobs legally / contractually.
2. Respect provider throttling.
3. Support paging.
4. Support time windows where possible.
5. Produce deterministic normalized payloads.
6. Avoid duplicates inside same batch.
7. Write complete file atomically.

## 6.2 Atomic write rule

Write to temp path first, then rename/move into `/normalized/...` when complete.

Importer should never see partial files.

## 6.3 Sourcer retries

Allowed:

- page retries,
- source transient retries,
- partial page skips with diagnostics.

Not allowed:

- corrupt half-written batch files.

---

## 7. Universal importer specification

## 7.1 Trigger model

Azure Function timer-triggered every hour initially.

## 7.2 Discovery model

Importer scans `/normalized/**` for unprocessed files.

## 7.3 File processing order

Preferred:

1. oldest first
2. then lexical path order

Keeps replay deterministic.

## 7.4 Per-file flow

1. Read JSON.
2. Validate schema.
3. For each job row:
   - validate required fields,
   - optional `HEAD /jobs/exists`,
   - call `POST /jobs`,
   - record result.
4. Summarize counts.
5. Move file to processed / failed / quarantine.

## 7.5 Per-row outcomes

- created
n- existing
- rejected_bad_payload
- transient_failure
- permanent_failure

## 7.6 Poison-file rules

Move to `/quarantine` when:

- invalid JSON,
- unsupported schema version,
- too many row failures,
- repeated processing crashes.

## 7.7 Idempotency

Replaying same batch file must be safe.

Reason:

Jobs dedup should resolve creates to existing records via canonical identity.

---

## 8. Canonical identity rules

## 8.1 Mandatory model

Each imported job must map to:

`(Provider, ProviderTenant, ExternalId)`

## 8.2 Source of truth

Identity should come from **origin job link**, not aggregator wrapper link.

## 8.3 Temporary fallback

If source lacks origin link but provides stable direct identity, use source-native identity only if explicitly approved for that sourcer.

## 8.4 Anti-patterns

Do not use:

- page title hashes,
- timestamps,
- batch row numbers,
- random GUIDs.

---

## 9. Phase plan

## Phase 1 — Adzuna PoC (Completed)

Outcome preserved:

- sourcing technically feasible,
- metadata useful,
- unsuitable as direct importer source.

Closed as learning success.

## Phase 2 — Sourcing Workshop Loop (Current)

Goal:

Find at least one sourcer that reliably emits valid batch files.

Candidate experiments:

- AI browsing agent on Stepstone,
- paid Indeed API,
- Google alerts -> parse origin pages,
- company career-site crawlers,
- niche feeds.

### Acceptance criteria

At least one source repeatedly produces batch files with:

- valid schema,
- usable canonical identity,
- enough visible fields,
- acceptable cost,
- repeatable throughput.

## Phase 3 — Universal Importer Build

Deliver timer importer with processing / checkpointing / diagnostics.

## Phase 4 — End-to-End Activation

Imported jobs appear in UI and enrichment reacts.

## Phase 5 — Growth

Add more sourcers once one source works fully.

---

## 10. Observability and logging

Each sourcer run should log:

- source name,
- pages fetched,
- raw jobs,
- normalized jobs,
- file path,
- warnings.

Each importer run should log:

- files found,
- files processed,
- rows created,
- rows existing,
- rows failed,
- quarantined files,
- duration.

---

## 11. Risks and mitigations

## 11.1 Weak source quality

Mitigation:

cheap workshop loop before overbuilding importer.

## 11.2 Missing canonical identity

Mitigation:

source rejected until identity solved.

## 11.3 Duplicate floods after replay

Mitigation:

Jobs dedup + importer safe replays.

## 11.4 Storage clutter

Mitigation:

retention policy for processed files later.

## 11.5 Too many enrichments

Mitigation:

Enrichment Core remains policy owner.

---

## 12. Acceptance criteria for whole milestone

Milestone complete when:

1. At least one sourcer writes valid batch files automatically.
2. Importer consumes files unattended.
3. Imported jobs appear as shared open opportunities.
4. Duplicate replays are safe.
5. Existing enrichment can react asynchronously.
6. Adding second source requires sourcer work only, not importer redesign.

---

## 13. Recommended next implementation step

Implement **Phase 2 only**:

choose cheapest promising source, generate 30–50 normalized rows, validate identity quality before building importer further.

