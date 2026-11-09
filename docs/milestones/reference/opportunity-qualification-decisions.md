# Opportunity Qualification — design decision notes

**Optional reference only.** This is not the milestone plan. Read it only if Phase 5 needs to resolve a design dispute or a selected implementation encounters a blocking constraint. Canonical plan: [`../opportunity-qualification.md`](../opportunity-qualification.md).

## Accepted direction (2026-11-09, v4)

1. Store shared GEO and language **facts** in Jobs, not per-user eligibility flags. Do not require preference hashes or requalification runs. Evaluate current user criteria during Open Opportunities reads.
2. ATS Discovery imports a job and notifies Enrichers Core with suggested user IDs. It does not wait for inference or follow results. Core owns subsequent booking decisions, retries and repairs.
3. Core first books/reuses **job-level evidence**. After the validated facts have been delivered to Jobs, Core evaluates each suggested user's **current** profile against those facts. **Confirmed GEO/language mismatches skip compatibility booking.** Other outcomes follow the Phase 5 `unknown` policy. Core books only reasonable job–user compatibility runs.
4. This is a **booking dependency**, not a **scoring computation dependency**. A compatibility worker can score a job/CV pair without GEO/language facts. Core uses those facts to avoid wasted pair runs.
5. If the ATS-to-Core notification is lost, a Core timer scans recent jobs. It books missing evidence runs and, when facts are ready, evaluates **all profile-ready users** (CV, GEO preferences and language preferences configured) to repair missing pair bookings. Original ATS suggestions are not needed for timer recovery. The extra fan-out must be measured and bounded.
6. Keep historical compatibility scores **unchanged**, including 0.5 mandatory-language overrides. Define a forward-only scoring policy without the override for new runs after approval; no historical migration or mass rescore.
7. Local inference remains optional during ATS Discovery. Models must run and stop through Docker Compose without excessive GPU/VRAM contention. YAGNI/KISS and measured quality are architecture gates.

## Edges that need a concrete Phase 5 contract

**Projection-before-follow-up.** Current completion writes a run result and projection-dispatch intent; it is not proof that Jobs has current facts. Core should start its booking follow-up after Jobs accepts the job-fact projection, or use a proven version-consistent alternative. If the projection fails, it remains retryable. No external HTTP call inside the run-completion transaction. A crash after successful delivery but before pair booking must be recoverable.

**Matching policy ownership.** Jobs' Open Opportunities and Core's pair-booking gate must agree on GEO and language suitability. Choose the smallest mechanism supported by verified code: share one pure deterministic matcher, or call a Jobs-owned matching endpoint with current normalized profiles. Do not implement two independent eligibility rules or use cross-domain SQL access.

**Accepted suggestions.** A successful discovery notification must persist the job-evidence request and its suggested user IDs (or durable work that covers them). Multiple notifications of one job can add suggestions. Do not rerun valid shared evidence merely to process another user. Failure to persist an accepted suggestion must not silently lose it. An idempotent follow-up can reuse an already-published fact revision.

**Timer repair without suggestions.** Periodically enumerate bounded recent/updated Jobs and all current profile-ready Users through owner APIs. Profile-ready is an input-readiness test, not evidence that a specific job fits. Apply canonical matching, book only missing suitable pair runs, and record dedupe. The timer must check downstream pair coverage **even when the job evidence has already been delivered**. Use rate limits, pagination, an overlap/catch-up window and backlog metrics. This wider search may produce jobs for users who ATS did not originally suggest; measure actual cost before rollout. If cross-product growth becomes excessive, revisit candidate selection with evidence, not a generic workflow framework.

**Unknown and incomplete facts.** Do not treat unspecified language, uncertain CEFR, pending/failed extraction or missing CV-language mentions as a confirmed mismatch. For a *completed* evidence result with an uncertain requirement, decide in Phase 5 whether Core books a score or defers it. For *pending* extraction, the new automatic pair booking can remain pending; ATS never waits.

**Concurrent changes.** Core checks current user profiles at booking time. A user preference edit changes Open Opportunities immediately but does not automatically rescore historical pairs. Recent jobs that become suitable may acquire a missing score through timer repair. A confirmed mismatch after a preference edit makes an existing score unused but does not erase it. Old job-evidence projections and late scoring projections must not overwrite newer revisions.

**Special paths.** Manual scoring, manually saved jobs, user status updates, and existing integration tests must keep their supported behavior. Do not force all scoring entry points to wait for the automatic discovery evidence gate. Verify exact behavior in Phase 0, then define narrow exceptions in Phase 5.

## Rejected or deferred alternatives

| Alternative | Reason for deferral | Reopen only if |
| --- | --- | --- |
| Persist per-user GEO/language eligibility | Creates invalidation, backfill and preference-version management | Measured query-time matching cost is too high |
| Preference hash and historical qualification cache | Unnecessary for cheap read-time matching | Eligibility itself becomes expensive |
| Apply preference changes to future jobs only | Inconsistent with current live GEO filtering | Product requirements change explicitly |
| Book compatibility immediately on ATS notification | Scores users who may fail known GEO/language requirements | Evidence gate proves too costly or unreliable |
| Independent matching rules in Jobs and Core | Divergent results can waste scoring and confuse UI | Never; choose one canonical matching policy |
| Store all ATS user suggestions just for lost notification repair | Timer can use all profile-ready users | Repair fan-out exceeds measured capacity |
| General workflow/DAG orchestration | Extra state and maintenance for one known dependency | Several more distinct dependencies emerge |
| New cloud queue/scheduler | Existing runs, projection dispatch and timer repair may suffice | Verified capacity or reliability limits |
| Separate GPU server per model | Wastes local resources | Sustained throughput benchmark proves benefit |
| Historical score migration or full rescore | Time-sensitive jobs; operator accepts old results | Separate product requirement with measured value |

## Open contract questions at implementation gates

- Can the current run schema represent a job-only subject and retain suggested users safely? What is the smallest change?
- What event or receipt proves that current job facts are available in Jobs? Can Core trigger follow-up idempotently after that delivery, and can the timer repair a missed follow-up?
- How do Jobs and Core reuse the same GEO/language matching policy without duplicating SQL logic or overbuilding a new API?
- Can the authorized Users API enumerate **profile-ready** users without returning CV content? How many users/jobs can the timer review within a bounded window?
- Does the timer use the same lookback after a long Core outage? What is the cap on extra pair bookings compared to normal ATS suggestions?
- What does a user language list mean when it omits a language? Which uncertain results lead to scoring and which remain pending?
- How should Open Opportunities show pending/unknown evidence and scores, without hiding manually saved or status-bearing jobs?
- Does one combined evidence run outperform separate GEO and language extraction, and what failure coupling does that create?

These questions do not block documentation. They are contract gates that must be settled using the current code and measurements.
