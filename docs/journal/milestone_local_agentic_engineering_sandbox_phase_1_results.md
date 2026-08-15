## Phase 1 result

**Status:** provisional. The first real-repository end-to-end run succeeded. Phase 1 is not yet fully accepted because some milestone deliverables and acceptance checks are still pending.

**Date:** 2026-08-15

**Milestone:** https://github.com/Solanum-basilicus/ehestifter/blob/main/docs/milestone_local_agentic_engineering_sandbox.md

### Result summary

Phase 1 produced a valid patch from the real Ehestifter repository inside a disposable Incus VM.

The run used this flow:

```text
trusted host
  |
  | exact Git SHA + immutable Git bundle + task text
  v
disposable Incus VM
  |
  | Ralphex -> OpenCode -> local inference
  | free Git mutation inside the VM
  v
allowlisted patch artifacts
  |
  v
VM destroyed
  |
  v
fresh trusted checkout from the same bundle
  |
  | git apply --check
  | git apply
  | changed-path inspection
  v
manual verifier result
```

The first real task changed only `README.md`. The patch applied cleanly to the recorded base SHA.

The run also exposed several infrastructure and orchestration details that were not obvious from the initial design. These details are recorded below because they are required to reproduce the environment.

---

## Environment

Host:

- OS: Fedora Linux 44.
- CPU: AMD Ryzen 7 6800H.
- RAM: 16 GiB.
- Virtualization: Incus virtual machines with QEMU/KVM.
- Host storage:
  - `/`: ext4, 100 GiB total.
  - `/home`: ext4, 368 GiB total.
  - `/home` device: `/dev/mapper/glenspace-glenspacehome`.
- `/home` is a normal system boot mount from `/etc/fstab`.
- systemd unit: `home.mount`.

Project infrastructure root:

```text
Here and later in document substituted by $INFRA. Same environment variable returns absolute path.
```

Phase 1 state root:

```text
$INFRA/agentic-engineering-sandbox/phase-1
```

Persistent Incus storage root:

```text
$INFRA/agentic-engineering-sandbox/incus-storage
```

---

## Incus storage

### Initial finding

The first design tried to give Incus a custom loop-file path directly:

```bash
incus storage create agent-lvm lvm \
  source="$INCUS_POOL_FILE"
```

Incus rejected this configuration:

```text
Error: Custom loop file locations are not supported
```

### Final storage design

The final design uses a host-managed loop device and a dedicated LVM volume group.

Backing file:

```text
$INFRA/agentic-engineering-sandbox/incus-storage/agent-lvm.img
```

Backing-file logical size:

```text
80 GiB
```

The file is sparse. It initially used almost no physical space.

Host storage stack:

```text
/home ext4 filesystem
  |
  +-- agent-lvm.img, sparse 80 GiB file
        |
        +-- host-managed /dev/loopN
              |
              +-- LVM VG: ehestifter-incus
                    |
                    +-- Incus LVM storage pool: agent-lvm
```

Incus sees the existing LVM VG, not the backing file:

```bash
incus storage create \
  agent-lvm \
  lvm \
  source=ehestifter-incus
```

References:

- https://linuxcontainers.org/incus/docs/main/howto/storage_pools/
- https://linuxcontainers.org/incus/docs/main/reference/storage_lvm/

### Boot integration

A host systemd service manages the backing loop device and activates the VG:

```text
ehestifter-incus-storage.service
```

The unit uses:

```ini
RequiresMountsFor=$INFRA/agentic-engineering-sandbox/incus-storage/agent-lvm.img
```

This makes the storage service depend on the mount that contains the backing file.

Expected boot order:

```text
home.mount
  |
  v
ehestifter-incus-storage.service
  |
  v
Incus
```

Incus on Fedora is socket activated. Therefore, `incus.service` can be `inactive` after boot and still be healthy.

Use this boot-state check:

```bash
systemctl is-active home.mount
systemctl is-active ehestifter-incus-storage.service
systemctl is-active incus.socket

incus info
incus storage info agent-lvm
```

Do not require `incus.service` to be continuously active.

---

## Incus network

Managed bridge:

```text
agentbr0
```

Configuration:

```text
IPv4: 10.93.0.1/24
NAT: enabled
IPv6: disabled
```

Incus runs DHCP and DNS for the managed bridge.

Reference:

- https://linuxcontainers.org/incus/docs/main/reference/network_bridge/

### Firewalld finding

The VM NIC was present and UP, but the guest initially received no IPv4 lease.

The cause was the Fedora host firewall.

A dedicated firewalld zone was added:

```text
incus-agent
```

The zone is attached to `agentbr0`.

Host-facing ports allowed from this zone:

```text
67/udp
53/udp
53/tcp
```

This permits DHCP and DNS service on the Incus bridge without putting the bridge in firewalld's broad `trusted` zone.

After this change, the VM received a DHCP lease. One observed lease was:

```text
eh-agent-base-build
MAC: 10:66:6a:e6:dd:c6
IPv4: 10.93.0.114
```

### Firewalld forwarding policy

DHCP and DNS worked after the zone change, but Internet forwarding still failed.

A dedicated firewalld policy was added:

```text
incusEgress
```

Configuration:

```text
ingress zone: incus-agent
egress zone: ANY
target: ACCEPT
```

The `incus-agent` zone does not enable masquerading. Incus supplies NAT for `agentbr0`.

### Docker forwarding conflict

Internet forwarding still failed after the firewalld policy was present.

Host inspection showed:

```text
net.ipv4.conf.all.forwarding = 1

-P FORWARD DROP
-A FORWARD -j DOCKER-USER
-A FORWARD -j DOCKER-FORWARD
```

Docker had installed a global `FORWARD DROP` policy.

These scoped `DOCKER-USER` rules fixed Incus VM forwarding:

```bash
sudo iptables -I DOCKER-USER \
  -i agentbr0 \
  -j ACCEPT

sudo iptables -I DOCKER-USER \
  -o agentbr0 \
  -m conntrack \
  --ctstate RELATED,ESTABLISHED \
  -j ACCEPT
```

These rules allow connections that start from `agentbr0` and allow established return traffic. They do not add a general unsolicited forwarding rule into `agentbr0`.

The rules were configured for persistence through a Docker systemd drop-in. The pending reboot test must prove that Docker restores them.

References:

- https://linuxcontainers.org/incus/docs/main/howto/network_bridge_firewalld/
- https://docs.docker.com/engine/network/firewall-iptables/
- https://docs.docker.com/engine/network/packet-filtering-firewalls/

---

## Network security model

Two VM profiles exist.

### Builder profile

Profile:

```text
eh-agent-build
```

Initial resource configuration:

```text
CPU: 4
RAM: 4 GiB
root disk: 30 GiB on agent-lvm
network: agentbr0
```

The builder has normal outbound Internet access. It uses this access only to build the reusable golden image.

### Runtime profile

Profile:

```text
eh-agent-runtime
```

Initial resource configuration:

```text
CPU: 4
RAM: 6 GiB
root disk: 30 GiB on agent-lvm
network: agentbr0
```

The runtime profile has the Incus ACL:

```text
agent-runtime
```

The intended runtime egress rule allows only:

```text
$INFERENCE_IP:8081/tcp
```

Arbitrary Internet access is blocked.

The runtime network smoke test was completed before the real job.

Reference:

- https://linuxcontainers.org/incus/docs/main/howto/network_acls/

---

## Golden VM image

Base guest:

```text
Debian GNU/Linux 13 (trixie)
```

Observed source image metadata:

```text
Debian trixie amd64
serial: 20260812_05:24
```

Installed guest dependencies:

```text
docker.io
git
jq
zstd
ca-certificates
curl
```

Reusable published image:

```text
ehestifter-agent-phase1-v1
```

The golden image includes the previously proven Phase 0B runner assets.

Runner image:

```text
ehestifter/ralphex-opencode:phase-0b
```

Observed tool versions:

```text
Ralphex v1.5.1
OpenCode 1.17.7
```

The OpenCode compatibility wrapper is:

```text
/opt/ehestifter-agent/opencode-as-claude.sh
```

The OpenCode configuration is:

```text
/opt/ehestifter-agent/opencode.json
```

The runner uses the local inference endpoint through `$INFERENCEHOST:8081`.

The accepted Phase 0B model was:

```text
Qwen_Qwen3.5-9B-Q8_0.gguf
```

No host Docker socket is mounted into the coding VM.

No host Ehestifter checkout is mounted into the coding VM.

No host SSH, GitHub, or Azure credentials are intentionally transferred into the coding VM.

---

## Git mirror and immutable input

The trusted host maintains a mirror:

```text
$PHASE1/state/git/ehestifter.git
```

The mirror was created with:

```bash
git clone --mirror \
  https://github.com/Solanum-basilicus/ehestifter.git \
  "$MIRROR"
```

### Mirror ref finding

A `--mirror` clone mirrors normal branch refs directly.

The correct `main` ref is:

```text
refs/heads/main
```

It is not:

```text
refs/remotes/origin/main
```

The correct base resolution is:

```bash
BASE_SHA="$(
  git -C "$MIRROR" \
    rev-parse --verify 'refs/heads/main^{commit}'
)"
```

The first real Phase 1 run used:

```text
BASE_SHA=1c3cd60af66507d9b5b2792cb40b7a3be6ac81b4
```

### Bundle ref finding

The first bundle used a custom ref:

```text
refs/agent-input/<JOB_ID>
```

The bundle contained the required objects, but normal `git clone` did not select the custom ref as a branch.

The current job was recovered with an explicit `git fetch` of the bundle ref.

Future jobs must use a temporary branch ref:

```text
refs/heads/agent-input/<JOB_ID>
```

Example:

```bash
BUNDLE_BRANCH="agent-input/$JOB_ID"

git -C "$MIRROR" update-ref \
  "refs/heads/$BUNDLE_BRANCH" \
  "$BASE_SHA"

git -C "$MIRROR" bundle create \
  "$JOB/input/repository.bundle" \
  "refs/heads/$BUNDLE_BRANCH"

git -C "$MIRROR" update-ref -d \
  "refs/heads/$BUNDLE_BRANCH"

printf '%s\n' "$BUNDLE_BRANCH" \
  > "$JOB/input/bundle-branch.txt"
```

Validate the bundle before VM creation:

```bash
git -C "$MIRROR" bundle verify \
  "$JOB/input/repository.bundle"

test "$(
  git bundle list-heads \
    "$JOB/input/repository.bundle" \
    "refs/heads/$BUNDLE_BRANCH"
)" = "$BASE_SHA refs/heads/$BUNDLE_BRANCH"
```

This check should become part of the trusted controller.

---

## First real job

Job ID:

```text
phase1-20260815T121908Z
```

Base SHA:

```text
1c3cd60af66507d9b5b2792cb40b7a3be6ac81b4
```

Operator task:

```text
Documentation-only task.

Update the root README.md Documentation section to include a link to
docs/milestone_local_agentic_engineering_sandbox.md.

Describe it concisely as the active milestone for the disposable-VM
bundle/task-in, patch-out engineering sandbox.

Make no code changes and avoid unrelated documentation changes.
```

The task was passed as ordinary natural-language text.

The full Ehestifter monorepo was available inside the disposable VM.

The working branch was:

```text
agent-work
```

---

## Ralphex runner details

### Writable agent home finding

The first real Ralphex invocation failed before model execution.

OpenCode tried to write:

```text
/tmp/agent-home/.config/opencode/.gitignore
```

The first command had mounted the writable directory at `/agent-home`. This did not match the runner convention.

The working mount is:

```text
/job/agent-home:/tmp/agent-home:rw
```

with:

```text
HOME=/tmp/agent-home
```

This path must be retained in the runner entrypoint.

### Successful Ralphex command

The successful command used this effective container configuration:

```bash
docker run --rm \
  --name ralphex-job \
  --volume /workspace/ehestifter:/workspace/ehestifter:rw \
  --volume /job/agent-home:/tmp/agent-home:rw \
  --volume /opt/ehestifter-agent/opencode-as-claude.sh:/opt/ehestifter-agent/opencode-as-claude.sh:ro \
  --volume /opt/ehestifter-agent/opencode.json:/opt/ehestifter-agent/opencode.json:ro \
  --workdir /workspace/ehestifter \
  --env HOME=/tmp/agent-home \
  --env OPENCODE_CONFIG=/opt/ehestifter-agent/opencode.json \
  --env INFERENCEHOST="$INFERENCEHOST" \
  --entrypoint ralphex \
  ehestifter/ralphex-opencode:phase-0b \
    --claude-command=/opt/ehestifter-agent/opencode-as-claude.sh \
    --base-ref="$BASE_SHA" \
    --skip-finalize \
    --external-review-tool=none \
    --idle-timeout=5m \
    --session-timeout=30m \
    docs/plans/_agent-job.md
```

Ralphex completed the job successfully.

Observed total Ralphex duration:

```text
26m39s
```

Observed result:

```text
1 file changed
+1/-0 lines
```

Changed product file:

```text
README.md
```

---

## Ralphex timeout behavior

The implementation task completed quickly.

The review phase had repeated idle timeouts:

```text
claude review 1: idle timeout
claude review 2: idle timeout
claude review 3: idle timeout
claude review 4: completed
```

The configured idle timeout was `5m`.

The model sometimes worked for more than five minutes without producing output. This caused retries but did not prevent completion.

**Finding:** `--idle-timeout=5m` is probably too aggressive for the current local model and Ralphex review workflow.

Do not change it as part of this Phase 1 result record. For a later run, test a larger value such as 10 minutes and compare run time and failure behavior.

---

## Ralphex workflow-file collision

The trusted controller generated:

```text
docs/plans/_agent-job.md
```

Ralphex used this file as its workflow plan.

During review, one review agent interpreted the same file as an unrelated documentation change. It deleted the file to satisfy the operator request.

Ralphex later tried to move the workflow file to:

```text
docs/plans/completed/_agent-job.md
```

The move failed because the review had already deleted the source file.

Ralphex still completed successfully.

**Decision for Phase 1:** do not fix this now.

**Required future consideration:** controller-owned Ralphex workflow files must not be mistaken for candidate product changes. Future Ralphex plan design must separate workflow control data from the candidate patch or otherwise hide it from requirement review.

The patch exporter must always remove controller/runner metadata before staging:

```bash
rm -rf .ralphex

rm -f \
  docs/plans/_agent-job.md \
  docs/plans/completed/_agent-job.md
```

---

## Patch export

The final patch was generated against the recorded immutable base SHA, not against an assumed Ralphex branch.

The export used:

```bash
cd /workspace/ehestifter

rm -rf .ralphex

rm -f \
  docs/plans/_agent-job.md \
  docs/plans/completed/_agent-job.md

git add -A

git diff \
  --cached \
  --binary \
  --full-index \
  "$BASE_SHA" \
  > /job/output/change.patch

git diff \
  --cached \
  --name-status \
  "$BASE_SHA" \
  > /job/output/changed-paths.txt

git status --short \
  > /job/output/final-git-status.txt
```

`git add -A` is important. It makes the export include modifications, additions, deletions, and relevant final uncommitted tree changes.

The run retrieved only these declared output artifacts:

```text
change.patch
change.patch.sha256
changed-paths.txt
final-git-status.txt
```

The coding VM was then destroyed:

```bash
incus delete --force "$JOB_ID"
```

---

## Patch checksum defect

The first run generated the checksum with:

```bash
sha256sum /job/output/change.patch \
  > /job/output/change.patch.sha256
```

This wrote an absolute guest path into the checksum file:

```text
/job/output/change.patch
```

After the files were copied to the trusted host, `sha256sum -c` failed because that guest path does not exist on the host.

Future exports must generate a relative checksum:

```bash
(
  cd /job/output
  sha256sum change.patch > change.patch.sha256
)
```

For the existing Phase 1 run, verify the current artifact without trusting the path field:

```bash
EXPECTED="$(
  awk '{print $1}' "$JOB/output/change.patch.sha256"
)"

ACTUAL="$(
  sha256sum "$JOB/output/change.patch" |
    awk '{print $1}'
)"

test "$EXPECTED" = "$ACTUAL"
```

This check is still required before final Phase 1 acceptance.

---

## Thin verifier result

The verifier reconstructed a fresh repository from the immutable bundle and checked out:

```text
1c3cd60af66507d9b5b2792cb40b7a3be6ac81b4
```

The first-run bundle emitted this warning because it used the custom non-branch ref:

```text
warning: remote HEAD refers to nonexistent ref, unable to checkout
```

An explicit checkout of the recorded SHA succeeded.

Patch applicability check:

```bash
git -C "$VERIFY/repo" apply \
  --check \
  --binary \
  "$JOB/output/change.patch"
```

Result: success.

The patch was then applied to the fresh verifier tree.

Changed paths:

```text
M README.md
```

`git diff --check` reported no error.

The verifier did not execute patched code.

### Thin-verifier gaps

The manual verifier does not yet implement all Phase 1 verifier requirements.

Still required:

- reject path escapes;
- detect or reject unexpected symlink changes;
- enforce a patch/result size limit;
- explicitly report binary changes;
- explicitly report executable-bit changes;
- write a verifier result record;
- integrate the portable checksum check.

The current manual run proves clean patch application to the exact base. It is not yet the complete thin verifier described by the milestone.

---

## Corrected manual replay procedure

Use this procedure to repeat the Phase 1 documentation smoke test after the environment is stable.

### 1. Set trusted host variables

```bash
export INFRA=<absolute-path-to-infrastructure-root>
export PHASE1="$INFRA/agentic-engineering-sandbox/phase-1"
export MIRROR="$PHASE1/state/git/ehestifter.git"

export INFERENCE_IP=<local-inference-server-ip>
```

### 2. Check host storage and Incus

```bash
systemctl is-active home.mount
systemctl is-active ehestifter-incus-storage.service
systemctl is-active incus.socket

incus info
incus storage info agent-lvm

sudo losetup -j \
  "$INFRA/agentic-engineering-sandbox/incus-storage/agent-lvm.img"

sudo vgs
```

### 3. Check firewalld and Docker forwarding

```bash
sudo firewall-cmd \
  --zone=incus-agent \
  --list-all

sudo firewall-cmd \
  --info-policy=incusEgress

sudo iptables -S DOCKER-USER
```

Required scoped forwarding rules:

```text
-A DOCKER-USER -i agentbr0 -j ACCEPT
-A DOCKER-USER -o agentbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
```

### 4. Refresh the trusted Git mirror

```bash
git -C "$MIRROR" fetch --prune origin

BASE_SHA="$(
  git -C "$MIRROR" \
    rev-parse --verify 'refs/heads/main^{commit}'
)"

printf '%s\n' "$BASE_SHA"
```

### 5. Create a job

```bash
JOB_ID="phase1-$(date -u +%Y%m%dT%H%M%SZ)"
JOB="$PHASE1/state/jobs/$JOB_ID"

mkdir -p \
  "$JOB/input" \
  "$JOB/output"
```

### 6. Create a cloneable immutable bundle

```bash
BUNDLE_BRANCH="agent-input/$JOB_ID"

git -C "$MIRROR" update-ref \
  "refs/heads/$BUNDLE_BRANCH" \
  "$BASE_SHA"

git -C "$MIRROR" bundle create \
  "$JOB/input/repository.bundle" \
  "refs/heads/$BUNDLE_BRANCH"

git -C "$MIRROR" update-ref -d \
  "refs/heads/$BUNDLE_BRANCH"

printf '%s\n' "$BASE_SHA" \
  > "$JOB/input/base-sha.txt"

printf '%s\n' "$BUNDLE_BRANCH" \
  > "$JOB/input/bundle-branch.txt"

(
  cd "$JOB/input"
  sha256sum repository.bundle > repository.bundle.sha256
)
```

Validate before VM creation:

```bash
git -C "$MIRROR" bundle verify \
  "$JOB/input/repository.bundle"

test "$(
  git bundle list-heads \
    "$JOB/input/repository.bundle" \
    "refs/heads/$BUNDLE_BRANCH"
)" = "$BASE_SHA refs/heads/$BUNDLE_BRANCH"
```

### 7. Create the task

```bash
cat > "$JOB/input/task.md" <<'TASK'
Documentation-only task.

Update the root README.md Documentation section to include a link to
docs/milestone_local_agentic_engineering_sandbox.md.

Describe it concisely as the active milestone for the disposable-VM
bundle/task-in, patch-out engineering sandbox.

Make no code changes and avoid unrelated documentation changes.
TASK

(
  cd "$JOB/input"
  sha256sum task.md > task.md.sha256
)
```

### 8. Launch the disposable runtime VM

```bash
incus launch \
  ehestifter-agent-phase1-v1 \
  "$JOB_ID" \
  --vm \
  --profile eh-agent-runtime

until incus exec "$JOB_ID" -- true 2>/dev/null; do
  sleep 2
done

incus exec "$JOB_ID" -- \
  mkdir -p /job/input /job/output /workspace /job/agent-home

incus exec "$JOB_ID" -- \
  chmod 0777 /job/agent-home
```

### 9. Transfer immutable inputs

```bash
for f in \
  repository.bundle \
  task.md \
  base-sha.txt \
  bundle-branch.txt
do
  incus file push \
    "$JOB/input/$f" \
    "$JOB_ID/job/input/"
done
```

### 10. Reconstruct the exact repository

```bash
incus exec "$JOB_ID" -- bash -lc '
  set -eux

  BASE_SHA="$(cat /job/input/base-sha.txt)"
  BUNDLE_BRANCH="$(cat /job/input/bundle-branch.txt)"

  git clone \
    --branch "$BUNDLE_BRANCH" \
    --single-branch \
    /job/input/repository.bundle \
    /workspace/ehestifter

  cd /workspace/ehestifter

  test "$(git rev-parse HEAD)" = "$BASE_SHA"

  git switch -c agent-work

  git config user.name "Ehestifter Agent"
  git config user.email "agent@ehestifter.invalid"

  test "$(git rev-parse HEAD)" = "$BASE_SHA"
'
```

### 11. Create the temporary Ralphex plan

```bash
incus exec "$JOB_ID" -- bash -lc '
  set -eux

  cd /workspace/ehestifter
  mkdir -p docs/plans

  {
    echo "# Plan: Agent job"
    echo
    echo "## Operator request"
    echo
    sed "s/^/> /" /job/input/task.md
    echo
    echo "## Validation Commands"
    echo
    echo "- \`git diff --check\`"
    echo
    echo "### Task 1: Implement operator request"
    echo
    echo "- [ ] Read the complete operator request and relevant repository documentation."
    echo "- [ ] Make the smallest correct change satisfying it."
    echo "- [ ] Do not perform unrelated changes."
  } > docs/plans/_agent-job.md
'
```

Known issue: Ralphex review can treat this workflow file as a candidate change and can delete it. The exporter removes the workflow file before patch creation.

### 12. Run Ralphex

```bash
incus exec "$JOB_ID" \
  --env INFERENCEHOST="$INFERENCE_IP" \
  -- bash -lc '
    set -euo pipefail

    BASE_SHA="$(cat /job/input/base-sha.txt)"

    cd /workspace/ehestifter

    docker run --rm \
      --name ralphex-job \
      --volume /workspace/ehestifter:/workspace/ehestifter:rw \
      --volume /job/agent-home:/tmp/agent-home:rw \
      --volume /opt/ehestifter-agent/opencode-as-claude.sh:/opt/ehestifter-agent/opencode-as-claude.sh:ro \
      --volume /opt/ehestifter-agent/opencode.json:/opt/ehestifter-agent/opencode.json:ro \
      --workdir /workspace/ehestifter \
      --env HOME=/tmp/agent-home \
      --env OPENCODE_CONFIG=/opt/ehestifter-agent/opencode.json \
      --env INFERENCEHOST="$INFERENCEHOST" \
      --entrypoint ralphex \
      ehestifter/ralphex-opencode:phase-0b \
        --claude-command=/opt/ehestifter-agent/opencode-as-claude.sh \
        --base-ref="$BASE_SHA" \
        --skip-finalize \
        --external-review-tool=none \
        --idle-timeout=5m \
        --session-timeout=30m \
        docs/plans/_agent-job.md
  '
```

Note: the five-minute idle timeout caused repeated review retries in the first real run. Keep it for exact reproduction. Test a larger idle timeout separately.

### 13. Export the candidate patch

```bash
incus exec "$JOB_ID" -- env BASE_SHA="$BASE_SHA" bash -lc '
  set -eux

  cd /workspace/ehestifter

  rm -rf .ralphex

  rm -f \
    docs/plans/_agent-job.md \
    docs/plans/completed/_agent-job.md

  git add -A

  git diff \
    --cached \
    --binary \
    --full-index \
    "$BASE_SHA" \
    > /job/output/change.patch

  git diff \
    --cached \
    --name-status \
    "$BASE_SHA" \
    > /job/output/changed-paths.txt

  git status --short \
    > /job/output/final-git-status.txt

  (
    cd /job/output
    sha256sum change.patch > change.patch.sha256
  )
'
```

### 14. Retrieve only allowlisted artifacts

```bash
for f in \
  change.patch \
  change.patch.sha256 \
  changed-paths.txt \
  final-git-status.txt
do
  incus file pull \
    "$JOB_ID/job/output/$f" \
    "$JOB/output/$f"
done
```

### 15. Destroy the coding VM

```bash
incus delete --force "$JOB_ID"
```

The future controller must do this automatically for success, failure, cancellation, and timeout.

### 16. Run the current manual thin verifier

```bash
VERIFY="$(mktemp -d)"
BUNDLE_BRANCH="$(cat "$JOB/input/bundle-branch.txt")"

git clone \
  --branch "$BUNDLE_BRANCH" \
  --single-branch \
  "$JOB/input/repository.bundle" \
  "$VERIFY/repo"

test "$(
  git -C "$VERIFY/repo" rev-parse HEAD
)" = "$BASE_SHA"

(
  cd "$JOB/output"
  sha256sum -c change.patch.sha256
)

git -C "$VERIFY/repo" apply \
  --check \
  --binary \
  "$JOB/output/change.patch"

git -C "$VERIFY/repo" apply \
  --binary \
  "$JOB/output/change.patch"

git -C "$VERIFY/repo" diff \
  --name-status \
  "$BASE_SHA"

git -C "$VERIFY/repo" diff \
  --summary \
  "$BASE_SHA"

git -C "$VERIFY/repo" diff \
  --check \
  "$BASE_SHA"

rm -rf "$VERIFY"
```

Do not execute patched code in the Phase 1 verifier.

---

## Pending reboot test

A final reboot test is still required.

After reboot:

```bash
systemctl is-active home.mount
systemctl is-active ehestifter-incus-storage.service
systemctl is-active incus.socket

incus info
incus storage info agent-lvm

sudo losetup -j \
  $INFRA/agentic-engineering-sandbox/incus-storage/agent-lvm.img

sudo pvs
sudo vgs
sudo lvs -a

sudo firewall-cmd \
  --zone=incus-agent \
  --list-all

sudo firewall-cmd \
  --info-policy=incusEgress

sudo iptables -S DOCKER-USER
```

Then launch a temporary runtime VM and prove both network assertions again:

```text
local inference $INFERENCE_IP:8081: reachable
arbitrary Internet: unreachable
```

This validates the persistent chain:

```text
/home mount
  -> host loop/LVM activation
  -> Incus storage availability
  -> Incus bridge/firewalld policy
  -> Docker forwarding exception
  -> restricted runtime VM network
```

---

## Phase 1 acceptance review

| Criterion | Status | Evidence / gap |
|---|---|---|
| Host virtualization prerequisites documented and validated | PARTIAL | Incus/KVM/storage/resources were used successfully. Final reboot persistence test is pending. |
| Reusable coding VM base image/profile exists | PASS | `ehestifter-agent-phase1-v1`, `eh-agent-build`, and `eh-agent-runtime` exist and were used. |
| VM receives no GitHub or Azure credentials | PASS for observed run | No credentials were intentionally transferred. |
| No valuable host filesystem bind mounts | PASS | Repository enters as a copied immutable bundle. |
| No host Docker socket | PASS | Docker is inside the disposable VM. |
| Resolve requested ref to exact SHA | PASS manually | `main` resolved to `1c3cd60af66507d9b5b2792cb40b7a3be6ac81b4`. |
| VM receives self-contained immutable repository snapshot | PASS | Git bundle transferred into VM. |
| Natural-language task input | PASS | Documentation request was plain task text. |
| Ralphex/OpenCode can read and modify full monorepo | PASS | README edit and review completed. |
| Ralphex local Git mutation does not affect host repository | PASS by architecture; explicit host check still recommended | VM has an independent reconstructed repository. |
| Final Git-compatible patch against recorded base | PASS | `change.patch` produced and applied to exact base. |
| New/deleted files handled correctly | PARTIAL | Export uses `git add -A` and binary/full-index diff. First task only modified one tracked file. |
| Thin verifier reconstructs base and confirms patch applies | PARTIAL | Base reconstruction and apply check passed. Full anomaly checks and result record are not implemented. |
| Retrieve only allowlisted outputs | PASS for manual run | Four named output files were pulled. |
| Destroy coding VM on success/failure/cancel/timeout | PARTIAL | Success teardown was done. Automatic teardown on other exit paths is not implemented or tested. |
| Normal developer checkout remains untouched | LIKELY PASS; explicit evidence still required | No checkout was mounted. Record `git status --short` before final acceptance. |
| Useful result can be manually reviewed/applied | PASS | Patch changes only `README.md` and applies cleanly. |

---

## Deliverables still required by the milestone

The successful manual run proves the architecture, but Phase 1 deliverables are not yet all durable artifacts.

Still required:

1. **Trusted controller implementation**
   - resolve ref;
   - create and verify bundle;
   - launch VM;
   - copy input;
   - invoke runner;
   - enforce wall-clock/resource policy;
   - retrieve allowlisted outputs;
   - destroy VM in all exit paths.

2. **Version-controlled VM/profile definition**
   - document or export Incus storage, network, ACL, and profiles;
   - include the host systemd storage dependency;
   - include firewalld and Docker coexistence requirements.

3. **Durable runner entrypoint**
   - preserve `/tmp/agent-home`;
   - preserve read-only OpenCode wrapper/config mounts;
   - record runner identities.

4. **Durable patch exporter**
   - remove `.ralphex` and controller-owned plan artifacts;
   - use `git add -A`;
   - diff against exact base;
   - generate portable relative checksums.

5. **Complete thin verifier**
   - exact-base reconstruction;
   - patch checksum;
   - `git apply --check`;
   - changed-path report;
   - path-escape checks;
   - symlink checks;
   - patch/result size limit;
   - binary and executable-bit reporting;
   - result record;
   - no patched-code execution.

6. **Result manifest format and `result.json`**
   - job ID;
   - base SHA;
   - bundle hash;
   - task hash;
   - VM image identity;
   - runner image identity;
   - Ralphex version;
   - OpenCode version;
   - model identity where practical;
   - start/end timestamps;
   - final status;
   - patch hash;
   - changed paths;
   - self-tests attempted;
   - unresolved risks.

7. **Teardown behavior**
   - prove VM deletion on success, runner failure, cancellation, and controller timeout.

8. **Final host persistence test**
   - complete the reboot test described above.

9. **Current-run checksum verification**
   - compare the stored digest to the actual host patch because the first checksum file contains the guest absolute path.

10. **Explicit developer-checkout evidence**
    - record that the normal Ehestifter checkout is unchanged.

The milestone also recommends a small real code task soon after the documentation smoke test. This is useful evidence, but it is separate from the infrastructure proof.

---

## Decisions carried forward

1. Keep Incus VMs as the sandbox boundary.
2. Keep the full monorepo inside the disposable VM.
3. Keep Docker inside the disposable VM.
4. Do not expose the host Docker socket.
5. Keep the runtime VM network restricted to the local inference endpoint.
6. Use an Internet-enabled builder only to prepare the golden image.
7. Keep the host-managed sparse-file -> loop -> LVM VG design for Incus storage.
8. Keep the dedicated `incus-agent` firewalld zone instead of the broad `trusted` zone.
9. Keep the scoped `DOCKER-USER` forwarding exceptions for `agentbr0`.
10. Use mirror `refs/heads/main`, not `refs/remotes/origin/main`.
11. Use a temporary `refs/heads/agent-input/<JOB_ID>` ref for cloneable bundles.
12. Mount the runner home at `/tmp/agent-home`.
13. Remove `.ralphex` and generated plan files before patch staging.
14. Generate portable relative artifact checksums.
15. Do not fix the Ralphex `_agent-job.md` review collision in this Phase 1 result. Record it as a future runner-plan design issue.
16. Treat the five-minute Ralphex idle timeout as a known source of review retries. Test a larger value separately.
17. Keep the thin verifier non-executing in Phase 1.

---

## Conclusion

The Phase 1 architecture has a successful real-repository proof.

The run demonstrated:

- immutable source input;
- a disposable Incus VM;
- full-monorepo Ralphex/OpenCode execution;
- local-model access with restricted runtime networking;
- patch-only promotion to the trusted host;
- VM destruction after the run;
- fresh-base patch application outside the coding VM.

The remaining work is mainly to convert the proven manual procedure into the trusted controller, runner, exporter, verifier, and result-manifest deliverables that the milestone requires.

Do not mark Phase 1 as `accepted` until the pending completion items in this journal are closed.
