from __future__ import annotations

import json
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any

from .adzuna_client import AdzunaClient
from .canonical_identity import canonical_identity_from_url
from .normalize import normalize_adzuna_job
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
    """
    Returns the final printable PoC output string.

    Default resolve_index=2 means:
    - after filtering to included jobs,
    - pick the third job in that list,
    - resolve its origin URL and fuller description.
    """
    client = AdzunaClient(app_id=app_id, app_key=app_key)

    fetched_at = _utc_now()
    cutoff = fetched_at - timedelta(hours=hours)

    raw_total = 0
    within_window_total = 0
    title_matched_total = 0
    included_total = 0

    jobs: list[dict[str, Any]] = []

    for page in range(1, max_pages + 1):
        response = client.search_jobs(
            country=country,
            page=page,
            what=query,
            results_per_page=results_per_page,
        )

        results = response.get("results", [])
        raw_total += len(results)

        for raw_job in results:
            normalized = normalize_adzuna_job(raw_job=raw_job, cutoff_utc=cutoff)

            if normalized["filters"]["within_window"]:
                within_window_total += 1
            if normalized["filters"]["title_matched"]:
                title_matched_total += 1
            if normalized["filters"]["included"]:
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
        redirect_url = picked.get("adzunaRedirectUrl")

        resolved_payload = {
            "pickedIncludedJobIndex": resolve_index,
            "pickedAdzunaId": picked.get("adzunaId"),
            "pickedTitle": picked.get("title"),
            "resolutionAttempted": bool(redirect_url),
        }

        if redirect_url:
            resolution = resolve_from_adzuna_redirect(
                redirect_url,
                headless=headless,
                wait_ms=resolve_wait_ms,
            )

            canonical_identity = (
                canonical_identity_from_url(resolution.final_url)
                if resolution.final_url
                else None
            )

            resolved_payload.update(
                {
                    "adzunaRedirectUrl": redirect_url,
                    "originUrl": resolution.final_url,
                    "canonicalIdentity": canonical_identity,
                    "fullDescription": resolution.description_text,
                    "resolvedPageTitle": resolution.final_title,
                    "diagnostics": resolution.diagnostics,
                    "raw": resolution.raw,
                }
            )
        else:
            resolved_payload["diagnostics"] = ["picked job has no Adzuna redirect URL"]

    return _render_output(main_payload, resolved_payload)