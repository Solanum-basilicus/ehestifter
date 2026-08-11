#!/usr/bin/env python3
"""Local ATS Discovery operations scheduler.

This module is intentionally standard-library only. It is executed on the host by
systemd and launches the existing Docker Compose scanner as a short-lived process.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import date, datetime, time as dt_time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SCHEMA_VERSION = 1
TASK_KEYS = {
    "daily-discovery": "dailyDiscovery",
    "catalog-refresh": "catalogRefresh",
}
EXIT_COMPLETED_DEGRADED = 2
EXIT_RETRY_EXHAUSTED = 3
EXIT_CONFIG = 64
EXIT_TEMPORARY = 75
EXIT_STATE = 78


class ConfigError(ValueError):
    pass


class StateError(ValueError):
    pass


@dataclass(frozen=True)
class ScheduleSlot:
    slot_id: str
    scheduled_local: datetime


@dataclass
class LockHandle:
    file_handle: Any
    lock_path: Path
    owner_path: Path

    def release(self) -> None:
        try:
            self.owner_path.unlink(missing_ok=True)
        finally:
            fcntl.flock(self.file_handle.fileno(), fcntl.LOCK_UN)
            self.file_handle.close()

    def __enter__(self) -> "LockHandle":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.release()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc(value: Any, field: str) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise StateError(f"{field} must be a nonempty UTC timestamp or null")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise StateError(f"{field} is not a valid timestamp") from exc
    if parsed.tzinfo is None:
        raise StateError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _require_mapping(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{field} must be an object")
    return value


def _require_bool(value: Any, field: str) -> bool:
    if type(value) is not bool:
        raise ConfigError(f"{field} must be a boolean")
    return value


def _require_int(value: Any, field: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise ConfigError(f"{field} must be an integer between {minimum} and {maximum}")
    return value


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ConfigError(f"{field} must be a nonempty string")
    return value.strip()


def _require_string_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ConfigError(f"{field} must be a nonempty array")
    return [_require_string(item, f"{field}[{index}]") for index, item in enumerate(value)]


def parse_clock(value: Any, field: str) -> dt_time:
    text = _require_string(value, field)
    try:
        parsed = datetime.strptime(text, "%H:%M").time()
    except ValueError as exc:
        raise ConfigError(f"{field} must use 24-hour HH:MM format") from exc
    return parsed


def resolve_path(scanner_root: Path, value: Any, field: str) -> Path:
    text = _require_string(value, field)
    path = Path(text).expanduser()
    if not path.is_absolute():
        path = scanner_root / path
    return path.resolve()


def load_config(config_path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError(f"scheduler config not found: {config_path}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"scheduler config is invalid JSON: {exc}") from exc

    config = _require_mapping(raw, "config")
    if config.get("schemaVersion") != SCHEMA_VERSION:
        raise ConfigError(f"schemaVersion must be {SCHEMA_VERSION}")

    timezone_name = _require_string(config.get("timezone"), "timezone")
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ConfigError(f"unknown IANA timezone: {timezone_name}") from exc

    scanner_root = config_path.resolve().parent.parent
    paths = _require_mapping(config.get("paths"), "paths")
    resolved_paths = {
        "state": resolve_path(scanner_root, paths.get("state"), "paths.state"),
        "lock": resolve_path(scanner_root, paths.get("lock"), "paths.lock"),
        "lockOwner": resolve_path(scanner_root, paths.get("lockOwner"), "paths.lockOwner"),
        "runs": resolve_path(scanner_root, paths.get("runs"), "paths.runs"),
        "stateBackups": resolve_path(scanner_root, paths.get("stateBackups"), "paths.stateBackups"),
        "tenantState": resolve_path(scanner_root, paths.get("tenantState"), "paths.tenantState"),
        "tenantStateBackups": resolve_path(
            scanner_root, paths.get("tenantStateBackups"), "paths.tenantStateBackups"
        ),
    }

    boot_grace = _require_int(config.get("bootGraceMinutes"), "bootGraceMinutes", 0, 120)
    activation_grace = _require_int(
        config.get("activationGraceSeconds", 60), "activationGraceSeconds", 0, 3600
    )
    minimum_spacing = _require_int(config.get("minimumSpacingMinutes"), "minimumSpacingMinutes", 0, 1440)

    retry = _require_mapping(config.get("retry"), "retry")
    retry_validated = {
        "maxRetries": _require_int(retry.get("maxRetries"), "retry.maxRetries", 0, 20),
        "retryIntervalMinutes": _require_int(
            retry.get("retryIntervalMinutes"), "retry.retryIntervalMinutes", 1, 1440
        ),
        "retryWindowMinutes": _require_int(
            retry.get("retryWindowMinutes"), "retry.retryWindowMinutes", 1, 10080
        ),
    }

    compose = _require_mapping(config.get("compose"), "compose")
    compose_validated = {
        "command": _require_string_list(compose.get("command"), "compose.command"),
        "service": _require_string(compose.get("service"), "compose.service"),
    }

    daily = validate_task(config.get("dailyDiscovery"), "dailyDiscovery", weekly=False)
    catalog = validate_task(config.get("catalogRefresh"), "catalogRefresh", weekly=True)

    retention = _require_mapping(config.get("retention"), "retention")
    retention_validated = {
        "successfulDays": _require_int(retention.get("successfulDays"), "retention.successfulDays", 1, 3650),
        "degradedOrFailedDays": _require_int(
            retention.get("degradedOrFailedDays"), "retention.degradedOrFailedDays", 1, 3650
        ),
        "minimumRuns": _require_int(retention.get("minimumRuns"), "retention.minimumRuns", 0, 10000),
        "stateBackups": _require_int(retention.get("stateBackups"), "retention.stateBackups", 0, 1000),
        "tenantStateBackups": _require_int(
            retention.get("tenantStateBackups"), "retention.tenantStateBackups", 0, 1000
        ),
        "temporaryDirectoryHours": _require_int(
            retention.get("temporaryDirectoryHours"), "retention.temporaryDirectoryHours", 1, 8760
        ),
    }
    if retention_validated["degradedOrFailedDays"] < retention_validated["successfulDays"]:
        raise ConfigError("retention.degradedOrFailedDays must be >= retention.successfulDays")

    return {
        **config,
        "_configPath": config_path.resolve(),
        "_scannerRoot": scanner_root,
        "_paths": resolved_paths,
        "timezone": timezone_name,
        "bootGraceMinutes": boot_grace,
        "activationGraceSeconds": activation_grace,
        "minimumSpacingMinutes": minimum_spacing,
        "retry": retry_validated,
        "compose": compose_validated,
        "dailyDiscovery": daily,
        "catalogRefresh": catalog,
        "retention": retention_validated,
    }


def validate_task(value: Any, field: str, *, weekly: bool) -> dict[str, Any]:
    task = _require_mapping(value, field)
    result = {
        "enabled": _require_bool(task.get("enabled"), f"{field}.enabled"),
        "schedule": _require_string(task.get("schedule"), f"{field}.schedule"),
        "scannerArgs": _require_string_list(task.get("scannerArgs"), f"{field}.scannerArgs"),
    }
    parse_clock(result["schedule"], f"{field}.schedule")
    if weekly:
        weekday = _require_string(task.get("weekday"), f"{field}.weekday").lower()
        names = {name.lower(): index for index, name in enumerate(
            ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        )}
        if weekday not in names:
            raise ConfigError(f"{field}.weekday must be a full English weekday name")
        result["weekday"] = weekday.capitalize()
        result["weekdayIndex"] = names[weekday]
    return result


def empty_state(timezone_name: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "timezone": timezone_name,
        "tasks": {
            "dailyDiscovery": empty_task_state(),
            "catalogRefresh": empty_task_state(),
        },
    }


def empty_task_state() -> dict[str, Any]:
    return {
        "currentSlot": None,
        "firstAttemptAtUtc": None,
        "attemptsForCurrentSlot": 0,
        "lastAttemptAtUtc": None,
        "lastCompletedSlot": None,
        "lastCompletedAtUtc": None,
        "lastSuccessfulAtUtc": None,
        "lastRunId": None,
        "lastRunPath": None,
        "lastOutcome": None,
        "lastExitCode": None,
        "lastTrigger": None,
        "lastError": None,
        "consecutiveFailures": 0,
    }


def validate_task_state(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StateError(f"{field} must be an object")
    expected = empty_task_state()
    result = {**expected, **value}
    for key in ("currentSlot", "lastCompletedSlot", "lastRunId", "lastRunPath", "lastOutcome", "lastTrigger", "lastError"):
        if result[key] is not None and not isinstance(result[key], str):
            raise StateError(f"{field}.{key} must be a string or null")
    for key in ("firstAttemptAtUtc", "lastAttemptAtUtc", "lastCompletedAtUtc", "lastSuccessfulAtUtc"):
        parse_utc(result[key], f"{field}.{key}")
    for key in ("attemptsForCurrentSlot", "consecutiveFailures"):
        if type(result[key]) is not int or result[key] < 0:
            raise StateError(f"{field}.{key} must be a nonnegative integer")
    if result["lastExitCode"] is not None and type(result["lastExitCode"]) is not int:
        raise StateError(f"{field}.lastExitCode must be an integer or null")
    return result


def load_state(path: Path, timezone_name: str) -> dict[str, Any]:
    if not path.exists():
        return empty_state(timezone_name)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise StateError(f"scheduler state is invalid JSON: {path}: {exc}") from exc
    if not isinstance(raw, dict) or raw.get("schemaVersion") != SCHEMA_VERSION:
        raise StateError(f"scheduler state schemaVersion must be {SCHEMA_VERSION}")
    if raw.get("timezone") != timezone_name:
        raise StateError("scheduler state timezone does not match scheduler config")
    tasks = raw.get("tasks")
    if not isinstance(tasks, dict):
        raise StateError("scheduler state tasks must be an object")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "timezone": timezone_name,
        "tasks": {
            "dailyDiscovery": validate_task_state(tasks.get("dailyDiscovery"), "tasks.dailyDiscovery"),
            "catalogRefresh": validate_task_state(tasks.get("catalogRefresh"), "tasks.catalogRefresh"),
        },
    }


def atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        try:
            directory_fd = os.open(path.parent, os.O_DIRECTORY)
        except OSError:
            directory_fd = None
        if directory_fd is not None:
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        temp_path.unlink(missing_ok=True)


def backup_and_write_state(config: Mapping[str, Any], state: Mapping[str, Any], now: datetime) -> None:
    state_path: Path = config["_paths"]["state"]
    backups_path: Path = config["_paths"]["stateBackups"]
    keep = config["retention"]["stateBackups"]
    if state_path.exists() and keep > 0:
        backups_path.mkdir(parents=True, exist_ok=True)
        stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        shutil.copy2(state_path, backups_path / f"scheduler-state-{stamp}.json")
    atomic_write_json(state_path, state)
    prune_state_backups(backups_path, keep)


def prune_state_backups(backups_path: Path, keep: int) -> None:
    if not backups_path.exists():
        return
    files = sorted(backups_path.glob("scheduler-state-*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
    for old in files[keep:]:
        old.unlink(missing_ok=True)


def backup_file_atomic(source: Path, backup_dir: Path, prefix: str, now: datetime) -> Path | None:
    if not source.exists():
        return None
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = backup_dir / f"{prefix}-{stamp}.json"
    fd, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=backup_dir)
    temp_path = Path(temp_name)
    os.close(fd)
    try:
        shutil.copy2(source, temp_path)
        os.replace(temp_path, destination)
    finally:
        temp_path.unlink(missing_ok=True)
    return destination


def prune_named_backups(backup_dir: Path, prefix: str, keep: int) -> int:
    if not backup_dir.exists():
        return 0
    files = sorted(
        backup_dir.glob(f"{prefix}-*.json"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    deleted = 0
    for old in files[keep:]:
        old.unlink(missing_ok=True)
        deleted += 1
    return deleted


def backup_tenant_state(config: Mapping[str, Any], now: datetime) -> Path | None:
    destination = backup_file_atomic(
        config["_paths"]["tenantState"],
        config["_paths"]["tenantStateBackups"],
        "tenant-state",
        now,
    )
    prune_named_backups(
        config["_paths"]["tenantStateBackups"],
        "tenant-state",
        config["retention"]["tenantStateBackups"],
    )
    return destination


def acquire_lock(config: Mapping[str, Any], operation: str, now: datetime) -> LockHandle | None:
    lock_path: Path = config["_paths"]["lock"]
    owner_path: Path = config["_paths"]["lockOwner"]
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    owner = {
        "schemaVersion": SCHEMA_VERSION,
        "operation": operation,
        "startedAtUtc": iso_utc(now),
        "host": socket.gethostname(),
        "pid": os.getpid(),
        "userId": os.getuid(),
    }
    try:
        atomic_write_json(owner_path, owner)
    except Exception:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()
        raise
    return LockHandle(handle, lock_path, owner_path)


def read_lock_owner(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def inspect_lock(config: Mapping[str, Any]) -> dict[str, Any]:
    lock_path: Path = config["_paths"]["lock"]
    owner_path: Path = config["_paths"]["lockOwner"]
    owner = read_lock_owner(owner_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"busy": True, "owner": owner}
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            return {"busy": False, "owner": None, "staleOwner": owner}
    finally:
        handle.close()


def latest_slot(task_key: str, task_config: Mapping[str, Any], timezone_name: str, now: datetime) -> ScheduleSlot:
    zone = ZoneInfo(timezone_name)
    local_now = now.astimezone(zone)
    scheduled_time = parse_clock(task_config["schedule"], f"{task_key}.schedule")

    if task_key == "dailyDiscovery":
        slot_date = local_now.date()
        scheduled_local = datetime.combine(slot_date, scheduled_time, zone)
        if local_now < scheduled_local:
            slot_date -= timedelta(days=1)
            scheduled_local = datetime.combine(slot_date, scheduled_time, zone)
        return ScheduleSlot(slot_date.isoformat(), scheduled_local)

    weekday_index = task_config["weekdayIndex"]
    days_since = (local_now.weekday() - weekday_index) % 7
    slot_date = local_now.date() - timedelta(days=days_since)
    scheduled_local = datetime.combine(slot_date, scheduled_time, zone)
    if local_now < scheduled_local:
        slot_date -= timedelta(days=7)
        scheduled_local = datetime.combine(slot_date, scheduled_time, zone)
    return ScheduleSlot(slot_date.isoformat(), scheduled_local)


def next_scheduled(task_key: str, task_config: Mapping[str, Any], timezone_name: str, now: datetime) -> datetime:
    zone = ZoneInfo(timezone_name)
    local_now = now.astimezone(zone)
    scheduled_time = parse_clock(task_config["schedule"], f"{task_key}.schedule")
    if task_key == "dailyDiscovery":
        candidate = datetime.combine(local_now.date(), scheduled_time, zone)
        if candidate <= local_now:
            candidate += timedelta(days=1)
        return candidate
    weekday_index = task_config["weekdayIndex"]
    days_ahead = (weekday_index - local_now.weekday()) % 7
    candidate_date = local_now.date() + timedelta(days=days_ahead)
    candidate = datetime.combine(candidate_date, scheduled_time, zone)
    if candidate <= local_now:
        candidate += timedelta(days=7)
    return candidate


def boot_uptime_seconds(path: Path = Path("/proc/uptime")) -> float | None:
    try:
        first = path.read_text(encoding="utf-8").split()[0]
        return float(first)
    except (OSError, ValueError, IndexError):
        return None


def remaining_boot_grace_seconds(boot_grace_minutes: int, uptime_seconds: float | None) -> float:
    if boot_grace_minutes <= 0 or uptime_seconds is None:
        return 0.0
    return max(0.0, boot_grace_minutes * 60.0 - uptime_seconds)


def remaining_activation_grace_seconds(
    boot_grace_minutes: int,
    activation_grace_seconds: int,
    uptime_seconds: float | None,
) -> float:
    return max(
        remaining_boot_grace_seconds(boot_grace_minutes, uptime_seconds),
        float(activation_grace_seconds),
    )


def build_scanner_command(config: Mapping[str, Any], task_key: str) -> list[str]:
    compose = config["compose"]
    task = config[task_key]
    return [*compose["command"], "run", "--rm", compose["service"], *task["scannerArgs"]]


def snapshot_run_dirs(runs_path: Path) -> set[Path]:
    if not runs_path.exists():
        return set()
    return {entry.resolve() for entry in runs_path.iterdir() if entry.is_dir() and not is_temporary_run_dir(entry)}


def find_new_run(runs_path: Path, before: set[Path]) -> Path | None:
    after = snapshot_run_dirs(runs_path)
    new = list(after - before)
    if not new:
        return None
    return max(new, key=lambda item: item.stat().st_mtime)


def run_command(command: Sequence[str], cwd: Path) -> int:
    environment = os.environ.copy()
    environment.setdefault("LOCAL_UID", str(os.getuid()))
    environment.setdefault("LOCAL_GID", str(os.getgid()))
    print(f"[ats-scheduler] exec: {' '.join(command)}", flush=True)
    completed = subprocess.run(command, cwd=cwd, env=environment, check=False)
    return completed.returncode


def task_attempt_budget(task_state: Mapping[str, Any], slot_id: str, retry: Mapping[str, int], now: datetime) -> tuple[bool, str | None]:
    if task_state.get("currentSlot") != slot_id:
        return True, None
    attempts = task_state.get("attemptsForCurrentSlot", 0)
    first = parse_utc(task_state.get("firstAttemptAtUtc"), "task.firstAttemptAtUtc")
    if attempts >= retry["maxRetries"] + 1:
        return False, "attempt_limit"
    if first is not None and now - first > timedelta(minutes=retry["retryWindowMinutes"]):
        return False, "retry_window"
    return True, None


def reset_for_slot(task_state: dict[str, Any], slot_id: str) -> None:
    if task_state.get("currentSlot") != slot_id:
        task_state["currentSlot"] = slot_id
        task_state["firstAttemptAtUtc"] = None
        task_state["attemptsForCurrentSlot"] = 0


def mark_completed(
    task_state: dict[str, Any],
    *,
    slot_id: str,
    now: datetime,
    outcome: str,
    exit_code: int,
    trigger: str,
    run_path: Path | None,
    success: bool,
) -> None:
    task_state["lastAttemptAtUtc"] = iso_utc(now)
    task_state["lastCompletedSlot"] = slot_id
    task_state["lastCompletedAtUtc"] = iso_utc(now)
    if success:
        task_state["lastSuccessfulAtUtc"] = iso_utc(now)
    task_state["lastRunId"] = run_path.name if run_path else task_state.get("lastRunId")
    task_state["lastRunPath"] = str(run_path) if run_path else task_state.get("lastRunPath")
    task_state["lastOutcome"] = outcome
    task_state["lastExitCode"] = exit_code
    task_state["lastTrigger"] = trigger
    task_state["lastError"] = None
    task_state["consecutiveFailures"] = 0


def mark_failed(
    task_state: dict[str, Any],
    *,
    now: datetime,
    outcome: str,
    exit_code: int,
    trigger: str,
    run_path: Path | None,
    error_message: str | None = None,
) -> None:
    task_state["lastAttemptAtUtc"] = iso_utc(now)
    task_state["lastRunId"] = run_path.name if run_path else task_state.get("lastRunId")
    task_state["lastRunPath"] = str(run_path) if run_path else task_state.get("lastRunPath")
    task_state["lastOutcome"] = outcome
    task_state["lastExitCode"] = exit_code
    task_state["lastTrigger"] = trigger
    task_state["lastError"] = error_message[:1000] if error_message else None
    task_state["consecutiveFailures"] = int(task_state.get("consecutiveFailures", 0)) + 1


def write_run_scheduler_metadata(run_path: Path | None, payload: Mapping[str, Any]) -> None:
    if run_path is None:
        return
    try:
        atomic_write_json(run_path / "scheduler.json", payload)
    except OSError as exc:
        print(f"[ats-scheduler] warning: could not write run scheduler metadata: {exc}", file=sys.stderr)


def run_scheduled_task(
    config: Mapping[str, Any],
    task_name: str,
    *,
    trigger: str,
    force: bool = False,
    now_fn: Callable[[], datetime] = utc_now,
    sleep_fn: Callable[[float], None] = time.sleep,
    command_runner: Callable[[Sequence[str], Path], int] = run_command,
    uptime_fn: Callable[[], float | None] = boot_uptime_seconds,
) -> int:
    task_key = TASK_KEYS[task_name]
    task_config = config[task_key]
    if not task_config["enabled"] and not force:
        print(f"[ats-scheduler] {task_name}: disabled")
        return 0

    if trigger == "systemd":
        remaining = remaining_activation_grace_seconds(
            config["bootGraceMinutes"],
            config["activationGraceSeconds"],
            uptime_fn(),
        )
        if remaining > 0:
            print(
                f"[ats-scheduler] activation grace: sleeping {int(remaining)} seconds",
                flush=True,
            )
            sleep_fn(remaining)

    now = now_fn()
    lock = acquire_lock(config, task_name, now)
    if lock is None:
        owner = read_lock_owner(config["_paths"]["lockOwner"])
        print(f"[ats-scheduler] {task_name}: global lock busy; owner={json.dumps(owner)}", file=sys.stderr)
        return EXIT_TEMPORARY

    with lock:
        try:
            state = load_state(config["_paths"]["state"], config["timezone"])
        except StateError as exc:
            print(f"[ats-scheduler] state error: {exc}", file=sys.stderr)
            return EXIT_STATE

        task_state = state["tasks"][task_key]
        slot = latest_slot(task_key, task_config, config["timezone"], now)
        reset_for_slot(task_state, slot.slot_id)

        if not force and task_state.get("lastCompletedSlot") == slot.slot_id:
            print(f"[ats-scheduler] {task_name}: slot {slot.slot_id} already completed")
            return 0

        last_completed = parse_utc(task_state.get("lastCompletedAtUtc"), "task.lastCompletedAtUtc")
        if not force and last_completed is not None:
            spacing = timedelta(minutes=config["minimumSpacingMinutes"])
            if now - last_completed < spacing:
                mark_completed(
                    task_state,
                    slot_id=slot.slot_id,
                    now=now,
                    outcome="skipped_minimum_spacing",
                    exit_code=0,
                    trigger=trigger,
                    run_path=None,
                    success=False,
                )
                backup_and_write_state(config, state, now)
                print(f"[ats-scheduler] {task_name}: collapsed slot {slot.slot_id} into recent completed run")
                return 0

        allowed, exhausted_reason = task_attempt_budget(task_state, slot.slot_id, config["retry"], now)
        if not force and not allowed:
            mark_failed(
                task_state,
                now=now,
                outcome=f"failed_permanent_{exhausted_reason}",
                exit_code=EXIT_RETRY_EXHAUSTED,
                trigger=trigger,
                run_path=None,
            )
            backup_and_write_state(config, state, now)
            print(f"[ats-scheduler] {task_name}: retry budget exhausted for slot {slot.slot_id}", file=sys.stderr)
            return EXIT_RETRY_EXHAUSTED

        if task_state["firstAttemptAtUtc"] is None:
            task_state["firstAttemptAtUtc"] = iso_utc(now)
        task_state["attemptsForCurrentSlot"] += 1
        task_state["lastAttemptAtUtc"] = iso_utc(now)
        task_state["lastTrigger"] = trigger
        backup_and_write_state(config, state, now)

        runs_path: Path = config["_paths"]["runs"]
        if task_key == "dailyDiscovery":
            try:
                tenant_backup = backup_tenant_state(config, now)
                if tenant_backup is not None:
                    print(f"[ats-scheduler] tenant state backup: {tenant_backup}")
            except OSError as exc:
                finished = now_fn()
                error_message = f"{type(exc).__name__}: {exc}"
                mark_failed(
                    task_state,
                    now=finished,
                    outcome="failed_state_backup",
                    exit_code=1,
                    trigger=trigger,
                    run_path=None,
                    error_message=error_message,
                )
                backup_and_write_state(config, state, finished)
                print(f"[ats-scheduler] tenant state backup failed: {error_message}", file=sys.stderr)
                return 1
        before = snapshot_run_dirs(runs_path)
        command = build_scanner_command(config, task_key)
        launch_error = None
        try:
            exit_code = command_runner(command, config["_scannerRoot"])
        except OSError as exc:
            exit_code = 1
            launch_error = f"{type(exc).__name__}: {exc}"
            print(f"[ats-scheduler] launch failure: {launch_error}", file=sys.stderr)
        finished = now_fn()
        run_path = find_new_run(runs_path, before) if task_key == "dailyDiscovery" else None

        artifact_exit_codes = (
            0,
            EXIT_COMPLETED_DEGRADED,
            EXIT_CONFIG,
            EXIT_TEMPORARY,
        )
        if launch_error is not None:
            outcome = "failed_launch"
        elif (
            task_key == "dailyDiscovery"
            and exit_code in artifact_exit_codes
            and run_path is None
        ):
            exit_code = 1
            outcome = "failed_missing_run_artifact"
        elif exit_code == 0:
            outcome = "success"
        elif exit_code == EXIT_COMPLETED_DEGRADED:
            outcome = "completed_degraded"
        elif task_key == "dailyDiscovery" and exit_code == EXIT_TEMPORARY:
            outcome = "aborted_retryable"
        elif task_key == "dailyDiscovery" and exit_code == EXIT_CONFIG:
            outcome = "failed_prerequisite"
        else:
            outcome = "failed_transient"

        if outcome in ("success", "completed_degraded"):
            mark_completed(
                task_state,
                slot_id=slot.slot_id,
                now=finished,
                outcome=outcome,
                exit_code=exit_code,
                trigger=trigger,
                run_path=run_path,
                success=(outcome == "success"),
            )
        else:
            mark_failed(
                task_state,
                now=finished,
                outcome=outcome,
                exit_code=exit_code,
                trigger=trigger,
                run_path=run_path,
                error_message=launch_error,
            )

        metadata = {
            "schemaVersion": SCHEMA_VERSION,
            "task": task_name,
            "slot": slot.slot_id,
            "trigger": trigger,
            "outcome": outcome,
            "exitCode": exit_code,
            "error": launch_error,
            "finishedAtUtc": iso_utc(finished),
        }
        write_run_scheduler_metadata(run_path, metadata)
        backup_and_write_state(config, state, finished)
        try:
            retention_summary = apply_retention(config, finished)
            print(f"[ats-scheduler] retention: {json.dumps(retention_summary, sort_keys=True)}")
        except Exception as exc:  # retention must not change the completed run result
            print(f"[ats-scheduler] warning: retention failed: {type(exc).__name__}: {exc}", file=sys.stderr)

        print(
            f"[ats-scheduler] {task_name}: slot={slot.slot_id} outcome={outcome} "
            f"exit={exit_code} run={run_path or '-'}"
        )
        if outcome == "completed_degraded":
            return EXIT_COMPLETED_DEGRADED
        if outcome == "aborted_retryable":
            return EXIT_TEMPORARY
        if outcome == "failed_prerequisite":
            return EXIT_CONFIG
        if outcome.startswith("failed_"):
            return 1
        return 0


def classify_run_for_retention(run_path: Path) -> str:
    metadata_path = run_path / "scheduler.json"
    if metadata_path.exists():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            outcome = metadata.get("outcome")
            if outcome == "success":
                return "success"
            if isinstance(outcome, str):
                return "degraded_or_failed"
        except (json.JSONDecodeError, OSError):
            return "degraded_or_failed"
    summary_path = run_path / "summary.json"
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return "degraded_or_failed"
    if summary.get("providerHealthWarnings"):
        return "degraded_or_failed"
    if int(summary.get("providerCanariesDegraded") or 0) > 0:
        return "degraded_or_failed"
    variants = summary.get("providerVariants")
    if isinstance(variants, dict) and any(
        isinstance(item, dict) and item.get("status") == "degraded"
        for item in variants.values()
    ):
        return "degraded_or_failed"
    if summary.get("discoveryUsersLoadStatus") == "error":
        return "degraded_or_failed"
    if int(summary.get("compatibilityErrors") or 0) > 0:
        return "degraded_or_failed"
    return "success"


def is_temporary_run_dir(path: Path) -> bool:
    name = path.name
    return name.startswith(".") or name.endswith(".tmp") or ".tmp-" in name


def apply_retention(config: Mapping[str, Any], now: datetime) -> dict[str, int]:
    runs_path: Path = config["_paths"]["runs"]
    policy = config["retention"]
    summary = {
        "runsDeleted": 0,
        "temporaryDeleted": 0,
        "backupsDeleted": 0,
        "tenantStateBackupsDeleted": 0,
    }
    if runs_path.exists():
        entries = [entry for entry in runs_path.iterdir() if entry.is_dir()]
        temporary_cutoff = now.timestamp() - policy["temporaryDirectoryHours"] * 3600
        for entry in entries:
            if is_temporary_run_dir(entry) and entry.stat().st_mtime < temporary_cutoff:
                shutil.rmtree(entry)
                summary["temporaryDeleted"] += 1

        published = [entry for entry in entries if entry.exists() and not is_temporary_run_dir(entry)]
        published.sort(key=lambda item: item.stat().st_mtime, reverse=True)
        protected = {entry.resolve() for entry in published[: policy["minimumRuns"]]}
        for entry in published[policy["minimumRuns"] :]:
            classification = classify_run_for_retention(entry)
            days = policy["successfulDays"] if classification == "success" else policy["degradedOrFailedDays"]
            if entry.stat().st_mtime < now.timestamp() - days * 86400 and entry.resolve() not in protected:
                shutil.rmtree(entry)
                summary["runsDeleted"] += 1

    backups_path: Path = config["_paths"]["stateBackups"]
    before = len(list(backups_path.glob("scheduler-state-*.json"))) if backups_path.exists() else 0
    prune_state_backups(backups_path, policy["stateBackups"])
    after = len(list(backups_path.glob("scheduler-state-*.json"))) if backups_path.exists() else 0
    summary["backupsDeleted"] = max(0, before - after)
    summary["tenantStateBackupsDeleted"] = prune_named_backups(
        config["_paths"]["tenantStateBackups"],
        "tenant-state",
        policy["tenantStateBackups"],
    )
    return summary


def status_payload(config: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    state = load_state(config["_paths"]["state"], config["timezone"])
    tasks: dict[str, Any] = {}
    for task_name, task_key in TASK_KEYS.items():
        task_config = config[task_key]
        task_state = state["tasks"][task_key]
        slot = latest_slot(task_key, task_config, config["timezone"], now)
        next_time = next_scheduled(task_key, task_config, config["timezone"], now)
        tasks[task_name] = {
            "enabled": task_config["enabled"],
            "currentDueSlot": slot.slot_id,
            "slotScheduledAt": slot.scheduled_local.isoformat(),
            "nextScheduledAt": next_time.isoformat(),
            "due": task_config["enabled"] and task_state.get("lastCompletedSlot") != slot.slot_id,
            **task_state,
        }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAtUtc": iso_utc(now),
        "timezone": config["timezone"],
        "lock": inspect_lock(config),
        "tasks": tasks,
    }


def print_status(payload: Mapping[str, Any]) -> None:
    print(f"ATS Discovery scheduler ({payload['timezone']})")
    lock = payload.get("lock", {})
    if lock.get("busy"):
        print(f"  Lock: busy {json.dumps(lock.get('owner'))}")
    elif lock.get("staleOwner"):
        print(f"  Lock: free (stale metadata {json.dumps(lock.get('staleOwner'))})")
    else:
        print("  Lock: free")
    for task_name, task in payload["tasks"].items():
        print(f"\n{task_name}")
        print(f"  Enabled:            {task['enabled']}")
        print(f"  Current due slot:   {task['currentDueSlot']}")
        print(f"  Due:                {task['due']}")
        print(f"  Last completed:     {task.get('lastCompletedAtUtc') or '-'}")
        print(f"  Last outcome:       {task.get('lastOutcome') or '-'}")
        print(f"  Last error:         {task.get('lastError') or '-'}")
        print(f"  Last run:           {task.get('lastRunPath') or '-'}")
        print(f"  Attempts this slot: {task.get('attemptsForCurrentSlot', 0)}")
        print(f"  Next scheduled:     {task['nextScheduledAt']}")


def run_locked_scanner(config: Mapping[str, Any], scanner_args: Sequence[str], label: str) -> int:
    now = utc_now()
    lock = acquire_lock(config, label, now)
    if lock is None:
        owner = read_lock_owner(config["_paths"]["lockOwner"])
        print(f"[ats-scheduler] global lock busy; owner={json.dumps(owner)}", file=sys.stderr)
        return EXIT_TEMPORARY
    with lock:
        command = [*config["compose"]["command"], "run", "--rm", config["compose"]["service"], *scanner_args]
        try:
            return run_command(command, config["_scannerRoot"])
        except OSError as exc:
            print(f"[ats-scheduler] launch failure: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1


def default_config_path(script_path: Path) -> Path:
    env = os.environ.get("ATS_SCHEDULER_CONFIG")
    if env:
        return Path(env).expanduser().resolve()
    return (script_path.resolve().parents[2] / "config" / "scheduler.local.json").resolve()


class HelpOnErrorArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_help(sys.stderr)
        self.exit(2, f"\n{self.prog}: error: {message}\n")


SCANNER_HELP = """
Scanner command forms (arguments after -- are passed unchanged):
  scan tracked --offline [--no-progress]
      Run due tracked/catalog targets without Jobs preflight or import.

  scan tracked --preflight [--catalog-targets N] [--no-progress]
      Run Jobs identity preflight; optionally add a bounded catalog shard.

  scan tracked --import --max-create N [--catalog-targets N] [--no-progress]
      Preflight and import, bounded by both --max-create and runtime config.

  catalog sync <provider|all>
      Refresh one machine-managed provider catalog, or all catalogs.

  repair lever-description <lever-job-url> [--apply]
      Inspect or apply the focused Lever description repair workflow.

Examples:
  ./ops/scheduler/ats-ops scanner -- scan tracked --preflight --catalog-targets 1
  ./ops/scheduler/ats-ops scanner -- catalog sync all
  ./ops/scheduler/ats-ops scanner -- --help

The final example asks the scanner container for its exact current CLI usage.
"""


ROOT_HELP = """
Examples:
  ./ops/scheduler/ats-ops status
  ./ops/scheduler/ats-ops run daily-discovery
  ./ops/scheduler/ats-ops run catalog-refresh --force
  ./ops/scheduler/ats-ops scanner -h
  ./ops/scheduler/ats-ops scanner -- scan tracked --preflight --catalog-targets 1

Use '<command> -h' for command-specific help.
"""


def build_parser() -> argparse.ArgumentParser:
    parser = HelpOnErrorArgumentParser(
        prog="ats-ops",
        description=(
            "Ehestifter ATS Discovery host-side operations wrapper. "
            "Scheduled tasks and manual scanner commands share one global lock."
        ),
        epilog=ROOT_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--config", type=Path, help="scheduler config path")
    sub = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    run = sub.add_parser(
        "run",
        help="run one scheduler-defined task",
        description=(
            "Run a task defined in scheduler.local.json under scheduler slot/retry rules. "
            "Use --force for a deliberate manual rerun of an already completed/too-recent slot."
        ),
        epilog=(
            "Tasks:\n"
            "  daily-discovery  Run configured dailyDiscovery.scannerArgs.\n"
            "  catalog-refresh  Run configured catalogRefresh.scannerArgs.\n\n"
            "Examples:\n"
            "  ./ops/scheduler/ats-ops run daily-discovery\n"
            "  ./ops/scheduler/ats-ops run catalog-refresh --force"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    run.add_argument("task", choices=sorted(TASK_KEYS), metavar="TASK", help="configured task name")
    run.add_argument(
        "--trigger",
        choices=["systemd", "manual", "retry"],
        default="manual",
        help="recorded trigger type (default: manual)",
    )
    run.add_argument("--force", action="store_true", help="ignore completed-slot and minimum-spacing checks")

    status = sub.add_parser("status", help="show scheduler state and next slots")
    status.add_argument("--json", action="store_true", dest="as_json")

    scanner = sub.add_parser(
        "scanner",
        help="run the scanner CLI directly under the global lock",
        description=(
            "Pass ATS Discovery scanner arguments through to the Compose service while "
            "still honoring the scheduler global lock. Use -- before the scanner command "
            "to make the wrapper/scanner boundary explicit."
        ),
        epilog=SCANNER_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    scanner.add_argument(
        "--label",
        default="manual-scanner",
        help="operation label written to lock-owner metadata (default: manual-scanner)",
    )
    scanner.add_argument(
        "scanner_args",
        nargs=argparse.REMAINDER,
        metavar="SCANNER_ARG",
        help="scanner CLI arguments passed unchanged after an optional -- separator",
    )
    scanner.set_defaults(_command_parser=scanner)

    prune = sub.add_parser("prune", help="apply configured artifact/state retention now")
    prune.add_argument("--json", action="store_true", dest="as_json")

    sub.add_parser("validate-config", help="validate scheduler.local.json and resolved scheduler paths")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    scanner_args: list[str] | None = None
    if args.command == "scanner":
        scanner_args = list(args.scanner_args)
        if scanner_args and scanner_args[0] == "--":
            scanner_args = scanner_args[1:]
        if not scanner_args:
            args._command_parser.error("scanner requires arguments after --")

    config_path = args.config.resolve() if args.config else default_config_path(Path(__file__))
    try:
        config = load_config(config_path)
    except ConfigError as exc:
        print(f"[ats-scheduler] config error: {exc}", file=sys.stderr)
        return EXIT_CONFIG

    try:
        if args.command == "run":
            return run_scheduled_task(config, args.task, trigger=args.trigger, force=args.force)
        if args.command == "status":
            payload = status_payload(config, utc_now())
            if args.as_json:
                print(json.dumps(payload, indent=2, sort_keys=True))
            else:
                print_status(payload)
            outcomes = [task.get("lastOutcome") for task in payload["tasks"].values() if task["enabled"]]
            return EXIT_COMPLETED_DEGRADED if any(
                isinstance(outcome, str) and ("degraded" in outcome or "failed" in outcome)
                for outcome in outcomes
            ) else 0
        if args.command == "scanner":
            assert scanner_args is not None
            return run_locked_scanner(config, scanner_args, args.label)
        if args.command == "prune":
            result = apply_retention(config, utc_now())
            if args.as_json:
                print(json.dumps(result, indent=2, sort_keys=True))
            else:
                print(f"retention: {json.dumps(result, sort_keys=True)}")
            return 0
        if args.command == "validate-config":
            print(f"valid: {config_path}")
            return 0
    except StateError as exc:
        print(f"[ats-scheduler] state error: {exc}", file=sys.stderr)
        return EXIT_STATE
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
