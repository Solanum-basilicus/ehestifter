#!/usr/bin/env python3
"""Refresh ATS Discovery's Web Core geography snapshot inside Docker."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys

IMAGE = "ehestifter/ats-discovery:geo-tools"
SOURCE = "backend/core/static/data/geo.sample8.json"
OUTPUT = "scrapers/ats-discovery/src/locations/data/web-geo.generated.json"
MANIFEST = "scrapers/ats-discovery/src/locations/data/web-geo.generated.manifest.json"
GENERATOR = "scrapers/ats-discovery/scripts/refresh-web-geo-snapshot.mjs"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--no-build", action="store_true")
    return parser.parse_args()


def run(command: list[str], *, cwd: Path) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).expanduser().resolve()
    required = [repo_root / SOURCE, repo_root / GENERATOR]
    missing = [str(path.relative_to(repo_root)) for path in required if not path.is_file()]
    if missing:
        print("Cannot refresh ATS geography snapshot; missing full-checkout files:", file=sys.stderr)
        for item in missing:
            print(f"- {item}", file=sys.stderr)
        return 2

    output_path = repo_root / OUTPUT
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not args.no_build:
        run([
            "docker", "build",
            "--tag", IMAGE,
            "--file", "scrapers/ats-discovery/Dockerfile",
            "scrapers/ats-discovery",
        ], cwd=repo_root)

    source_path = repo_root / SOURCE
    output_dir = output_path.parent
    security_options = []
    if Path("/sys/fs/selinux/enforce").is_file():
        security_options = ["--security-opt", "label=disable"]

    command = [
        "docker", "run", "--rm",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "--read-only",
        "--tmpfs", "/tmp:size=64m",
        *security_options,
        "--mount", (
            f"type=bind,src={source_path},dst=/input/geo.sample8.json,readonly"
        ),
        "--mount", f"type=bind,src={output_dir},dst=/output",
        "--entrypoint", "node",
        IMAGE,
        "/app/scripts/refresh-web-geo-snapshot.mjs",
        "--source", "/input/geo.sample8.json",
        "--output", "/output/web-geo.generated.json",
        "--manifest", "/output/web-geo.generated.manifest.json",
    ]
    if args.check:
        command.append("--check")
    run(command, cwd=repo_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
