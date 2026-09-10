from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
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
        self.assertEqual(state["lastFinishedAtUtc"], scheduler.iso_utc(now + timedelta(hours=1)))
        self.assertEqual(state["lastFailureAtUtc"], scheduler.iso_utc(now + timedelta(hours=1)))
        self.assertEqual(state["lastFailureOutcome"], "failed_transient")
        self.assertEqual(state["lastFailureError"], "boom")
        self.assertEqual(state["lastFailureRunPath"], str(failed))

    def test_success_clears_current_error_but_preserves_last_failure(self):
        state = scheduler.empty_task_state()
        failed_at = datetime(2026, 8, 31, 8, 0, tzinfo=timezone.utc)
        succeeded_at = failed_at + timedelta(hours=1)
        failed_run = Path("/tmp/failed-run")
        success_run = Path("/tmp/success-run")

        scheduler.mark_failed(
            state,
            now=failed_at,
            outcome="failed_transient",
            exit_code=1,
            trigger="retry",
            run_path=failed_run,
            error_message="fetch failed: EAI_AGAIN",
        )
        scheduler.mark_completed(
            state,
            slot_id="2026-08-31",
            now=succeeded_at,
            outcome="success",
            exit_code=0,
            trigger="retry",
            run_path=success_run,
            success=True,
        )

        self.assertEqual(state["lastOutcome"], "success")
        self.assertIsNone(state["lastError"])
        self.assertEqual(state["lastFinishedAtUtc"], scheduler.iso_utc(succeeded_at))
        self.assertEqual(state["lastFailureAtUtc"], scheduler.iso_utc(failed_at))
        self.assertEqual(state["lastFailureOutcome"], "failed_transient")
        self.assertEqual(state["lastFailureError"], "fetch failed: EAI_AGAIN")
        self.assertEqual(state["lastFailureRunPath"], str(failed_run))


    def test_legacy_state_without_new_diagnostic_fields_still_loads(self):
        legacy = scheduler.empty_task_state()
        for key in (
            "lastFinishedAtUtc",
            "lastFailureAtUtc",
            "lastFailureOutcome",
            "lastFailureError",
            "lastFailureRunId",
            "lastFailureRunPath",
        ):
            legacy.pop(key)
        legacy["lastOutcome"] = "success"
        legacy["lastAttemptAtUtc"] = "2026-09-09T08:21:33Z"

        loaded = scheduler.validate_task_state(legacy, "task")
        self.assertIsNone(loaded["lastFinishedAtUtc"])
        self.assertIsNone(loaded["lastFailureAtUtc"])
        self.assertEqual(loaded["lastOutcome"], "success")

    def test_status_json_uses_configured_local_timezone(self):
        with tempfile.TemporaryDirectory() as temp:
            config = write_config(Path(temp))
            now = datetime(2026, 8, 31, 14, 51, 9, tzinfo=timezone.utc)
            state = scheduler.empty_state(config["timezone"])
            task = state["tasks"]["dailyDiscovery"]
            task["currentSlot"] = "2026-08-30"
            task["attemptsForCurrentSlot"] = 3
            task["lastAttemptAtUtc"] = "2026-08-31T09:44:49Z"
            task["lastFinishedAtUtc"] = "2026-08-31T09:40:00Z"
            task["lastCompletedAtUtc"] = "2026-08-26T08:16:13Z"
            task["lastFailureAtUtc"] = "2026-08-30T08:15:00Z"
            task["lastFailureOutcome"] = "failed_transient"
            task["lastFailureError"] = "network failure"
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
            self.assertEqual(daily["lastFinishedAt"], "2026-08-31T11:40:00+02:00")
            self.assertEqual(daily["lastCompletedAt"], "2026-08-26T10:16:13+02:00")
            self.assertEqual(daily["lastFailureAt"], "2026-08-30T10:15:00+02:00")
            self.assertEqual(daily["lastFailureOutcome"], "failed_transient")
            self.assertEqual(daily["lastFailureError"], "network failure")
            self.assertEqual(daily["attemptsForDueSlot"], 0)
            self.assertNotIn("lastAttemptAtUtc", daily)
            self.assertNotIn("lastFinishedAtUtc", daily)
            self.assertNotIn("lastCompletedAtUtc", daily)
            self.assertNotIn("lastFailureAtUtc", daily)
            self.assertNotIn("generatedAtUtc", payload)
            self.assertEqual(daily["lastCompletedRunPath"], str(legacy_run))
            self.assertIsNone(daily["lastAttemptRunPath"])

    def test_pretty_status_prioritizes_current_state_and_previous_result(self):
        payload = {
            "timezone": "Europe/Berlin",
            "lock": {
                "busy": True,
                "owner": {
                    "operation": "daily-discovery",
                    "startedAt": "2026-09-10T09:22:29+02:00",
                    "pid": 625431,
                },
            },
            "tasks": {
                "daily-discovery": {
                    "enabled": True,
                    "due": True,
                    "currentDueSlot": "2026-09-10",
                    "attemptsForDueSlot": 1,
                    "nextScheduledAt": "2026-09-11T08:30:00+02:00",
                    "lastOutcome": "completed_degraded",
                    "lastFinishedAt": None,
                    "lastCompletedAt": "2026-09-09T10:21:33+02:00",
                    "lastAttemptRunPath": "/data/runs/previous",
                    "lastError": None,
                },
                "catalog-refresh": {
                    "enabled": True,
                    "due": True,
                    "currentDueSlot": "2026-09-06",
                    "attemptsForDueSlot": 0,
                    "nextScheduledAt": "2026-09-13T07:30:00+02:00",
                    "lastOutcome": "success",
                    "lastFinishedAt": "2026-08-31T09:09:22+02:00",
                    "lastAttemptRunPath": None,
                    "lastError": None,
                },
            },
        }
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            scheduler.print_status(payload)
        output = stdout.getvalue()

        self.assertIn(
            "Lock: daily-discovery running since 2026-09-10T09:22:29+02:00 (pid 625431)",
            output,
        )
        self.assertIn("State:        IN PROGRESS", output)
        self.assertIn(
            "Slot:         2026-09-10 · attempts 1 · next 2026-09-11T08:30:00+02:00",
            output,
        )
        self.assertIn(
            "Previous:     completed_degraded · 2026-09-09T10:21:33+02:00",
            output,
        )
        self.assertIn("Previous run: /data/runs/previous", output)
        self.assertIn("State:        DUE", output)
        self.assertIn("2026-09-06 · attempts 0", output)
        self.assertNotIn("Last attempt:", output)
        self.assertNotIn("Last outcome:", output)
        self.assertNotIn("Enabled:", output)
        self.assertNotIn("Due:", output)
        self.assertNotIn("Previous run: -", output)

    def test_pretty_status_shows_latest_error_only_while_unrecovered(self):
        failed = {
            "timezone": "Europe/Berlin",
            "lock": {"busy": False, "owner": None},
            "tasks": {
                "daily-discovery": {
                    "enabled": True,
                    "due": True,
                    "currentDueSlot": "2026-09-10",
                    "attemptsForDueSlot": 1,
                    "nextScheduledAt": "2026-09-11T08:30:00+02:00",
                    "lastOutcome": "failed_transient",
                    "lastFinishedAt": "2026-09-10T10:13:49+02:00",
                    "lastAttemptRunPath": "/data/runs/failed",
                    "lastError": "fetch failed: EAI_AGAIN",
                },
            },
        }
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            scheduler.print_status(failed)
        self.assertIn("Error:        fetch failed: EAI_AGAIN", stdout.getvalue())



if __name__ == "__main__":
    unittest.main()
