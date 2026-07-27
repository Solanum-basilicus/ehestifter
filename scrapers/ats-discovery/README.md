# ATS Discovery

ATS Discovery is Ehestifter's local, run-to-completion vacancy discovery component. It scans supported applicant-tracking systems once per shared target plan, applies bounded profile-derived filters, asks the Jobs domain for canonical identity, imports missing shared jobs, and requests compatibility for matched users without creating application status.

This README is the canonical component guide. `README-PHASE*.md` files are retained as implementation records, not current architecture sources.

## Ownership and boundaries

ATS Discovery owns:

- scanner CLI and run lifecycle;
- provider adapters and provider-native acquisition diagnostics;
- machine-managed tenant catalogs and operator discovery policy;
- target planning, cadence, health, cooldowns, circuit breakers, and canaries;
- cheap multi-user matching;
- Jobs preflight, bounded detail enrichment, location normalization, and guarded import orchestration;
- compatibility request orchestration for matched users;
- local scanner state, run artifacts, scheduler state, backups, locking, and retention.

ATS Discovery does not own:

- canonical job identity or shared job persistence — Jobs owns both;
- user/CV source data — Users owns it;
- compatibility run/projection lifecycle — Enrichment Core owns it;
- application status — users set status manually;
- direct SQL writes in any product domain.

## Providers and catalogs

Accepted provider paths:

- Greenhouse;
- Lever;
- Ashby;
- Workday;
- Personio;
- SmartRecruiters;
- Softgarden;
- SuccessFactors RMK;
- SuccessFactors CSB.

Machine-managed catalogs currently exist for:

- Ashby;
- Greenhouse;
- Lever;
- Workday.

Catalog data and operator policy remain separate. Catalog synchronizers record source provenance, fetch time, item count, and SHA-256 and use atomic replacement so a failed refresh does not destroy the previous valid catalog.

SuccessFactors has independent health partitions:

```text
successfactors:rmk
successfactors:csb
```

A CSB authentication/schema failure must not open the RMK breaker. Provider canaries are health-only: they bypass user filters, never call Jobs, and never enter import candidates.

## Shared multi-user scan

The scanner requests bounded discovery profiles from:

```text
GET /users/internal/discovery-eligible
```

The Users response supplies saved discovery filters and profile metadata, not CV text. The scanner compounds eligible profiles into one target scan and records which users cheaply match each candidate.

For a retained candidate:

1. scan the ATS target once;
2. match all eligible user profiles;
3. ask Jobs for canonical identity once;
4. fetch detail once when required and the job is missing;
5. create the shared job once through Jobs;
6. request compatibility for each matched user when needed;
7. never create or change application status.

## Product identity and attribution

The component/product identity is:

```text
ats-discovery
```

New imported jobs use:

```text
foundOn = "ats-discovery"
```

Career-Ops remains the attributed upstream for selected provider code and design ideas. job-board-aggregator remains the attributed source/reference for selected machine-managed tenant catalogs and resilience ideas. Product renaming must not remove source repository, pinned revision, license, or Ehestifter-change notices.

The script `scripts/copy-upstream-providers.sh` is bootstrap/reproducibility tooling only. It can overwrite locally adapted provider files and must not be used as an unattended update mechanism. Review upstream changes, apply selectively, and rerun provider fixtures/canaries.

## Configuration

Operator-owned active files are intentionally excluded from phase archives and normal commits:

```text
config/scanner.local.json
config/scheduler.local.json
compose.yaml                 when locally customized
secrets/
data/
```

Common committed inputs include:

```text
config/scanner.example.json
config/scheduler.example.json
config/portals.yml
config/company-overrides.yml
config/discovery-policy.yml
```

Review active configuration before live traffic, especially:

- provider enablement and request bounds;
- priority/disabled overrides;
- catalog target budgets and global ceilings;
- posting lookback/overlap;
- import mode and create caps;
- selected discovery users and matching defaults;
- scheduler timezone, slots, retry policy, retention, and Compose service.

Secrets are mounted/read by the existing scanner configuration path. Do not print function keys, tokens, cookies, CSRF values, CV data, or full user profiles into run artifacts.

## Run modes

Use the existing CLI help as the exact command source:

```bash
docker compose run --rm ats-discovery --help
```

Representative controlled commands:

```bash
# Offline provider scan; no Jobs or Enrichment calls.
docker compose run --rm ats-discovery scan tracked --offline

# Priority/tracked Jobs preflight without import.
docker compose run --rm ats-discovery scan tracked

# Explicitly bounded import.
docker compose run --rm ats-discovery \
  scan tracked --import --max-create 1 --catalog-targets 23
```

After scheduled operation is enabled, prefer the host wrapper so manual work shares the global lock:

```bash
./ops/scheduler/ats-ops scanner -- scan tracked --offline
./ops/scheduler/ats-ops scanner -- catalog sync all
```

Direct Compose commands cannot participate in the host lock.

## Run artifacts and state

Scanner-owned local paths include:

```text
data/catalogs/                 machine-managed catalogs
data/runs/<run-id>/            immutable-ish run evidence
data/state/tenant-state.json   provider/tenant cadence and health
data/state/scheduler-state.json logical scheduler slots and outcomes
data/backups/                  bounded scheduler/scanner-state backups
```

A normal run can emit:

```text
metadata.json
summary.json
target-plan.json
provider-results.json
provider-canary-results.json
candidates.json
rejected.json
user-match-results.json
preflight-results.json
detail-results.json
location-results.json
import-results.json
tenant-state-changes.json
rate-observations.json
scheduler.json
```

Historical runs are retained as evidence. Product renames must not rewrite existing run artifacts or historical job provenance.

## Scheduling semantics

Phase 7 supplies system-level systemd timers whose oneshot services execute as the normal repository owner.

Key behavior:

- daily discovery and weekly catalog refresh use independent timers;
- `Persistent=true` supplies a missed calendar activation, while application state proves whether a logical slot completed;
- one invocation processes only the latest due slot — missed days are not replayed one by one;
- a late boot follows normal catch-up logic with no late-night cutoff;
- only the remaining part of the configured boot grace is waited;
- `fcntl.flock` provides the shared scanner/catalog lock;
- lock contention and launch failures participate in bounded retry behavior;
- scanner exit `0` completes normally;
- scanner exit `2` completes the slot as degraded and remains visible;
- malformed or timezone-mismatched scheduler state fails closed;
- discovery may continue with the previous valid catalogs when refresh fails;
- scheduler and tenant-state backups plus artifact retention are bounded.

Schedule/retry fields are rendered from `config/scheduler.local.json` into installed units. Reinstall units after changing them.

## Scheduler setup

Create and validate active config:

```bash
cp config/scheduler.example.json config/scheduler.local.json
chmod 600 config/scheduler.local.json
./ops/scheduler/ats-ops validate-config
./ops/scheduler/ats-ops status
```

Render without installation:

```bash
mkdir -p /tmp/ehestifter-ats-units
python3 ops/systemd/install_systemd.py render \
  /tmp/ehestifter-ats-units \
  --scanner-root "$PWD" \
  --user "$USER"
```

Install system-level units:

```bash
sudo -E python3 ops/systemd/install_systemd.py install \
  --scanner-root "$PWD"
```

Inspect:

```bash
systemctl list-timers 'ehestifter-ats-*'
systemctl status ehestifter-ats-discovery.timer
systemctl status ehestifter-ats-catalog-refresh.timer
./ops/scheduler/ats-ops status
```

Uninstall:

```bash
sudo python3 ops/systemd/install_systemd.py uninstall
```

Uninstalling units does not delete scanner configuration, catalogs, state, backups, or run artifacts.

## Validation

Run the repository layout validator from the Ehestifter root:

```bash
python3 tools/validate_ats_discovery_layout.py
```

Run scheduler tests and syntax checks:

```bash
cd scrapers/ats-discovery
python3 -m unittest discover \
  -s ops/scheduler/tests \
  -p 'test_*.py' \
  -v
python3 -m compileall -q ops/scheduler ops/systemd
```

Run the full scanner suite in Docker:

```bash
LOCAL_UID="$(id -u)" \
LOCAL_GID="$(id -g)" \
docker compose run --rm \
  --no-deps \
  --entrypoint node \
  ats-discovery \
  --test
```

Accepted pre-Phase-9 baselines supplied by the completed milestone are:

```text
scanner:   355 tests passing
scheduler: 27 tests passing
```

Phase 9 changes naming, documentation, migration, and validation surfaces; it does not intentionally change provider, matching, Jobs, import, or scheduler algorithms. Any regression in those suites blocks commit.

## Operational checks

Before trusting scheduled live operation:

1. validate config and repository layout;
2. run the scanner and scheduler suites;
3. run a bounded offline scan;
4. run a bounded preflight;
5. inspect `summary.json`, provider/variant warnings, canary outcomes, and state changes;
6. install timers only after rendered units point to `scrapers/ats-discovery` and Compose service `ats-discovery`;
7. inspect the next natural missed-slot catch-up after reboot/resume.

Failure visibility is local: systemd unit state, journal output, scheduler state/status, and retained run artifacts. There is no external email/chat alert channel.

## Deferred work

- Optional GCP Cloud Run Job deployment remains skipped and uncommitted.
- Unsupported ATS ingestion/catalog discovery remains tracked separately.
- Direct Compose commands still bypass the host lock.
- Timers catch up after resume but do not wake sleeping hardware.
- Rootless Docker requires explicit operator adaptation.
