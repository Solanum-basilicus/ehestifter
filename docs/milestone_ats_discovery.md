# Milestone Design: ATS Discovery for Ehestifter

**Status:** active milestone, reframed after the local scanner spike
**Previous framing:** Career-Ops powered job discovery
**Primary implementation location today:** `scrapers/career-ops-scan`
**Planned final name before merge:** `scrapers/ats-discovery`
**Planned creation provenance:** `foundOn = "ats-discovery"`
**Audience:** coding agents and human operators continuing implementation

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
- date lookback and overlap policy;
- runtime tenant health;
- cheap filtering;
- Jobs API preflight and create behavior;
- detail fetching;
- location normalization;
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
6. Validate the resulting provider with Ehestifter-owned tests and fixtures.

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

### 2.7 Use provider-side date constraints when available

“New jobs since last run” is fuzzy because ATS APIs differ and some do not support an authoritative update cursor.

Nevertheless, ATS Discovery should use provider-supported date constraints when they reduce work or result volume.

Base policy:

```text
lookbackStart = lastSuccessfulRelevantScan - overlap
```

The overlap protects against clock skew, delayed publication, and uncertain posting timestamps. A practical initial overlap is 6–24 hours depending on provider behavior.

If a provider cannot filter by date, fetch the listing and apply the posting-age filter locally.

The project explicitly accepts a bounded risk that a job can fall through provider or timestamp cracks. The alternative—unbounded historical scanning every day—raises rate-limit and operational risk.

### 2.8 Scan tenants once, then match all users

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
- scanner/provider contract ideas;
- title, location, and posting-age filter behavior;
- reference for additional providers such as SuccessFactors, Personio, SmartRecruiters, Softgarden, Workable, Teamtailor, Recruitee, Avature, and Phenom;
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

- curated tenant catalogs under CC BY-NC 4.0;
- reference for provider-specific concurrency;
- retry and backoff behavior;
- rate-limit handling;
- pagination safeguards;
- durable versus transient tenant failure handling;
- broad-run anomaly and volume monitoring;
- reference implementations for ATSs not yet supported locally.

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
- Greenhouse, Lever, Ashby, and Workday providers already validated in the scanner;
- selective adoption of additional ATS providers;
- external tenant catalog synchronization;
- operator priority and disabled overrides;
- ordered scan planning;
- rotating tenant shards;
- provider-specific concurrency and request pacing;
- bounded date lookback and overlap;
- transient-failure cooldown and dead-tenant re-probe;
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

### 4.2 Out of scope

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
- SuccessFactors implementation before the core catalog planner and scheduler are stable.

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

## 6. Current implementation baseline — completed

The completed work remains valid under the new framing.

### 6.1 Approach-validation spike completed

The Career-Ops scanner was inspected and Option C—an Ehestifter-owned runner using extracted provider/filter code—was selected.

Reasons confirmed by the spike:

- `scan.mjs` was coupled to Career-Ops tracker, pipeline, history, and plugin concerns;
- direct wrapper output was not the cleanest contract for Ehestifter;
- provider modules returned enough data to form useful candidates;
- Jobs URL identity could canonicalize Greenhouse and Ashby candidates;
- descriptions could be fetched through provider detail endpoints.

### 6.2 Scanner skeleton completed

Current location:

```text
scrapers/career-ops-scan
```

Implemented components include:

- Docker image and Compose service;
- JSON runtime configuration;
- small `portals.yml` source list;
- CLI modes for offline, preflight, and guarded import;
- local run artifacts under `/data/runs`;
- Jobs API secret mounted as a file;
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

### 6.3 Initial provider set completed

The scanner currently loads:

- Greenhouse;
- Lever;
- Ashby;
- Workday.

Initial live tracked targets:

- Celonis through Greenhouse;
- n8n through Ashby;
- one additional configured target used by the scan plan.

### 6.4 Offline scanning completed

Observed controlled runs produced three relevant candidates after title, location, and posting-age filtering:

- two Celonis “Application Product Manager - AI System Transformations” postings;
- one n8n “AI Product Manager” posting.

Rejected counts varied slightly between runs because upstream boards changed, but filtering behavior remained consistent.

### 6.5 Jobs identity preflight completed

Jobs API returned canonical identities:

```text
greenhouse / celonis / 7798592003
greenhouse / celonis / 7788415003
ashby / n8n / 42e72645-d99a-4545-97b7-53ba3a699893
```

The scanner keeps Jobs canonical identity separate from URL-derived company/provenance hints.

Candidate provenance remains scanner-owned and is not overwritten by the Jobs inference response.

### 6.6 Detail enrichment completed

Implemented:

- conservative HTML-to-plain-text conversion;
- Greenhouse detail endpoint fetching;
- Ashby board endpoint fetching;
- one-request Ashby board cache;
- fetch-only-for-missing behavior;
- skip details for jobs already present in Ehestifter;
- bounded detail concurrency and per-run fetch cap;
- `detail-results.json` artifacts.

Validated descriptions were approximately 9 KB of readable text for all three canaries.

Ashby enrichment also supplied:

- application URL;
- remote type;
- structured Berlin/Germany location.

### 6.7 Guarded import completed

Implemented:

- explicit config gate `imports.enabled`;
- required CLI cap `--max-create N`;
- config ceiling `imports.maxCreatesPerRun`;
- system actor/source headers;
- create payload validation;
- conservative location deduplication;
- sequential create attempts;
- retry only for ambiguous/retryable failures;
- reconciliation through `GET /jobs/exists` after ambiguous POST outcomes;
- detailed import dispositions and `import-results.json`.

The first live canary imported one job and displayed correctly in Ehestifter with:

```text
title: correct
company: correct
description: present
foundOn: career-ops-scan
```

Three bounded runs imported all three candidates. A fourth run found all three as existing and created no duplicates.

Final observed shared job IDs:

```text
8954057d-e68c-4740-b798-a6a3cba50614
08647249-8be0-4a31-abd6-d651ae1ef1bc
f61c3482-b61c-4792-abe2-72359da312c7
```

### 6.8 Jobs create hardening completed

The Jobs service was hardened before live import:

- duplicate-key handling was narrowed to relevant uniqueness failures;
- location request rows were normalized and deduplicated;
- location inserts became idempotent against both city and no-city unique indexes.

This prevents scanner retries or duplicate location entries from failing a valid job create path.

### 6.9 Conservative location normalization completed

Implemented after detail enrichment:

- preserve provider-native structured locations;
- parse exact `City, Country` values for explicitly supported countries;
- parse exact country-only and `Remote, Country` scope;
- reject ambiguous multi-location strings;
- never infer a country from a city alone;
- write `location-results.json` and summary metrics.

Validated preflight result:

```text
Munich, Germany
→ Germany / DE / Munich
```

The n8n raw multi-country value remained unparsed rather than generating guessed locations.

### 6.10 Metrics clarification completed

The misleading `missingDescriptions` metric was split into:

```text
candidateDescriptionsMissing
missingDescriptionsForImport
```

Existing jobs can legitimately have no description in the current run object because detail fetching is skipped. That must not be reported as an import blocker.

### 6.11 Confirmed test evidence

The last explicitly recorded test run before location-normalizer additions passed 11 of 11 tests, including:

- HTML conversion;
- Greenhouse and Ashby detail behavior;
- title/location/posting-age filters;
- payload construction;
- ambiguous create reconciliation;
- import cap enforcement;
- Jobs identity mapping;
- preflight provenance preservation.

Location normalization was subsequently validated through live preflight artifacts. The exact post-location total test count should be re-recorded in the next session rather than inferred.

---

## 7. Target component model

```text
catalog synchronizer
        ↓
machine-managed provider catalogs
        ↓
target planner ← operator overrides
        ↓
provider-aware scheduler and tenant state
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

### 7.1 Catalog synchronizer

Responsibilities:

- download selected tenant lists from job-board-aggregator;
- validate schema and tenant identifiers;
- record source, license, timestamp, item count, and SHA-256;
- write atomically;
- retain the previous valid catalog if refresh fails;
- run independently of the scanner;
- initially run manually, later on a thin weekly timer.

Suggested storage:

```text
data/catalogs/greenhouse.json
data/catalogs/lever.json
data/catalogs/ashby.json
data/catalogs/workday.json
data/catalog-state.json
```

Catalogs are machine-managed. Operators should not hand-edit them.

### 7.2 Operator policy

Suggested committed file:

```text
config/company-overrides.yml
```

Example:

```yaml
schema_version: 1

priority:
  greenhouse:
    - celonis
  ashby:
    - n8n

disabled:
  greenhouse:
    - noisy-company
  workday:
    - broken-tenant|wd5|External

overrides:
  workday:
    special-company|wd3|Careers:
      display_name: Special Company
      max_pages: 10
```

Priority entries may refer to catalog tenants or define a tenant not yet present in the catalog.

Disabled entries always win.

### 7.3 Discovery policy

Suggested committed file:

```text
config/discovery-policy.yml
```

Example starting point:

```yaml
schema_version: 1

providers:
  greenhouse:
    enabled: true
    concurrency: 12
    requests_per_second: 5
    lookback_hours: 48
    overlap_hours: 12

  lever:
    enabled: true
    concurrency: 10
    requests_per_second: 4
    lookback_hours: 48
    overlap_hours: 12

  ashby:
    enabled: true
    concurrency: 3
    requests_per_second: 1
    lookback_hours: 48
    overlap_hours: 12

  workday:
    enabled: true
    concurrency: 5
    requests_per_second: 2
    max_pages_per_tenant: 50
    lookback_hours: 72
    overlap_hours: 24
```

These values are initial safety limits, not claimed optimums.

### 7.4 Target planner

Input:

- provider catalogs;
- operator priority and disabled lists;
- provider policy;
- tenant runtime state;
- current run budget;
- compound user profile constraints.

Output should be an ordered plan artifact:

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "targets": [
    {
      "provider": "ashby",
      "tenant": "n8n",
      "priority": "priority",
      "reason": "operator_priority",
      "lookbackStartUtc": "...",
      "state": "healthy"
    }
  ]
}
```

Ordering:

1. operator priority tenants;
2. recently active tenants due for scan;
3. healthy normal shard;
4. long-empty tenants due for occasional scan;
5. suspected/confirmed-dead re-probes.

Disabled tenants are omitted.

### 7.5 Tenant runtime state

Suggested fields:

```json
{
  "schemaVersion": 1,
  "provider": "ashby",
  "tenant": "example",
  "lastAttemptAtUtc": null,
  "lastSuccessfulAtUtc": null,
  "lastNewJobAtUtc": null,
  "lastResultCount": null,
  "consecutiveFailures": 0,
  "lastHttpStatus": null,
  "health": "healthy",
  "cooldownUntilUtc": null,
  "nextEligibleScanAtUtc": null,
  "lastErrorClass": null
}
```

Keep operator policy outside runtime state.

### 7.6 Provider adapter contract

Each provider should expose the minimum stable interface required by ATS Discovery:

```js
{
  id,
  detect?,
  fetch(target, httpContext)
}
```

Provider output is adapted to the shared candidate shape before filters and API calls.

Provider-specific behavior belongs in provider modules:

- URL construction;
- pagination;
- supported server-side date filters;
- posting timestamp extraction;
- rate-limit signal interpretation;
- durable versus transient errors;
- provider-native structured locations;
- list versus detail endpoint behavior.

Shared behavior must not be duplicated inside providers:

- Jobs preflight;
- create reconciliation;
- scanner provenance;
- generic title/location filtering;
- import caps;
- artifact writing;
- user matching.

---

## 8. Scan cadence and rate strategy

### 8.1 Initial cadence objectives

The scanner is primarily local, so cloud compute cost does not dictate cadence. Timeliness and respectful source behavior do.

Recommended initial objectives:

```text
priority tenants:
  daily, processed first

recently active normal tenants:
  daily or every 48 hours

healthy normal catalog tenants:
  rotating shards targeting a complete sweep within 2–3 days

long-empty healthy tenants:
  gradually reduce toward weekly

suspected or confirmed dead tenants:
  monthly re-probe
```

A two-week default for all healthy normal tenants is rejected because relevant postings may be stale before discovery.

The exact sweep target is empirical. If source limits make a 2–3 day sweep unsafe, the system should reduce rate, preserve priority coverage, and report the resulting delay explicitly.

### 8.2 Circuit breaking

Per-provider circuit breaker should stop or pause work when a threshold is exceeded, for example:

- repeated `429` responses;
- elevated transient error rate;
- sustained latency increase;
- provider-specific anti-bot response;
- pagination anomaly;
- unexpected response-schema failure.

A provider breaker must not disable unrelated providers.

A tenant failure must not disable the whole provider unless evidence indicates a provider-wide issue.

### 8.3 Rate tuning

Start with explicit static limits and measured diagnostics.

Record per provider:

- requests;
- successful responses;
- `429` count;
- transient and durable errors;
- p50/p95 latency;
- jobs returned;
- candidates retained;
- tenants skipped by cooldown;
- breaker activations.

Initial tuning should be semi-automatic:

1. scanner records evidence;
2. summary recommends increasing, retaining, or decreasing limits;
3. operator changes policy;
4. later, bounded additive-increase/multiplicative-decrease may be added behind strict caps.

Do not implement autonomous rate tuning before several real runs provide a baseline.

---

## 9. Candidate and observation model

Candidate acquisition source must not leak into the downstream contract.

Example normalized candidate:

```json
{
  "schemaVersion": 1,
  "sourceMode": "catalog",
  "sourceProvider": "greenhouse",
  "sourceCompany": "celonis",
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
  "sourceMeta": {
    "providerImplementationOrigin": "santifer/career-ops",
    "providerImplementationRef": "...",
    "catalogOrigin": "Feashliaa/job-board-aggregator",
    "catalogSha256": "..."
  }
}
```

The shared `JobOffering.FoundOn` field is insufficient to represent every observation. Future analytics should keep discovery-run observations separately if source coverage, match rates, or repeated sightings need analysis.

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

## 11. Provider roadmap

Provider count is not an acceptance criterion. Data quality and relevance are.

### 11.1 Proven base

- Greenhouse;
- Lever;
- Ashby;
- Workday.

### 11.2 Next DACH-relevant evaluation group

Evaluate current Career-Ops implementations and compare with other references:

- SuccessFactors;
- Personio;
- SmartRecruiters;
- Softgarden.

SuccessFactors is important for large DACH employers but should be added after the catalog planner, provider policy, and runtime state are stable.

### 11.3 Later candidates

Adopt only when demand and candidate quality justify maintenance:

- BambooHR;
- Workable;
- Teamtailor;
- Recruitee;
- Avature;
- Phenom;
- iCIMS;
- Paylocity;
- other provider-specific sources.

### 11.4 Provider acceptance matrix

| Capability | Requirement |
|---|---|
| Stable origin URL | Required |
| Canonical identity derivable by Jobs | Required |
| Title | Required |
| Hiring company | Required |
| Description or reliable detail route | Required before compatibility/import |
| Posting date | Strongly preferred |
| Location | Strongly preferred |
| Bounded pagination | Required |
| Known request policy | Required |
| Durable/transient failure distinction | Required |
| Tests or fixtures | Required |
| Attribution and pinned origin | Required when derived |

---

## 12. Artifacts and observability

Every run should retain enough evidence to diagnose source and filtering behavior without replaying live requests.

Existing artifacts:

```text
metadata.json
summary.json
candidates.json
rejected.json
preflight-results.json
detail-results.json
location-results.json
import-results.json
```

Planned additions:

```text
target-plan.json
provider-results.json
tenant-state-changes.json
user-match-results.json
rate-observations.json
```

Summary should report at least:

- targets planned/attempted/skipped;
- priority versus normal targets;
- provider request counts;
- provider errors and `429`s;
- breaker activation;
- raw jobs;
- retained candidates;
- rejection reasons;
- preflight existing/missing/errors;
- detail outcomes;
- location normalization outcomes;
- import outcomes;
- user cheap-match counts;
- compatibility requests when implemented;
- catalog source/hash/count;
- effective lookback window.

Avoid logging secrets, CV content, or full sensitive user profiles.

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

After the target planner is stable, add a host timer or lightweight local scheduler that starts a run-to-completion container once per day.

Prevent overlapping runs with a global lock and stale-lock recovery.

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

## 14. Rename and cleanup before merge

Before merging the milestone branch into `master`:

1. Rename directory:

```text
scrapers/career-ops-scan
→ scrapers/ats-discovery
```

2. Rename Compose service and image consistently.
3. Change new-job provenance:

```text
career-ops-scan
→ ats-discovery
```

4. Keep the three existing canary jobs unchanged as historical evidence.
5. Update paths in tests, documentation, Docker commands, and CI.
6. Replace or clearly mark `copy-upstream-providers.sh` as bootstrap-only.
7. Ensure notices still distinguish Career-Ops-derived code and job-board-aggregator catalogs.

The rename is cleanup, not a prerequisite for the next catalog-planner experiment.

---

## 15. Phase plan

### Phase 0 — Approach validation — completed

- inspect Career-Ops scanner and provider outputs;
- run controlled ATS sources;
- verify identity quality and description availability;
- choose Ehestifter-owned extraction instead of full wrapper;
- pin and attribute source revision.

### Phase 1 — Controlled tracked scanner — completed

- Docker scanner skeleton;
- Greenhouse, Lever, Ashby, Workday providers;
- offline scan;
- Jobs preflight;
- detail enrichment;
- guarded import;
- ambiguous create reconciliation;
- location normalization;
- idempotent live canaries;
- run artifacts and metrics.

### Phase 2 — Catalog and target-planner foundation — next

- define catalog file contract;
- add one catalog synchronizer, beginning with Ashby;
- define `company-overrides.yml`;
- define provider discovery policy;
- merge catalog, priority, disabled, and runtime state;
- write ordered `target-plan.json`;
- keep execution offline for the first bounded shard;
- prove priority tenants are processed first;
- prove disabled tenants are omitted;
- prove catalog refresh does not overwrite overrides.

### Phase 3 — Provider-aware scheduling and health

- persist tenant runtime state;
- rotating healthy shards;
- recent-activity promotion;
- long-empty demotion;
- monthly dead-tenant re-probe;
- provider circuit breakers;
- rate and latency metrics;
- operator-reviewed rate recommendations;
- bounded date lookback with overlap.

### Phase 4 — Catalog-backed live preflight and import

- enable Jobs preflight for a bounded catalog shard;
- quantify existing/new ratio;
- fetch details only for missing candidates;
- import under a small explicit cap;
- confirm idempotency;
- scale shard size gradually.

### Phase 5 — Provider expansion

- inspect current Career-Ops providers and job-board-aggregator behavior;
- add providers based on DACH relevance and acceptance matrix;
- likely order: SuccessFactors, Personio, SmartRecruiters, Softgarden;
- add provider fixtures and request policies;
- record source provenance per provider.

### Phase 6 — Multi-user discovery

- Users discovery-eligible endpoint;
- profile-derived cheap filters;
- compounded scan profile;
- per-candidate matched-user set;
- shared job import once;
- compatibility requests per matched user;
- no automatic status creation.

### Phase 7 — Scheduled operations

- local daily run;
- global lock;
- state backup and artifact retention;
- catalog refresh timer;
- operational summary and failure alerting.

### Phase 8 — Optional GCP Cloud Run Job

- container cleanup and rename;
- durable state backend;
- bounded cloud shard;
- cost/runtime measurement;
- explicit decision whether broad scans remain local.

### Phase 9 — Documentation integration

- merge stabilized architecture into `system-design.md`;
- archive this milestone document;
- retain journal and attribution notices.

---

## 16. Acceptance criteria

The milestone is complete when:

- ATS Discovery has an Ehestifter-owned provider and candidate contract;
- catalogs and operator overrides are separate;
- priority, normal, disabled, cooldown, and dead concepts are represented correctly;
- priority tenants run before catalog shards;
- healthy normal tenants are scanned on a measured, timely rotating cadence;
- provider-side date filtering is used where supported with overlap;
- rate limits trigger provider-aware cooldown rather than uncontrolled retries;
- tenant scans are shared across users;
- candidate filters prevent obviously irrelevant jobs from reaching compatibility;
- Jobs API remains authoritative for canonical identity and persistence;
- detail fetches occur only when needed;
- imports are capped, replay-safe, and idempotent;
- compatibility is requested per matched user without creating statuses;
- at least the proven four providers remain operational;
- additional providers are adopted only through the acceptance matrix;
- all derived code and catalogs retain attribution and source revisions;
- local scheduled operation is stable;
- scanner and provenance naming are changed to ATS Discovery before merge.

---

## 17. Immediate next coding-agent task

Implement **Phase 2A: catalog and target-planner foundation**, without adding another scan pipeline.

Concrete target:

1. Keep the existing scanner and current directory name temporarily.
2. Add a machine-managed Ashby catalog loader using `data/ashby_companies.json` from job-board-aggregator.
3. Store catalog metadata and SHA-256 atomically under `/data/catalogs`.
4. Replace the current assumption that `portals.yml` is the complete target list.
5. Treat the existing tracked companies as priority overrides.
6. Add an explicit disabled list.
7. Produce `target-plan.json` containing priority targets first, then at most 100 healthy Ashby catalog targets.
8. Run the planned targets in `--offline` mode only.
9. Record per-target provider result and rejection reason.
10. Do not enable catalog-wide preflight or import yet.

First-session validation commands should remain Docker-only.

---

## 18. References

- [Career-Ops repository](https://github.com/santifer/career-ops)
- [Career-Ops providers](https://github.com/santifer/career-ops/tree/main/providers)
- [Career-Ops release used for the initial extraction](https://github.com/santifer/career-ops/releases/tag/career-ops-v1.20.0)
- [job-board-aggregator repository](https://github.com/Feashliaa/job-board-aggregator)
- [job-board-aggregator scraper](https://github.com/Feashliaa/job-board-aggregator/blob/main/scripts/scraper.py)
- [job-board-aggregator tenant catalogs](https://github.com/Feashliaa/job-board-aggregator/tree/main/data)
- [job-board-aggregator license](https://github.com/Feashliaa/job-board-aggregator/blob/main/LICENSE)