from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "ats_scheduler.py"
SPEC = importlib.util.spec_from_file_location("ats_scheduler_resilience", MODULE_PATH)
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


def write_config(root: Path, *, activation_grace_seconds: int | None = 60):
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
        "retry": {
            "maxRetries": 3,
            "retryIntervalMinutes": 30,
            "retryWindowMinutes": 240,
        },
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
    if activation_grace_seconds is not None:
        value["activationGraceSeconds"] = activation_grace_seconds
    path = config_dir / "scheduler.local.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return scheduler.load_config(path)


class SchedulerResilienceTests(unittest.TestCase):
    def test_activation_grace_defaults_and_uses_larger_boot_delay(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp), activation_grace_seconds=None)
            self.assertEqual(config["activationGraceSeconds"], 60)

        self.assertEqual(
            scheduler.remaining_activation_grace_seconds(10, 60, 120),
            480,
        )
        self.assertEqual(
            scheduler.remaining_activation_grace_seconds(10, 60, 700),
            60,
        )

    def test_activation_grace_rejects_unbounded_values(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(scheduler.ConfigError):
                write_config(Path(temp), activation_grace_seconds=3601)

    def test_systemd_activation_waits_before_counting_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 7, 31, 7, 55, tzinfo=timezone.utc)
            slept = []

            def sleep(delay):
                self.assertFalse(config["_paths"]["state"].exists())
                slept.append(delay)

            def runner(command, cwd):
                run = config["_paths"]["runs"] / "run-after-activation-grace"
                run.mkdir(parents=True)
                (run / "summary.json").write_text("{}", encoding="utf-8")
                return 0

            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="systemd",
                now_fn=Clock(start, start + timedelta(minutes=1)),
                sleep_fn=sleep,
                uptime_fn=lambda: 700.0,
                command_runner=runner,
            )

            self.assertEqual(result, 0)
            self.assertEqual(slept, [60.0])

    def test_exit_75_with_run_artifact_is_retryable_abort(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 7, 31, 7, 55, tzinfo=timezone.utc)

            def runner(command, cwd):
                run = config["_paths"]["runs"] / "run-aborted"
                run.mkdir(parents=True)
                (run / "summary.json").write_text(
                    '{"runStatus":"aborted_retryable"}',
                    encoding="utf-8",
                )
                return scheduler.EXIT_TEMPORARY

            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="manual",
                now_fn=Clock(start, start + timedelta(seconds=5)),
                command_runner=runner,
            )

            self.assertEqual(result, scheduler.EXIT_TEMPORARY)
            task = scheduler.load_state(
                config["_paths"]["state"],
                config["timezone"],
            )["tasks"]["dailyDiscovery"]
            self.assertIsNone(task["lastCompletedSlot"])
            self.assertEqual(task["lastOutcome"], "aborted_retryable")
            self.assertEqual(task["lastExitCode"], scheduler.EXIT_TEMPORARY)
            self.assertTrue(
                scheduler.status_payload(config, start)["tasks"]["daily-discovery"]["due"],
            )

    def test_exit_64_with_run_artifact_stops_automatic_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 7, 31, 7, 55, tzinfo=timezone.utc)

            def runner(command, cwd):
                run = config["_paths"]["runs"] / "run-prerequisite-failed"
                run.mkdir(parents=True)
                (run / "summary.json").write_text(
                    '{"runStatus":"failed_prerequisite"}',
                    encoding="utf-8",
                )
                return scheduler.EXIT_CONFIG

            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="manual",
                now_fn=Clock(start, start + timedelta(seconds=5)),
                command_runner=runner,
            )

            self.assertEqual(result, scheduler.EXIT_CONFIG)
            task = scheduler.load_state(
                config["_paths"]["state"],
                config["timezone"],
            )["tasks"]["dailyDiscovery"]
            self.assertIsNone(task["lastCompletedSlot"])
            self.assertEqual(task["lastOutcome"], "failed_prerequisite")

    def test_retryable_abort_requires_a_published_run(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 7, 31, 7, 55, tzinfo=timezone.utc)

            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="manual",
                now_fn=Clock(start, start + timedelta(seconds=5)),
                command_runner=lambda command, cwd: scheduler.EXIT_TEMPORARY,
            )

            self.assertEqual(result, 1)
            task = scheduler.load_state(
                config["_paths"]["state"],
                config["timezone"],
            )["tasks"]["dailyDiscovery"]
            self.assertEqual(task["lastOutcome"], "failed_missing_run_artifact")

    def test_discovery_service_allows_long_runs_and_stops_on_exit_64(self):
        service = (
            MODULE_PATH.parents[1]
            / "systemd"
            / "ehestifter-ats-discovery.service.in"
        ).read_text(encoding="utf-8")
        self.assertIn("TimeoutStartSec=12h", service)
        self.assertIn("RestartPreventExitStatus=3 64 78", service)
        self.assertIn("SuccessExitStatus=2", service)


if __name__ == "__main__":
    unittest.main()
