# Milestone Design: Adzuna-backed Automatic Job Sourcing

## 1. Goal

Implement the first usable pipeline for automatically sourcing jobs from Adzuna into Ehestifter.

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
   - imported jobs become visible on “Open opportunities”,
   - existing enrichment subsystem reacts to new jobs and books compatibility runs asynchronously.

## 2. Scope boundaries and stretch goals

### 2.1 In scope

- provider-specific Adzuna importer,
- local PoC for inspecting normalized output,
- canonical identity extraction from the origin link of the job,
- create-through-existing-Jobs-endpoint flow,
- asynchronous enrichment booking initiated outside the importer.

### 2.2 Out of scope for the base milestone

This milestone does **not** require:

- multi-provider ingestion framework beyond what is needed to avoid painting ourselves into a corner,
- production-grade scraping abstraction,
- bulk job ingestion endpoint,
- archival / Synapse / Parquet analytics,
- remote classification perfection,
- provider-agnostic canonical job taxonomy.

### 2.3 Stretch goals

The following are desirable but optional for initial shipment:

- fuzzy deduplication beyond canonical identity,
- user-facing toggle for “participate in auto-enrichment”,
- Users-owned `GET /users/active` endpoint or equivalent owner-side selection surface,
- importer-oriented fuzzy duplicate endpoint in Jobs,
- dedicated bulk create endpoint in Jobs.

## 3. Challenged assumptions and decisions

### 3.1 Do not depend on “full job details” from Adzuna in this milestone

The Adzuna search docs explicitly say the response contains only a snippet of the description.

**Decision:** treat the search result as the authoritative source for v1 import.  
If later investigation finds a stable official detail endpoint or higher-tier capability, it can be added as an optional enrichment step before job creation.

### 3.2 “Project Manager in title” should be enforced locally, not trusted to API semantics

The Adzuna docs clearly show keyword search via `what`, but not a documented title-only filter in the material reviewed.

**Decision:** query broadly with `what=project manager`, then keep only rows whose normalized title contains `project manager`. Shape of configurable filters should be descided on results of PoC.

### 3.3 Remote-for-Germany detection will be heuristic

The docs reviewed show standard search fields and examples for location filtering, but no clearly documented public “remote only” flag that this design should rely on.

**Decision:** for this milestone, accept:
- jobs located in Germany, or
- jobs whose title, description, or location text strongly suggests remote/WFH and German relevance.

### 3.4 False-positive merge is the primary deduplication risk

A false-positive merge can collapse multiple distinct postings into one job record, which is worse than temporarily allowing duplicates.

**Decision:** canonical identity remains the only hard idempotency guarantee for the base milestone.  
A lightweight secondary similarity check is allowed only as a stretch goal if it can be done through existing APIs or a narrowly scoped additional endpoint.

## 4. Existing system constraints that shape the design

The design must preserve these current behaviors from `system-design.md`:

- Jobs are shared across users. Status and compatibility are per `(jobId, userId)`.
- Jobs owns compatibility projection storage and exposure. Enrichment Core only produces and dispatches projections.
- Users currently expose per-user CV snapshot retrieval for enrichment via internal API; there is no documented “list active users for enrichment” endpoint today.
- Browser-facing manual job creation must not be burdened by extra synchronous work. The current architecture already separates creation from later enrichment flows.

## 5. Target architecture

### 5.1 Components

#### New
- **Adzuna PoC CLI script**
  - local only,
  - fetch + normalize + print,
  - deprecates by the complition of milestone.

- **Adzuna Import Azure Function**
  - timer-triggered,
  - provider-specific,
  - imports jobs into Jobs domain.

#### Reused
- Jobs domain `POST /jobs`
- Jobs domain `GET/HEAD /jobs/exists`
- existing canonical identity extraction logic used by Jobs
- existing enrichment subsystem lifecycle, queueing, worker, and projection flow

### 5.2 Separation of concerns

#### Importer owns
- talking to Adzuna,
- pagination,
- time-window selection,
- normalization from Adzuna shape to Ehestifter create payload,
- origin-link extraction and canonical identity preparation,
- posting jobs into Jobs,
- importer checkpoint state and diagnostics.

#### Jobs owns
- actual create semantics,
- canonical identity enforcement,
- location persistence,
- created-by-system semantics,
- final durable shared job record,
- publishing or exposing enough signal about newly created jobs for downstream asynchronous processing.

#### Enrichment Core owns
- discovering or receiving notification of newly created jobs,
- selecting target users for enrichment,
- compatibility run creation,
- snapshot composition,
- queueing,
- result dispatch into Jobs.

#### Users owns
- CV presence and later active-user selection logic,
- any future user-facing opt-in or opt-out toggle for automatic enrichment.

That split matches the current system ownership rules and keeps the importer isolated from enrichment and user-selection concerns.

## 6. Proposed end-to-end flow

### 6.1 PoC flow

1. Run script locally with Adzuna credentials from environment.
2. Query Adzuna Germany jobs with `what=project manager`.
3. Page through recent results.
4. Keep only jobs created within last 24 hours.
5. Normalize fields:
   - origin link and Adzuna link,
   - title,
   - hiring company,
   - posting company / agency,
   - description snippet,
   - locations,
   - remote hints,
   - canonical identity inferred from origin link.
6. Print sorted formatted JSON.

### 6.2 Importer flow

1. Timer fires hourly.
2. Importer determines fetch window:
   - default last successful run time to now,
   - initial bootstrap mode may use `last 24h`.
3. Query Adzuna page by page.
4. Locally filter and normalize each job.
5. For each normalized job:
   - resolve the origin link from the Adzuna result,
   - derive canonical provider identity from the origin link using the same logic as Jobs,
   - call `HEAD /jobs/exists`,
   - if clearly exists, skip create,
   - otherwise call `POST /jobs`.
6. Log counts and diagnostics.

### 6.3 Asynchronous enrichment flow after job creation

1. Jobs domain persists a new shared job.
2. Enrichment Core detects or receives signal that a new job was created.
3. Enrichment Core determines which users should receive compatibility enrichment.
4. Enrichment Core books compatibility runs.
5. Existing enrichment lifecycle proceeds unchanged.

The importer does not book enrichment runs and does not communicate with Users for target selection.

## 7. Data normalization design

### 7.1 Canonical identity extraction

Canonical identity should be extracted from the **origin link of the job**, not from Adzuna’s own redirect or wrapper link.

Target behavior:
- use the Adzuna result to obtain the origin job URL,
- run the same canonical identity extraction logic currently used by Jobs,
- pass the resolved canonical identity fields into `POST /jobs` when possible.

Rationale:
- preserves deduplication usefulness across manual entry, imported jobs, and possible future providers,
- avoids siloing all Adzuna imports under Adzuna-native identifiers,
- keeps the importer aligned with the existing Jobs identity model.

Implementation note:
- copying the helper into the importer is acceptable only as a temporary measure,
- long-term preferred options are either:
  - shared library/package consumed by both Jobs and importer, or
  - a narrowly scoped internal Jobs endpoint that returns canonical identity for a provided URL.

If helper code is duplicated initially, drift prevention should be tracked explicitly as technical debt.

### 7.2 Field mapping

#### URL fields
- `Url` = normalized origin link if recoverable,
- `ApplyUrl` = normalized origin link initially,
- keep Adzuna redirect URL in diagnostics/logging for traceability.

Reason:
- keeps imported jobs aligned with origin postings rather than aggregator wrappers,
- improves cross-provider deduplication and later manual inspection.

#### Title
- normalize whitespace,
- trim,
- preserve original wording,
- reject if empty after normalization.

#### Hiring company vs posting company

Initial mapping rules:

1. If the posting appears to be directly from the hiring company:
   - `HiringCompanyName = company.display_name`
   - `PostingCompanyName = null/empty`

2. If the posting appears to come from an agency and the hiring company is unknown:
   - `HiringCompanyName = "Unknown"`
   - `PostingCompanyName = agency name`

3. If the posting appears to come from an agency and a distinct hiring company can be identified reliably:
   - `HiringCompanyName = identified hiring company`
   - `PostingCompanyName = agency name`

Agency identification may be heuristic in this milestone. The important rule is to avoid storing the same company in both fields when the posting is direct.

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

If multiple locations are not exposed cleanly in the Adzuna result, create one normalized location row only.

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

The hard idempotency key for imported jobs should be the canonical identity extracted from the job’s origin link, using the same provider-tenant-external-id model already enforced by Jobs.

Target form:

`(Provider, ProviderTenant, ExternalId)`

where values are derived from the origin posting URL rather than from Adzuna-native identifiers.

### 9.2 Use of `HEAD /jobs/exists`

Use `HEAD /jobs/exists` before `POST /jobs` as a cheap preflight check against avoidable creates. The current system already uses that surface for duplicate detection and the final create still resolves to existing object when canonical identity matches.

### 9.3 Optional lightweight fuzzy guard

Stretch goal only, and only if existing endpoints make it cheap or if a new narrow endpoint is justified:

- if `HEAD /jobs/exists` misses,
- compare against likely matches by normalized title + company + location,
- skip create only on very high-confidence match.

This should not block milestone completion.

### 9.4 Important anti-pattern to avoid

Do not treat the Adzuna listing identifier as the universal canonical job identifier when the job can be traced to an origin posting with a stronger cross-provider identity.

## 10. Enrichment triggering strategy

### 10.1 Principle

Imported job creation must remain decoupled from enrichment execution.

Manual UI create must not become slower or require new user input, and imported creates should follow the same architectural principle of “create fast, enrich asynchronously.”

### 10.2 Ownership model

- importer does not decide who gets enriched,
- importer does not talk to Users,
- importer does not book compatibility runs,
- Jobs does not own enrichment policy but may emit or expose signals about newly created jobs,
- Enrichment Core owns detection of new jobs and booking of compatibility runs.

### 10.3 Initial target-user strategy

For the base milestone, Enrichment Core may use a temporary configuration-based list of target user IDs.

Example env var:
- `AUTO_ENRICH_USER_IDS=guid1,guid2`

This is a temporary bridge until a proper Users-owned active-user selection mechanism exists.

### 10.4 Detection mechanism options

Preferred options, in order of architectural cleanliness:

1. **Jobs emits a message/event when a new job is created**
   - Enrichment Core subscribes or is triggered from that signal.

2. **Enrichment Core polls for newly created jobs on a timer**
   - based on `FirstSeenAt`, `CreatedAt`, or equivalent timestamp/state.

3. **Hybrid approach**
   - event-first with timer-based catch-up.

The exact mechanism can be chosen based on current implementation convenience, but the ownership boundary remains the same: Enrichment Core reacts to new jobs rather than the importer booking runs directly.

## 11. Recommended API and contract changes

### 11.1 Required or near-required

#### A. Reuse or expose canonical identity extraction without drift
One of the following should be chosen:

- shared helper/library used by Jobs and importer,
- narrow internal Jobs endpoint that resolves canonical identity from a URL,
- temporary helper copy with explicit follow-up task to remove drift risk.

#### B. Enrichment Core needs a way to discover new jobs
Possible implementations:

- consume a job-created message,
- poll Jobs for newly created jobs,
- consume a lightweight notification emitted by Jobs.

#### C. No importer-to-Users API surface required
The importer should not query Users for active users or CV presence.

### 11.2 Deferred
- `GET /users/active`
- user participation toggle for auto-enrichment
- dedicated bulk create endpoint in Jobs
- dedicated importer-oriented fuzzy duplicate endpoint in Jobs

## 12. Azure Function design

### 12.1 Function shape

Function app:
- either a new provider-specific function app or an existing ingestion-related function app if one already exists.

Recommended operational shape:
- one function app can host multiple provider functions later,
- one function **per provider** within that app.

Reason:
- preserves provider isolation in execution paths,
- avoids unnecessary cost and ops overhead from multiplying function apps too early.

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
- per-job retries for Jobs API calls
- do not let one bad job abort the whole batch

## 13. PoC design

### 13.1 Purpose

Validate:
- whether Adzuna free-tier results are usable,
- whether description snippets are enough to start,
- whether normalized location/company/title are good enough,
- whether imported origin URLs look stable enough for canonical identity extraction.

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
      "adzunaRedirectUrl": "https://...",
      "originUrl": "https://...",
      "canonicalIdentity": {
        "provider": "greenhouse",
        "providerTenant": "example-company",
        "externalId": "987654"
      },
      "title": "Project Manager Digital Transformation",
      "postingCompanyName": "Example Recruiting GmbH",
      "hiringCompanyName": "Unknown",
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
- origin URLs and inferred canonical identities look trustworthy enough for import.

## 14. Milestone implementation plan

### Phase 1 — PoC
- build local Adzuna client
- build provider-specific normalization module
- resolve origin URL and canonical identity
- print formatted JSON
- inspect sample manually

### Phase 2 — Importer skeleton
- timer-triggered function
- checkpoint storage in blob
- Adzuna paging + local filtering
- structured logs only, no create yet

### Phase 3 — Create jobs
- resolve origin URL and canonical identity
- call `HEAD /jobs/exists`
- call `POST /jobs`
- capture created/existing job IDs
- log duplicates / failures

### Phase 4 — Asynchronous enrichment hookup
- implement or connect a signal that new jobs are available for enrichment
- let Enrichment Core detect new jobs and book runs for configured user IDs
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
- per-job warnings:
  - missing company
  - suspicious empty description
  - missing or unresolvable origin URL
  - canonical identity fallback or failure
  - location parse fallback
  - API error
  - create rejected

Suggested per-job correlation fields:
- adzuna redirect URL
- resolved origin URL
- provider
- providerTenant
- externalId
- resulting jobId if any

## 16. Risks and mitigations

### 16.1 Adzuna snippet descriptions may be too poor for compatibility scoring
Mitigation:
- prove/disprove quickly with PoC,
- if poor, later add provider-page fetch or another provider before overinvesting.  
This risk is real because Adzuna documents descriptions as snippets.

### 16.2 False-positive merge in Jobs due to weak canonical identity extraction
Mitigation:
- prefer origin-link-based canonical identity,
- reuse the same canonical extraction logic as Jobs,
- track helper-drift risk if code duplication is introduced.

### 16.3 Missing or unstable origin links
Mitigation:
- surface origin-link resolution quality in PoC output,
- reject or quarantine jobs whose canonical identity cannot be derived with acceptable confidence,
- add fallback strategy only after inspecting real samples.

### 16.4 False positives in remote/Germany relevance
Mitigation:
- isolate heuristics in provider adapter,
- keep raw source location fields in diagnostics.

### 16.5 Too many enrichment runs if import volume grows
Mitigation:
- keep target user list explicit and small in the first version,
- later add proper Users-owned active-user selection endpoint,
- later add caps or batching inside Enrichment Core if needed.

### 16.6 Re-import due to checkpoint loss
Mitigation:
- rely on canonical identity preflight + create idempotency,
- importer can safely retry create attempts because Jobs create is intended to resolve duplicates to the existing job.

## 17. Open items deferred on purpose

- Users-owned `GET /users/active`
- user participation toggle for auto-enrichment
- provider-agnostic import framework
- full-text job detail fetching
- fuzzy dedupe endpoint in Jobs
- bulk create endpoint in Jobs
- source-specific confidence scoring
- provider provenance/history UI

## 18. Acceptance criteria

The milestone is done when:

1. A local PoC can fetch and print normalized Adzuna jobs for the last 24 hours for Germany and `Project Manager`.
2. An hourly Azure function can import Adzuna jobs using canonical identity derived from the origin job link.
3. Imported jobs are created by system actor, with no user status.
4. Imported jobs appear as shared open opportunities in existing UX.
5. Existing enrichment subsystem can react to newly created jobs and book compatibility runs asynchronously.
6. Compatibility scores eventually appear through the existing Jobs projection flow.

## 19. Recommended next implementation step

Start with **Phase 1 PoC only** and inspect 30–50 normalized rows before touching Azure Functions or enrichment-trigger plumbing. That is the cheapest way to test the most fragile assumptions in the whole plan: whether Adzuna’s free-tier payload is rich enough to be worth importing at all, and whether origin-link-based canonical identity can be recovered reliably from real samples.