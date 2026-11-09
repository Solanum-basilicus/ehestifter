# Milestone: Local Agentic Engineering Sandbox — Disposable VM, Bundle In / Patch Out

**Status:** Planned  
**Date:** 2026-08-07  
**Repository:** [Solanum-basilicus/ehestifter](https://github.com/Solanum-basilicus/ehestifter)  
**Supersedes:** the unfinished Phase 0D+ plan in the earlier local-agentic-engineering-sandbox milestone.

## 1. Purpose

Build a useful autonomous coding setup for Ehestifter that can accept a task against a known repository revision, work freely inside a disposable environment, and return a patch for human review.

The system does **not** need to protect its own disposable working copy from the coding agent. The important security boundary is between the autonomous coding environment and the developer host / real infrastructure.

The desired operator experience is approximately:

```text
task description
      +
current Ehestifter main
      ↓
disposable autonomous coding environment
      ↓
implementation + review/fix + optional self-testing
      ↓
patch + report
      ↓
human review / trusted validation / normal deployment process
```

At the end of this milestone, the autonomous setup should be useful without being trusted with GitHub credentials, Azure credentials, the developer checkout, or the host Docker daemon.

---

## 2. Previous experimental evidence

The earlier experiments remain useful evidence and are considered complete prerequisites.

- [Phase 0A results](https://github.com/Solanum-basilicus/ehestifter/blob/main/docs/journal/milestone_local_agentic_engineering_sandbox_phase_0A_results.md)
- [Phase 0B results](https://github.com/Solanum-basilicus/ehestifter/blob/main/docs/journal/milestone_local_agentic_engineering_sandbox_phase_0B_results.md)
- [Phase 0C results](https://github.com/Solanum-basilicus/ehestifter/blob/main/docs/journal/milestone_local_agentic_engineering_sandbox_phase_0C_results.md)

Those phases established, among other things, that:

1. OpenCode can be used with the selected local inference setup.
2. Ralphex can orchestrate OpenCode through the compatibility wrapper.
3. Ralphex should be treated as a **mutating local Git actor**:
   - it creates/uses local Git branches and commits;
   - review/fix behavior can modify code and commit fixes;
   - attempting to make its internal workflow read-only is contrary to how the tool naturally operates.
4. The original idea of enforcing bounded-context ownership by physically exposing only repository subtrees adds substantial orchestration complexity and is not required for the security objective.

The architectural bounded contexts documented in [system-design.md](https://github.com/Solanum-basilicus/ehestifter/blob/main/docs/system-design.md) still matter. They are product architecture rules to be respected by implementation and review; they are no longer intended to be filesystem security boundaries for the coding sandbox.

---

## 3. Revised design principles

### 3.1 The durable interface is bundle/task in, patch out

Ralphex, OpenCode, the chosen model, and the VM implementation are replaceable details.

The stable conceptual contract is:

**Input**

- an exact Ehestifter repository revision, represented internally by a Git bundle or equivalent immutable source snapshot;
- the operator's natural-language task;
- controller-owned execution policy.

**Output**

- a Git-compatible patch against the exact input revision;
- an implementation/review report;
- execution and self-test evidence where available;
- logs useful for diagnosing failed runs.

The patch is an **untrusted artifact** until independently reviewed or validated.

### 3.2 The agent may own its disposable VM

The autonomous coding setup may:

- rewrite repository files;
- make arbitrary local commits and branches;
- rewrite tests;
- install tools inside the guest where policy permits;
- run Docker and Docker Compose;
- build modified Dockerfiles;
- start databases and local emulators;
- inspect container logs;
- corrupt its Git repository;
- corrupt or destroy its guest operating system.

Those are acceptable failure modes if the guest VM is disposable.

The agent must **not** receive:

- the host Docker socket;
- host filesystem bind mounts containing valuable data;
- GitHub credentials;
- Azure credentials;
- production secrets;
- SSH keys from the host;
- uncontrolled access to the developer network.

### 3.3 Security and validation integrity are different problems

Agent-controlled testing is valuable for iterative coding but cannot be trusted as independent proof of correctness.

For example, the agent can make a failing test pass by changing the test rather than fixing the product. This is a validation-integrity problem, not a sandbox escape.

Therefore:

- **self-tests** run by the coding VM are evidence for the coding loop;
- **trusted validation**, when added, runs independently from immutable inputs in a separate disposable environment;
- human review remains authoritative until trusted validation is sufficiently mature.

### 3.4 Whole-repository visibility is preferred

The coding sandbox should normally receive the complete Ehestifter source snapshot.

Reasons:

- cross-domain contracts can be inspected directly;
- repository-level changes do not require synthetic partial trees;
- architectural decisions and component README files remain available;
- the agent can discover affected tests and infrastructure;
- orchestration is substantially simpler.

Whole-repository filesystem visibility does not imply placing the whole repository into the model context at once. OpenCode/Ralphex and future retrieval/planning mechanisms may still select relevant files for model context.

### 3.5 No autonomous push or deployment

This milestone ends at a patch/result package.

The system must not:

- push to GitHub;
- create or merge pull requests using repository credentials;
- deploy to Azure;
- access production data;
- make changes to real infrastructure.

Those can be considered independently later.

---

## 4. High-level architecture

```text
                          optional front ends
               ┌────────────┬────────────┬─────────────┐
               │ local CLI  │ Telegram   │ web/OpenWebUI│
               └──────┬─────┴──────┬─────┴──────┬──────┘
                      └─────────────┼─────────────┘
                                    v
                         TRUSTED JOB CONTROLLER
                         ----------------------
                         - authenticate operator
                         - preserve original task
                         - resolve repository ref
                         - create immutable input
                         - select fixed policy
                         - launch/delete VM
                         - enforce time/resource limits
                         - retrieve explicit outputs
                                    |
                                    v
                    DISPOSABLE CODING VM (UNTRUSTED)
                    ---------------------------------
                    - full Ehestifter source snapshot
                    - Ralphex
                    - OpenCode
                    - local-model access
                    - normal Docker daemon
                    - Docker Compose
                    - no real credentials
                    - no valuable host mounts
                    - may freely mutate guest state
                                    |
                                    v
                         UNTRUSTED RESULT PACKAGE
                         ------------------------
                         - change.patch
                         - report(s)
                         - self-test results
                         - logs
                                    |
                                    v
                         TRUSTED THIN VERIFIER
                         ---------------------
                         - reconstruct exact base
                         - patch syntax/apply check
                         - inspect changed paths
                         - artifact sanity checks
                         - does NOT initially execute
                           patched code
                                    |
                           human review / later
                         independent validation
```

Later phases add a separate disposable **validation VM**, but the coding VM does not need to become more restricted when that happens.

---

## 5. Initial virtualization choice

### Decision: Incus virtual machines backed by QEMU/KVM

Use actual Incus **VMs**, not Incus system containers, for the primary coding sandbox.

Rationale:

- the VM has its own kernel and forms a stronger practical boundary than another container sharing the host kernel;
- Incus provides lifecycle management, images, file transfer, guest command execution, resource controls, networking, and ACLs;
- the controller can create and destroy VMs programmatically without building directly on raw QEMU/libvirt plumbing;
- ordinary Docker can run inside the guest, eliminating the need for Docker-in-Docker or Sysbox as part of the baseline design.

Official references:

- Incus VMs are implemented using QEMU and are fully virtualized systems:  
  https://linuxcontainers.org/incus/docs/main/explanation/instances/
- Incus container/VM isolation model:  
  https://linuxcontainers.org/incus/docs/main/explanation/containers_and_vms/
- Incus instance options, including `security.nesting`:  
  https://linuxcontainers.org/incus/docs/main/reference/instance_options/
- Incus network ACLs:  
  https://linuxcontainers.org/incus/docs/main/howto/network_acls/

### Nested virtualization

The coding workload needs Docker containers inside the VM, not VMs inside the VM.

Set VM nested virtualization off unless a future task demonstrates a real need:

```text
security.nesting=false
```

For Incus VMs this disables the guest VMX/SVM CPU flags.

### Docker location

A normal Docker daemon runs **inside the disposable VM**.

If Ralphex/OpenCode itself runs in a container, that runner container may receive the **guest VM's** Docker socket.

This intentionally gives the coding agent broad control over the *guest*. Docker itself warns that access to its daemon can effectively provide root-level control over the Docker host:

https://docs.docker.com/engine/security/protect-access/

In this architecture:

```text
Docker host == disposable coding VM
```

That is an accepted capability.

The **real developer host Docker daemon must never be exposed to the coding VM**.

---

## 6. Job intake

### 6.1 Normal operator input

Routine jobs should require as little ceremony as possible.

Preferred human-facing submission:

```yaml
repository: ehestifter
ref: main
task: |
  <natural-language request>
```

`repository` and `ref` may eventually default to `ehestifter` and `main`, leaving only the task text for ordinary use.

The operator should not normally have to prepare:

- a Git bundle;
- `task.md`;
- `run.yaml`;
- a list of files;
- test commands;
- container manifests.

### 6.2 Controller-generated repository input

For the normal Ehestifter workflow, the trusted controller maintains or refreshes a clean repository mirror.

At job creation it:

1. resolves the requested ref to an exact full commit SHA;
2. records that SHA in the job manifest;
3. creates the immutable bundle/source snapshot itself;
4. transfers that snapshot into the disposable VM.

This removes routine repository upload from both local and remote workflows.

Explicit bundle upload remains useful as an advanced/offline input mode and for reproducing historical states.

### 6.3 Task preservation and optional LLM planning

A design-aware LLM may later help expand the operator task into implementation context and acceptance criteria.

However, the original operator request must be stored verbatim and remain authoritative.

Suggested internal task structure:

```markdown
# Operator request

<verbatim submitted task>

# Planning context

<LLM-generated interpretation, repository observations, suggested acceptance criteria>

# Controller policy

<fixed instructions such as patch-only output and credential restrictions>
```

The planner may recommend tests or likely files, but it must not choose or weaken security policy.

The planner is optional. Phase 1 must work without it.

### 6.4 Remote submission

All interfaces should eventually target the same small controller API.

Candidate front ends:

- local CLI;
- local watched inbox directory;
- Telegram bot;
- authenticated/tailnet-only web form;
- later, an OpenWebUI/OpenAPI integration.

Telegram should communicate with the trusted controller, **not directly with OpenCode**. The controller deterministically invokes Ralphex; the LLM does not decide whether to invoke the orchestrator.

Remote intake is Phase 3 and is deliberately not required for the first useful version.

---

## 7. Network policy

The VM is disposable, but unrestricted network access is still undesirable.

Initial coding VMs should have outbound access only to explicitly required endpoints, especially:

- the local inference endpoint;
- DNS if required by the selected network implementation.

The default should prevent access to:

- the broader development LAN;
- Azure control/data-plane endpoints;
- GitHub authentication surfaces;
- arbitrary Internet hosts.

Incus network ACLs support explicit ingress/egress policies:

https://linuxcontainers.org/incus/docs/main/howto/network_acls/

Package downloads and external container image pulls complicate this policy. They should be addressed incrementally through one or more of:

- prebuilt/golden VM images;
- preloaded Docker images;
- controlled package/container caches;
- a separately selected network-enabled execution policy.

The first useful coding run does not need to solve all offline dependency management.

---

## 8. Immutable inputs and artifact promotion

Do not mount a valuable host workspace directly into the coding VM.

Preferred transfer model:

```text
trusted host storage
      |
      | copy immutable job input
      v
 disposable VM filesystem
      |
      | retrieve only named result artifacts
      v
trusted host result storage
```

The coding VM can destroy its copy without affecting the original input.

The controller should retrieve only an allowlisted result set such as:

```text
output/
  change.patch
  result.json
  implementation-report.md
  review-report.md
  tests/
  logs/
```

Do not automatically promote:

- arbitrary VM filesystem contents;
- generated executables;
- VM images;
- container volumes;
- arbitrary symlink targets.

The patch remains untrusted data.

---

## 9. Patch generation

Ralphex may use whatever branches and commits it wants internally.

The final artifact is generated relative to the exact recorded base commit, not from assumptions about Ralphex branch structure.

The export mechanism must account for:

- modified files;
- added files;
- deleted files;
- executable-bit changes;
- binary files if such changes are permitted;
- relevant final uncommitted modifications, or explicitly fail if the final tree is unexpectedly dirty.

The result manifest should include at least:

- job ID;
- input base SHA;
- input bundle/snapshot hash;
- task hash;
- runner/VM image identity;
- Ralphex/OpenCode/model identifiers where practical;
- execution timestamps;
- final status;
- patch hash;
- changed paths;
- self-tests attempted and their reported results;
- unresolved risks reported by the agent.

---

## 10. Thin verifier

The initial verifier is intentionally small.

It must operate from trusted immutable inputs, not from the coding VM repository.

For Phase 1 it should:

1. reconstruct a fresh repository at the exact input base;
2. verify that the produced patch is syntactically valid;
3. verify that the patch applies cleanly to that base;
4. enumerate changed paths;
5. reject obviously dangerous artifact/path anomalies;
6. record verifier results;
7. **not execute patched code**.

Suggested sanity checks include:

- no paths escaping repository root;
- no unexpected symlink tricks;
- reasonable patch/result size limits;
- binary changes are explicitly reported;
- executable-bit changes are explicitly reported;
- base SHA matches the job manifest.

This verifier does **not** prove that the implementation is correct. Its initial purpose is to guarantee that the output is a well-formed artifact against the intended source revision.

---

# 11. Milestone phases

## Phase 1 — Real-repository isolated runner

### Goal

Produce the first useful end-to-end Ehestifter patch using the real monorepo inside a disposable VM.

This phase replaces the old synthetic/domain-scoped sandbox experiments.

### Scope

Build the minimum trusted controller and verifier required to:

1. resolve a real Ehestifter revision;
2. create immutable job input;
3. create a disposable Incus VM;
4. transfer the repository snapshot and task into it;
5. run the existing Ralphex/OpenCode/local-model toolchain;
6. let Ralphex mutate Git freely;
7. export a patch and report;
8. retrieve only declared output artifacts;
9. destroy the VM;
10. independently check that the patch applies to the original base.

No trusted project tests are required.

### First task

Use the real Ehestifter monorepo immediately.

A documentation-only task is preferred for the first run because failures are easier to attribute to runner/orchestration problems, but this is a debugging convenience rather than a security requirement.

Follow it quickly with a small real code task.

### Acceptance criteria

- [ ] Host virtualization prerequisites are documented and validated (`/dev/kvm`, Incus, storage, CPU/RAM).
- [ ] A reusable coding-VM base image/profile exists.
- [ ] The VM receives no GitHub or Azure credentials.
- [ ] The VM receives no valuable host filesystem bind mounts.
- [ ] The VM cannot access the host Docker socket.
- [ ] The controller resolves `main` (or specified ref) to an exact SHA before execution.
- [ ] The VM receives a self-contained immutable repository snapshot.
- [ ] The operator can provide the task as ordinary natural-language text.
- [ ] Ralphex/OpenCode can read and modify the complete monorepo.
- [ ] Ralphex may create arbitrary local branches/commits without affecting the host repository.
- [ ] A final Git-compatible patch is produced against the recorded base.
- [ ] New/deleted files are handled correctly.
- [ ] The thin verifier reconstructs the base and confirms the patch applies.
- [ ] The controller retrieves only allowlisted output artifacts.
- [ ] The coding VM is destroyed on success, failure, cancellation, and timeout.
- [ ] The developer's normal Ehestifter checkout remains untouched.
- [ ] A useful Phase 1 result can be manually reviewed and applied using the ordinary developer workflow.

### Explicit non-goals

- trusted automated tests;
- Azure emulator stack;
- remote submission;
- automated GitHub push/PR;
- automated deployment;
- strong correctness guarantees.

### Deliverables

- controller implementation;
- VM image/profile definition;
- runner entrypoint;
- patch exporter;
- thin verifier;
- result manifest format;
- Phase 1 journal entry with at least one real Ehestifter run.

---

## Phase 2 — Self-testing coding VM

### Goal

Allow the autonomous coding loop to build and test its own changes with broad freedom **inside the disposable VM**.

### Design

Run an ordinary Docker daemon in the coding VM.

The agent may use it directly or through a runner container connected to the VM's Docker socket.

The agent may:

- run existing test containers;
- run Docker Compose;
- build changed Dockerfiles;
- modify Compose files;
- start SQL or other supporting containers;
- modify tests;
- inspect logs;
- retry implementation based on failures.

No custom Docker test broker is required.

These results are explicitly classified as **self-test evidence**, not trusted validation.

### Acceptance criteria

- [ ] Docker Engine and Compose are usable in the coding VM.
- [ ] The agent can run Docker commands through the established OpenCode/Ralphex execution path.
- [ ] Docker access is confined to the disposable VM.
- [ ] The agent can build a repository Dockerfile after modifying it.
- [ ] The agent can start and inspect a simple Compose workload.
- [ ] At least one real Ehestifter component test suite can be executed autonomously.
- [ ] The agent can observe a deliberately introduced failure, modify code, and rerun the relevant test.
- [ ] Test commands/output are captured in the result package.
- [ ] The final report clearly distinguishes tests actually run from tests merely suggested or skipped.
- [ ] VM resource and wall-clock limits survive attempts by containers to consume excessive resources.
- [ ] VM teardown cleans up all guest containers, networks, volumes, and modified guest state by destroying the VM.

### Validation warning

A green self-test result is not authoritative because the coding agent can alter the tests and test configuration.

This risk is accepted in Phase 2 because self-testing primarily exists to help the autonomous implementation loop converge.

---

## Phase 3 — Remote intake and job control

### Goal

Make the setup comfortably usable when the operator is away from the development workstation.

### Architecture rule

Remote interfaces are thin adapters over the trusted job controller.

They must **not** expose OpenCode or Ralphex directly as the primary orchestration interface.

Control flow stays deterministic:

```text
operator
   ↓
remote front end
   ↓
trusted controller
   ↓
Ralphex
   ↓
OpenCode
```

### Initial remote interface

Telegram is the preferred first implementation because ordinary jobs normally require only task text; the controller creates the repository snapshot itself.

Expected operations:

- submit task;
- optionally select ref/profile;
- get job status;
- cancel job;
- retrieve summary/result patch or result archive;
- retrieve diagnostics for failed runs.

### Security requirements

- allowlist authorized Telegram user/chat identities;
- keep bot credentials on the trusted controller side;
- never inject the bot token into the coding VM;
- enforce one or a small bounded number of active jobs initially;
- enforce input size limits;
- never expose arbitrary host shell commands;
- preserve submitted task text verbatim in the job record.

### Optional later front ends

- small authenticated/tailnet-only web page;
- local CLI;
- OpenWebUI calling a controller OpenAPI endpoint.

These interfaces are intentionally outside the coding engine and can be added without redesigning execution.

### Acceptance criteria

- [ ] An authorized remote operator can submit an ordinary Ehestifter task without manually creating a Git bundle.
- [ ] The controller records the exact base SHA used for the remote job.
- [ ] Unauthorized Telegram users/chats cannot submit or inspect jobs.
- [ ] The operator can request job status.
- [ ] The operator can cancel a running job.
- [ ] The operator receives or can retrieve the final patch/result package.
- [ ] No GitHub/Azure credentials are introduced to the coding VM as part of remote access.
- [ ] Remote intake failure does not leave uncontrolled VMs running.

---

## Phase 4 — Independent validation VM

### Goal

Add automated evidence that does not depend solely on tests and files controlled by the coding agent.

### Architecture

Use a second disposable VM created independently from trusted immutable inputs.

```text
immutable base snapshot
          |
     +----+------------------+
     |                       |
     v                       v
coding VM              validation VM
     |                       |
     | change.patch          |
     +---------------------->|
                             |
                    apply to clean base
                             |
                    controller-selected
                       validation steps
```

The validation VM:

- does not run the coding agent;
- starts from the original trusted base;
- receives the candidate patch;
- applies the patch itself;
- executes controller-owned validation procedures;
- is disposable, so it may safely build/run agent-modified Dockerfiles if required.

### Validation classes

#### A. Patch/base verification

Carry forward Phase 1 checks.

#### B. Original-test compatibility

Where practical, execute tests from the original base against patched production code.

Purpose:

- detect simple deletion/weakening of existing tests;
- detect regressions hidden by agent modifications to the test suite.

This cannot be an unconditional hard gate for every task because legitimate behavior changes may require old tests to change.

#### C. Patched-suite execution

Run the repository test suite as delivered by the patch.

Purpose:

- establish that added/changed tests actually execute;
- verify the candidate tree's own claimed test state.

This remains weaker evidence because tests are agent-controlled.

#### D. Controller-owned checks

Add high-value fixtures/tests outside the writable repository where useful.

These are the strongest automated checks because the coding agent cannot alter them during implementation.

### Acceptance criteria

- [ ] Validation runs in a separate disposable VM/job from coding.
- [ ] The validation VM is reconstructed from immutable controller-owned inputs.
- [ ] The validator never trusts the coding VM working tree or Git metadata.
- [ ] At least one Ehestifter component has a controller-selected validation procedure.
- [ ] Validation results separately report original/base tests, patched tests, and external/controller-owned checks where applicable.
- [ ] Test mutation by the coding agent is visible in the result report.
- [ ] A deliberately weakened/deleted pre-existing test can be detected by at least one validation method.
- [ ] A malicious/broken candidate Dockerfile cannot affect the real host beyond the disposable validation VM boundary.
- [ ] Validation failure does not destroy the candidate patch; it is returned with clear failure evidence for human review.

### Non-goal

Do not attempt to make the autonomous system the merge authority. Human review remains part of the workflow.

---

## Phase 5 — Azure-local integration profiles

### Goal

Improve validation of Azure-oriented Ehestifter domains without giving the coding or validation VMs credentials to real Azure infrastructure.

Implement local integration environments only where they provide meaningful value.

### General principle

Prefer the cheapest useful validation level:

1. static/unit tests;
2. one Function App plus required local dependencies;
3. component integration stack;
4. multi-domain local stack only where justified.

Do not require every task to launch a complete Ehestifter environment.

### Azure Functions

Use **Azure Functions Core Tools** for the local Functions host.

The local runtime is started with:

```text
func start
```

Official reference:

https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local

Azure CLI (`az`) is not required merely to run Functions locally and should not be added to the baseline coding environment unless a later use case justifies it.

No real Azure credentials should be available.

### SQL

Provide a disposable SQL-compatible container and deterministic schema/seed process.

Before implementing this profile, identify from the current repository:

- the authoritative schema/migration path;
- required reference/seed data;
- component-specific database assumptions;
- cleanup/isolation requirements.

Start with the least complicated supported SQL Server/Azure-compatible local option that exercises the application's actual SQL usage.

### Storage

Use Azurite where Blob/Queue/Table storage integration is worth exercising.

Microsoft recommends Azurite as the local Azure Storage emulator:

https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite

If current production code assumes managed identity/service URI configuration only, add an explicit local-testing configuration seam rather than weakening production identity behavior.

### Messaging

Add a local Service Bus-compatible/emulator dependency only when a component test genuinely requires it.

Do not make the complete messaging stack a prerequisite for all Function App tests.

### Acceptance criteria

- [ ] At least one Azure Functions-based Ehestifter domain can run locally without Azure credentials.
- [ ] Its Function host is launched using a pinned/reproducible Core Tools environment.
- [ ] Required SQL schema and seed data are deterministic.
- [ ] Selected existing HTTP/integration tests can be pointed at the local Function host.
- [ ] Local tests cannot accidentally target the production database/storage/account through inherited credentials.
- [ ] Storage emulation is added for at least one component only if needed by meaningful integration coverage.
- [ ] Local integration environments are reusable by both coding self-tests and independent validation.
- [ ] Coding-VM self-tests and validation-VM results remain clearly distinguished.
- [ ] The documentation lists known differences between local emulators and the real Azure services for each implemented profile.

---

# 12. Execution policies

Do not require the operator to author per-job `run.yaml` files.

The controller should own a small set of explicit profiles.

Possible eventual profiles:

```text
default
    isolated VM
    local-model access
    no general Internet
    normal resource limits
    Docker available inside guest

network-enabled
    same as default
    controlled outbound Internet/package access
    explicit operator selection

high-resource
    larger CPU/RAM/time budget
    explicit operator selection

validation
    no coding agent
    clean base + candidate patch
    trusted validation procedure
```

Profile selection is security policy. An LLM may recommend a profile but should not autonomously grant itself broader network/credential/host access.

---

# 13. Threat model

## Protected assets

The design primarily protects:

- developer host filesystem;
- normal Ehestifter checkout;
- GitHub credentials;
- Azure credentials;
- production Azure resources;
- developer LAN services;
- trusted source snapshots/result store;
- trusted controller and validation definitions.

## Expected hostile or broken behavior inside coding VM

Assume the coding agent or generated code may:

- execute arbitrary shell commands;
- recursively delete files;
- modify Git configuration/history;
- modify tests;
- create large files;
- consume CPU/RAM/disk;
- create privileged Docker containers inside the VM;
- mount arbitrary **guest** paths into containers;
- download/run malicious software if network policy allows it;
- lie or be mistaken in its report.

The design should remain safe under those assumptions within the practical limits of a hobby-project VM boundary.

## Out of scope

This milestone is not attempting to provide:

- formal isolation guarantees against a QEMU/KVM hypervisor escape;
- safe execution of deliberately nation-state-grade hostile workloads;
- autonomous handling of production credentials;
- autonomous production deployment.

---

# 14. Resource and lifecycle controls

The trusted controller must own lifecycle enforcement independently of guest cooperation.

At minimum:

- CPU limit;
- RAM limit;
- maximum VM disk/job storage budget;
- wall-clock timeout;
- cancellation;
- forced VM stop/delete;
- stale-job cleanup on controller restart.

The agent must not be able to disable host-side timeout or resource controls by changing guest configuration.

Job cleanup is considered successful only when the disposable VM/storage allocated for the job is removed or deliberately retained by explicit operator debugging action.

---

# 15. Result trust model

Every result should be labelled conceptually according to its evidence level.

### Level 0 — Candidate only

- patch applies to expected base;
- no tests trusted/executed.

This is sufficient for Phase 1.

### Level 1 — Self-tested candidate

- coding agent reports tests/builds run in its own VM;
- logs/results captured;
- test suite may have been modified.

This is Phase 2 evidence.

### Level 2 — Independently validated candidate

- candidate reconstructed in a separate validation VM;
- controller-selected checks executed;
- results independent from coding VM state.

This starts in Phase 4.

No evidence level implies automatic merge/deployment approval during this milestone.

---

# 16. Deliberate simplifications

The revised design intentionally avoids several mechanisms considered in the earlier milestone.

### No per-domain filesystem sandbox

Bounded contexts remain architectural review rules, not separate physical agent workspaces.

### No Docker-in-Docker baseline

Docker runs normally in the disposable VM.

### No Sysbox baseline

It is unnecessary if the VM itself is the isolation boundary.

### No Docker test broker initially

The coding agent receives flexible Docker control inside the disposable VM. A restricted test broker would impede legitimate iteration and duplicate orchestration features already provided by Docker/Compose.

### No read-only Ralphex review

Ralphex may review and fix code using its natural mutating Git workflow.

### No agent-facing GitHub finalizer

The result boundary is the patch, not a pushed branch.

### No manually authored per-job `run.yaml`

Common policy belongs to the controller.

### No mandatory tiny-repository phase

The revised isolation model allows testing against the real monorepo immediately. A bad result is discarded with its VM.

---

# 17. Open questions to resolve during implementation

These should be answered from the real host/repository as the corresponding phase begins rather than designed speculatively.

## Before Phase 1

- Is KVM available and stable on the current development host?
- Which Incus installation method fits the host distribution?
- What VM image/base distribution should be pinned?
- What CPU/RAM/disk budget is reasonable for one coding job?
- How should the isolated VM reach the local inference endpoint without reaching the rest of the LAN?
- Should the runner execute directly in the guest or remain containerized inside it?
- What exact Ralphex command/profile should be considered the canonical batch entrypoint?
- What is the correct patch export behavior for a dirty final tree?

## Before Phase 2

- Which Docker images should be preloaded into the base VM?
- Which Ehestifter component gives the cheapest representative containerized test?
- Is controlled Internet/package access necessary, or can initial tests use cached/prebuilt artifacts?
- How should self-test commands/results be recorded reliably enough for review?

## Before Phase 3

- Telegram bot from scratch versus adapting an existing OpenCode Telegram project?
- Tailscale-only controller access versus Telegram Bot API only?
- Maximum result size practical for Telegram; when should result retrieval use a web/tailnet link instead?

## Before Phase 4

- Which existing test suites are high-value independent regression gates?
- How should base tests be overlaid against patched product code per language/component?
- Which checks need immutable external fixtures?
- What validation failures should be hard failures versus warnings?

## Before Phase 5

- Where is the authoritative Ehestifter SQL schema/migration bootstrap?
- Which Functions apps have sufficiently local dependencies for the first integration profile?
- Which production managed-identity paths need explicit local-test configuration seams?
- Which Azure emulators differ materially from production behavior used by Ehestifter?

---

# 18. Critical design review

## Strengths

1. **The security boundary matches the desired capability.**  
   The agent gets broad freedom where it is useful—inside a VM—rather than forcing every legitimate build/test operation through a custom permission layer.

2. **Value arrives in Phase 1.**  
   The project does not wait for remote interfaces, Azure emulators, or trusted automated validation before producing useful patches.

3. **The output contract is simple and tool-independent.**  
   Ralphex/OpenCode can later be replaced without changing the fundamental bundle/task-to-patch workflow.

4. **Testing freedom does not get confused with testing trust.**  
   Agent-run tests help convergence immediately; independent validation is added later.

5. **The real monorepo is used from the beginning.**  
   There is no need to maintain artificial bounded-context snapshots purely for isolation.

## Main remaining risks

### Hypervisor boundary is stronger, not absolute

A VM is a substantially more appropriate boundary for a Docker-controlling coding agent than another ordinary container, but it is not a formal guarantee against hypervisor/kernel vulnerabilities. Keep the host patched and avoid unnecessary passthrough devices.

### Network policy can become the practical weak point

A fully disposable VM with unrestricted LAN/Internet access could still:

- probe local services;
- interact with accidental credentials/services on the network;
- download nondeterministic dependencies;
- exfiltrate source/task material.

Network restrictions deserve early attention even though trusted testing can wait.

### Golden-image drift

A mutable manually maintained VM image can make runs difficult to reproduce.

The base image/profile should eventually have a declarative build/update process and identifiable version/digest.

### Disk exhaustion

An agent with Docker can generate large images, build caches, SQL files, and logs. Guest/VM storage must have a host-enforced quota or bounded volume.

### Patch is not automatically harmless

A patch may intentionally or accidentally introduce malicious code. The patch boundary protects the host during generation; it does not make applying/running the patch safe. Human review and later independent validation remain necessary.

### Agent-modified infrastructure deserves independent execution later

Dockerfile/Compose changes are precisely where unrestricted self-testing is most useful and self-reported success is least trustworthy. Phase 4's separate disposable validation VM is therefore important once Phase 1/2 prove useful.

### Planner-generated task expansion can distort intent

If an intake LLM is added, always retain the operator's original text verbatim and make generated planning context visibly secondary.

---

# 19. Success condition for the milestone

This milestone is successful when the following workflow is practical for ordinary hobby development:

1. The operator submits a natural-language task against Ehestifter.
2. The controller resolves an immutable source revision.
3. A disposable VM performs autonomous implementation, review/fix, and useful self-testing.
4. The VM has broad local build/test freedom but no valuable host/infrastructure credentials.
5. The system returns a well-formed patch and evidence package.
6. The disposable coding environment is destroyed.
7. A separate validation path can reproduce and independently test the candidate where worthwhile.
8. The operator remains the authority who decides whether to apply, commit, push, and deploy the change.

The preferred day-to-day experience should approach:

> **Give the system a problem and a repository revision; receive a patch worth reviewing.**

Anything beyond that is an optimization, not the core product.