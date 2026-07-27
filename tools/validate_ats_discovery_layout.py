#!/usr/bin/env python3
"""Validate the steady-state ATS Discovery repository layout after Phase 9."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Iterable

OLD_REL = Path("scrapers/career-ops-scan")
NEW_REL = Path("scrapers/ats-discovery")
OLD_TOKEN = "career-ops-scan"
NEW_TOKEN = "ats-discovery"
BOOTSTRAP_MARKER = "ATS-DISCOVERY-BOOTSTRAP-ONLY"
EXCLUDED_DIRS = {".git", ".cache", "data", "dist", "node_modules", "secrets"}
PACKAGE_ARTIFACT_NAMES = {
    "APPLY.md",
    "CRITICAL-REVIEW.md",
    "MANIFEST.md",
    "SOURCES.md",
    "TEST-RECORD.md",
    "apply_phase9.py",
    "phase9-payload",
    "phase9-tests",
}
TEXT_SUFFIXES = {
    "",
    ".cjs",
    ".env",
    ".example",
    ".in",
    ".js",
    ".json",
    ".lock",
    ".md",
    ".mjs",
    ".py",
    ".service",
    ".sh",
    ".timer",
    ".txt",
    ".yaml",
    ".yml",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--json", action="store_true", dest="as_json")
    return parser.parse_args()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def text_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root)
        if any(part in EXCLUDED_DIRS for part in relative.parts[:-1]):
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            if path.stat().st_size > 4 * 1024 * 1024:
                continue
            sample = path.read_bytes()[:8192]
        except OSError:
            continue
        if b"\x00" not in sample:
            yield path


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def active_repository_candidates(repo_root: Path) -> list[Path]:
    probe = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=repo_root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if probe.returncode == 0:
        result = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            return [repo_root / raw.decode("utf-8") for raw in result.stdout.split(b"\0") if raw]
    return list(repo_root.rglob("*"))


def validate(repo_root: Path) -> list[str]:
    errors: list[str] = []
    scanner = repo_root / NEW_REL

    require(scanner.is_dir(), f"missing canonical scanner directory: {NEW_REL}", errors)
    require(not (repo_root / OLD_REL).exists(), f"legacy scanner directory still exists: {OLD_REL}", errors)

    package_path = scanner / "package.json"
    if package_path.is_file():
        try:
            package = json.loads(read_text(package_path))
            require(
                package.get("name") == "@ehestifter/ats-discovery",
                "package.json name must be @ehestifter/ats-discovery",
                errors,
            )
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"cannot parse {package_path}: {exc}")
    else:
        errors.append(f"missing {package_path}")

    compose_path = scanner / "compose.yaml"
    if compose_path.is_file():
        compose = read_text(compose_path)
        require(
            re.search(r"(?m)^\s{2}ats-discovery:\s*$", compose) is not None,
            "compose.yaml must define service ats-discovery",
            errors,
        )
        require(
            "ehestifter/ats-discovery:local" in compose,
            "compose.yaml must use image ehestifter/ats-discovery:local",
            errors,
        )
        require(OLD_TOKEN not in compose, "compose.yaml still contains legacy product token", errors)
    else:
        errors.append(f"missing {compose_path}")

    scheduler_example = scanner / "config" / "scheduler.example.json"
    if scheduler_example.is_file():
        try:
            scheduler = json.loads(read_text(scheduler_example))
            service = scheduler.get("compose", {}).get("service")
            require(service == NEW_TOKEN, "scheduler.example.json compose.service must be ats-discovery", errors)
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"cannot parse {scheduler_example}: {exc}")
    else:
        errors.append(f"missing {scheduler_example}")

    found_on_new = False
    if scanner.is_dir():
        for path in text_files(scanner):
            try:
                text = read_text(path)
            except (OSError, UnicodeDecodeError):
                continue
            if OLD_TOKEN in text:
                errors.append(f"legacy product token remains in active scanner text: {path.relative_to(repo_root)}")
            if "foundOn" in text and NEW_TOKEN in text:
                found_on_new = True
        require(found_on_new, "no active scanner source/config contains foundOn with ats-discovery", errors)

    gitignore = repo_root / ".gitignore"
    if gitignore.is_file():
        text = read_text(gitignore)
        require(str(OLD_REL) not in text, ".gitignore still contains legacy scanner path", errors)
    else:
        errors.append("missing repository .gitignore")

    system_design = repo_root / "docs" / "system-design.md"
    if system_design.is_file():
        text = read_text(system_design)
        require("## 14. ATS Discovery" in text, "system-design.md lacks canonical ATS Discovery section", errors)
        require(str(NEW_REL) in text, "system-design.md lacks canonical scanner path", errors)
        require("scrapers are not active" not in text, "system-design.md still says scrapers are not active", errors)
        require("- production scrapers" not in text, "system-design.md still excludes production scrapers", errors)
    else:
        errors.append("missing docs/system-design.md")

    root_readme = repo_root / "README.md"
    if root_readme.is_file():
        text = read_text(root_readme)
        require("ATS Discovery" in text, "root README does not describe ATS Discovery", errors)
        require(str(NEW_REL) in text, "root README lacks canonical scanner path", errors)
    else:
        errors.append("missing root README.md")

    old_milestone = repo_root / "docs" / "milestone_ats_discovery.md"
    archive = repo_root / "docs" / "archive" / "milestones" / "ats-discovery.md"
    require(not old_milestone.exists(), "active ATS milestone file was not archived/removed", errors)
    if archive.is_file():
        archive_text = read_text(archive)
        require("**Status:** archived" in archive_text, "archived milestone is not marked archived", errors)
        require("Phase 9" in archive_text and "complete" in archive_text.lower(), "archived milestone lacks Phase 9 completion", errors)
    else:
        errors.append(f"missing archived milestone: {archive.relative_to(repo_root)}")

    bootstrap = scanner / "scripts" / "copy-upstream-providers.sh"
    if bootstrap.is_file():
        require(BOOTSTRAP_MARKER in read_text(bootstrap), "copy-upstream-providers.sh is not marked bootstrap-only", errors)
    else:
        errors.append(f"missing bootstrap helper: {bootstrap.relative_to(repo_root)}")

    expected_scheduler_files = [
        scanner / "ops" / "scheduler" / "ats_scheduler.py",
        scanner / "ops" / "systemd" / "install_systemd.py",
        scanner / "ops" / "systemd" / "ehestifter-ats-discovery.service.in",
        scanner / "ops" / "systemd" / "ehestifter-ats-discovery.timer",
    ]
    for path in expected_scheduler_files:
        require(path.is_file(), f"missing Phase 7 scheduler file: {path.relative_to(repo_root)}", errors)

    # Active references outside historical docs/package staging must use the canonical name.
    for path in sorted(active_repository_candidates(repo_root)):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(repo_root)
        if not relative.parts or relative.parts[0] in PACKAGE_ARTIFACT_NAMES | {".git"}:
            continue
        if len(relative.parts) >= 2 and relative.parts[0] == "docs" and relative.parts[1] == "archive":
            continue
        if relative.is_relative_to(NEW_REL):
            continue
        if relative == Path("tools/validate_ats_discovery_layout.py"):
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            if path.stat().st_size > 4 * 1024 * 1024:
                continue
            content = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        if OLD_TOKEN in content:
            errors.append(f"legacy product token remains in active repository text: {relative}")
        if OLD_TOKEN in path.name:
            errors.append(f"legacy product token remains in active repository path: {relative}")

    attribution_found = False
    if scanner.is_dir():
        for path in text_files(scanner):
            try:
                text = read_text(path)
            except (OSError, UnicodeDecodeError):
                continue
            if "santifer/career-ops" in text or "Career-Ops" in text:
                attribution_found = True
                break
    require(attribution_found, "Career-Ops source attribution is no longer discoverable", errors)

    return errors


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).expanduser().resolve()
    errors = validate(repo_root)
    if args.as_json:
        print(json.dumps({"ok": not errors, "errors": errors}, indent=2))
    elif errors:
        print("ATS Discovery layout validation failed:")
        for error in errors:
            print(f"- {error}")
    else:
        print("ATS Discovery layout validation passed.")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
