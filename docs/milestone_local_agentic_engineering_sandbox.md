# Milestone: Local Agentic Engineering Sandbox

## 1. Goal

Design and validate a local agentic engineering loop for Ehestifter with small blast radius.

The target end-state of this milestone is:

1. `ralphex` can orchestrate `opencode` through its OpenCode proxy path.
2. `opencode` can use the local OpenAI-compatible model API.
3. Agents can work inside Docker-contained workspaces.
4. Domain workers are physically prevented from reading or writing unrelated domains.
5. Review agents can inspect produced changes.
6. Final code can be pushed to a safe branch or opened as a PR for manual human review.
7. No agent receives GitHub credentials, cloud credentials, Docker socket access, or broad host filesystem access.

This milestone is an infrastructure and workflow milestone. It does not implement product features.

---

## 2. Context

Ehestifter is increasingly developed with coding-agent assistance.

The existing system has strong domain boundaries:

* Web Core owns browser presentation and proxy/orchestration.
* Jobs owns job records, statuses, compatibility projections, and job-related storage.
* Users owns user profile, CV, Telegram linking, and user-related storage.
* Enrichment Core owns enrichment lifecycle and projection dispatch.
* Gateway owns Service Bus bridge and worker-facing APIs.
* Compatibility worker owns local inference execution.

The agentic infrastructure should preserve those boundaries rather than flattening the repo into one writable blob.

---

## 3. Main design decision

Subagent boundaries are not trusted if implemented only as prompts.

For this project:

* OpenCode/ralphex agent configuration may define behavior.
* Docker container boundaries define actual filesystem and network access.
* Bind mounts define what the agent can read or write.
* Network policy defines which local services the agent can call.
* Git finalization happens after work and review, not continuously during agent execution.

Prompt discipline is useful, but not a security boundary.

---

## 4. Non-goals

This milestone does not include:

* autonomous deployment,
* direct agent access to GitHub,
* direct agent access to Azure,
* direct agent access to GCP,
* direct Docker socket access,
* production integration-test automation,
* unit-test strategy design,
* full MCP/tool ecosystem,
* internet-enabled browsing agents,
* long-running autonomous background operation,
* multi-branch merge automation,
* automatic merging of agent output.

---

## 5. Threat model

## 5.1 Main risks

Agents may:

* read files outside intended scope,
* rewrite unrelated domains,
* exfiltrate secrets,
* call unintended network services,
* mutate infrastructure or deployment configuration,
* produce broad unreviewable diffs,
* hide behavior in generated scripts,
* modify test or validation logic to make bad code pass,
* push directly to production-connected branches.

## 5.2 Mitigation principles

* No cloud credentials inside agent containers.
* No GitHub token inside agent containers.
* No Docker socket inside agent containers.
* No broad repo write mount for domain workers.
* No raw internet access by default.
* Domain workers receive only the domain they may edit.
* Cross-domain knowledge is supplied through readonly docs/contracts.
* Final branch/PR operation is separate from coding.
* Human operator merges or rejects the branch/PR manually.

---

## 6. Component model

## 6.1 Human Operator

Owns:

* milestone selection,
* task framing,
* branch/PR acceptance,
* deployment,
* infrastructure changes,
* secrets,
* resolving merge conflicts,
* accepting or rejecting generated code.

The human operator is the only actor allowed to merge to deployment-connected branches.

## 6.2 Composer

Composer is the top-level agent role.

Possible implementation:

* ralphex-driven opencode session,
* or direct opencode session during early experiments.

Composer may:

* read full project context if needed,
* create or refine task plan,
* select worker profile,
* prepare minimal context for workers,
* run review loop,
* decide whether finalization is allowed.

Composer may not:

* deploy,
* access cloud credentials,
* access GitHub credentials directly,
* merge to protected branches,
* rewrite unrelated domains itself unless explicitly running in broad-workspace experimental mode.

## 6.3 Domain Worker

A Domain Worker is an agent session running in a container with a narrow workspace.

Example worker profiles:

* `worker-gateway`
* `worker-jobs`
* `worker-users`
* `worker-enrichers`
* `worker-core`
* `worker-telegrambot`
* `worker-compatibility`
* `worker-docs`

A domain worker receives:

* one writable domain mount,
* readonly docs,
* readonly contract/context snapshots,
* local model API access,
* no GitHub credentials,
* no cloud credentials,
* no Docker socket,
* no internet by default.

Example:

```text
worker-gateway can write:
- backend/gateway

worker-gateway can read:
- docs
- contracts
- .agent-context

worker-gateway cannot see:
- backend/jobs
- backend/users
- backend/enrichers
- backend/core
- workers/compatibility
```

This is intentional. If gateway needs a Jobs API shape, Composer gives it a contract snapshot. If Jobs code must change, Composer starts a separate Jobs worker.

## 6.4 Review Agent

A Review Agent inspects code after worker changes.

Review agents may be ralphex-native if the ralphex/opencode path works.

Initial review profiles:

* correctness review,
* security review,
* boundary review,
* minimalism review,
* documentation review.

Review agents should be readonly in v0.

They may inspect:

* changed domain,
* generated diff,
* relevant docs/contracts,
* milestone plan.

They should not directly patch files in v0.

## 6.5 Finalizer

Finalizer is a narrow script or container, not a general Git broker.

It runs only after:

1. worker finished,
2. review finished,
3. Composer decided output is finalizable.

Finalizer may support only these modes:

```text
finalize-branch
finalize-pr
```

### `finalize-branch`

Creates or updates a configured branch name such as:

```text
agent/<milestone-slug>
```

Allowed behavior:

* check working tree status,
* create branch from current local main,
* commit current workspace changes,
* push branch to origin.

Disallowed behavior:

* push to main,
* force-push,
* create tags,
* create releases,
* edit GitHub Actions as a hidden side effect,
* deploy.

### `finalize-pr`

Same as `finalize-branch`, plus opens a PR targeting a configured branch.

Human operator still reviews and merges manually.

## 6.6 Contract Snapshots

Contract snapshots are readonly context files supplied to agents.

Initial files may be manually maintained:

```text
contracts/jobs-api.md
contracts/users-api.md
contracts/enrichers-api.md
contracts/gateway-api.md
contracts/storage-layout.md
contracts/domain-boundaries.md
```

Later they may be generated from code, OpenAPI, SQL migrations, or system design sections.

In v0, correctness matters more than automation.

---

## 7. Filesystem boundary model

## 7.1 Full repo checkout

There is one normal local checkout controlled by the human operator.

Composer may operate over this checkout during early experiments.

Domain workers should not receive the whole checkout read-write.

## 7.2 Worker mount pattern

Each worker container receives a synthetic workspace.

Example for gateway:

```text
/workspace/backend/gateway        rw
/workspace/docs                   ro
/workspace/contracts              ro
/workspace/.agent-context         ro
/workspace/.agent-output          rw
```

The worker does not receive mounts for other domains.

## 7.3 Why not rely on `.gitignore`, prompts, or agent config?

Because those are advisory.

A capable agent with shell/file tools can inspect anything visible to the process.

Therefore:

* unmounted paths are the primary read boundary,
* readonly mounts are the primary write boundary,
* tool permissions are secondary,
* prompts are tertiary.

---

## 8. Network boundary model

## 8.1 Default policy

Agent containers should have no internet access by default.

They may access only:

* local OpenAI-compatible model API,
* local ralphex/opencode proxy path as needed,
* optional local contract/context services if introduced later.

## 8.2 Local model API

The local OpenAI-compatible API currently does not require auth.

For this milestone, that is acceptable if:

* it is reachable only from local Docker network,
* it is not bound to public interfaces,
* no cloud or repo credentials are exposed through it.

Shared-key/password auth can be postponed.

## 8.3 Internet access

No raw internet access in v0.

If future tasks need dependency docs or package lookup, add one of:

* human-provided context,
* readonly downloaded docs,
* a separate fetcher container with allowlisted domains,
* an explicit manual research step.

---

## 9. Git workflow

## 9.1 Branch-per-milestone model

Only one active agent branch should exist per milestone.

Recommended branch name:

```text
agent/<milestone-slug>
```

Each new milestone starts from one of:

* accepted main,
* manually selected base branch,
* previously accepted agent branch.

Do not stack new autonomous milestones on unresolved branches unless explicitly chosen.

## 9.2 Local work cycle

1. Human operator starts from clean repo.
2. Human operator pulls latest main.
3. Composer starts.
4. Composer creates plan.
5. Worker agents modify scoped workspaces.
6. Review agents inspect output.
7. Composer accepts or loops.
8. Finalizer commits and pushes branch or PR.
9. Human operator reviews outside agent setup.
10. Human operator merges or rejects.

## 9.3 Merge conflict policy

Merge conflicts are not solved autonomously in v0.

If base branch changes during a milestone:

* human operator decides whether to rebase/restart,
* agent may help explain conflicts,
* finalizer should not force-push or auto-resolve.

---

## 10. Test and validation model

## 10.1 Current reality

Automated test infrastructure is not mature enough to be a hard gate for this milestone.

Current constraints:

* many components are Azure Functions,
* local boot often requires Azure Functions tooling,
* current integration tests mostly target production environment,
* gateway integration tests can race with compatibility workers because they share Service Bus channel,
* unit tests are not yet established.

## 10.2 Decision

Do not build a test runner in this milestone.

Do not make automated test execution a Phase 0 acceptance gate.

## 10.3 Allowed validation in this milestone

Use lightweight validation only:

* static diff inspection,
* syntax checks if directly available,
* lint/type checks only where already cheap and local,
* reviewer inspection,
* manual operator-run tests when appropriate.

## 10.4 Future test-runner milestone

A future milestone may design deterministic testing.

Likely direction:

* per-domain local unit tests first,
* fake Service Bus or isolated queue for gateway tests,
* no production integration tests as autonomous gate,
* runner-owned compose files outside agent write scope,
* no Docker socket exposed to agents.

---

## 11. Phase plan

## Phase 0A — OpenCode Local Model Smoke Test

Goal:

Validate that opencode can use the local OpenAI-compatible API from inside Docker.

Tasks:

1. Create disposable tiny repo.
2. Run opencode in container.
3. Configure provider to local OpenAI-compatible API.
4. Ask opencode to make a trivial code/doc change.
5. Confirm output is usable.
6. Confirm container has no GitHub token, no cloud creds, and no Docker socket.

Acceptance criteria:

* opencode can complete a trivial edit.
* local model API path works.
* no external provider credentials are required.
* no host-level dangerous access is present.

## Phase 0B — ralphex to opencode Proxy Smoke Test

Goal:

Validate that ralphex can drive opencode through the proxy script path.

Tasks:

1. Install or mount ralphex in a container.
2. Configure ralphex to use the opencode compatibility/proxy path.
3. Use the same disposable tiny repo.
4. Write a minimal ralphex plan with one task and one harmless validation command.
5. Run ralphex.
6. Observe session creation, task execution, validation behavior, review behavior, and commit behavior.

Acceptance criteria:

* ralphex can invoke opencode.
* ralphex can execute one planned task.
* ralphex behavior is understandable from logs.
* ralphex does not require unwanted cloud credentials.
* ralphex does not require direct GitHub access for local execution.
* any automatic commit behavior is understood and can be accepted or disabled.

## Phase 0C — ralphex Review Plausibility Test

Goal:

Determine whether ralphex can be used as the review/gatekeeper layer.

Tasks:

1. Prepare a tiny intentional bug.
2. Run ralphex review flow.
3. Check whether review agents detect the bug.
4. Check whether review can run readonly or without direct patching.
5. Check whether review can consume extra context files.
6. Check whether review can be pointed at a restricted workspace/diff.

Acceptance criteria:

* review flow is useful enough to keep evaluating,
* review output is structured enough for Composer/human use,
* readonly review mode is plausible,
* context injection is plausible.

## Phase 0D — Scoped Workspace Experiment

Goal:

Validate that filesystem isolation prevents cross-domain access.

Tasks:

1. Create fake repo with directories:

   * `backend/gateway`
   * `backend/jobs`
   * `backend/users`
   * `docs`
   * `contracts`
2. Start `worker-gateway` container with:

   * `backend/gateway` mounted rw,
   * `docs` mounted ro,
   * `contracts` mounted ro,
   * no mounts for `backend/jobs` or `backend/users`.
3. Ask worker to inspect Jobs code.
4. Confirm it cannot.
5. Ask worker to edit Gateway code.
6. Confirm it can.
7. Ask worker to edit docs.
8. Confirm readonly mount blocks writes.

Acceptance criteria:

* unmounted domains are not visible.
* readonly docs/contracts cannot be modified.
* writable domain can be modified.
* opencode/ralphex still function under scoped mounts.

## Phase 0E — Finalizer Spike

Goal:

Replace bloated git broker idea with a narrow finalization mechanism.

Tasks:

1. Create `agent-finalize` script or container.
2. Support `finalize-branch`.
3. Optionally support `finalize-pr`.
4. Hardcode or configure:

   * allowed source repo path,
   * allowed branch prefix `agent/`,
   * forbidden target branch `main` for direct push,
   * no force-push.
5. Test on disposable repo.

Acceptance criteria:

* finalizer can commit and push an agent branch.
* finalizer cannot push to main.
* finalizer does not expose GitHub token to agent containers.
* finalizer is invoked only after review.

## Phase 1 — Minimal Real Repo Dry Run

Goal:

Run the workflow against Ehestifter with a documentation-only change.

Tasks:

1. Create branch `agent/local-agent-sandbox-docs`.
2. Give Composer access to system design and this milestone.
3. Give docs worker write access only to selected docs path.
4. Make a tiny documentation change.
5. Run review.
6. Finalize to branch or PR.
7. Human operator reviews manually.

Acceptance criteria:

* workflow works on real repo.
* generated diff is small.
* unrelated code is untouched.
* final branch/PR is reviewable.

## Phase 2 — Single-Domain Code Dry Run

Goal:

Allow an agent to make a low-risk code change in one domain.

Candidate domains:

* Gateway, if task is isolated.
* Web Core, if UI-only and non-destructive.
* Compatibility worker, if local-only.

Avoid initially:

* Jobs DB write paths,
* Users identity/CV storage,
* enrichment lifecycle,
* migrations,
* GitHub Actions,
* deployment configuration.

Acceptance criteria:

* one scoped worker completes one small code task.
* reviewer finds no boundary violations.
* human operator can understand the diff.
* no unrelated domains are touched.

## Phase 3 — Cross-Domain Orchestration Dry Run

Goal:

Validate Composer splitting work across two domains without giving one worker broad access.

Tasks:

1. Choose tiny cross-domain change.
2. Composer prepares contracts/context.
3. Worker A changes domain A.
4. Worker B changes domain B.
5. Review agents inspect combined diff.
6. Finalizer creates branch/PR.

Acceptance criteria:

* workers remain physically scoped.
* cross-domain contract is explicit.
* no worker needed full repo write access.
* final diff is coherent.

---

## 12. Operational rules

## 12.1 Before starting a run

Human operator should ensure:

* repo is clean,
* base branch is correct,
* local model API is running,
* no production secrets are mounted,
* intended worker profile is selected,
* task is small enough for review.

## 12.2 During a run

Composer should keep a task log:

```text
.agent-output/task-log.md
```

Recommended content:

* task goal,
* selected worker profile,
* files changed,
* validations attempted,
* reviewer findings,
* unresolved risks.

## 12.3 After a run

Human operator should inspect:

* full diff,
* changed file list,
* task log,
* reviewer output,
* branch name,
* PR target if applicable.

---

## 13. Safety invariants

The setup is invalid if any of these are false:

* Agent container has GitHub token.
* Agent container has Azure credentials.
* Agent container has GCP credentials.
* Agent container has Docker socket.
* Domain worker can read unrelated domain source.
* Domain worker can write docs/contracts mounted readonly.
* Finalizer can push directly to main.
* Agent can edit finalizer script during the same run.
* Agent can edit its own Docker Compose/profile during the same run.
* Agent can silently modify GitHub Actions or deployment configuration.

---

## 14. Deferred work

Deferred to future milestones:

* deterministic local test runner,
* isolated Service Bus queue for gateway tests,
* unit-test strategy,
* contract snapshot generation,
* GitHub PR comment bot,
* policy-as-code enforcement,
* internet fetcher skill,
* local package/documentation mirror,
* MCP server allowlist,
* shared-key auth for local model API,
* multi-agent dashboard.

---

## 15. Acceptance criteria for whole milestone

Milestone is complete when:

1. opencode works against local OpenAI-compatible API in Docker.
2. ralphex can plausibly drive opencode through proxy path, or is explicitly rejected with documented reason.
3. At least one domain worker profile physically restricts filesystem access.
4. Review flow is validated as useful or explicitly deferred.
5. Finalizer can push a safe agent branch or PR without exposing GitHub credentials to agents.
6. No agent has cloud credentials, GitHub credentials, Docker socket, or broad host filesystem access.
7. A real repo documentation-only dry run succeeds.
8. A small single-domain code dry run succeeds or is blocked with documented reason.
9. The resulting operating procedure is documented for future milestones.

---

## 16. Recommended first implementation step

Start with Phase 0A and Phase 0B only.

Do not build scoped workers, finalizer, or review gates before confirming the basic ralphex/opencode/local-model chain works.

The first useful artifact should be a short note:

```text
docs/agentic/phase-0-results.md
```

It should record:

* opencode local model config,
* ralphex opencode proxy config,
* exact command used,
* whether commits were automatic,
* whether review worked,
* whether any unwanted access was required,
* decision: continue / modify / reject ralphex path.

```
```
