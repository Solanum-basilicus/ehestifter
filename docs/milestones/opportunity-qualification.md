# Milestone: Opportunity Qualification

Status: planned; no implementation is approved by this file alone.
Revision: v4 — evidence-gated compatibility booking, profile-ready user repair, historical scores unchanged.

Updated: 2026-11-09.
Related: [system design](https://github.com/Solanum-basilicus/ehestifter/blob/main/docs/system-design.md), [GEO pilot #38](https://github.com/Solanum-basilicus/ehestifter/issues/38), [discovery recovery #49](https://github.com/Solanum-basilicus/ehestifter/issues/49).

## How to use this milestone

For each session, read `docs/system-design.md`, this file, the **current phase number**, and the prior phase's hand-off. Inspect the current repository code or a fresh Git bundle before changing contracts or source files. Do not assume that this plan describes implemented code. Complete **only the selected phase**; do not cross its gate without operator approval. The operator runs local integration tests and deploys services.

Each implementation phase delivers a git-compatible `.patch` in an archive with `APPLY.md` (apply/test/configuration), `REVIEW.md` (critical review, risks, tests, corrections), and `SOLUTION.md` (behavior, reasoning, commit summary). Do not add installation scripts. Prefer ASD-STE100 language in docs and code comments. For every patch, review domain ownership, idempotency, retries, stale inputs, security, SQL/query cost, test isolation, rollback, and YAGNI/KISS.

**Supporting documents are not normal phase inputs.** Consult [model research](reference/opportunity-qualification-model-research.md) only in the model-research phase or when a model choice is blocked. Consult [design decisions](reference/opportunity-qualification-decisions.md) only if a design gate needs a disputed alternative or if the selected design fails. Do not load either document in an ordinary implementation session.

## Objective and operating limits

Improve the full path from an ATS vacancy to a useful **Open Opportunities** entry: (1) job geography evidence; (2) job language requirements; (3) per-user language/GEO eligibility; (4) job–CV compatibility score and summary. Improve accuracy first, then time to useful result and local inference throughput.

The current local Qwen setup produces about **70 compatibility scores/hour**. About **1,400 pairs/day** and discovery runs under **22 hours** are tolerable today. Avoid an emergency infrastructure redesign. The local AMD node must support Docker Compose start/stop and free resources for other tasks. Inference may be offline during discovery. Keep cloud costs low; avoid new services unless an existing component cannot meet a measured need. Parallel production shadow models are not expected to run for long; use offline replay and short manual canaries.

## Target architecture and boundaries

This is the **design target**, not a statement that new endpoints or schemas exist:

```text
ATS Discovery
  find/match candidate; apply existing bounded discovery filters
  -> import shared job through Jobs
  -> notify Enrichers Core: job ID + suggested user IDs
  -> continue scan; never poll or interpret enrichment results

Enrichers Core (on accepted notification)
  -> book/dedupe job-level GEO/language evidence enrichment
  -> retain accepted suggestions until downstream booking is settled
  -> if current job evidence already exists, reuse it; do not rerun

Job-evidence run -> validate -> dispatch facts to Jobs -> confirm delivery
  -> Core obtains current profiles of suggested, profile-ready users
  -> apply canonical GEO/language matching against published job facts
  -> confirmed mismatch: skip; pass/unknown: follow approved policy
  -> book/dedupe qualified job-user compatibility runs
  -> each compatibility run -> validate -> dispatch score to Jobs

Enrichers Core (periodic repair)
  -> scan a bounded set of recent/updated Jobs through its owner API
  -> repair missing/outdated job-evidence bookings
  -> for jobs with current published facts, enumerate ALL profile-ready
     users from Users (CV + GEO + language preferences configured)
  -> apply the same matching and book missing reasonable pair runs
  -> use idempotency, limits and persistent progress to resume safely

Jobs -> store shared, versioned job evidence; no user eligibility flags
Users -> own explicit language profile and existing GEO preferences
Open Opportunities -> match CURRENT profiles with current job facts
                      at query time; no model calls; score is separate
```

The work above need not be one combined inference request. Phase 3 decides whether a combined GEO+language extractor, separate extractors, or deterministic extraction with an optional model is better. **Logical work stages do not imply new containers or services.**

### Domain rules

- **Jobs** owns job content, canonical geography, shared job-language facts, job read APIs, and compatibility projections. Use one authoritative deterministic eligibility policy for Jobs read-time filtering and Core booking decisions. Reuse a tested pure matching function or an owner-domain API; do not maintain two divergent implementations. Choose the smallest approach after source review.
- **Users** owns normalized user GEO preferences and an explicit, user-controlled language list (language, stated level, completeness/unknown status). CV text can suggest entries; omission from a CV is not evidence of absence. Do not send CVs to ATS Discovery or to job-fact inference.
- **Enrichers Core** owns run identity, booking/dedupe, snapshots, retries, booking repair, and type-specific completion/projection delivery. It owns the explicit follow-up: after valid job evidence is delivered, evaluate current user profiles and book reasonable pair runs. Preserve accepted discovery suggestions until handled. Isolate type-specific completion and follow-up handling rather than adding branches to `backend/enrichers/helpers/enrichment_completion.py`. Do not build a generic DAG/workflow product.
- **Gateway** only transports worker requests and completions. **Workers** compute and validate; they do not read cross-domain state or update other services. **ATS Discovery** never waits for inference or starts work based on enrichment outcomes. Only Core coordinates later steps.
- Keep existing pre-import deterministic GEO policy until a separately measured change is approved. Model evidence must not invent eligibility rules. Jobs may still contain vacancies that later fail per-user eligibility.

### Real-time eligibility; no preference hash cache

Jobs stores **shared facts**, not persistent `geoCompatible` or `languageCompatible` fields for a user. Open Opportunities receives the user's current normalized criteria through its existing authorized query path (extend the contract for languages) and filters before pagination/count. It must not call inference. No preference-hash requalification jobs, historical eligibility cache, or mass recalculation on preference edits are required.

For an explicit **mandatory** language mismatch, exclude the pair from the default eligible results. For absent, ambiguous, conditional, or unprocessed evidence, return **unknown**, not `fail`; preserve a user-visible route to the job. Preferred languages do not hard-exclude. A job ad's language alone is not a mandatory language requirement. Assess level labels and `AND`/`OR` conditions explicitly. A human-reviewed test set must determine the final unknown presentation and hard-exclusion policy before rollout.

The current score is a different object. **Preference changes require new read-time eligibility, not automatic rescoring.** **GEO and language evidence are required for automatic compatibility-booking decisions, but are not required inputs to the compatibility scoring worker.** The worker can score a job–CV pair without these facts. Core must avoid booking a pair when a confirmed eligibility mismatch makes the score unused. Inspect the existing worker's reported language-driven 0.5 override in source. For **new** scoring runs, agree and test a score policy without this eligibility override; do not change or migrate stored historical scores, including 0.5 results. They remain as recorded. Read-time eligibility does not reinterpret those scores. Accept that a historical 0.5 may reflect a language restriction that the user's current profile no longer has.

### Async handoff and correctness rules

- **Accepted notification.** A successful Core response means the job-only booking and supplied user suggestions are durably accepted or already covered by durable work. If Core is unavailable, ATS Discovery logs the submission failure and moves on; its role ends. Do not call external services from a completion SQL transaction. Reuse existing run/snapshot records for suggestions if verified sufficient; add new intent storage only when necessary.
- **Explicit booking dependency.** Automatic pair booking waits for usable GEO/language job facts and a deterministic user eligibility check. The **scoring calculation is independent**: the compatibility worker needs job/CV input, not those facts. Do not confuse computational independence with the Core booking order.
- **Projection acknowledgement.** A completed evidence run is not necessarily visible in Jobs. Prefer to start the follow-up after confirmed Jobs delivery, or use a proven version-consistent alternative approved in Phase 5. The same evidence revision must drive both the Core booking gate and Open Opportunities. Failed projection delivery must remain retryable; it must not silently trigger pair runs on stale facts.
- **Eligible user scope.** In normal operation, Core considers the suggested user IDs supplied by ATS Discovery, with **current** Users profiles. A user is *profile-ready* when CV, GEO preferences and language preferences are configured; this does not mean the job is suitable for that user. Apply the canonical job–user GEO/language match before booking compatibility. Skip a confirmed mismatch. Do not treat missing or ambiguous evidence as a confirmed mismatch; define whether `unknown` is scored or deferred in Phase 5. A preferred language does not make a user ineligible.
- **No duplicate matching policy.** Jobs read-time filters and Core booking decisions must implement the same GEO/language rules. Inspect existing module/package and API boundaries before choosing a shared pure function or a Jobs-owned batch matching API. Do not copy SQL eligibility logic by hand into a different service. Never read or write another domain's SQL tables directly.
- **Timer-based repair.** Core periodically scans recent/updated Jobs through an authorized, paginated Jobs API. If valid evidence or an evidence run is missing/outdated, book/retry job-evidence work. For jobs with current published evidence, enumerate **all profile-ready users** through an authorized Users API, evaluate their current GEO/language match and book missing appropriate pair runs. Do not require lost ATS suggestions for recovery. Use a bounded lookback, pagination, overlap/catch-up after downtime, throughput limits and idempotent retries. This wider user scope is a recovery behavior; measure its extra pair count and cost against normal ATS suggestions.
- **Durable follow-up and duplicate observations.** A crash after evidence publication but before pair booking must be repaired. Do not rely only on the job-evidence completion callback: the timer must reconcile downstream pair coverage too. A later ATS observation of a job can add new suggestions without repeating valid job-evidence inference. Job-only evidence and pair runs must be deduplicated under the current input/policy revisions; keep retryable failures distinguishable from successful results.
- **Stale inputs and changed profiles.** An old job-evidence result must not overwrite newer job facts. For booking, use current user profiles, not an ATS-time snapshot. Preference edits change Open Opportunities immediately; they do not trigger a historical rescore or persistent eligibility recompute. Recent active jobs may gain a missing score through normal booking/repair after eligibility changes, subject to the agreed window. A completed score remains recorded even if a later preference edit hides the job. Guard delayed compatibility projections against stale results.
- **Unavailable inference and backlogs.** Discovery never waits on local models. If job evidence is pending or failed, compatibility booking for that new job may wait; this is expected, not an ATS failure. Do not mark pending/error/uncertain evidence as a hard eligibility failure. Bound retries, backlog growth, model contention, and repair fan-out; measure time from import to first useful score.

## Phase plan and measurable gates

### Phase 0 — Current-flow audit and representative data

Inspect actual current code for ATS import/compatibility requests, Enrichment booking and run schema, Core timers, `enrichment_completion.py`, dispatch acknowledgement, Jobs evidence storage and `POST /jobs/open/query`, Users preferences, worker language override, and integration tests. Verify how Jobs can be listed for timer reconciliation, how Core can persist accepted suggestions, and how Users can list profile-ready users for repair without exposing CV text. Measure 0.5 override frequency and causes, suggested-versus-all-ready user fan-out, eligible pair fraction, candidate volumes, current query latency, score throughput, and current GEO errors. Produce private, fixed benchmark inputs and a human-review rubric; never commit raw CVs or secrets.

**Gate 0:** A code-referenced contract/sequence map; a tested data export method; baseline metrics with sample size; an explicit list of gaps and risks. No changes to production behavior. If the public code or logs are insufficient, obtain a fresh bundle and diagnostic artifacts.

### Phase 1 — Reproducible offline benchmark and local runtime

Use self-contained snapshots or an owner-domain export. Reproduce current Qwen compatibility and GEO-pilot behavior with fixed prompt/model/quantization/settings. Record latency distribution, valid JSON/schema, CPU/GPU memory, effective throughput, human-reviewed errors, and output variability. Run offline, without production queue credentials. Verify `docker compose up/down` frees local resources; include cold and warm runs. Respect the actual ROCm/GPU support discovered during the phase.

**Gate 1:** Baselines can be replayed with pinned input/config; measurements and failures are comparable; nothing is written to production. Hardware/runtime limitations are documented.

### Phase 2 — Narrow model research after baseline

Use Phase 1 results to identify the main hard cases, context lengths, resource bottlenecks, and score quality risks. Search open-weight generative models **outside Qwen** and task-specific extraction/reranking/classification models. Check license, local runtime and ROCm support, context limit, actual output type, model provenance, and published evaluation limits. Shortlist only plausible candidates. Do not assume System 1 models generate source spans or explanations.

**Gate 2:** A small candidate matrix with evidence-based reasons to test/reject each model. The research report is a separate document, not added to this milestone's normal context.

### Phase 3 — GEO and language job-evidence pilot

Use a reviewed set of typical and difficult jobs (including ATS metadata conflicts, remote restrictions, travel destinations mistaken for worksites, multilingual clauses, mandatory/preferred languages, alternatives, and unknown levels). Compare deterministic, generative and non-generative extraction where practical. Test combined versus separate GEO/language extraction. Preserve exact source evidence and distinguish explicit facts from inference. Include issue #38 cases. Test input truncation and incomplete outputs.

**Gate 3:** Per-type precision/recall, severe false claim count, quote validity, false mandatory exclusion rate, runtime/resource measurements, and recommendation for the smallest evidence producer. **No automatic GEO or language exclusions based on unreviewed model output.**

### Phase 4 — Compatibility quality/performance benchmark

Replay the same job–CV pairs under current Qwen and selected alternatives, including no/limited thinking and at least one small matching model if it fits real inputs. Compare score differences, per-user ranking, top-k agreement, human judgments, invalid content, missing explanation claims, threshold crossings, and sustainable scores/hour. Evaluate a conditional summary only as a separately measured option. Measure the fraction of pair requests avoided by evidence-based GEO/language booking, including missed useful jobs, and compare it to a worker-local language precheck as an offline alternative. The automatic booking gate is a separate decision from the scoring-model contract.

**Gate 4:** An evidence-backed model choice or a decision to keep Qwen; measured quality loss and compute savings from pre-booking eligibility checks; a future-only score-contract change plan if score-only is selected. GEO/language facts gate automatic *booking*, not the scoring calculation. Agreement with current Qwen scores is not ground truth.

### Phase 5 — Approve minimal contracts and orchestration shape

Using Gates 0–4, decide what job-evidence enrichment produces and whether GEO and language share a job run. Specify only required API/schema changes: job-only run identity and snapshot; discovery notification with persisted user suggestions; validated job-fact projection and delivery acknowledgement; explicit Core post-processing to check **current** suggested users and book compatible pair runs; one canonical read-time/booking eligibility policy; Users API for profile-ready enumeration; timer repair of both evidence and missing downstream pair bookings; Jobs read-time matching; user-language semantics; stale evidence and score rules; unknown/pending UI behavior. Define the behavior for a new suggestion on an already-enriched job and failure after evidence delivery but before pair booking. Benchmark a representative Open Opportunities SQL query **before** adopting storage/index changes. Avoid a generic DAG engine or new cloud service without measured need.

**Gate 5:** Operator approves a short sequence/contract document with sample payloads and traces for (a) normal notification, (b) already-enriched job/new suggestion, (c) unavailable Core at notification time, (d) missed downstream booking after evidence delivery, (e) duplicate messages, and (f) changed user preferences. Show how repair enumerates all profile-ready users, applies the same eligibility rules as Open Opportunities, and limits the extra fan-out. Specify how Core identifies successful fact delivery before follow-up. Define the `unknown` booking policy. Confirm source owners, rollback and query-performance limits. A worker-local precheck is an alternative only if it meets the shared job-fact requirements.

### Phase 6 — Implement job evidence and deterministic read-time matching

Make the smallest approved code changes in Jobs, Users, Enrichers Core, Gateway/worker and ATS Discovery. Separate Core's per-type completion policies from transaction handling. Persist validated shared evidence in Jobs, reject stale delivery, and add live language matching to the existing Open Opportunities request contract; keep GEO eligibility read-time. Preserve count/pagination correctness. Add user language input and define the meaning of unlisted languages. Implement job-evidence booking and persisted notification suggestions behind a controlled switch. ATS Discovery submits one request and does not follow results. Build the Core timer's bounded job-evidence repair using existing timer patterns; expose the minimum Jobs/Users read contracts needed for later pair recovery. Keep existing compatibility booking active until Phase 7 cuts over, so this phase alone does not remove scores.

**Gate 6:** Unit/contract tests cover job-only runs, accepted suggestion durability, duplicate/retried booking, failed/offline notification recovery, stale evidence/projection order, Core's timer discovery of missing/outdated evidence, long downtime, mandatory/unknown/alternative language logic, preference edits without requalification, and SQL list paging/count. The ready-user enumeration contract is tested without returning CV text. Existing prod-targeting pytest integration tests are not broken by new unit tests. Operator measures p50/p95 query latency against Phase 0.

### Phase 7 — Enable evidence-gated compatibility booking and future score policy

Replace ATS-initiated pair booking with Core's **post-evidence** booking path. After Jobs confirms current job-fact delivery, Core fetches current suggested users' profiles, reuses the canonical matching policy, skips confirmed mismatches, and books suitable pair runs idempotently. New suggestions on an already-enriched job must follow the same gate without repeating extraction. Extend Core's repair timer: for recent jobs with current facts, enumerate **all profile-ready users**, apply the same match, and book missing pair runs, even if the original discovery notification was lost. Cover a failure after projection delivery but before follow-up. Limit repair work and measure excess pair fan-out and inference cost. The compatibility worker still scores from job/CV inputs without GEO/language facts. For new scoring runs, apply the approved score policy without the mandatory-language 0.5 override. Leave **all historical scores** unchanged and continue retryable per-type projection delivery. Do not hide manually saved or status-bearing jobs only because scoring is pending.

**Gate 7:** End-to-end tests prove that pair bookings occur **after** current job evidence is delivered and the eligibility check passes (or follows the approved `unknown` policy). Confirmed mismatches generate no pair run. Tests cover later suggestions, all-ready-user repair after Core outage, crash after fact delivery, duplicate completion/projection messages, changed preferences, no stale overwrite, and bounded catch-up. Quantify avoided and unnecessary pair requests; show that repair remains within the local capacity budget. No historical score is rewritten. Core owns the follow-up; no cross-domain SQL or generic workflow engine is added.

### Phase 8 — Controlled rollout, review and hand-off

Use offline replay and a short operator-controlled canary. Compare old/new opportunity sets, excluded good jobs, missing score explanations, list latency, time to a useful result, GPU-hours and backlog recovery. Confirm Core's timer repairs both missed job-evidence bookings and missing pair runs by considering all profile-ready users. Record its actual additional pair volume and cost. Keep rollback possible without rewriting historical scores or manual job statuses. Update `docs/system-design.md` with the verified final behavior after rollout and remove obsolete milestone material from the steady-state architecture.

**Gate 8:** Operator accepts measured quality and operational limits, verified rollback and hand-off. A decision to retain current models or skip an optional feature is a valid success outcome.

## Global stop conditions

Stop and review if the change silently removes likely good jobs; treats absent/unclear language as confirmed failure; performs LLM calls in Open Opportunities; blocks discovery on local inference; books automatic pair runs before trusted job evidence is available or after a confirmed mismatch; loses accepted suggestions or downstream booking work after a restart; duplicates pair scoring under retry; allows stale job facts or score projections to replace current ones; rewrites historical scores without approval; adds direct cross-domain DB writes; or causes an unacceptable query-latency increase. Preserve the old behavior behind a narrow rollback mechanism until Gates 7–8 pass.

## Required phase hand-off

Every phase leaves a short hand-off with: repository commit/bundle baseline, changed files and API contracts, measurements and sample sizes, passing/failing tests, deployment/config changes, known regressions, unresolved questions, the gate decision, and **the exact next phase**. Keep research and discarded alternatives outside this file unless they change its target architecture.
