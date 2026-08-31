from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "ats_scheduler.py"
SPEC = importlib.util.spec_from_file_location("ats_scheduler_failure_diagnostics", MODULE_PATH)
assert SPEC and SPEC.loader
scheduler = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scheduler
SPEC.loader.exec_module(scheduler)


def write_config(root: Path):
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
        "bootGraceMinutes": 0,
        "activationGraceSeconds": 0,
        "minimumSpacingMinutes": 0,
        "retry": {"maxRetries": 3, "retryIntervalMinutes": 30, "retryWindowMinutes": 240},
        "compose": {"command": ["docker", "compose"], "service": "ats-discovery"},
        "dailyDiscovery": {
            "enabled": True,
            "schedule": "08:30",
            "scannerArgs": ["scan", "tracked", "--offline"],
        },
        "catalogRefresh": {
            "enabled": False,
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
    path = config_dir / "scheduler.local.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return scheduler.load_config(path)


class FailureDiagnosticsTests(unittest.TestCase):
    def test_failure_artifact_populates_last_error_and_attempt_run(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            start = datetime(2026, 8, 31, 9, 0, tzinfo=timezone.utc)
            finish = start + timedelta(minutes=1)

            def runner(command, cwd):
                run = config["_paths"]["runs"] / "failed-run"
                run.mkdir(parents=True)
                (run / "failure.json").write_text(json.dumps({
                    "stage": "runtime_config_validation",
                    "error": {"message": "--max-create 2000 exceeds imports.maxCreatesPerRun 1000"},
                }), encoding="utf-8")
                return 64

            result = scheduler.run_scheduled_task(
                config,
                "daily-discovery",
                trigger="manual",
                now_fn=iter((start, finish)).__next__,
                command_runner=runner,
            )
            self.assertEqual(result, scheduler.EXIT_CONFIG)
            task = scheduler.load_state(config["_paths"]["state"], config["timezone"])["tasks"]["dailyDiscovery"]
            self.assertEqual(task["lastAttemptRunId"], "failed-run")
            self.assertIsNone(task["lastCompletedRunId"])
            self.assertIn("runtime_config_validation", task["lastError"])
            self.assertIn("maxCreatesPerRun 1000", task["lastError"])

    def test_completed_and_failed_attempt_paths_are_separate(self):
        state = scheduler.empty_task_state()
        completed = Path("/tmp/completed-run")
        failed = Path("/tmp/failed-run")
        now = datetime(2026, 8, 31, 8, 0, tzinfo=timezone.utc)
        scheduler.mark_completed(
            state,
            slot_id="2026-08-31",
            now=now,
            outcome="success",
            exit_code=0,
            trigger="manual",
            run_path=completed,
            success=True,
        )
        scheduler.mark_failed(
            state,
            now=now + timedelta(hours=1),
            outcome="failed_transient",
            exit_code=1,
            trigger="retry",
            run_path=failed,
            error_message="boom",
        )
        self.assertEqual(state["lastCompletedRunPath"], str(completed))
        self.assertEqual(state["lastAttemptRunPath"], str(failed))

    def test_status_json_uses_configured_local_timezone(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            now = datetime(2026, 8, 31, 14, 51, 9, tzinfo=timezone.utc)
            state = scheduler.empty_state(config["timezone"])
            task = state["tasks"]["dailyDiscovery"]
            task["lastAttemptAtUtc"] = "2026-08-31T09:44:49Z"
            task["lastCompletedAtUtc"] = "2026-08-26T08:16:13Z"
            legacy_run = config["_paths"]["runs"] / "legacy-completed"
            legacy_run.mkdir(parents=True)
            (legacy_run / "scheduler.json").write_text(
                json.dumps({"outcome": "success"}), encoding="utf-8"
            )
            task["lastRunId"] = legacy_run.name
            task["lastRunPath"] = str(legacy_run)
            task["lastOutcome"] = "failed_transient"
            scheduler.atomic_write_json(config["_paths"]["state"], state)

            payload = scheduler.status_payload(config, now)
            self.assertEqual(payload["generatedAt"], "2026-08-31T16:51:09+02:00")
            daily = payload["tasks"]["daily-discovery"]
            self.assertEqual(daily["lastAttemptAt"], "2026-08-31T11:44:49+02:00")
            self.assertEqual(daily["lastCompletedAt"], "2026-08-26T10:16:13+02:00")
            self.assertNotIn("lastAttemptAtUtc", daily)
            self.assertNotIn("lastCompletedAtUtc", daily)
            self.assertNotIn("generatedAtUtc", payload)
            self.assertEqual(daily["lastCompletedRunPath"], str(legacy_run))
            self.assertIsNone(daily["lastAttemptRunPath"])


if __name__ == "__main__":
    unittest.main()
