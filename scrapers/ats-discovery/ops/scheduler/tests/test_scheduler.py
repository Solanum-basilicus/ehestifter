from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "ats_scheduler.py"
SPEC = importlib.util.spec_from_file_location("ats_scheduler", MODULE_PATH)
assert SPEC and SPEC.loader
scheduler = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scheduler
SPEC.loader.exec_module(scheduler)


class Clock:
    def __init__(self, *values: datetime):
        self.values = list(values)
        self.last = values[-1]

    def __call__(self) -> datetime:
        if self.values:
            self.last = self.values.pop(0)
        return self.last


def write_config(root: Path, **overrides):
    config_dir = root / "config"
    config_dir.mkdir(parents=True)
    value = {
        "schemaVersion": 1,
        "timezone": "Europe/Berlin",
        "paths": {
            "state": "data/state/scheduler-state.json",
            "lock": "data/state/ats-discovery.lock",
            "lockOwner": "data/state/ats-discovery-lock-owner.json",
            "runs": "data/runs",
            "stateBackups": "data/state/backups",
            "tenantState": "data/state/tenant-state.json",
            "tenantStateBackups": "data/state/backups/tenant-state",
        },
        "bootGraceMinutes": 10,
        "minimumSpacingMinutes": 240,
        "retry": {"maxRetries": 3, "retryIntervalMinutes": 30, "retryWindowMinutes": 240},
        "compose": {"command": ["docker", "compose"], "service": "ats-discovery"},
        "dailyDiscovery": {
            "enabled": True,
            "schedule": "08:30",
            "scannerArgs": ["scan", "tracked", "--offline"],
        },
        "catalogRefresh": {
            "enabled": True,
            "weekday": "Sunday",
            "schedule": "07:30",
            "scannerArgs": ["catalog", "sync", "all"],
        },
        "retention": {
            "successfulDays": 30,
            "degradedOrFailedDays": 90,
            "minimumRuns": 2,
            "stateBackups": 3,
            "tenantStateBackups": 3,
            "temporaryDirectoryHours": 24,
        },
    }
    for key, item in overrides.items():
        value[key] = item
    path = config_dir / "scheduler.local.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return scheduler.load_config(path)


class SchedulerTests(unittest.TestCase):
    def test_config_loads_and_resolves_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = write_config(root)
            self.assertEqual(config["_scannerRoot"], root)
            self.assertEqual(config["_paths"]["state"], root / "data/state/scheduler-state.json")
            self.assertEqual(config["catalogRefresh"]["weekdayIndex"], 6)

    def test_config_rejects_bad_timezone_and_retention(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(scheduler.ConfigError):
                write_config(root, timezone="Mars/Olympus")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(scheduler.ConfigError):
                write_config(
                    root,
                    retention={
                        "successfulDays": 90,
                        "degradedOrFailedDays": 30,
                        "minimumRuns": 2,
                        "stateBackups": 3,
                        "tenantStateBackups": 3,
                        "temporaryDirectoryHours": 24,
                    },
                )

    def test_daily_slot_before_and_after_schedule(self):
        config = {"schedule": "08:30"}
        before = datetime(2026, 7, 25, 5, 0, tzinfo=timezone.utc)  # 07:00 CEST
        after = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)   # 09:00 CEST
        self.assertEqual(scheduler.latest_slot("dailyDiscovery", config, "Europe/Berlin", before).slot_id, "2026-07-24")
        self.assertEqual(scheduler.latest_slot("dailyDiscovery", config, "Europe/Berlin", after).slot_id, "2026-07-25")

    def test_weekly_slot_uses_latest_scheduled_sunday(self):
        config = {"schedule": "07:30", "weekdayIndex": 6}
        monday = datetime(2026, 7, 27, 10, 0, tzinfo=timezone.utc)
        sunday_before = datetime(2026, 7, 26, 4, 0, tzinfo=timezone.utc)
        self.assertEqual(scheduler.latest_slot("catalogRefresh", config, "Europe/Berlin", monday).slot_id, "2026-07-26")
        self.assertEqual(scheduler.latest_slot("catalogRefresh", config, "Europe/Berlin", sunday_before).slot_id, "2026-07-19")

    def test_late_boot_has_no_cutoff_and_boot_grace_is_remaining_time(self):
        self.assertEqual(scheduler.remaining_boot_grace_seconds(10, 60), 540)
        self.assertEqual(scheduler.remaining_boot_grace_seconds(10, 700), 0)
        config = {"schedule": "08:30"}
        late = datetime(2026, 7, 25, 21, 30, tzinfo=timezone.utc)  # 23:30 local
        self.assertEqual(scheduler.latest_slot("dailyDiscovery", config, "Europe/Berlin", late).slot_id, "2026-07-25")

    def test_atomic_state_backup_rotation(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            now = datetime(2026, 7, 25, 10, tzinfo=timezone.utc)
            state = scheduler.empty_state(config["timezone"])
            for index in range(6):
                state["tasks"]["dailyDiscovery"]["attemptsForCurrentSlot"] = index
                scheduler.backup_and_write_state(config, state, now + timedelta(seconds=index))
            backups = list(config["_paths"]["stateBackups"].glob("scheduler-state-*.json"))
            self.assertEqual(len(backups), 3)
            loaded = scheduler.load_state(config["_paths"]["state"], config["timezone"])
            self.assertEqual(loaded["tasks"]["dailyDiscovery"]["attemptsForCurrentSlot"], 5)

    def test_corrupt_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            state_path = config["_paths"]["state"]
            state_path.parent.mkdir(parents=True)
            state_path.write_text("{broken", encoding="utf-8")
            with self.assertRaises(scheduler.StateError):
                scheduler.load_state(state_path, config["timezone"])

    def test_kernel_lock_has_owner_metadata_and_blocks_second_holder(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            now = datetime(2026, 7, 25, 10, tzinfo=timezone.utc)
            first = scheduler.acquire_lock(config, "first", now)
            self.assertIsNotNone(first)
            self.assertEqual(scheduler.read_lock_owner(config["_paths"]["lockOwner"])["operation"], "first")
            second = scheduler.acquire_lock(config, "second", now)
            self.assertIsNone(second)
            first.release()
            self.assertFalse(config["_paths"]["lockOwner"].exists())

    def test_successful_daily_run_completes_slot_and_writes_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = write_config(root)
            start = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)
            finish = start + timedelta(minutes=2)

            def runner(command, cwd):
                self.assertEqual(command[-3:], ["scan", "tracked", "--offline"])
                run = config["_paths"]["runs"] / "run-success"
                run.mkdir(parents=True)
                (run / "summary.json").write_text("{}", encoding="utf-8")
                return 0

            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="manual",
                now_fn=Clock(start, finish),
                command_runner=runner,
            )
            self.assertEqual(result, 0)
            state = scheduler.load_state(config["_paths"]["state"], config["timezone"])
            task = state["tasks"]["dailyDiscovery"]
            self.assertEqual(task["lastCompletedSlot"], "2026-07-25")
            self.assertEqual(task["lastOutcome"], "success")
            metadata = json.loads((config["_paths"]["runs"] / "run-success/scheduler.json").read_text())
            self.assertEqual(metadata["outcome"], "success")

    def test_same_slot_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            now = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)
            state = scheduler.empty_state(config["timezone"])
            state["tasks"]["dailyDiscovery"]["lastCompletedSlot"] = "2026-07-25"
            scheduler.atomic_write_json(config["_paths"]["state"], state)
            called = False

            def runner(command, cwd):
                nonlocal called
                called = True
                return 0

            result = scheduler.run_scheduled_task(config, "daily-discovery", trigger="manual", now_fn=lambda: now, command_runner=runner)
            self.assertEqual(result, 0)
            self.assertFalse(called)

    def test_minimum_spacing_collapses_new_slot(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            now = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)
            state = scheduler.empty_state(config["timezone"])
            task = state["tasks"]["dailyDiscovery"]
            task["lastCompletedSlot"] = "2026-07-24"
            task["lastCompletedAtUtc"] = scheduler.iso_utc(now - timedelta(hours=2))
            scheduler.atomic_write_json(config["_paths"]["state"], state)
            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="manual",
                now_fn=lambda: now,
                command_runner=lambda command, cwd: self.fail("runner must not execute"),
            )
            self.assertEqual(result, 0)
            updated = scheduler.load_state(config["_paths"]["state"], config["timezone"])["tasks"]["dailyDiscovery"]
            self.assertEqual(updated["lastCompletedSlot"], "2026-07-25")
            self.assertEqual(updated["lastOutcome"], "skipped_minimum_spacing")

    def test_exit_two_completes_degraded_without_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)

            def runner(command, cwd):
                run = config["_paths"]["runs"] / "run-degraded"
                run.mkdir(parents=True)
                (run / "summary.json").write_text('{"providerHealthWarnings":["x"]}', encoding="utf-8")
                return 2

            result = scheduler.run_scheduled_task(
                config, "daily-discovery", trigger="manual", now_fn=Clock(start, start + timedelta(minutes=1)), command_runner=runner
            )
            self.assertEqual(result, 2)
            task = scheduler.load_state(config["_paths"]["state"], config["timezone"])["tasks"]["dailyDiscovery"]
            self.assertEqual(task["lastCompletedSlot"], "2026-07-25")
            self.assertEqual(task["lastOutcome"], "completed_degraded")

    def test_success_without_run_artifact_is_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)
            result = scheduler.run_scheduled_task(
                config, "daily-discovery", trigger="manual", now_fn=Clock(start, start + timedelta(minutes=1)), command_runner=lambda command, cwd: 0
            )
            self.assertEqual(result, 1)
            task = scheduler.load_state(config["_paths"]["state"], config["timezone"])["tasks"]["dailyDiscovery"]
            self.assertIsNone(task["lastCompletedSlot"])
            self.assertEqual(task["lastOutcome"], "failed_missing_run_artifact")

    def test_retry_budget_stops_after_initial_plus_three_retries(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            now = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)
            state = scheduler.empty_state(config["timezone"])
            task = state["tasks"]["dailyDiscovery"]
            task["currentSlot"] = "2026-07-25"
            task["firstAttemptAtUtc"] = scheduler.iso_utc(now - timedelta(hours=1))
            task["attemptsForCurrentSlot"] = 4
            scheduler.atomic_write_json(config["_paths"]["state"], state)
            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="retry",
                now_fn=lambda: now,
                command_runner=lambda command, cwd: self.fail("runner must not execute"),
            )
            self.assertEqual(result, scheduler.EXIT_RETRY_EXHAUSTED)
            updated = scheduler.load_state(config["_paths"]["state"], config["timezone"])["tasks"]["dailyDiscovery"]
            self.assertEqual(updated["lastOutcome"], "failed_permanent_attempt_limit")

    def test_catalog_success_does_not_require_run_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 7, 26, 6, 0, tzinfo=timezone.utc)
            result = scheduler.run_scheduled_task(
                config, "catalog-refresh", trigger="manual", now_fn=Clock(start, start + timedelta(seconds=5)), command_runner=lambda command, cwd: 0
            )
            self.assertEqual(result, 0)
            task = scheduler.load_state(config["_paths"]["state"], config["timezone"])["tasks"]["catalogRefresh"]
            self.assertEqual(task["lastOutcome"], "success")

    def test_retention_keeps_minimum_and_keeps_degraded_longer(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            runs = config["_paths"]["runs"]
            runs.mkdir(parents=True)
            now = datetime(2026, 7, 25, 12, tzinfo=timezone.utc)

            def create(name, age_days, outcome):
                path = runs / name
                path.mkdir()
                (path / "scheduler.json").write_text(json.dumps({"outcome": outcome}), encoding="utf-8")
                stamp = (now - timedelta(days=age_days)).timestamp()
                os.utime(path, (stamp, stamp))
                return path

            newest = create("newest", 1, "success")
            second = create("second", 2, "success")
            old_success = create("old-success", 40, "success")
            old_degraded = create("old-degraded", 40, "completed_degraded")
            ancient_degraded = create("ancient-degraded", 100, "completed_degraded")
            result = scheduler.apply_retention(config, now)
            self.assertTrue(newest.exists())
            self.assertTrue(second.exists())
            self.assertFalse(old_success.exists())
            self.assertTrue(old_degraded.exists())
            self.assertFalse(ancient_degraded.exists())
            self.assertEqual(result["runsDeleted"], 2)

    def test_old_temporary_directory_is_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            runs = config["_paths"]["runs"]
            runs.mkdir(parents=True)
            partial = runs / ".run.tmp-123"
            partial.mkdir()
            now = datetime(2026, 7, 25, 12, tzinfo=timezone.utc)
            stamp = (now - timedelta(hours=25)).timestamp()
            os.utime(partial, (stamp, stamp))
            result = scheduler.apply_retention(config, now)
            self.assertFalse(partial.exists())
            self.assertEqual(result["temporaryDeleted"], 1)

    def test_status_reports_due_and_next_schedule(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            now = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)
            payload = scheduler.status_payload(config, now)
            self.assertTrue(payload["tasks"]["daily-discovery"]["due"])
            self.assertEqual(payload["tasks"]["daily-discovery"]["currentDueSlot"], "2026-07-25")
            self.assertIn("2026-07-26T08:30:00", payload["tasks"]["daily-discovery"]["nextScheduledAt"])

    def test_scanner_command_preserves_configured_arguments(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            command = scheduler.build_scanner_command(config, "dailyDiscovery")
            self.assertEqual(command, ["docker", "compose", "run", "--rm", "ats-discovery", "scan", "tracked", "--offline"])

    def test_systemd_trigger_waits_only_remaining_boot_grace(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)
            slept = []

            def runner(command, cwd):
                run = config["_paths"]["runs"] / "run-after-grace"
                run.mkdir(parents=True)
                (run / "summary.json").write_text("{}", encoding="utf-8")
                return 0

            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="systemd",
                now_fn=Clock(start, start + timedelta(minutes=1)),
                sleep_fn=slept.append,
                uptime_fn=lambda: 120.0,
                command_runner=runner,
            )
            self.assertEqual(result, 0)
            self.assertEqual(slept, [480.0])

    def test_launch_error_is_recorded_and_remains_due(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)

            def runner(command, cwd):
                raise FileNotFoundError("docker")

            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="manual",
                now_fn=Clock(start, start + timedelta(seconds=1)),
                command_runner=runner,
            )
            self.assertEqual(result, 1)
            task = scheduler.load_state(config["_paths"]["state"], config["timezone"])["tasks"]["dailyDiscovery"]
            self.assertIsNone(task["lastCompletedSlot"])
            self.assertEqual(task["lastOutcome"], "failed_launch")
            self.assertIn("FileNotFoundError", task["lastError"])

    def test_status_distinguishes_stale_owner_metadata_from_busy_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            owner_path = config["_paths"]["lockOwner"]
            scheduler.atomic_write_json(owner_path, {"operation": "stale"})
            lock = scheduler.inspect_lock(config)
            self.assertFalse(lock["busy"])
            self.assertEqual(lock["staleOwner"]["operation"], "stale")

    def test_retention_marks_degraded_variant_as_long_retention(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            run = config["_paths"]["runs"] / "legacy-run"
            run.mkdir(parents=True)
            (run / "summary.json").write_text(
                json.dumps({"providerVariants": {"x": {"status": "degraded"}}}),
                encoding="utf-8",
            )
            self.assertEqual(scheduler.classify_run_for_retention(run), "degraded_or_failed")

    def test_daily_run_backs_up_tenant_state_before_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            tenant_state = config["_paths"]["tenantState"]
            tenant_state.parent.mkdir(parents=True)
            tenant_state.write_text('{"schemaVersion":1,"sentinel":"before"}\n', encoding="utf-8")
            start = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)

            def runner(command, cwd):
                tenant_state.write_text('{"schemaVersion":1,"sentinel":"after"}\n', encoding="utf-8")
                run = config["_paths"]["runs"] / "run-with-state-backup"
                run.mkdir(parents=True)
                (run / "summary.json").write_text("{}", encoding="utf-8")
                return 0

            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="manual",
                now_fn=Clock(start, start + timedelta(minutes=1)),
                command_runner=runner,
            )
            self.assertEqual(result, 0)
            backups = list(config["_paths"]["tenantStateBackups"].glob("tenant-state-*.json"))
            self.assertEqual(len(backups), 1)
            self.assertIn('"before"', backups[0].read_text())

    def test_tenant_state_backup_rotation_is_bounded(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            tenant_state = config["_paths"]["tenantState"]
            tenant_state.parent.mkdir(parents=True)
            tenant_state.write_text("{}\n", encoding="utf-8")
            now = datetime(2026, 7, 25, 7, 0, tzinfo=timezone.utc)
            for index in range(6):
                scheduler.backup_tenant_state(config, now + timedelta(seconds=index))
            backups = list(config["_paths"]["tenantStateBackups"].glob("tenant-state-*.json"))
            self.assertEqual(len(backups), 3)


if __name__ == "__main__":
    unittest.main()
