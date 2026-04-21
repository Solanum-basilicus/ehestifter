from __future__ import annotations

import argparse
import os
import sys

from .poc import run_poc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Adzuna local PoC")
    parser.add_argument("--country", default="de")
    parser.add_argument("--query", default="project manager")
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--max-pages", type=int, default=3)
    parser.add_argument("--results-per-page", type=int, default=50)

    parser.add_argument(
        "--resolve-index",
        type=int,
        default=2,
        help="0-based index within the filtered included jobs list to resolve. Default: 2 (third job). Use -1 to disable.",
    )
    parser.add_argument(
        "--resolve-wait-ms",
        type=int,
        default=15000,
        help="How long to wait for browser-side redirection to the origin page.",
    )
    parser.add_argument(
        "--show-browser",
        action="store_true",
        help="Run Playwright browser in headed mode for debugging.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    app_id = os.getenv("ADZUNA_APP_ID")
    app_key = os.getenv("ADZUNA_APP_KEY")

    if not app_id or not app_key:
        print("ADZUNA_APP_ID and ADZUNA_APP_KEY must be set.", file=sys.stderr)
        return 2

    resolve_index = None if args.resolve_index < 0 else args.resolve_index

    output = run_poc(
        app_id=app_id,
        app_key=app_key,
        country=args.country,
        query=args.query,
        hours=args.hours,
        max_pages=args.max_pages,
        results_per_page=args.results_per_page,
        resolve_index=resolve_index,
        resolve_wait_ms=args.resolve_wait_ms,
        headless=not args.show_browser,
    )
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())