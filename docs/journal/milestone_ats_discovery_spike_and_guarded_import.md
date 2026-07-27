# ATS Discovery Journal: Approach Spike Through Guarded Import

**Date covered:** July 2026  
**Branch:** `feature/ats-discovery`  
**Current implementation path:** `scrapers/ats-discovery`  
**Planned final name:** `scrapers/ats-discovery`  
**Purpose:** implementation record and new-session handoff  

---

## 1. Executive summary

The original milestone began as “Career-Ops powered job discovery.” The implementation spike established that the best boundary is an Ehestifter-owned scanner using selectively adapted ATS provider code rather than running the complete Career-Ops application.

A working local Docker scanner now:

```text
scans configured ATS tenants
→ applies cheap filters
→ obtains Jobs canonical identity
→ fetches missing descriptions
→ normalizes conservative locations
→ imports through Jobs API under an explicit cap
→ reconciles ambiguous create outcomes
→ remains idempotent on replay
```

Three real jobs were imported successfully and a later run detected all three as existing without duplicates.

The architecture has now been reframed as **ATS Discovery**. Career-Ops and job-board-aggregator are monitored sources of implementation ideas and selected code/data, but Ehestifter owns the scanner shape.

The next implementation step is not a separate “full ATS scanner.” It is a catalog-backed target planner that merges machine-managed tenant catalogs with priority and disabled overrides, then reuses the existing scan pipeline.

---

## 2. Initial problem and constraints

The project needed automatic job discovery while preserving current domain ownership:

- Jobs owns canonical identity, job persistence, and shared job records.
- Users owns user and CV facts.
- Enrichment Core owns compatibility work.
- Jobs are shared globally.
- Compatibility and application status are per user.
- Discovery must not write directly to SQL or create `Applied` status.
- The hobby project must remain inexpensive and operable locally.

The initial upstream candidate was [Career-Ops](https://github.com/santifer/career-ops), particularly its zero-token ATS scanners.

---

## 3. Approach-validation result

Three integration styles were considered:

1. run Career-Ops unchanged and parse its Markdown/TSV outputs;
2. keep a small JSON-output patch on Career-Ops;
3. extract/provider-adapt the useful scanner layer into an Ehestifter-owned runner.

The spike selected option 3.

Reasons:

- Career-Ops `scan.mjs` was coupled to its own tracker, pipeline, history, and plugin system;
- provider outputs were useful but the whole runtime contract was not;
- Ehestifter needed direct control over candidate JSON, Jobs calls, artifacts, and import behavior;
- provider code was small enough to adapt;
- descriptions and canonical identity could be obtained independently.

Pinned Career-Ops source used during the spike:

```text
release: career-ops-v1.20.0
commit: 493487462608c0cced82c1440e7ba8be6c01f306
```

Attribution was retained through `UPSTREAM.md`, licenses, and derived-source comments.

---

## 4. Scanner scaffold created

Current directory:

```text
scrapers/ats-discovery
```

Important files introduced during the spike:

```text
config/scanner.local.json
config/portals.yml
src/cli.mjs
src/config.mjs
src/scan/tracked-source.mjs
src/ehestifter/jobs-client.mjs
src/artifacts/run-writer.mjs
src/providers/*
UPSTREAM.md
licenses/*
```

The host intentionally does not require Node/npm. All tests and commands run in Docker.

Canonical test command:

```bash
LOCAL_UID="$(id -u)" \
LOCAL_GID="$(id -g)" \
docker compose run --rm \
  --no-deps \
  --entrypoint node \
  ats-discovery \
  --test
```

Initial runtime config included:

```json
{
  "careerOps": {
    "upstreamRef": "493487462608c0cced82c1440e7ba8be6c01f306"
  },
  "scan": {
    "providerConcurrency": 8,
    "jobsApiConcurrency": 3,
    "maxCandidatesPerRun": 100,
    "requireDescriptionForCreate": true,
    "description": {
      "fetchMissing": true,
      "maxFetchesPerRun": 50,
      "concurrency": 2
    }
  },
  "imports": {
    "enabled": false,
    "maxCreatesPerRun": 5
  }
}
```

---

## 5. Initial providers

Provider modules adapted from Career-Ops:

- Greenhouse;
- Lever;
- Ashby;
- Workday.

The scanner initially used a small controlled `portals.yml` rather than a broad tenant list.

This made it possible to validate data quality, filtering, Jobs identity, and live imports before introducing broad catalog behavior.

---

## 6. Offline scan result

A controlled offline run loaded four providers and scanned three configured targets.

Representative result:

```text
targets: 3
candidates: 3
rejected: approximately 258–264 depending on live board changes
```

Retained candidates:

1. Celonis — Application Product Manager - AI System Transformations
2. Celonis — Application Product Manager - AI System Transformations
3. n8n — AI Product Manager

Rejections were mainly expected title, location, and posting-age failures.

This established that the provider/listing layer produced useful candidate data and that the cheap filters worked before any Jobs or detail calls.

---

## 7. Jobs identity preflight

The scanner uses:

```text
GET /jobs/exists?url=<job-url>
```

Jobs is authoritative for:

```text
provider
providerTenant
externalId
identitySource
```

Canonical identities returned for the three canaries:

```text
greenhouse / celonis / 7798592003
greenhouse / celonis / 7788415003
ashby / n8n / 42e72645-d99a-4545-97b7-53ba3a699893
```

A design correction was made during implementation:

- `canonicalIdentity` contains only Jobs-owned identity fields;
- URL-derived `foundOn`, hiring company, and posting company hints remain in a separate `urlInference` object;
- scanner provenance remains `ats-discovery` and is not overwritten by Jobs inference.

---

## 8. Detail enrichment

Added files:

```text
src/details/text.mjs
src/details/fetchers.mjs
tests/details.test.mjs
```

Implemented:

- conservative HTML-to-plain-text conversion;
- Greenhouse detail endpoint;
- Ashby board endpoint;
- one-request Ashby board cache;
- skip detail fetching for Jobs already present in Ehestifter;
- fetch only missing descriptions;
- configurable fetch limit and concurrency;
- `detail-results.json` artifact.

Validated result:

```text
detailReady: 3
detailErrors: 0
missingDescriptions: 0
```

Description sizes were approximately:

```text
Celonis candidate 1: 9.6 KB
Celonis candidate 2: 9.3 KB
n8n candidate: 9.4 KB
```

The text was manually inspected and found readable.

Ashby also improved:

- apply URL;
- remote type;
- structured Berlin/Germany location.

---

## 9. Jobs create hardening

Before live import, Jobs create behavior was hardened.

Changes included:

- duplicate-key exception handling narrowed to the relevant uniqueness paths;
- request locations normalized and deduplicated;
- inserts guarded against both Jobs location unique indexes:
  - `(JobOfferingId, CountryName)` when city is null;
  - `(JobOfferingId, CountryName, CityName)` when city is present.

This reduced the chance that retries or duplicate normalized locations would fail an otherwise valid job create.

---

## 10. Guarded import implementation

Added or extended:

```text
src/ehestifter/job-payload.mjs
src/ehestifter/jobs-client.mjs
src/ehestifter/import-jobs.mjs
src/cli.mjs
src/artifacts/run-writer.mjs
tests/import.test.mjs
```

Safety behavior:

- import disabled by default;
- `imports.enabled=true` required;
- `--max-create N` required in import mode;
- CLI cap cannot exceed configured ceiling;
- create attempts are sequential;
- missing descriptions block new imports when configured;
- invalid payloads are skipped;
- non-retryable `4xx` failures are not retried;
- network failures, timeout, malformed successful response, `429`, and `5xx` are treated as ambiguous/retryable;
- ambiguous POST is reconciled with `GET /jobs/exists` before another POST;
- system actor/source headers are supplied;
- `import-results.json` records outcome and submitted payload.

Import dispositions include:

```text
existing_preflight
skipped_preflight_error
skipped_missing_description
skipped_create_limit
skipped_invalid_payload
submitted
reconciled_after_ambiguous_post
error
```

---

## 11. CLI scope bug found during live canary

The first import attempt after enabling the config gate failed with:

```text
ReferenceError: importResults is not defined
```

Root causes in `src/cli.mjs`:

1. an inner `const client` shadowed the outer `let client`;
2. `let importResults` was declared inside the detail block and referenced outside it;
3. the import block was accidentally nested in the detail block.

The fix:

- assign the outer `client` instead of redeclaring it;
- declare `importResults` in `main()` scope;
- place the import block after detail enrichment.

Why tests did not catch it:

- unit tests exercised helpers directly;
- no test executed the complete CLI orchestration path;
- the code was syntactically valid and failed only when the import branch reached the out-of-scope variable.

A CLI orchestration test was deliberately deferred until later container/Cloud Run work.

---

## 12. Confirmed test run

After fixing the Jobs client and import helpers, the following run passed:

```text
tests: 11
pass: 11
fail: 0
```

Covered behavior:

- HTML conversion;
- Greenhouse details;
- Ashby detail request reuse;
- short title acronym boundaries;
- location allow precedence;
- undated posting behavior;
- create payload provenance and identity;
- ambiguous POST reconciliation;
- import cap enforcement;
- Jobs identity authority;
- preflight provenance preservation.

Location tests were added later as part of the normalizer work, but the exact final test total was not captured in the conversation. Re-run and record it at the start of the next session.

---

## 13. Live import evidence

### First import run

Command:

```bash
LOCAL_UID="$(id -u)" \
LOCAL_GID="$(id -g)" \
docker compose run --rm \
  ats-discovery \
  scan tracked --import --max-create 1
```

Observed summary:

```json
{
  "candidates": 3,
  "preflightMissing": 3,
  "detailReady": 3,
  "importSubmitted": 1,
  "importSkipped": 2,
  "importErrors": 0
}
```

The imported job appeared in the Ehestifter web UI with correct title, company, description, and:

```text
found on ats-discovery
```

The first Greenhouse canary had no structured location at that time because Greenhouse list/detail handling preserved only `rawLocation`.

### Repeated bounded imports

The command was run three more times.

The final run reported:

```json
{
  "candidates": 3,
  "preflightExisting": 3,
  "preflightMissing": 0,
  "preflightErrors": 0,
  "detailExistingSkipped": 3,
  "importExisting": 3,
  "importSubmitted": 0,
  "importReconciled": 0,
  "importSkipped": 0,
  "importErrors": 0
}
```

This confirmed end-to-end idempotency.

Final job IDs:

```text
8954057d-e68c-4740-b798-a6a3cba50614
08647249-8be0-4a31-abd6-d651ae1ef1bc
f61c3482-b61c-4792-abe2-72359da312c7
```

---

## 14. Location normalizer

A deliberately narrow normalizer was added after detail enrichment.

Rules:

- provider-native structured locations win;
- exact `City, Country` may be normalized for supported countries;
- exact country-only may be normalized;
- `Remote, Country` becomes country scope without inventing a city;
- multi-location strings are rejected as ambiguous;
- country is never inferred from city alone;
- raw location remains in the artifact.

Validated preflight summary:

```json
{
  "locationProviderStructured": 0,
  "locationNormalized": 2,
  "locationUnparsed": 1,
  "locationMissing": 0
}
```

Celonis result:

```json
{
  "rawLocation": "Munich, Germany",
  "locations": [
    {
      "countryName": "Germany",
      "countryCode": "DE",
      "cityName": "Munich",
      "region": null
    }
  ],
  "locationNormalization": {
    "status": "normalized_city_country"
  }
}
```

The n8n multi-country value remained:

```text
unparsed_multiple
```

because its provider detail was skipped once the job already existed. Existing stored jobs were not mutated by preflight.

---

## 15. Metric correction

The summary originally reported:

```text
missingDescriptions: 3
```

on an all-existing run. This was misleading: descriptions were missing only from current run objects because detail fetching was correctly skipped for existing jobs.

The metric was split into:

```text
candidateDescriptionsMissing
missingDescriptionsForImport
```

Observed corrected values:

```json
{
  "candidateDescriptionsMissing": 3,
  "missingDescriptionsForImport": 0
}
```

---

## 16. Architectural reconsideration

The next planned step was initially called `full-ats` and proposed using job-board-aggregator tenant lists with the four current JavaScript providers.

Review of job-board-aggregator showed that it also contains a contained Python scraper for seven ATS systems and practical broad-run behavior:

- provider-specific worker counts;
- retries and backoff;
- `429`, `502`, and `503` handling;
- pagination checks;
- dead-board handling;
- anomaly monitoring;
- large curated tenant catalogs.

The generated job-feed/chunk path was rejected because the desired operating model is direct daily discovery with profile filtering before expensive work.

The updated decision is:

- keep an Ehestifter-owned scanner;
- keep the proven downstream pipeline;
- inspect both Career-Ops and job-board-aggregator for smart provider and resilience behavior;
- selectively adapt code and algorithms;
- reuse job-board-aggregator tenant catalogs;
- do not deploy either whole project;
- do not build a separate full-ATS pipeline;
- replace the small source list with a layered catalog + overrides target planner.

---

## 17. Clarified meaning of upstream

In project discussion, “upstream” means a repository that could otherwise be pulled and patched as a whole.

The final policy is more selective:

- do not expect whole-project `git pull` updates to remain compatible;
- monitor source repositories;
- pin provider origins;
- cherry-pick or port relevant changes;
- preserve attribution;
- validate every adopted change with local tests.

Career-Ops remains valuable because its provider set and scanner fixes continue evolving.

The current script:

```text
scripts/copy-upstream-providers.sh
```

should be treated as bootstrap-only and deprecated after a manifest-driven selective provider update workflow exists.

---

## 18. New name and cleanup decision

Final scanner name:

```text
ATS Discovery
```

Before merge to `master`, perform cleanup:

```text
scrapers/ats-discovery
→ scrapers/ats-discovery
```

and change new creation provenance:

```text
foundOn = "ats-discovery"
→ foundOn = "ats-discovery"
```

The existing three canary jobs should remain unchanged as historical records.

The rename is not required before the next catalog-planner experiment.

---

## 19. Updated operating model

### Tenant inputs

```text
job-board-aggregator tenant catalogs
+ priority overrides
- disabled overrides
+ provider-specific patches
= ordered target plan
```

### Cadence

Initial intended behavior:

```text
priority tenants:
  daily and first

recently active normal tenants:
  daily or every 48 hours

healthy normal tenants:
  rotating shards with a target full sweep in 2–3 days

long-empty tenants:
  gradually reduce toward weekly

dead/suspected-dead tenants:
  monthly re-probe
```

A two-week default for healthy tenants was rejected because found jobs could already be stale.

### Date filtering

Use provider-side “recent” filters where supported:

```text
last successful scan minus overlap
```

Accept bounded risk of missed jobs rather than scanning unbounded history on every run.

### Rate limits

Start with explicit provider-specific limits and circuit breakers.

Record evidence and make operator-reviewed tuning recommendations. Fully automatic rate tuning is deferred until enough real run data exists.

### Multi-user behavior

Compound user cheap filters into one scan plan. Fetch each tenant once, then determine which users match each candidate. Import a shared job once and request compatibility only for matched users.

---

## 20. Current repository state relevant to continuation

Expected branch state includes:

- working scanner in `scrapers/ats-discovery`;
- imports enabled locally for the canary test;
- four provider modules;
- offline, preflight, detail, location, and import stages;
- live data artifacts under `data/runs`;
- three canary jobs already present in Ehestifter;
- location and description summary metric refinements;
- no CLI orchestration integration test yet;
- no broad tenant catalog planner yet;
- no Users eligibility or compatibility integration yet;
- no local timer or Cloud Run Job yet.

Before running more live imports, inspect the current config and keep explicit caps.

---

## 21. Immediate next implementation task

Implement an Ashby-backed catalog target-planner spike without creating another scanner path.

Required behavior:

1. Download or import `data/ashby_companies.json` from job-board-aggregator.
2. Validate tenant strings.
3. Store machine-managed catalog and metadata under `/data/catalogs`.
4. Record source, CC BY-NC 4.0 license, timestamp, item count, and SHA-256.
5. Keep the existing configured companies as priority overrides.
6. Add a disabled override list.
7. Produce `target-plan.json` with priority tenants first.
8. Add at most 100 normal Ashby tenants for the first experiment.
9. Run offline only.
10. Preserve the existing downstream candidate/filter pipeline.
11. Capture per-target success, error class, jobs returned, candidates retained, and duration.
12. Do not enable broad Jobs preflight or import yet.

After the bounded Ashby experiment, use observed rate and quality evidence to design tenant runtime state and the first rotating-shard policy.

---

## 22. First message for the next project session

Paste the following together with the updated milestone and this journal:

```text
Continue the ATS Discovery milestone from the attached milestone and journal.

Treat the journal as the record of completed work. Do not repeat the Career-Ops wrapper/extraction spike, Jobs identity work, detail enrichment, guarded import, or location normalizer.

First inspect the current feature/ats-discovery branch and confirm the Docker test result and scanner config. Then implement Phase 2A only: an Ashby tenant catalog loader and ordered target planner that merges machine-managed catalog entries with priority and disabled overrides. Reuse the existing scanner pipeline. Limit the first catalog experiment to 100 normal Ashby tenants, run offline only, and write target-plan/provider-result artifacts. Keep all host commands Docker-only.
```

---

## 23. References

- [Updated ATS Discovery milestone](./milestone_ats_discovery.md)
- [Career-Ops](https://github.com/santifer/career-ops)
- [Career-Ops providers](https://github.com/santifer/career-ops/tree/main/providers)
- [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator)
- [job-board-aggregator scraper](https://github.com/Feashliaa/job-board-aggregator/blob/main/scripts/scraper.py)
- [job-board-aggregator catalogs](https://github.com/Feashliaa/job-board-aggregator/tree/main/data)