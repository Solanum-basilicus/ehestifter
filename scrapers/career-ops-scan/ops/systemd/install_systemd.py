#!/usr/bin/env python3
"""Render and install the Phase 7 system-level systemd units."""
from __future__ import annotations

import argparse
import getpass
import grp
import importlib.util
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

UNIT_NAMES = [
    "ehestifter-ats-discovery.service",
    "ehestifter-ats-discovery.timer",
    "ehestifter-ats-catalog-refresh.service",
    "ehestifter-ats-catalog-refresh.timer",
]
WEEKDAY_SHORT = {
    "Monday": "Mon",
    "Tuesday": "Tue",
    "Wednesday": "Wed",
    "Thursday": "Thu",
    "Friday": "Fri",
    "Saturday": "Sat",
    "Sunday": "Sun",
}


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(command))
    return subprocess.run(command, check=check, text=True)


def invoking_user(explicit_user: str | None = None) -> tuple[str, str]:
    user = explicit_user or os.environ.get("SUDO_USER")
    if not user:
        if os.geteuid() == 0:
            raise SystemExit("running as root without SUDO_USER; pass --user <normal-user>")
        user = getpass.getuser()
    try:
        record = pwd.getpwnam(user)
    except KeyError as exc:
        raise SystemExit(f"unknown user: {user}") from exc
    group = grp.getgrgid(record.pw_gid).gr_name
    return user, group


def load_scheduler_module(scanner_root: Path) -> Any:
    path = scanner_root / "ops" / "scheduler" / "ats_scheduler.py"
    spec = importlib.util.spec_from_file_location("ats_scheduler_install", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load scheduler module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def quote_systemd_argument(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_templates(
    scanner_root: Path,
    output_dir: Path,
    user: str,
    group: str,
    python_path: Path,
    config: dict[str, Any],
) -> None:
    template_dir = Path(__file__).resolve().parent
    retry = config["retry"]
    replacements = {
        "@SCANNER_ROOT@": str(scanner_root),
        "@USER@": user,
        "@GROUP@": group,
        "@PYTHON@": str(python_path),
        "@START_LIMIT_INTERVAL@": f"{retry['retryWindowMinutes']}min",
        "@START_LIMIT_BURST@": str(retry["maxRetries"] + 1),
        "@RESTART_SEC@": f"{retry['retryIntervalMinutes']}min",
        "@TIMEZONE@": config["timezone"],
        "@DAILY_SCHEDULE@": config["dailyDiscovery"]["schedule"],
        "@CATALOG_WEEKDAY_SHORT@": WEEKDAY_SHORT[config["catalogRefresh"]["weekday"]],
        "@CATALOG_SCHEDULE@": config["catalogRefresh"]["schedule"],
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    for name in UNIT_NAMES:
        source = template_dir / (name + ".in")
        if not source.exists():
            source = template_dir / name
        text = source.read_text(encoding="utf-8")
        for old, new in replacements.items():
            text = text.replace(old, new)
        unresolved = [token for token in replacements if token in text]
        if unresolved:
            raise SystemExit(f"unresolved placeholders in {name}: {unresolved}")
        if " " in str(scanner_root):
            text = text.replace(
                f"WorkingDirectory={scanner_root}",
                f"WorkingDirectory={quote_systemd_argument(str(scanner_root))}",
            )
            text = text.replace(
                f"file://{scanner_root}",
                f"file://{scanner_root.as_posix().replace(' ', '%20')}",
            )
            text = text.replace(
                f"ExecStart={python_path} {scanner_root}/ops/scheduler/ats_scheduler.py",
                f"ExecStart={quote_systemd_argument(str(python_path))} "
                f"{quote_systemd_argument(str(scanner_root / 'ops/scheduler/ats_scheduler.py'))}",
            )
        (output_dir / name).write_text(text, encoding="utf-8")


def verify_units(directory: Path) -> None:
    analyzer = shutil.which("systemd-analyze")
    if not analyzer:
        print("warning: systemd-analyze not found; skipping unit verification", file=sys.stderr)
        return
    # Verify in an isolated load path with a minimal docker.service placeholder.
    # This checks our syntax even in CI/container environments that do not run Docker via systemd.
    with tempfile.TemporaryDirectory(prefix="ehestifter-unit-verify-") as temp:
        verify_dir = Path(temp)
        for name in UNIT_NAMES:
            shutil.copy2(directory / name, verify_dir / name)
        (verify_dir / "docker.service").write_text(
            "[Unit]\nDescription=Verification-only Docker placeholder\n"
            "[Service]\nType=oneshot\nExecStart=/bin/true\n",
            encoding="utf-8",
        )
        run([
            analyzer,
            "verify",
            str(verify_dir / "docker.service"),
            *(str(verify_dir / name) for name in UNIT_NAMES),
        ])


def load_config(scanner_root: Path) -> dict[str, Any]:
    config_path = scanner_root / "config" / "scheduler.local.json"
    if not config_path.exists():
        raise SystemExit(
            f"missing {config_path}; copy scheduler.example.json, review scannerArgs, then retry"
        )
    module = load_scheduler_module(scanner_root)
    try:
        return module.load_config(config_path)
    except Exception as exc:
        raise SystemExit(f"scheduler config is invalid: {exc}") from exc


def install(scanner_root: Path, *, enable: bool, explicit_user: str | None) -> None:
    if os.geteuid() != 0:
        raise SystemExit("installation writes /etc/systemd/system; run with sudo")
    config = load_config(scanner_root)
    user, group = invoking_user(explicit_user)
    python_path = Path(shutil.which("python3") or "/usr/bin/python3").resolve()
    target = Path("/etc/systemd/system")
    with tempfile.TemporaryDirectory(prefix="ehestifter-systemd-") as temp:
        rendered = Path(temp)
        render_templates(scanner_root, rendered, user, group, python_path, config)
        verify_units(rendered)
        for name in UNIT_NAMES:
            shutil.copy2(rendered / name, target / name)
            os.chmod(target / name, 0o644)
    run(["systemctl", "daemon-reload"])
    if enable:
        run([
            "systemctl",
            "enable",
            "--now",
            "ehestifter-ats-discovery.timer",
            "ehestifter-ats-catalog-refresh.timer",
        ])
    print(f"installed units for user={user} group={group} root={scanner_root}")


def uninstall(*, disable: bool) -> None:
    if os.geteuid() != 0:
        raise SystemExit("uninstallation writes /etc/systemd/system; run with sudo")
    if disable:
        run([
            "systemctl",
            "disable",
            "--now",
            "ehestifter-ats-discovery.timer",
            "ehestifter-ats-catalog-refresh.timer",
        ], check=False)
    target = Path("/etc/systemd/system")
    for name in UNIT_NAMES:
        (target / name).unlink(missing_ok=True)
    run(["systemctl", "daemon-reload"])
    run([
        "systemctl",
        "reset-failed",
        "ehestifter-ats-discovery.service",
        "ehestifter-ats-catalog-refresh.service",
    ], check=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    install_parser = sub.add_parser("install")
    install_parser.add_argument("--scanner-root", type=Path, default=Path(__file__).resolve().parents[2])
    install_parser.add_argument("--user")
    install_parser.add_argument("--no-enable", action="store_true")
    uninstall_parser = sub.add_parser("uninstall")
    uninstall_parser.add_argument("--keep-enabled", action="store_true")
    render_parser = sub.add_parser("render")
    render_parser.add_argument("output", type=Path)
    render_parser.add_argument("--scanner-root", type=Path, default=Path(__file__).resolve().parents[2])
    render_parser.add_argument("--user")
    args = parser.parse_args()

    if args.command == "install":
        install(args.scanner_root.resolve(), enable=not args.no_enable, explicit_user=args.user)
    elif args.command == "uninstall":
        uninstall(disable=not args.keep_enabled)
    else:
        scanner_root = args.scanner_root.resolve()
        config = load_config(scanner_root)
        user, group = invoking_user(args.user)
        python_path = Path(shutil.which("python3") or "/usr/bin/python3").resolve()
        render_templates(scanner_root, args.output.resolve(), user, group, python_path, config)
        verify_units(args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
