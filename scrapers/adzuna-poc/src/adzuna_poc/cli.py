from __future__ import annotations

import argparse
import json
import sys

from .adzuna_client import AdzunaClient
from .config import ConfigurationError, load_settings
from .models import QuerySpec
from .poc import PocRunner



def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the local Adzuna Phase 1 PoC")
    parser.add_argument("--country", default="de", help="Adzuna country code, default: de")
    parser.add_argument("--query", default="project manager", help="Adzuna 'what' query")
    parser.add_argument("--hours", type=int, default=24, help="Only keep jobs newer than N hours")
    parser.add_argument("--max-pages", type=int, default=3, help="Maximum number of Adzuna pages to fetch")
    parser.add_argument("--results-per-page", type=int, default=50, help="Adzuna results_per_page")
    parser.add_argument(
        "--output",
        choices=("json",),
        default="json",
        help="Output format. Only json is implemented in Phase 1.",
    )
    return parser



def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        settings = load_settings()
        client = AdzunaClient(settings)
        runner = PocRunner(client)
        spec = QuerySpec(
            country=args.country,
            what=args.query,
            hours=args.hours,
            max_pages=args.max_pages,
            results_per_page=args.results_per_page,
        )
        payload = runner.run(spec)
    except ConfigurationError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI should show operator-friendly failure.
        print(f"PoC failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0
