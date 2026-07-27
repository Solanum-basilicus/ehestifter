# Archived Milestone: ATS Discovery for Ehestifter

**Status:** archived — Phases 0–7 and 9 completed; optional Phase 8 skipped  
**Completion date:** 2026-07-26  
**Final implementation location:** `scrapers/ats-discovery`  
**Creation provenance for new imports:** `foundOn = "ats-discovery"`  
**Accepted pre-Phase-9 validation baseline:** 355 scanner tests and 27 scheduler tests passing  
**Canonical steady-state architecture:** [`docs/system-design.md`](../../system-design.md)  
**Audience:** maintainers investigating implementation history, source attribution, and deferred decisions

This document is the archived implementation design and decision journal. Sections 1–13 preserve the planning-time architecture and implementation evidence, including references to the former working directory `scrapers/career-ops-scan`. Those historical references are intentional. The canonical product name, paths, ownership boundaries, and operator behavior now live in `docs/system-design.md` and `scrapers/ats-discovery/README.md`.

Phase 9 performed the product rename, integrated stable architecture into the master system design, archived this milestone, added a canonical scanner runbook and a repository layout validator, and retained historical run/canary evidence unchanged.

---

## 1. Goal

Build an Ehestifter-owned ATS discovery service that periodically finds recent job postings, applies cheap profile-derived filters, deduplicates through the Jobs API, enriches only useful candidates, and imports shared jobs without changing user application status.

The scanner should combine the strongest relevant ideas from existing open-source implementations without adopting either project as the product backend:

- [Career-Ops](https://github.com/santifer/career-ops) is a provider and scanner design reference and a source of selectively adapted provider implementations.
- [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator) is a provider-resilience reference and the source of curated ATS tenant catalogs for the current non-commercial project.
- Ehestifter owns orchestration, filtering, state, canonical identity integration, detail enrichment, persistence, compatibility scheduling, and UX.

The target end-state is:

1. A scheduled run selects discovery-eligible users and compounds their cheap search constraints into one scan plan.
2. ATS tenants are scanned once per run plan, not once per user.
3. Priority tenants are processed first; healthy catalog tenants are processed in rotating shards.
4. Provider-supported date filters are used with a bounded overlap window to reduce requests and stale results.
5. Candidate listings are filtered before expensive detail fetching and compatibility work.
6. Jobs API canonical identity is authoritative for deduplication.
7. Missing shared jobs are imported through Jobs API.
8. Compatibility is requested only for users whose profiles matched the candidate.
9. Users retain manual control over application status.
10. Materially different protocols within one ATS family have independent operational health, cooldowns, circuit breakers, and canaries.

This milestone preserves the vendor-agnostic boundary already established in Ehestifter:

```text
ATS sources and tenant catalogs
        ↓
Ehestifter ATS Discovery
        ↓
normalized candidate observations
        ↓
Jobs API canonical identity and persistence
        ↓
Enrichment Core compatibility per user
        ↓
existing Open opportunities UX
```

---

## 2. Reframed architecture decision

### 2.1 Ehestifter owns the scanner shape

ATS Discovery is not a wrapper around a complete Career-Ops checkout and is not a deployment of the job-board-aggregator ETL.

Ehestifter owns:

- scanner CLI and run lifecycle;
- provider adapter contract;
- candidate schema;
- tenant target planning;
- priority and disabled overrides;
- provider-specific request policy;
- provider-variant health partitions where one provider family contains materially different protocols;
- date lookback and overlap policy;
- runtime tenant health;
- cheap filtering;
- Jobs API preflight and create behavior;
- detail fetching;
- location normalization;
- health-only provider canaries;
- run artifacts and diagnostics;
- future multi-user matching and compatibility requests.

This lets the scanner keep a narrow contract appropriate to Ehestifter instead of inheriting unrelated CV, application, dashboard, publishing, chunking, or frontend concerns.

### 2.2 “Upstream” means monitored source repositories, not wholesale updates

For this milestone, an upstream project is a repository whose implementation is inspected and selectively adapted.

It does **not** mean that ATS Discovery should regularly perform a blind `git pull` and expect local patches to continue applying to the full project.

The desired maintenance model is:

1. Pin the source commit used for an adapted provider or algorithm.
2. Keep required attribution and license notices.
3. Record meaningful Ehestifter modifications.
4. Periodically inspect upstream changes.
5. Cherry-pick or manually port improvements that are relevant.
6. Validate the resulting provider with Ehestifter-owned tests, fixtures, and live canaries where appropriate.

Career-Ops remains a useful upstream because its provider layer continues to receive provider additions and operational fixes. job-board-aggregator remains a useful influence because its scraper contains practical rate-limit, retry, pagination, anomaly, and dead-tenant handling developed from broad runs.

### 2.3 The current copy script is bootstrap-only

The current script:

```text
scrapers/career-ops-scan/scripts/copy-upstream-providers.sh
```

was useful to reproduce the initial four-provider spike from a pinned Career-Ops revision.

It should now be treated as **bootstrap-only and pending deprecation**, because blindly replacing local provider files is not a safe long-term update strategy.

Do not remove it until a replacement exists. The replacement should be manifest-driven and should download a named provider at a named commit into a temporary location, show the diff, run tests, and update recorded provenance only after review.

### 2.4 Implementation language is not an architecture constraint

Most of Ehestifter is Python, while the current scanner is Node.js because the validated Career-Ops providers were JavaScript modules.

The scanner is containerized, so language consistency alone is not a sufficient reason to rewrite a working provider. New provider work should use the implementation with the lowest total maintenance cost.

Rules:

- keep the current Node.js scanner unless a measured problem justifies a rewrite;
- adapt a well-tested JavaScript provider directly when practical;
- port small Python algorithms when they are demonstrably better or are the only suitable reference;
- do not copy a monolithic scraper merely to gain a provider count;
- keep provider-specific code behind a stable Ehestifter contract.

### 2.5 Tenant catalogs and operator policy are separate inputs

Curated tenant catalogs from job-board-aggregator are valuable and should be reused under their CC BY-NC 4.0 terms for this non-commercial project.

They must not be manually merged into one enormous `portals.yml`.

Instead use layered input:

```text
machine-managed tenant catalogs
+ operator priority overrides
- operator disabled overrides
+ provider-specific patches
= ordered scan targets
```

Machine-managed catalogs and human-owned policy have different lifecycles and should not create giant diffs or overwrite one another.

Ashby catalog synchronization and planning are implemented. Phase 5B generalizes that machinery for Greenhouse, Lever, and Workday.

### 2.6 Priority policy and runtime health are independent

Operator policy:

```text
priority
normal
disabled
```

Runtime health:

```text
healthy
cooldown
temporarily_failed
suspected_dead
confirmed_dead
```

A priority tenant may be in cooldown. A normal tenant may be healthy. An operator-disabled tenant must never be re-enabled automatically.

Transient failures such as timeouts, `429`, `500`, `502`, `503`, malformed responses, and temporary WAF pages must not permanently disable a tenant.

Durable failures such as repeated `404` or `410` responses may move a tenant toward confirmed-dead state, but dead tenants should still be re-probed on a long interval because companies can change ATS configuration.

### 2.7 Provider family and health partition are distinct

A provider family may contain protocols with different failure modes. SuccessFactors currently has two operational partitions:

```text
provider family:  successfactors
health partition: successfactors:rmk
health partition: successfactors:csb
```

RMK uses server-rendered search pages. CSB uses a bootstrapped session, an embedded CSRF token, and a JSON listing API. A CSB authentication or schema failure must not open the RMK breaker or suppress RMK targets.

Health-partition identity is used for:

- provider circuit breakers;
- provider cooldowns;
- provider rate observations;
- tenant-state keys;
- planning and skip counters;
- provider-variant summaries and warnings.

Tenant-specific durable failures do not degrade the whole partition. Job-level outcomes such as an explicitly withdrawn detail page do not count as provider health errors.

### 2.8 Use provider-side date constraints when available

“New jobs since last run” is fuzzy because ATS APIs differ and some do not support an authoritative update cursor.

Nevertheless, ATS Discovery should use provider-supported date constraints when they reduce work or result volume.

Base policy:

```text
lookbackStart = lastSuccessfulRelevantScan - overlap
```

The overlap protects against clock skew, delayed publication, and uncertain posting timestamps. A practical initial overlap is 6–24 hours depending on provider behavior.

If a provider cannot filter by date, fetch the listing and apply the posting-age filter locally.

The project explicitly accepts a bounded risk that a job can fall through provider or timestamp cracks. The alternative—unbounded historical scanning every day—raises rate-limit and operational risk.

### 2.9 Scan tenants once, then match all users

Do not perform one ATS request per user.

Future multi-user flow:

```text
eligible user profiles
        ↓
compound cheap discovery constraints
        ↓
scan each selected tenant once
        ↓
apply user-specific cheap filters to each candidate
        ↓
retain candidate only if at least one user matches
        ↓
Jobs identity once
        ↓
detail fetch once
        ↓
create shared job once
        ↓
request compatibility for matched users
```

Jobs remain global. Compatibility and status remain per user.

---

## 3. Source projects and how they are used

### 3.1 Career-Ops

Reference: [santifer/career-ops](https://github.com/santifer/career-ops)

Initial pinned source used by the spike:

```text
career-ops-v1.20.0
493487462608c0cced82c1440e7ba8be6c01f306
```

Current uses:

- initial Greenhouse, Lever, Ashby, and Workday provider implementations;
- Personio, SmartRecruiters, Softgarden, and SuccessFactors provider implementations selectively adapted during Phase 5;
- scanner/provider contract ideas;
- title, location, and posting-age filter behavior;
- reference for liveness, retry, provider health, and scanner diagnostics improvements.

Not used for:

- CV generation;
- application automation;
- application tracker state;
- Ehestifter persistence;
- Ehestifter compatibility scoring;
- runtime workspace structure.

### 3.2 job-board-aggregator

Reference: [Feashliaa/job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator)

Current uses:

- Ashby tenant catalog under CC BY-NC 4.0;
- planned Phase 5B source catalogs for Greenhouse, Lever, and Workday;
- reference for provider-specific concurrency;
- retry and backoff behavior;
- rate-limit handling;
- pagination safeguards;
- durable versus transient tenant failure handling;
- broad-run anomaly and volume monitoring;
- reference implementations for ATSs not supported locally.

Not adopted wholesale because its Python scraper is a broad publishing ETL that combines concerns not required by Ehestifter, including public dataset generation, chunking, geolocation, classification, frontend data preparation, and repository publishing.

### 3.3 Attribution rule

Every derived provider or substantial algorithm must record:

- source repository;
- source file;
- pinned commit;
- upstream license;
- Ehestifter changes;
- test fixtures or acceptance evidence.

Catalog artifacts must record:

- source repository;
- source URL or path;
- fetch time;
- content hash;
- license;
- item count.

No commercial use is expected. If that assumption changes, the tenant-catalog license must be revisited before deployment or distribution.

---

## 4. Scope

### 4.1 In scope

- local Docker-based ATS scanner;
- Greenhouse, Lever, Ashby, and Workday providers;
- Personio, SmartRecruiters, Softgarden, and SuccessFactors RMK/CSB providers;
- external Ashby tenant catalog synchronization;
- Phase 5B catalog synchronization for Greenhouse, Lever, and Workday;
- operator priority and disabled overrides;
- ordered scan planning;
- rotating tenant shards;
- provider-specific concurrency and request pacing;
- provider-variant health partitions where required;
- bounded date lookback and overlap;
- transient-failure cooldown and dead-tenant re-probe;
- filter-independent provider canaries for high-risk protocols;
- silent-empty and volume-collapse detection;
- offline scan mode;
- Jobs API preflight mode;
- detail enrichment for missing jobs;
- conservative location normalization;
- guarded import mode;
- replay-safe create reconciliation;
- run artifacts and diagnostics;
- future multi-user profile compounding;
- future compatibility requests;
- local scheduled execution;
- optional GCP Cloud Run Job deployment after local behavior is understood.

### 4.2 Explicitly out of scope for this milestone

- consuming the generated job-board-data chunk feed;
- deploying the complete Career-Ops application;
- deploying the complete job-board-aggregator ETL;
- direct SQL writes across Ehestifter domains;
- direct compatibility projection writes;
- automatic job application;
- automatic application-status creation;
- per-user scanner execution against the same tenant;
- unrestricted full-catalog import in one run;
- self-adjusting rate algorithms before basic metrics exist;
- commercial use of CC BY-NC tenant catalogs;
- adding BambooHR, iCIMS, or Paylocity provider ingestion;
- building tenant catalogs for Personio, SmartRecruiters, Softgarden, or SuccessFactors;
- catalog ingestion for unsupported providers;
- automatic catalog refresh before Phase 7 scheduling exists.

The unsupported-provider ingestion and missing-catalog limitations are tracked in project issues [#3](https://github.com/Solanum-basilicus/ehestifter/issues/3) and [#4](https://github.com/Solanum-basilicus/ehestifter/issues/4).

### 4.3 Deferred cross-domain and data-quality issues

- [Issue #1](https://github.com/Solanum-basilicus/ehestifter/issues/1): richer location normalization and location evidence available only after detail enrichment.
- [Issue #2](https://github.com/Solanum-basilicus/ehestifter/issues/2): Jobs canonical identity parsing for SuccessFactors CSB URLs.

Issue #2 remains owned by Jobs. ATS Discovery preserves the provider-native requisition ID in provenance and does not manufacture canonical identity. Existing slug-derived identities may differ from corrected numeric identities after the Jobs fix; that mismatch is expected and accepted. A migration is not required for this hobby project unless real data demonstrates material impact.

---

## 5. Existing ownership constraints

Preserve these invariants:

- Jobs API owns canonical identity, duplicate handling, persistence, and shared job records.
- Users API owns user and CV facts.
- Enrichment Core owns compatibility request lifecycle and projection dispatch.
- Discovery does not write directly to another domain’s tables.
- Discovery does not create user application status.
- Provider identity is required for imported jobs.
- The job is global; compatibility and status are per user.
- `foundOn` records the creation channel, not every later observation source.
- Provider-native identity and acquisition provenance remain scanner evidence even when Jobs returns a different canonical provider representation.

For current Jobs integration, URL preflight remains authoritative:

```text
GET /jobs/exists?url=<origin-url>
```

The response supplies canonical:

```text
provider
providerTenant
externalId
identitySource
```

Job creation remains:

```text
POST /jobs
```

with system actor headers and scanner provenance.

---

## 6. Current implementation baseline — completed through Phase 5

### 6.1 Phase 0 and Phase 1 baseline

The Career-Ops scanner was inspected and Option C—an Ehestifter-owned runner using extracted provider/filter code—was selected.

The completed controlled scanner includes:

- Docker image and Compose service;
- JSON and YAML runtime configuration;
- CLI modes for offline, preflight, and guarded import;
- Greenhouse, Lever, Ashby, and Workday providers;
- local run artifacts under `/data/runs`;
- Jobs API secret mounted as a file;
- Jobs URL identity preflight;
- bounded detail enrichment;
- conservative location normalization;
- guarded, capped, replay-safe import;
- ambiguous create reconciliation;
- idempotent live import canaries;
- no requirement for Node/npm on the host.

Canonical Docker test command:

```bash
LOCAL_UID="$(id -u)" \
LOCAL_GID="$(id -g)" \
docker compose run --rm \
  --no-deps \
  --entrypoint node \
  career-ops-scan \
  --test
```

### 6.2 Phase 2 — Ashby catalog and target planner — completed

Implemented:

- machine-managed `/data/catalogs/ashby.json`;
- atomic catalog synchronization and metadata/hash validation;
- operator-owned priority and disabled overrides;
- provider discovery policy;
- ordered target planning;
- priority targets before catalog targets;
- bounded Ashby catalog shards;
- `target-plan.json` and `provider-results.json`;
- offline-only catalog execution during initial rollout;
- protection against catalog refresh overwriting operator policy.

### 6.3 Phase 3 — provider-aware scheduling and health — completed

Implemented:

- persistent `/data/state/tenant-state.json`;
- priority cadence and rotating healthy shards;
- relevant-activity promotion;
- empty-board demotion;
- transient cooldowns;
- repeated `404`/`410` progression to suspected and confirmed dead;
- monthly dead-board re-probe;
- bounded per-target lookback with overlap;
- provider concurrency and request-start pacing;
- provider circuit breakers for rate limits and transient failures;
- rate and latency observations;
- operator-reviewed rate recommendations;
- sweep-budget diagnostics;
- `tenant-state-changes.json` and `rate-observations.json`.

Manual preflight and import remain priority-only and bypass stateful cadence. Stateful scheduling applies to offline runs.

### 6.4 Phase 4 — bounded catalog-backed preflight and import — completed

Implemented:

- explicit `--catalog-targets N` gate;
- mode-specific live-catalog configuration ceilings;
- hard code ceiling on live catalog targets;
- catalog-only preflight and import metrics;
- details fetched only for Jobs-missing candidates;
- small explicit import caps;
- replay-safe reconciliation;
- location-scope rejection before Jobs traffic;
- TTY-only progress display with `--no-progress` override.

Catalog-backed Jobs traffic remains opt-in and bounded.

### 6.5 Phase 5 — DACH-relevant provider expansion — completed

Accepted providers and live evidence:

| Provider path | Listing | Detail | Notes |
|---|---|---|---|
| Personio | Passed | Passed from listing data | XML listing feed supplies descriptions |
| SmartRecruiters | Passed | Passed through posting detail API | Live preflight produced detail-ready missing candidates |
| Softgarden | Passed | Passed through `JobPosting` JSON-LD | NECT returned 13 jobs; retained candidates received descriptions and structured Hamburg/Deutschland locations |
| SuccessFactors RMK | Passed | Passed through bounded HTML fallback | EY returned 25 jobs; retained candidates received 4–5.5 KB descriptions |
| SuccessFactors CSB | Passed | Route and safe failure classification validated | Gore listing returned 57–61 jobs through session/CSRF API; selected detail rows were explicitly withdrawn |

Phase 5 additionally implemented:

- provider-specific URL detection and tenant identity;
- provider-specific pagination and request bounds;
- pinned source provenance per provider;
- same-origin detail protections;
- boundary-safe Unicode title/location keyword matching;
- Softgarden current vacancies parsing with fallback behavior;
- SuccessFactors RMK HTML detail extraction when JSON-LD is absent;
- SuccessFactors CSB bootstrap using `JSESSIONID` and the CSRF token embedded in `$.ajaxSetup`;
- CSB API request payload and one-refresh retry;
- CSB public-listing fallback and explicit acquisition modes;
- target-local and detail-stage session handling;
- explicit withdrawn-job classification.

### 6.6 SuccessFactors variant-health hardening — completed

SuccessFactors operational health is partitioned into:

```text
successfactors:rmk
successfactors:csb
```

Implemented:

- partition-specific execution guards, circuit breakers, cooldowns, rate observations, state, and summaries;
- first-run migration of legacy shared SuccessFactors tenant state into the detected variant;
- intentional retirement of the ambiguous shared SuccessFactors cooldown;
- filter-independent provider canaries that never call Jobs and never enter import candidates;
- shared provider fetch when a tracked target and canary resolve to the same tenant/variant;
- CSB explicit-empty, schema, authentication, and nonempty outcome telemetry;
- rolling per-tenant listing-volume baselines;
- one-hour re-probe after a suspicious zero or at least 90% volume collapse;
- confirmation of a new lower baseline after two fresh matching results;
- separate listing and detail canary outcomes;
- withdrawn-only detail samples classified as `inconclusive`, visible but non-degrading;
- provider-variant warnings and notices in `summary.json`;
- nonzero exit status for degraded health or invalid enabled canary configuration.

A stateful validation run showed:

```text
successfactors:csb: healthy
jobsReturned: 61
listingOutcome: listing_success_nonempty
providerHealthWarnings: []
```

RMK remains independently schedulable if CSB degrades.

### 6.7 Current test baseline

The current repository-wide scanner suite passes:

```text
297 tests
297 pass
0 fail
```

This is the baseline before Phase 5B.

---

## 7. Target component model

```text
catalog synchronizers
        ↓
machine-managed provider catalogs
        ↓
target planner ← operator overrides and provider canaries
        ↓
provider-aware scheduler, health partitions, and tenant state
        ↓
provider adapters
        ↓
shared candidate filters
        ↓
Jobs preflight
        ↓
detail enrichment
        ↓
location normalization
        ↓
guarded import
        ↓
future per-user compatibility requests
```

### 7.1 Catalog synchronizers

Current implementation:

- Ashby catalog synchronization;
- atomic writes;
- source metadata, item count, and SHA-256;
- previous valid catalog retained when refresh fails;
- independent manual command.

Phase 5B extends the same contract to:

```text
data/catalogs/greenhouse.json
data/catalogs/lever.json
data/catalogs/workday.json
```

Catalogs are machine-managed. Operators should not hand-edit them.

Provider-specific validation is required. Workday catalog entries must preserve the structured host, tenant, and career-site identity needed by the adapter rather than being flattened into an ambiguous string.

### 7.2 Operator policy

Operator-owned inputs currently include:

```text
config/portals.yml
config/company-overrides.yml
config/discovery-policy.yml
```

Policy responsibilities:

- tracked companies and cheap filters;
- priority and disabled tenants;
- provider-specific target patches;
- provider budgets and request limits;
- canary definitions and thresholds.

Priority entries may refer to catalog tenants or define a tenant not yet present in a catalog. Disabled entries always win.

### 7.3 Discovery policy

Provider policy contains independent controls for:

- enablement;
- normal-target budget;
- cadence;
- concurrency;
- minimum request interval;
- page caps;
- lookback and overlap;
- breaker thresholds;
- silent-empty monitoring defaults.

Do not use one shared normal-target budget as the only control once multiple provider catalogs exist. Greenhouse, Lever, Ashby, and Workday have different request costs and should have independent bounded shards under a global hard ceiling.

### 7.4 Target planner

Input:

- provider catalogs;
- tracked companies;
- provider canaries;
- operator priority and disabled lists;
- provider policy;
- tenant runtime state;
- provider-variant cooldowns;
- current run budget;
- future compounded user profile constraints.

Output is an ordered `target-plan.json` containing explicit source mode, provider variant, health partition, scheduling reason, and lookback.

Ordering:

1. due provider canaries and operator priority tenants;
2. recently active tenants due for scan;
3. healthy normal provider shards;
4. long-empty tenants due for occasional scan;
5. suspected/confirmed-dead re-probes.

Disabled tenants are omitted. Provider shards must be allocated independently so one large catalog cannot starve the others indefinitely.

### 7.5 Tenant runtime state

State is scanner-owned and separate from operator policy.

Representative fields:

```json
{
  "schemaVersion": 1,
  "provider": "successfactors",
  "providerVariant": "csb",
  "healthPartition": "successfactors:csb",
  "tenant": "wlgore.jobs.hr.cloud.sap",
  "lastAttemptAtUtc": null,
  "lastSuccessfulAtUtc": null,
  "lastRelevantCandidateAtUtc": null,
  "lastResultCount": null,
  "lastNonEmptyAtUtc": null,
  "recentSuccessfulCounts": [],
  "consecutiveFailures": 0,
  "lastHttpStatus": null,
  "health": "healthy",
  "cooldownUntilUtc": null,
  "nextEligibleScanAtUtc": null,
  "lastErrorClass": null
}
```

`lastRelevantCandidateAtUtc` means a posting passed scanner cheap filters. It does not claim Jobs proved the posting globally new.

### 7.6 Provider adapter contract

Current provider adapters expose the minimum stable interface required by ATS Discovery:

```js
{
  id,
  source,
  capabilities,
  detect(entry),
  tenant(entry),
  sourceOrigin(entry),
  fetch(entry, httpContext)
}
```

Provider-specific behavior belongs in provider modules:

- URL construction and target detection;
- variant detection where applicable;
- pagination;
- supported server-side date filters;
- posting timestamp extraction;
- rate-limit signal interpretation;
- durable versus transient errors;
- provider-native structured locations;
- list versus detail endpoint behavior;
- acquisition mode and safe protocol diagnostics.

Shared behavior must not be duplicated inside providers:

- Jobs preflight;
- create reconciliation;
- scanner provenance;
- generic title/location filtering;
- import caps;
- artifact writing;
- user matching.

### 7.7 Provider canaries

A provider canary is a priority health-only target. It:

- bypasses title, location, posting-age, salary, and content filters;
- does not call Jobs preflight;
- is never submitted to import;
- may sample a bounded number of details;
- uses normal offline cadence and runtime state;
- shares a fetch with a matching tracked target when possible.

Canaries are appropriate for protocols where a response can appear healthy while silently returning no parseable jobs.

Current CSB protections distinguish:

```text
listing_success_nonempty
listing_success_explicit_empty
listing_empty_anomaly
listing_volume_anomaly
listing_schema_error
listing_auth_error
listing_transport_error
```

A historically nonempty CSB tenant receives a short re-probe after zero jobs or a drop of at least 90% from its rolling baseline. A repeated fresh result may establish a new lower baseline.

---

## 8. Scan cadence and rate strategy

### 8.1 Initial cadence objectives

The scanner is primarily local, so cloud compute cost does not dictate cadence. Timeliness and respectful source behavior do.

Current objectives:

```text
priority tenants:
  daily, processed first

provider protocol canaries:
  daily unless evidence supports a different cadence

recently active normal tenants:
  daily or every 48 hours

healthy normal catalog tenants:
  rotating shards targeting a complete sweep within 2–3 days

long-empty healthy tenants:
  gradually reduce toward weekly

suspected or confirmed dead tenants:
  monthly re-probe

suspicious zero or severe volume collapse:
  fresh-session re-probe after approximately one hour
```

A two-week default for all healthy normal tenants is rejected because relevant postings may be stale before discovery.

The exact sweep target is empirical. If source limits make a 2–3 day sweep unsafe, the system should reduce rate, preserve priority coverage, and report the resulting delay explicitly.

### 8.2 Circuit breaking

Circuit breakers operate by health partition where required.

Examples:

```text
ashby
workday
successfactors:rmk
successfactors:csb
```

A partition breaker may stop or pause work after:

- repeated `429` responses;
- elevated transient error rate;
- sustained latency increase;
- provider-specific anti-bot response;
- pagination anomaly;
- unexpected response-schema failure;
- repeated authentication/bootstrap failure.

A CSB breaker must not disable RMK. A tenant failure must not disable the whole partition unless evidence indicates a partition-wide problem. Repeated tenant `404`/`410` results remain tenant-level durable failures.

### 8.3 Rate tuning

Start with explicit static limits and measured diagnostics.

Record per provider and health partition:

- targets planned, attempted, and skipped;
- requests and successful responses;
- `429` count;
- transient and durable errors;
- p50/p95 latency;
- jobs returned;
- listing outcomes and anomalies;
- candidates retained;
- tenants skipped by cooldown;
- breaker activations;
- canary health.

Initial tuning remains semi-automatic:

1. scanner records evidence;
2. summary recommends increasing, retaining, or decreasing limits;
3. operator changes policy;
4. later, bounded additive-increase/multiplicative-decrease may be added behind strict caps.

Do not implement autonomous rate tuning before several real runs provide a baseline.

---

## 9. Candidate and observation model

Candidate acquisition source must not leak into the downstream Jobs contract, but scanner provenance must retain enough evidence to diagnose acquisition.

Example normalized candidate:

```json
{
  "schemaVersion": 1,
  "sourceMode": "catalog",
  "sourceProvider": "greenhouse",
  "sourceTenant": "celonis",
  "sourceCompany": "Celonis",
  "url": "https://job-boards.greenhouse.io/celonis/jobs/7798592003",
  "applyUrl": null,
  "foundOn": "ats-discovery",
  "canonicalIdentity": null,
  "existingJobId": null,
  "title": "Application Product Manager - AI System Transformations",
  "hiringCompanyName": "Celonis",
  "postingCompanyName": null,
  "rawLocation": "Munich, Germany",
  "locations": [],
  "remoteType": null,
  "description": null,
  "postedAtUtc": null,
  "provenance": {
    "providerNativeId": "7798592003",
    "sourceOrigin": "https://job-boards.greenhouse.io",
    "acquisitionMode": "greenhouse-api",
    "providerImplementation": {
      "repository": "santifer/career-ops",
      "file": "providers/greenhouse.mjs",
      "ref": "...",
      "license": "MIT"
    },
    "catalog": {
      "repository": "Feashliaa/job-board-aggregator",
      "sha256": "..."
    }
  }
}
```

The shared `JobOffering.FoundOn` field is insufficient to represent every observation. Future analytics should keep discovery-run observations separately if source coverage, match rates, repeated sightings, or acquisition-mode health need analysis.

---

## 10. Multi-user filtering design

### 10.1 Eligible user input

Future Users endpoint:

```text
GET /users/internal/discovery-eligible
```

Base eligibility:

```text
usable plaintext CV
AND discovery enabled
AND not a configured test user
```

### 10.2 Compounded scan profile

Build cheap user constraints such as:

- title include/exclude terms;
- seniority ranges;
- allowed countries/cities;
- remote/hybrid/on-site constraints;
- language or market requirements when reliable;
- explicit company preference/block lists.

The provider scan plan uses the union of constraints needed by at least one eligible user.

Each candidate records the set of users passing cheap filters. Candidates matching no users are rejected before Jobs detail and compatibility work.

### 10.3 Expensive work boundaries

For a candidate matching at least one user:

1. canonical identity preflight once;
2. detail fetch once if missing and new;
3. shared job create once;
4. compatibility request for each matched user when needed.

Do not fetch the same description or create the same shared job separately for each user.

---

## 11. Provider and catalog roadmap

Provider count is not an acceptance criterion. Data quality, relevance, operational safety, and maintenance cost are.

### 11.1 Accepted providers

- Greenhouse;
- Lever;
- Ashby;
- Workday;
- Personio;
- SmartRecruiters;
- Softgarden;
- SuccessFactors RMK;
- SuccessFactors CSB.

### 11.2 Phase 5B catalog expansion

Add machine-managed catalogs for providers already accepted locally and supported by the selected upstream catalog source:

- Greenhouse;
- Lever;
- Workday.

Ashby remains the proven catalog baseline.

Phase 5B must generalize catalog synchronization and planning rather than creating three unrelated copies of Ashby-specific code.

### 11.3 Deferred providers and catalogs

Out of scope for this milestone:

- BambooHR ingestion;
- iCIMS ingestion;
- Paylocity ingestion;
- Personio tenant catalog discovery;
- SmartRecruiters tenant catalog discovery;
- Softgarden tenant catalog discovery;
- SuccessFactors tenant catalog discovery.

These limitations are tracked in issues #3 and #4.

### 11.4 Provider acceptance matrix

| Capability | Requirement |
|---|---|
| Stable origin URL | Required |
| Canonical identity derivable by Jobs | Required, or an explicit cross-domain issue and import guard must exist |
| Provider-native identity retained in provenance | Required |
| Title | Required |
| Hiring company | Required |
| Description or reliable detail route | Required before compatibility/import |
| Posting date | Strongly preferred |
| Location | Strongly preferred |
| Bounded pagination | Required |
| Known request policy | Required |
| Durable/transient failure distinction | Required |
| Variant health isolation | Required when a provider family contains materially different protocols |
| Silent-empty protection or canary | Required for protocols that can fail with superficially successful responses |
| Tests or fixtures | Required |
| Attribution and pinned origin | Required when derived |

---

## 12. Artifacts and observability

Every run should retain enough evidence to diagnose source, planning, health, filtering, and Jobs behavior without replaying live requests.

Implemented artifacts:

```text
metadata.json
summary.json
target-plan.json
provider-results.json
provider-canary-results.json        when canaries are evaluated
candidates.json
rejected.json
preflight-results.json
detail-results.json
location-results.json
import-results.json
tenant-state-changes.json
rate-observations.json
```

Future artifact:

```text
user-match-results.json
```

Summary currently reports:

- targets planned, attempted, and skipped;
- priority, canary, normal, and catalog counts;
- provider and provider-variant health;
- partition-specific planning and cooldown skips;
- provider errors, rate limits, and breaker activation;
- listing outcomes, empty anomalies, and volume anomalies;
- provider canary healthy/degraded/inconclusive counts;
- raw jobs and retained candidates;
- rejection reasons;
- preflight existing/missing/errors;
- detail outcomes;
- location normalization outcomes;
- import outcomes;
- catalog source/hash/count;
- effective lookback window;
- tenant-state and re-probe changes;
- rate recommendations.

Future multi-user summaries should add:

- user cheap-match counts;
- per-user candidate counts;
- compatibility requests and outcomes.

Avoid logging secrets, cookies, CSRF tokens, CV content, or full sensitive user profiles.

---

## 13. Runtime and deployment

### 13.1 Local first

Local Docker remains the primary implementation and experimentation environment.

Advantages:

- no marginal cloud compute charge;
- easier long-running broad scans;
- direct observation of provider behavior;
- simple access to local state and artifacts;
- safe tuning before cloud scheduling.

### 13.2 Local scheduling

Phase 7 adds a host timer or lightweight local scheduler that starts a run-to-completion container once per day.

Requirements:

- prevent overlapping runs with a global lock;
- recover stale locks;
- retain state backups and bounded artifacts;
- schedule catalog refresh independently from scan execution;
- expose degraded provider-variant and canary results as operator-visible failures.

### 13.3 GCP Cloud Run Job later

Cloud Run Job remains optional for portability and operational experience.

Do not move broad scans to GCP until measurements establish:

- expected run duration;
- request volume;
- memory use;
- catalog size;
- provider rate behavior;
- required durable state;
- acceptable cost.

A future cloud deployment may scan priority or bounded shards while the local runner handles broader discovery.

---

## 14. Rename and documentation integration — completed

Phase 9 completed the deferred product cleanup:

```text
scrapers/career-ops-scan
→ scrapers/ats-discovery
```

Active product identifiers were changed consistently:

```text
Compose service:     ats-discovery
local image:         ehestifter/ats-discovery:local
npm package:         @ehestifter/ats-discovery
new-job provenance:  foundOn = "ats-discovery"
```

The migration deliberately moved the complete scanner directory before rewriting active text. This preserved ignored local configuration, secrets, catalogs, tenant/scheduler state, backups, and run artifacts. Historical run artifacts and already-created canary jobs were not rewritten.

Installed systemd units were treated as an operational dependency because their rendered `WorkingDirectory` and Compose command contain the scanner path/service. The operator procedure therefore uninstalls old units before the rename and reinstalls them from the canonical path after validation.

Career-Ops and job-board-aggregator attribution remains source attribution. The product rename does not remove source repository, pinned revision, license, catalog provenance, or Ehestifter-change records. `scripts/copy-upstream-providers.sh` is explicitly marked bootstrap-only.

The steady-state documentation shape is now:

```text
docs/system-design.md
  canonical as-is architecture and ownership rules

scrapers/ats-discovery/README.md
  current component architecture, config, operations, tests, and limitations

docs/archive/milestones/ats-discovery.md
  this historical milestone design and decision journal
```

## 15. Final phase ledger

### Phase 0 — approach validation — complete

Career-Ops and job-board-aggregator were inspected; an Ehestifter-owned scanner with selectively adapted providers/catalogs was chosen instead of deploying either complete upstream application.

### Phase 1 — controlled tracked scanner — complete

Docker scanner, initial providers, offline/preflight/import modes, Jobs canonical-identity integration, bounded detail/location processing, replay-safe create reconciliation, artifacts, and live canaries were implemented.

### Phase 2 — Ashby catalog and target planner — complete

Machine-managed catalog synchronization, operator priority/disabled policy, deterministic planning, catalog artifacts, and atomic refresh were implemented.

### Phase 3 — provider-aware scheduling and health — complete

Persistent tenant health/cadence state, rotating shards, promotion/demotion, cooldown/dead re-probe, request pacing, circuit breaking, lookback overlap, and rate diagnostics were implemented.

### Phase 4 — bounded catalog-backed live operation — complete

Explicit live catalog gates, catalog target ceilings, missing-only detail, guarded create caps, replay-safe reconciliation, and progress/summary diagnostics were implemented.

### Phase 5 — DACH provider expansion and protocol hardening — complete

Personio, SmartRecruiters, Softgarden, and SuccessFactors RMK/CSB were accepted with fixtures/live evidence. SuccessFactors variant health isolation, CSB session/CSRF behavior, canaries, silent-empty/volume-collapse protection, and detail outcome classification were implemented.

### Phase 5B — Greenhouse, Lever, and Workday catalogs — complete

The catalog contract/synchronizer was generalized; provider-specific catalog identities and validation were added; per-provider deterministic budgets under the global ceiling prevent catalog starvation; bounded offline and explicit live gates were preserved.

### Phase 6 — multi-user discovery — complete

Users gained a bounded discovery-eligible endpoint. The scanner compounds eligible profiles into one scan, tracks matched users per candidate, imports a shared job once, and requests compatibility per matched user without creating status. CV text remains outside the discovery-profile contract.

### Phase 7 — scheduled operations — complete

System-level persistent timers, latest-slot catch-up, remaining boot grace, `flock` mutual exclusion, bounded retries, degraded completion semantics, scheduler/tenant-state backups, retention, status commands, and independent catalog refresh were implemented.

### Phase 8 — optional GCP Cloud Run Job — skipped

No Cloud Run Job was introduced. Local Docker/systemd remains the accepted runtime until measurements and a concrete operational need justify cloud execution and durable cloud state.

### Phase 9 — documentation, validation, and cleanup — complete

The canonical rename, system-design integration, milestone archival, root/component README cleanup, bootstrap-helper warning, migration tooling, and repository-layout validation were implemented. Phase 9 intentionally does not alter provider, matching, Jobs, import, compatibility, or scheduler algorithms.

## 16. Acceptance outcome

The milestone acceptance criteria are met with the following explicit qualifications:

- Jobs remains authoritative for canonical identity and persistence.
- Jobs and compatibility work are shared/bounded as designed; application status remains manual.
- Provider families with materially different protocols use isolated health partitions.
- High-risk protocols retain health-only canaries and silent-empty protection.
- Catalogs and operator policy remain separate.
- Imports remain capped, replay-safe, and idempotent.
- Derived providers/catalogs retain source attribution and revisions.
- Local scheduling exposes degraded health and catches up the latest due slot after boot/resume.
- The product is named ATS Discovery in active code/config/docs.
- Phase 8 is not required for milestone completion.

Accepted limitations:

- direct Compose commands bypass the host lock;
- no external notification channel exists;
- timers do not wake sleeping hardware;
- schedule/retry changes require reinstalling rendered units;
- the local node cannot discover vacancies while powered off;
- rootless Docker needs operator-specific adaptation;
- unsupported providers/catalogs and richer cross-domain identity/location work remain deferred.

## 17. Deferred issues and future work

The milestone does not absorb unrelated domain fixes or provider expansion:

- [Issue #1](https://github.com/Solanum-basilicus/ehestifter/issues/1): richer location normalization/evidence.
- [Issue #2](https://github.com/Solanum-basilicus/ehestifter/issues/2): Jobs canonical identity for SuccessFactors CSB URLs.
- [Issue #3](https://github.com/Solanum-basilicus/ehestifter/issues/3): unsupported provider ingestion.
- [Issue #4](https://github.com/Solanum-basilicus/ehestifter/issues/4): missing provider tenant catalogs.

A later milestone may consider Cloud Run Job execution, external notifications, stronger lock enforcement inside the container entrypoint, or additional provider/catalog coverage. Those changes must preserve the ownership, traffic-bounding, attribution, and no-status rules recorded in the master system design.

## 18. References

- [Career-Ops repository](https://github.com/santifer/career-ops)
- [Career-Ops providers](https://github.com/santifer/career-ops/tree/main/providers)
- [Career-Ops release used for the initial extraction](https://github.com/santifer/career-ops/releases/tag/career-ops-v1.20.0)
- [job-board-aggregator repository](https://github.com/Feashliaa/job-board-aggregator)
- [job-board-aggregator scraper](https://github.com/Feashliaa/job-board-aggregator/blob/main/scripts/scraper.py)
- [job-board-aggregator tenant catalogs](https://github.com/Feashliaa/job-board-aggregator/tree/main/data)
- [job-board-aggregator license](https://github.com/Feashliaa/job-board-aggregator/blob/main/LICENSE)
- [Ehestifter issue #1](https://github.com/Solanum-basilicus/ehestifter/issues/1)
- [Ehestifter issue #2](https://github.com/Solanum-basilicus/ehestifter/issues/2)
- [Ehestifter issue #3](https://github.com/Solanum-basilicus/ehestifter/issues/3)
- [Ehestifter issue #4](https://github.com/Solanum-basilicus/ehestifter/issues/4)