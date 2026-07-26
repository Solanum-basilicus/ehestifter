# Phase 7 — Local scheduled operations

Phase 7 adds a host-side, systemd-driven operations layer around the existing
run-to-completion ATS Discovery container.

It does not add a scheduler daemon to the scanner image and does not move scans
to cloud infrastructure.

## Implemented shape

```text
system-level systemd timer
        ↓
standard-library Python due/lock wrapper
        ↓
Docker Compose run-to-completion scanner
        ↓
existing scanner artifacts and tenant state
        +
scheduler-state.json and scheduler metadata
```

Two independent tasks are configured:

- daily discovery, initially at `08:30 Europe/Berlin`;
- weekly catalog refresh, initially Sunday at `07:30 Europe/Berlin`.

Both systemd timers use calendar activation and `Persistent=true`. The wrapper
owns the application-level meaning of a completed slot, retry attempts, minimum
spacing, and retention. This avoids treating a timer activation as proof that a
scan completed.

Primary systemd references:

- <https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html>
- <https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html>
- <https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html>

## Missed runs

The wrapper computes the latest scheduled local slot at execution time.

Examples for a daily `08:30` schedule:

```text
node available at 08:30        → run the current slot
node boots at 14:00            → run once after remaining boot grace
node was off for five days     → run one latest due slot, not five replays
node boots at 08:25            → wait through boot grace; one current-slot run
node boots at 06:00            → catch the previous slot; 08:30 may collapse
very late boot                 → normal catch-up, no cutoff
```

A ten-minute boot grace is implemented from `/proc/uptime`. It delays only the
remaining grace period. A machine already up for ten minutes does not wait.

The wrapper tracks logical slot IDs rather than shifting the permanent schedule
to the time of a catch-up run.

## Minimum spacing

The default minimum spacing is four hours per task.

When a new slot becomes due shortly after the previous completed run, the new
slot is marked `skipped_minimum_spacing` and considered completed. This prevents
near-duplicate catch-up/calendar runs without moving the next calendar time.

## Retry policy

Default policy:

```text
initial attempt + 3 retries
30 minutes between retries
4-hour retry window
```

The systemd units render these values from `config/scheduler.local.json`.

Outcome handling:

| Outcome | Slot completed | systemd retry |
|---|---:|---:|
| scanner exit `0` | yes | no |
| scanner exit `2` / degraded | yes | no |
| launch or scanner failure | no | yes |
| retry budget exhausted | no | stopped; unit remains failed |
| invalid config/state | no | stopped; unit remains failed |

Exit `2` remains visible in scheduler state and `scheduler.json`, while
`SuccessExitStatus=2` prevents an immediate full rescan.

## Global lock

The host wrapper uses a non-blocking kernel `flock` on:

```text
data/state/ats-discovery.lock
```

The kernel releases the lock when the process exits or the node reboots. A
human-readable sidecar is written to:

```text
data/state/ats-discovery-lock-owner.json
```

The status command distinguishes a real held lock from stale owner metadata.

Scheduled discovery, scheduled catalog refresh, and manual operations launched
through `ats-ops scanner` use the same lock.

Direct `docker compose run ...` commands bypass this host lock. Once Phase 7 is
enabled, use the operations wrapper for manual scans and catalog synchronization.

## Scheduler state

Default path:

```text
data/state/scheduler-state.json
```

State records independently for discovery and catalog refresh:

- current logical slot;
- first attempt and attempts for that slot;
- last completed slot;
- last attempt/completion/success timestamps;
- last run ID and path;
- outcome, exit code, trigger, and bounded launch error;
- consecutive failures.

State writes are atomic. The previous valid scheduler state is backed up before
replacement and the newest fourteen backups are retained by default. Before each
scheduled discovery attempt, the current scanner-owned `tenant-state.json` is also
snapshotted atomically into its own bounded backup directory.

Corrupt or timezone-mismatched scheduler state fails closed. It is not silently
reset, because resetting could duplicate scheduled work.

## Run retention

Default retention:

```text
successful runs:       30 days
degraded/failed runs:  90 days
minimum retained:      newest 20 published runs
scheduler backups:     newest 14
tenant-state backups:  newest 14
stale staging dirs:    24 hours
```

Every scheduled discovery run receives `scheduler.json`, which records the task,
slot, trigger, outcome, exit code, and completion time.

Retention failure is logged but does not rewrite a completed scanner outcome.

## Catalog refresh and discovery interaction

Catalog refresh is normally scheduled one hour before discovery.

The services are deliberately not dependency-chained. If both are catching up
after boot, the shared lock serializes them and the lock loser retries. A catalog
refresh failure therefore does not hold discovery behind the catalog task's full
retry window. Discovery can continue using the previous atomically retained
catalogs.

## Operations commands

From `scrapers/career-ops-scan`:

```bash
# Human-readable state
./ops/scheduler/ats-ops status

# Machine-readable state
./ops/scheduler/ats-ops status --json

# Run a due task manually; normal slot/idempotency checks still apply
./ops/scheduler/ats-ops run daily-discovery --trigger manual
./ops/scheduler/ats-ops run catalog-refresh --trigger manual

# Force a task despite completed-slot/minimum-spacing checks
./ops/scheduler/ats-ops run daily-discovery --trigger manual --force

# Manual scanner operations under the same global lock
./ops/scheduler/ats-ops scanner --label manual-offline -- scan tracked --offline
./ops/scheduler/ats-ops scanner --label manual-catalog -- catalog sync all

# Apply retention without starting a scan
./ops/scheduler/ats-ops prune --json
```

Systemd visibility:

```bash
systemctl list-timers 'ehestifter-ats-*'
systemctl status ehestifter-ats-discovery.service
systemctl status ehestifter-ats-catalog-refresh.service
journalctl -u ehestifter-ats-discovery.service
journalctl -u ehestifter-ats-catalog-refresh.service
```

## Boundaries preserved

- Systemd runs the existing scanner; it does not own discovery business logic.
- Scheduler state is local operations state, not Jobs/Users/Enrichment data.
- No database changes are introduced.
- Catalog refresh remains independent from scan execution.
- Provider/canary degraded exit status remains operator-visible.
- No wake-from-suspend request is configured.
- No external notification provider or recurring cloud resource is introduced.
