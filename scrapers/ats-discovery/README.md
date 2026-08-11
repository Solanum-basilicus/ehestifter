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
- Workday;
- Personio;
- SmartRecruiters;
- Softgarden;
- SuccessFactors.

Catalog data and operator policy remain separate. Catalog synchronizers record source provenance, fetch time, item count, rejection count, and SHA-256 and use atomic replacement so a failed refresh does not destroy the previous valid catalog. Ashby, Greenhouse, Lever, and Workday use the existing `Feashliaa/job-board-aggregator` JSON inventories. Personio, SmartRecruiters, Softgarden, and SuccessFactors use the MIT-licensed `kalil0321/ats-scrapers` CSV inventories under `ats-companies/`.

The CSV ingestion boundary is strict: the header must be exactly `name,slug,url`, malformed CSV fails the refresh, provider-specific URL/tenant mismatches are rejected, and each new source has a minimum plausible row count plus a minimum normalization acceptance ratio. These are catastrophe guards for upstream truncation/schema drift, not completeness claims.

SuccessFactors is intentionally URL-identified. Its upstream `slug` values are not unique across branded career domains. Rows whose identity depends on query parameters such as legacy `?company=...` RMK URLs are rejected because the current provider canonicalizer deliberately strips query parameters; importing them would merge distinct companies. The accepted catalog therefore has fewer rows than the upstream CSV until that legacy URL shape is supported explicitly.

SuccessFactors has independent health partitions:

```text
successfactors:rmk
successfactors:csb
```

A CSB authentication/schema failure must not open the RMK breaker. Provider canaries are health-only: they bypass user filters, never call Jobs, and never enter import candidates.

Workday listing acquisition preserves the CXS `externalPath` as provider-native
identity. When a Jobs-missing candidate requires a description, the detail stage
derives a same-origin CXS detail endpoint from the validated Workday host, career
site, and `externalPath`; it does not reconstruct that request from an arbitrary
job URL. Workday detail GETs use the scanner's existing timeout and 5 MB response
ceiling and are serialized per Workday origin. Different Workday origins can
still use the configured global detail concurrency.

A Workday detail `404`, `410`, or `canApply: false` result is recorded as
`detail.status = "unavailable"`. Changed response shapes, unsafe identity,
timeouts, and transport failures remain `detail.status = "error"`. The same
explicit unavailable status is used for the recognized SuccessFactors withdrawn
page. Provider canaries exclude unavailable samples from parser-error counts and
report detail as inconclusive when every sampled posting disappeared.

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

Career-Ops remains the attributed upstream for selected provider code and design ideas. job-board-aggregator remains the attributed source/reference for selected Ashby/Greenhouse/Lever/Workday catalogs and resilience ideas. `kalil0321/ats-scrapers` is the attributed source for Personio/SmartRecruiters/Softgarden/SuccessFactors tenant inventories. Product renaming must not remove source repository, recorded ref, license, or Ehestifter-change notices.

The script `scripts/copy-upstream-providers.sh` is bootstrap/reproducibility tooling only. It can overwrite locally adapted provider files and must not be used as an unattended update mechanism. Review upstream changes, apply selectively, and rerun provider fixtures/canaries.

## Operator guide

Run all commands in this section from:

```bash
cd scrapers/ats-discovery
```

Start by checking the current operational state:

```bash
./ops/scheduler/ats-ops validate-config
./ops/scheduler/ats-ops status
systemctl list-timers 'ehestifter-ats-*'
```

### Where to make common changes

| Goal | Edit | What the file controls |
|---|---|---|
| Add or remove a directly tracked company | `config/portals.yml` | `tracked_companies` entries and provider URLs |
| Change broad title/location matching | `config/portals.yml` | `title_filter`, `location_scope_filter`, `location_filter`, and `max_posting_age_days` |
| Prioritize or disable a catalog tenant | `config/company-overrides.yml` | Operator-owned `priority` and `disabled` provider identities |
| Change scan cadence, lookback, catalog shard sizes, pacing, or breakers | `config/discovery-policy.yml` | Provider planning and health policy |
| Change API endpoints, import ceilings, live-catalog gates, or multi-user/compatibility behavior | `config/scanner.local.json` | Scanner runtime integration settings |
| Move the daily/weekly times, change scheduled scanner arguments, activation grace, retries, or retention | `config/scheduler.local.json` | Host scheduler policy and the values rendered into systemd units |

The `*.example.*` files are committed templates. The active files without
`.example` are operator-owned local configuration and should not contain secrets
that are committed to Git.

### After changing scanner or discovery configuration

The current Compose service bind-mounts `./config` as `/config`. Therefore a new
run reads changes to `portals.yml`, `company-overrides.yml`,
`discovery-policy.yml`, and `scanner.local.json` immediately. **Do not rebuild
the image for a config-only edit.** A currently running scan keeps the
configuration it loaded at startup; validate with a new bounded run.

Use the global-lock wrapper after scheduled operation is installed:

```bash
./ops/scheduler/ats-ops scanner \
  --label config-check \
  -- scan tracked --offline
```

Rebuild the image after changing scanner code, dependencies, or the Dockerfile:

```bash
docker compose build ats-discovery
```

This includes changes under `src/`, `package.json`, `package-lock.json`, or
`Dockerfile`. A rebuild is also required when running an image without the
current `/config` bind mount.

### After changing scheduler configuration

Operator rule: after **any** `config/scheduler.local.json` edit, validate and
rerun the systemd installer. This avoids having to remember which values are
read at runtime and which are copied into the installed units. Schedule,
timezone, weekday, and retry values are definitely rendered into systemd.

```bash
./ops/scheduler/ats-ops validate-config

sudo -E python3 ops/systemd/install_systemd.py install \
  --scanner-root "$PWD"

systemctl list-timers 'ehestifter-ats-*'
systemctl status ehestifter-ats-discovery.timer
systemctl status ehestifter-ats-catalog-refresh.timer
./ops/scheduler/ats-ops status
```

The installer overwrites the four ATS units, verifies them, runs
`systemctl daemon-reload`, and enables/starts both timers. It does not delete
scanner configuration, catalogs, scheduler state, tenant state, or run
artifacts.

### Repair an already imported Lever description

Lever's public API splits a posting across the combined opening/body,
structured lists, and optional closing content. New scans compose those fields
automatically. Existing Jobs rows are not overwritten by normal discovery, so
repair a known row explicitly.

Rebuild after applying the code change:

```bash
docker compose build ats-discovery
```

First run the read-only dry-run. It fetches the Lever posting, resolves the
existing Jobs identity, reads the stored job, and prints the before/after
description lengths without issuing a PUT:

```bash
docker compose run --rm ats-discovery \
  repair lever-description \
  https://jobs.lever.co/360learning/7c97a721-9d46-4568-a803-a11a7f669a5b
```

Apply only after reviewing that output:

```bash
docker compose run --rm ats-discovery \
  repair lever-description \
  https://jobs.lever.co/360learning/7c97a721-9d46-4568-a803-a11a7f669a5b \
  --apply
```

The apply path updates only the Jobs `description` field. It refuses missing
Jobs rows and provider, tenant, or external-id identity mismatches.

### Add a tracked company

1. Add an enabled item under `tracked_companies` in `config/portals.yml`:

   ```yaml
   tracked_companies:
     - name: Example Company
       careers_url: https://job-boards.greenhouse.io/example
       enabled: true
   ```

2. Run an offline scan under the host lock:

   ```bash
   ./ops/scheduler/ats-ops scanner \
     --label add-example-company \
     -- scan tracked --offline
   ```

3. Inspect the newest run's `target-plan.json`, `provider-results.json`,
   `rejected.json`, and `summary.json` before trying preflight or import.

The URL must be a provider URL recognized by an accepted adapter. Do not invent
provider/tenant canonical identity for Jobs; Jobs preflight remains
authoritative.

### Change match keywords

Edit the global filters near the top of `config/portals.yml`:

```yaml
title_filter:
  positive:
    - "Product Manager"
    - "Engineering Manager"
  negative:
    - "Junior"
    - "Intern"

location_scope_filter:
  enabled: true
  allow:
    - "Germany"
    - "Europe"
  block:
    - "United States"

max_posting_age_days: 30
```

These are broad scanner-level gates. When multi-user discovery is enabled, the
Users-domain saved discovery profiles can further narrow which users match a
retained candidate. Validate keyword changes in `--offline` mode first and
inspect rejection reasons; only then use `--preflight` or `--import`.

### Move the scheduled times

Edit `dailyDiscovery.schedule` and/or `catalogRefresh.weekday` plus
`catalogRefresh.schedule` in `config/scheduler.local.json`. Times use 24-hour
`HH:MM` in the configured IANA timezone, normally `Europe/Berlin`.

Example:

```json
{
  "timezone": "Europe/Berlin",
  "dailyDiscovery": {
    "schedule": "03:30"
  },
  "catalogRefresh": {
    "weekday": "Sunday",
    "schedule": "02:30"
  }
}
```

Keep all other required keys in the real file. Then follow **After changing
scheduler configuration** above. `systemctl list-timers` is the final check that
systemd received the new slots.

## Configuration reference

Operator-owned active files are intentionally excluded from phase archives and
normal commits:

```text
config/scanner.local.json
config/scheduler.local.json
config/portals.yml
config/company-overrides.yml
config/discovery-policy.yml
compose.yaml                 when locally customized
secrets/
data/
```

Committed templates are:

```text
config/scanner.example.json
config/scheduler.example.json
config/portals.example.yml
config/company-overrides.example.yml
config/discovery-policy.example.yml
```

Review active configuration before live traffic, especially:

- provider enablement and request bounds;
- priority/disabled overrides;
- catalog target budgets and live-traffic caps;
- posting lookback/overlap;
- import mode and create caps;
- selected discovery users and matching defaults;
- scheduler timezone, slots, retry policy, retention, and Compose service.

Tenant listing-volume history is used only to guard an explicit zero result from
a historically non-empty tenant. Any nonzero listing result is accepted as the
current provider observation, even when it is much smaller than earlier runs.
Provider canaries may still enforce their own explicit minimum-job thresholds.

Secrets are mounted/read by the existing scanner configuration path. Do not
print function keys, tokens, cookies, CSRF values, CV data, or full user
profiles into run artifacts.

## Scanner run modes

The scanner requires exactly one mode for `scan tracked`:

```bash
docker compose run --rm ats-discovery --help
```

### `--offline` — source and filter validation

```bash
./ops/scheduler/ats-ops scanner -- scan tracked --offline
```

What it does:

- builds the due target plan;
- calls ATS providers and health canaries;
- applies scanner-wide and enabled user-profile cheap filters;
- writes run evidence and updates applicable tenant health/cadence state.

What it does **not** do:

- no Jobs identity preflight;
- no Jobs create/import;
- no compatibility request.

When multi-user discovery is enabled, offline mode may still call the Users API
to obtain discovery-eligible profiles. Offline normal-catalog target counts come
from `discovery-policy.yml`; `--catalog-targets` is intentionally invalid here.

Use this first after adding a company or changing filters/provider policy.

### `--preflight` — check identity and import readiness without creating

```bash
./ops/scheduler/ats-ops scanner -- \
  scan tracked --preflight
```

What it adds on top of the provider scan:

- calls Jobs `/jobs/exists` for canonical identity and duplicate status;
- fetches bounded missing details for Jobs-missing candidates when configured;
- canonicalizes provider and description-derived locations against the Web Core
  geography snapshot;
- evaluates final location eligibility after detail enrichment;
- writes preflight/detail/location artifacts.

It does **not** create jobs and does not request compatibility.

`detail-results.json` separates an unavailable posting from acquisition or
parser failure. An unavailable result is a safe listing/detail race: it remains
visible for diagnosis but does not count as a detail parser error.

Description evidence is secondary. It may refine `Germany` to a confidently
resolved city such as `Garching`, clarify an unqualified `Remote` scope, or mark
a provider/description conflict. It never silently erases the provider
observation. Only decisive incompatible evidence blocks import; unresolved,
unsupported, and inconclusive conflicts are retained in artifacts and propagate
to Jobs.

The scanner also owns a small administrative-region dictionary separate from
Web Core geography. It currently covers US states/DC and aliases, German
federal states, and explicit German district forms such as `Landkreis ...` or
`Kreis ...`. This lets deterministic parsing retain values such as
`Austin, TX`, `local to Maryland`, and German district names in the Jobs
`region` field without changing the Web UI geography source.

High-signal description declarations can refine provider metadata without
replacing it. Examples include `Location: Austin, TX`, explicit candidate
residency/citizenship restrictions, and employer-country evidence used only to
disambiguate a provider city such as `Berlin`. US-specific employment markers
such as `401(k)` are weak country hints and are used only to disambiguate
provider localities (for example a city or the US state/country name
`Georgia`); they do not create a location by themselves.

Explicit work-hours/timezone requirements are recorded in each normalized
candidate as `workTimeConstraints`. The current import and discovery-profile
filters do not act on this evidence yet. It is retained for a later compatibility
filter that can compare required work-time regions with a user's feasible
remote-work region.

The scanner packages a generated copy of Web Core's geography data. Runtime
containers do not mount or read the Web Core directory. Refresh the committed
snapshot from a full checkout through the host-side Python entry point; Node.js
runs inside the scanner image:

```bash
python3 tools/refresh_ats_geo_snapshot.py
python3 tools/validate_ats_discovery_layout.py
```

The refresh command builds `ehestifter/ats-discovery:geo-tools`, validates a
full checkout, mounts only the Web source file and scanner output directory,
and invokes the Node generator in Docker. A scanner-only
checkout or deployment can build and run from the committed snapshot, but it
cannot regenerate that snapshot without the Web Core source file. After a
refresh, rebuild the normal scanner image.

For normal catalog tenants, add an explicit live-traffic cap:

```bash
./ops/scheduler/ats-ops scanner -- \
  scan tracked --preflight --catalog-targets 5
```

`--catalog-targets N` is an operator-owned upper bound, not an exact target
count. The planner uses the smaller of that value and the sum of enabled
providers' `max_normal_targets_per_run` budgets. It may therefore be set above
the current policy capacity without failing; future enabled catalogs can consume
the unused headroom. `target-plan.json` records `catalogTargetsRequested`,
`catalogTargetsEffective`, and `combinedPolicyCapacity`. There is no separate
compiled catalog-count ceiling.

Use this after offline evidence looks correct and before the first import for a
new target or major filter change.

### `--import` — bounded write mode

```bash
./ops/scheduler/ats-ops scanner -- \
  scan tracked --import --max-create 1 --catalog-targets 23
```

Import mode performs the preflight/detail/location stages and then:

- creates only Jobs-missing candidates through the Jobs API;
- stops at the mandatory `--max-create N` command-line cap and the lower/equal
  configured import ceiling;
- reconciles ambiguous create responses;
- skips `detail.status = "unavailable"` as
  `import.status = "skipped_detail_unavailable"` before the missing-description
  gate and performs no Jobs write;
- requests compatibility for matched users only when multi-user compatibility
  is enabled;
- never creates or changes application status.

This is the third and only write mode. Keep the create cap small until the
preceding run artifacts have been inspected.

### Catalog refresh is a separate command

```bash
./ops/scheduler/ats-ops scanner -- catalog sync all
```

This refreshes all eight machine-managed provider catalogs using atomic
replacement. It does not scan vacancies, call Jobs, import jobs, or request
compatibility. Existing active discovery policy is not modified by catalog
sync; the four newly catalog-backed providers remain catalog-disabled unless
the operator enables them in `config/discovery-policy.yml`.

`--no-progress` may be added to any scan mode when machine-readable or quiet
output is preferable.

## `ats-ops` command reference

`ats-ops` is a small host launcher for `ats_scheduler.py`. It reads
`config/scheduler.local.json` by default and gives manual operations the same
host-wide `flock` used by systemd.

```text
./ops/scheduler/ats-ops [--config PATH] COMMAND ...
```

### `validate-config`

```bash
./ops/scheduler/ats-ops validate-config
```

Parses and validates scheduler JSON, timezone, paths, task arguments, retry
ranges, and retention ranges. It does not run Docker or change systemd.

### `status [--json]`

```bash
./ops/scheduler/ats-ops status
./ops/scheduler/ats-ops status --json | jq .
```

Shows both configured tasks, latest logical slots, outcomes, next schedules,
and the live/stale lock state. Its exit code is `2` when an enabled task's last
outcome is degraded or failed, which is useful for monitoring but can surprise a
shell running with `set -e`.

### `scanner [--label NAME] -- <scanner arguments>`

```bash
./ops/scheduler/ats-ops scanner \
  --label manual-offline \
  -- scan tracked --offline
```

Runs arbitrary scanner CLI arguments in a fresh Compose container while holding
the global lock. It prevents overlap with scheduled discovery, catalog refresh,
or another wrapped manual operation. It does not mark a scheduler logical slot
complete; the scanner can still update its normal run artifacts and tenant
state.

Prefer this over direct `docker compose run` after timers are enabled. Direct
Compose commands bypass the host lock.

### `run daily-discovery|catalog-refresh`

```bash
./ops/scheduler/ats-ops run daily-discovery
./ops/scheduler/ats-ops run catalog-refresh
```

Runs one configured scheduler task with logical-slot checks, minimum spacing,
state updates, backups, and retention. The default trigger label is `manual`;
`--trigger systemd|manual|retry` changes recorded trigger metadata. The
installed units use `systemd`; choosing `retry` does not itself schedule a
retry.

Without `--force`, an already completed current slot is skipped. Use `--force`
only for an intentional second full execution:

```bash
./ops/scheduler/ats-ops run daily-discovery --trigger manual --force
```

`--force` bypasses completed-slot and minimum-spacing checks. It does not remove
the global lock or scanner-side safety caps.

### `prune [--json]`

```bash
./ops/scheduler/ats-ops prune
```

Applies configured run/temp-directory and state-backup retention immediately.
It does not scan or refresh catalogs.

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
failure.json                  prerequisite failures only
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

If required Users discovery input fails before provider execution, the scanner still publishes an atomic run directory. `failure.json` contains a bounded sanitized cause chain; provider/canary/state-change artifacts remain empty or absent because no provider health observation was made.

`summary.json` reports unavailable detail observations separately through
`detailUnavailable` and reports their no-write import outcome through
`importDetailUnavailableSkipped`.

Historical runs are retained as evidence. Product renames must not rewrite existing run artifacts or historical job provenance.

## Scheduling semantics

Phase 7 supplies system-level systemd timers whose oneshot services execute as the normal repository owner.

Key behavior:

- daily discovery and weekly catalog refresh use independent timers;
- `Persistent=true` supplies a missed calendar activation, while application state proves whether a logical slot completed;
- one invocation processes only the latest due slot — missed days are not replayed one by one;
- a late boot follows normal catch-up logic with no late-night cutoff;
- systemd-triggered runs wait the larger of remaining boot grace and `activationGraceSeconds`; wrapped manual runs do not wait;
- `fcntl.flock` provides the shared scanner/catalog lock;
- lock contention and launch failures participate in bounded retry behavior;
- scanner exit `0` completes normally;
- scanner exit `2` completes the slot as degraded and remains visible;
- scanner exit `75` with a published run is `aborted_retryable`, leaves the slot due, and uses the existing bounded systemd retry policy;
- scanner exit `64` with a published run is `failed_prerequisite`, leaves the slot due, and stops the immediate systemd restart chain;
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
scanner:   418 tests passing
scheduler: 34 tests passing
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

For a degraded or aborted run, inspect `summary.json`, `failure.json` when present, `scheduler.json`, the systemd journal around the run, and owner-service telemetry. A missing owner-service request combined with host link/DNS events indicates failure before the request reached the service.

Failure visibility is local: systemd unit state, journal output, scheduler state/status, and retained run artifacts. There is no external email/chat alert channel.

## Deferred work

- Optional GCP Cloud Run Job deployment remains skipped and uncommitted.
- Unsupported ATS ingestion/catalog discovery remains tracked separately.
- Direct Compose commands still bypass the host lock.
- Timers catch up after resume but do not wake sleeping hardware.
- Rootless Docker requires explicit operator adaptation.