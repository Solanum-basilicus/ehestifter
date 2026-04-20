# Milestone Design: Adzuna-backed Automatic Job Sourcing

## 1. Goal

Implement the first usable pipeline for automatically sourcing jobs from Adzuna into Ehestifter, then auto-booking compatibility enrichment for selected users.

This milestone has two layers:

1. **PoC layer**
   - runnable from a development machine,
   - fetches Adzuna jobs from the last 24 hours,
   - filters for `Project Manager` in title,
   - limits to Germany or likely remote/WFH opportunities relevant to Germany,
   - normalizes selected fields,
   - prints formatted JSON for inspection.

2. **Milestone layer**
   - Azure timer-triggered importer for Adzuna,
   - creates new shared jobs in Jobs domain as `system` actor,
   - no user status is created,
   - filters defined by environmental varuables,
   - Enrichment Core books compatibility runs for a temporary configured set of user IDs,
   - imported jobs become visible on “Open opportunities” once created and later enriched.

## 2. Stretch goals

This milestone can be finished without implementing those:

- user-facing toggle for “participate in auto-enrichment",
- fuzzy deduplication logic.

## Non-goals

This milestone does **not** include:

- multi-provider ingestion framework beyond what is needed to avoid painting ourselves into a corner,
- production-grade scraping abstraction,
- bulk job ingestion endpoint,
- archival / Synapse / Parquet analytics,
- remote classification perfection,
- provider-agnostic canonical job taxonomy.

Those exclusions fit the current system guidance to keep changes narrow, incremental, and conservative in a single hobby environment.

## 3. Challenged assumptions and decisions

### 3.1 Do not depend on “full job details” from Adzuna in this milestone

The Adzuna search docs explicitly say the response contains only a snippet of the description.

**Decision:** treat the search result as the authoritative source for v1 import.  
If later investigation finds a stable official detail endpoint or higher-tier capability, it can be added as an optional enrichment step before job creation.

### 3.2 “Project Manager in title” should be enforced locally, not trusted to API semantics

The Adzuna docs clearly show keyword search via `what`, but not a documented title-only filter in the material reviewed.

**Decision:** for PoC query broadly with `what=project manager`, then keep only rows whose normalized title contains `project manager`. Shape of configurable filters should be descided on results of PoC.

### 3.3 Remote-for-Germany detection will be heuristic

The docs reviewed show standard search fields and examples for location filtering, but no clearly documented public “remote only” flag that this design should rely on.

**Decision:** for this milestone, accept:
- jobs located in Germany, or
- jobs whose title/description/location text strongly suggests remote/WFH and German relevance.

### 3.4 Deduplication risk is more dangerous on false-positive merge than false-negative duplicate

Concern: if URL-to-canonical identity extraction collapses distinct jobs into one, the damage is worse than briefly allowing duplicates.

Current Jobs behavior is canonical-identity-first and create is intended to resolve duplicates to an existing shared job.

**Decision:** this milestone keeps canonical identity as the only hard idempotency guarantee.  
A lightweight secondary similarity check is allowed in base milestone scope only if it can be done through existing Jobs endpoints without adding a DB-backed search endpoint. Adding special endpoint would be a part of stretch goal if we get to it. 

## 4. Existing system constraints that shape the design

The design must preserve these current behaviors:

- Jobs are shared across users. Status and compatibility are per `(jobId, userId)`.
- Jobs owns compatibility projection storage and exposure. Enrichment Core only produces and dispatches projections.
- There is no documented “list active users for enrichment” endpoint today; users currently expose per-user CV snapshot retrieval for enrichment via internal API, existance of CV snapshot can be indicative of user being active in absense of better metrics.
- Browser-facing manual job creation must not be burdened by extra synchronous work. The current architecture already separates creation from later enrichment flows.

## 5. Target architecture

### 5.1 Components

#### New
- **Adzuna PoC CLI script**
  - local only,
  - fetch + normalize + print,
  - deprecates after import function implementation.

- **Adzuna Import Azure Function**
  - timer-triggered,
  - provider-specific,
  - imports jobs into Jobs domain,

#### Reused
- Jobs domain `POST /jobs`
- Jobs domain `GET/HEAD /jobs/exists`
- Enrichment Core run creation / dispatch flow
- Users internal CV snapshot endpoint
- Existing worker + gateway + projection flow

### 5.2 Separation of concerns

#### Importer owns
- talking to Adzuna,
- pagination,
- time-window selection,
- normalization from Adzuna shape to Ehestifter create payload,
- provider-specific idempotency preparation,
- posting jobs into Jobs.

#### Jobs owns
- actual create semantics,
- canonical identity enforcement,
- location persistence,
- created-by-system semantics,
- final durable shared job record,

#### Enrichment Core owns
- compatibility run creation,
- snapshot composition,
- queueing,
- result dispatch into Jobs.
- requesting enrichment booking for configured users on new jobs.

That split matches the current system ownership rules.

## 6. Proposed end-to-end flow

### 6.1 PoC flow

1. Run script locally with Adzuna credentials from environment.
2. Query Adzuna Germany jobs with `what=project manager`.
3. Page through recent results.
4. Keep only jobs created within last 24 hours.
5. Normalize fields:
   - URL
   - title
   - hiring company
   - posting company / agency
   - description snippet
   - locations
   - remote hints
6. Print sorted formatted JSON.

### 6.2 Importer flow

1. Timer fires hourly.
2. Importer determines fetch window:
   - default last successful run time to now,
   - initial bootstrap mode may use `last 24h`.
3. Query Adzuna page by page.
4. Locally filter and normalize each job.
5. For each normalized job:
   - derive canonical provider identity,
   - call `HEAD /jobs/exists`,
   - if clearly exists, skip create,
   - otherwise call `POST /jobs`.
6. For each newly created or existing-resolved job ID that should be enriched:
   - enqueue compatibility run request(s) for configured user IDs.
7. Log counts and diagnostics.

## 7. Data normalization design

### 7.1 Proposed provider identity mapping

For Adzuna-imported jobs:

- `FoundOn = "adzuna"`
- `Provider = "adzuna"`
- `ProviderTenant = <country code or marketplace variant>`  
  Initial value: `"de"`
- `ExternalId = <Adzuna job id>`

Rationale:
- use provider-owned stable ID where available,
- do **not** depend on downstream URL parsing for imported jobs,
- reduce false merges caused by generic ATS URL patterns.

This is important because the current Jobs model treats `(Provider, ProviderTenant, ExternalId)` as canonical identity.

### 7.2 Field mapping

#### URL fields
- `Url` = Adzuna `redirect_url`
- `ApplyUrl` = same as `redirect_url` initially

Reason:
- simplest usable approach,
- later milestone may separate landing URL from application URL if provider offers both.

#### Title
- normalize whitespace,
- trim,
- preserve original wording,
- reject if empty after normalization.

#### Hiring company vs posting company
Adzuna search results include `company.display_name` in examples.

Initial mapping:
- `PostingCompanyName = company.display_name`
- `HiringCompanyName = company.display_name`

If heuristic later identifies likely agency/recruiter wording, we may split them, but not in this milestone.

#### Description
- use Adzuna `description` as-is after whitespace cleanup,
- note in diagnostics/docs that it is a snippet, not guaranteed full text.

#### Locations
From docs/examples, Adzuna returns a structured location object with `display_name` and `area[]`.

Initial approach:
- preserve provider raw location in importer logs,
- map one or more Ehestifter locations from:
  - country inferred from Adzuna country endpoint (`de`),
  - city/region inferred from `display_name` and `area`.

If multiple locations are not exposed cleanly in Adzuna result, create one normalized location row only.

#### Remote type
Heuristic mapping:
- if title or description contains strong remote markers, map `RemoteType = remote`
- else if hybrid markers, map `RemoteType = hybrid`
- else `onsite/unknown` according to current Jobs accepted values

This should be implemented through existing Jobs constants/helpers if they already exist, not by inventing a parallel enum.

## 8. Germany / remote filter strategy

### 8.1 Inclusion rule

A job is included if all are true:

1. Adzuna result is from country endpoint `de`
2. Created within the current fetch window
3. Normalized title contains `project manager`
4. And at least one:
   - explicit German location, or
   - remote/WFH markers and no evidence it is tied to another country

### 8.2 Initial remote markers

Examples:
- `remote`
- `work from home`
- `wfh`
- `home office`
- `hybrid`

### 8.3 Initial exclusion markers

Examples:
- strong location evidence for a non-German market when location parsing clearly disagrees

This logic is expected to be imperfect and should be isolated in provider-specific normalization code so it can evolve without affecting other providers.

## 9. Deduplication strategy

### 9.1 Hard idempotency key

The real idempotency key is:

`(Provider="adzuna", ProviderTenant="de", ExternalId=<adzuna-id>)`

This is the safest path because it bypasses fragile URL-based provider inference for imported records.

### 9.2 Use of `HEAD /jobs/exists`

Use `HEAD /jobs/exists` before `POST /jobs` as a cheap preflight check against avoidable creates. The current system already uses that surface for duplicate detection and the final create still resolves to existing object when canonical identity matches.

### 9.3 Optional lightweight fuzzy guard

Stretch goal only, and only if existing endpoints make it cheap:

- if `HEAD /jobs/exists` misses,
- search existing jobs by normalized title + company,
- skip create only on very high-confidence match.

This should not block milestone completion.

### 9.4 Important anti-pattern to avoid

Do **not** let the importer “guess” provider identity by passing only URL and relying on Jobs-side URL parsing when Adzuna already provides a stable ID.

That would reintroduce the exact false-merge risk you called out.

## 10. Enrichment booking strategy

### 10.1 Principle

Imported job creation must remain decoupled from enrichment execution.

Manual UI create must not become slower or require new user input, and imported creates should follow the same architectural principle of “create fast, enrich asynchronously.” That matches the current enrichment subsystem design.

### 10.2 Initial active-user strategy

For this milestone:
- use environment-configured user IDs,
- likely a single hardcoded active user ID.

Example env var:
- `AUTO_ENRICH_USER_IDS=guid1,guid2`

This is intentionally a temporary bridge until a proper Users-owned selection endpoint exists.

### 10.3 Booking point

After a job is successfully created, or create returns existing job ID for an active existing job:
- request compatibility enrichment for each configured target user.

### 10.4 Where booking logic should live

Preferred near-term design:
- importer calls existing Enrichment Core API to request compatibility runs.

Avoid:
- importer writing directly to enrichment tables,
- importer talking to gateway/queue directly,
- importer trying to compose snapshots itself.

This preserves existing subsystem ownership.

## 11. Recommended API changes

### 11.1 Required or near-required

#### A. Enrichment Core: explicit internal endpoint to request compatibility runs
If not already present in a usable form, add a narrow internal endpoint like:

`POST /internal/enrichers/compatibility-runs`

Request body:
```json
{
  "items": [
    { "jobId": "GUID", "userId": "GUID", "source": "adzuna-import" }
  ]
}
```

Behavior:
- idempotent-ish best effort,
- may skip if a recent run for same `(jobId, userId)` is already pending/running,
- returns accepted/skipped counts.

Reason:
- lets importer book work without learning enrichment internals.

#### B. No Jobs API changes required for milestone base path
Use existing create and exists surfaces.

### 11.2 Deferred
- `GET /users/active`
- dedicated bulk create endpoint in Jobs
- dedicated importer-oriented fuzzy duplicate endpoint in Jobs

## 12. Azure Function design

### 12.1 Function shape

Function app:
- either a new provider-specific function app or an existing ingestion-related function app if you already have one available.

My recommendation:
- one function app can host multiple provider functions later,
- one function **per provider** within that app.

Reason:
- you want provider isolation in execution paths,
- but a separate Azure Function App per provider may be unnecessary cost/ops overhead for a hobby setup.

That is my opinion, based on budget and operability tradeoff.

### 12.2 Trigger

- timer-triggered hourly

### 12.3 State

Need importer checkpoint state:
- `last_successful_import_utc`

Possible homes:
1. environment variable: bad fit for mutable runtime state
2. blob file: acceptable
3. dedicated table owned by importer service: best long-term
4. reuse existing table owned elsewhere: avoid

Recommendation:
- use a small blob checkpoint file for this milestone,
- move to DB-owned importer state later if ingestion grows.

### 12.4 Retries

- page-level retries for Adzuna calls
- per-job retries for Jobs/Enrichment API calls
- do not let one bad job abort the whole batch

## 13. PoC design

### 13.1 Purpose

Validate:
- whether Adzuna free-tier results are usable,
- whether description snippets are enough to start,
- whether normalized location/company/title are good enough,
- whether imported URLs and external IDs look stable.

### 13.2 CLI contract

Example:

```bash
python -m tools.adzuna_poc \
  --country de \
  --query "project manager" \
  --hours 24 \
  --max-pages 3 \
  --output json
```

### 13.3 Output shape

```json
{
  "fetchedAtUtc": "2026-04-20T12:00:00Z",
  "query": {
    "country": "de",
    "what": "project manager",
    "hours": 24
  },
  "counts": {
    "raw": 120,
    "withinWindow": 43,
    "titleMatched": 19,
    "included": 11
  },
  "jobs": [
    {
      "provider": "adzuna",
      "providerTenant": "de",
      "externalId": "123456789",
      "url": "https://...",
      "applyUrl": "https://...",
      "title": "Project Manager Digital Transformation",
      "postingCompanyName": "Example GmbH",
      "hiringCompanyName": "Example GmbH",
      "description": "snippet ...",
      "remoteType": "hybrid",
      "locations": [
        {
          "country": "Germany",
          "region": "Berlin",
          "city": "Berlin",
          "displayText": "Berlin"
        }
      ],
      "createdAtProviderUtc": "2026-04-19T18:20:00Z",
      "filters": {
        "titleMatched": true,
        "germanyRelevant": true,
        "remoteHint": true
      }
    }
  ]
}
```

### 13.4 Success criteria for PoC

- can run locally with only Adzuna credentials,
- produces stable normalized output,
- sample output is manually reviewable,
- external IDs and URLs look trustworthy enough for import.

## 14. Milestone implementation plan

### Phase 1 — PoC
- build local Adzuna client
- build provider-specific normalization module
- print formatted JSON
- inspect sample manually

### Phase 2 — Importer skeleton
- timer-triggered function
- checkpoint storage in blob
- Adzuna paging + local filtering
- structured logs only, no create yet

### Phase 3 — Create jobs
- call `HEAD /jobs/exists`
- call `POST /jobs`
- capture created/existing job IDs
- log duplicates / failures

### Phase 4 — Book enrichment
- call Enrichment Core internal booking endpoint
- use env-configured target user IDs
- verify compatibility scores appear downstream

### Phase 5 — Hardening
- retries
- rate limiting
- checkpoint correctness
- dead-letter style diagnostics
- import summary logs

## 15. Observability and logging

Each run should log:

- run start/end time
- fetch window
- pages fetched
- raw result count
- filtered count
- created count
- existing/skipped count
- enrichment booked count
- per-job warnings:
  - missing company
  - suspicious empty description
  - location parse fallback
  - API error
  - create rejected

Suggested per-job correlation fields:
- provider
- providerTenant
- externalId
- redirect_url
- resulting jobId if any

## 16. Risks and mitigations

### 16.1 Adzuna snippet descriptions may be too poor for compatibility scoring
Mitigation:
- prove/disprove quickly with PoC,
- if poor, later add provider-page fetch or another provider before overinvesting.  
This risk is real because Adzuna documents search descriptions as snippets.

### 16.2 False-positive merge in Jobs due to bad canonical identity
Mitigation:
- always supply explicit Adzuna provider identity fields,
- do not rely on URL parsing for imported records.

### 16.3 False positives in remote/Germany relevance
Mitigation:
- isolate heuristics in provider adapter,
- keep raw source location fields in diagnostics.

### 16.4 Too many enrichment runs if import volume grows
Mitigation:
- keep target user list explicit and small,
- later add proper active-user selection endpoint,
- later add importer-side caps if needed.

### 16.5 Re-import due to checkpoint loss
Mitigation:
- hard idempotency via provider identity,
- importer can safely retry create attempts because Jobs create is intended to resolve duplicates to the existing job.

## 17. Open items deferred on purpose

- Users-owned `GET /users/active`
- user-facing opt-in toggle for sourced-job enrichment
- provider-agnostic import framework
- full-text job detail fetching
- fuzzy dedupe endpoint in Jobs
- bulk create endpoint in Jobs
- source-specific confidence scoring
- provider provenance/history UI

## 18. Acceptance criteria

The milestone is done when:

1. A local PoC can fetch and print normalized Adzuna jobs for the last 24 hours for Germany and `Project Manager`.
2. An hourly Azure function can import Adzuna jobs using explicit Adzuna canonical identity.
3. Imported jobs are created by system actor, with no user status.
4. Imported jobs appear as shared open opportunities in existing UX.
5. Compatibility enrichment is booked automatically for configured user IDs.
6. Compatibility scores eventually appear through existing Jobs projection flow.

## 19. Recommended next implementation step

Start with **Phase 1 PoC only** and inspect 30–50 normalized rows before touching Azure Functions or Enrichment Core. That is the cheapest way to test the most fragile assumption in the whole plan: whether Adzuna’s free-tier payload is rich enough to be worth importing at all.
