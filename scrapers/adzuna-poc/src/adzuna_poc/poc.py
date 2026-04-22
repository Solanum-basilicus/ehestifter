from __future__ import annotations

import json
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

from .adzuna_client import AdzunaClient
from .canonical_identity import identity_to_dict, parse_canonical_identity
from .config import load_settings
from .models import QuerySpec
from .normalize import normalize_job
from .resolve import resolve_from_adzuna_redirect


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    return str(value)


def _render_output(main_payload: dict[str, Any], resolved_payload: dict[str, Any] | None) -> str:
    base = json.dumps(main_payload, indent=2, ensure_ascii=False, default=_json_default)
    if not resolved_payload:
        return base
    resolved = json.dumps(resolved_payload, indent=2, ensure_ascii=False, default=_json_default)
    return f"{base}\n\n----- RESOLVED JOB -----\n\n{resolved}\n"


def run_poc(
    *,
    app_id: str,
    app_key: str,
    country: str = "de",
    query: str = "project manager",
    hours: int = 24,
    max_pages: int = 3,
    results_per_page: int = 50,
    resolve_index: int | None = 2,
    resolve_wait_ms: int = 15_000,
    headless: bool = True,
) -> str:
    # load_settings already reads env vars; app_id/app_key are validated by CLI
    settings = load_settings()
    client = AdzunaClient(settings)

    fetched_at = _utc_now()
    spec = QuerySpec(
        country=country,
        what=query,
        hours=hours,
        max_pages=max_pages,
        results_per_page=results_per_page,
    )

    raw_total = 0
    within_window_total = 0
    title_matched_total = 0
    included_total = 0

    jobs: list[dict[str, Any]] = []

    for page in range(1, max_pages + 1):
        response = client.search_page(spec, page)
        results = response.get("results", [])
        raw_total += len(results)

        for raw_job in results:
            normalized_obj = normalize_job(
                raw_job,
                fetched_at_utc=fetched_at,
                hours=hours,
                country=country,
            )
            normalized = asdict(normalized_obj)

            filters = normalized.get("filters", {})
            if filters.get("within_window"):
                within_window_total += 1
            if filters.get("title_matched"):
                title_matched_total += 1
            if filters.get("included"):
                included_total += 1
                jobs.append(normalized)

    main_payload = {
        "fetchedAtUtc": fetched_at,
        "query": {
            "country": country,
            "what": query,
            "hours": hours,
            "maxPages": max_pages,
            "resultsPerPage": results_per_page,
        },
        "counts": {
            "raw": raw_total,
            "within_window": within_window_total,
            "title_matched": title_matched_total,
            "included": included_total,
        },
        "jobs": jobs,
    }

    resolved_payload: dict[str, Any] | None = None

    if resolve_index is not None and 0 <= resolve_index < len(jobs):
        picked = jobs[resolve_index]
        redirect_url = picked.get("adzuna_redirect_url")

        resolved_payload = {
            "pickedIncludedJobIndex": resolve_index,
            "pickedAdzunaId": picked.get("adzuna_id"),
            "pickedTitle": picked.get("title"),
            "resolutionAttempted": bool(redirect_url),
        }

        if redirect_url:
            resolution = resolve_from_adzuna_redirect(
                redirect_url,
                headless=headless,
                wait_ms=resolve_wait_ms,
            )

            canonical_identity = None
            canonical_identity_diagnostics: list[str] = []
            if resolution.final_url:
                canonical_identity, canonical_identity_diagnostics = parse_canonical_identity(
                    resolution.final_url
                )

            resolved_payload.update(
                {
                    "adzunaRedirectUrl": redirect_url,
                    "originUrl": resolution.final_url,
                    "canonicalIdentity": identity_to_dict(canonical_identity),
                    "fullDescription": resolution.description_text,
                    "resolvedPageTitle": resolution.final_title,
                    "diagnostics": resolution.diagnostics + canonical_identity_diagnostics,
                    "raw": resolution.raw,
                }
            )
        else:
            resolved_payload["diagnostics"] = ["picked job has no Adzuna redirect URL"]

    return _render_output(main_payload, resolved_payload)