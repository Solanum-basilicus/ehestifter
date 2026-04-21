from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

from .adzuna_client import AdzunaClient
from .models import FetchCounts, PocOutput, QuerySpec
from .normalize import normalize_job


class PocRunner:
    def __init__(self, client: AdzunaClient):
        self._client = client

    def run(self, spec: QuerySpec) -> dict[str, Any]:
        fetched_at = datetime.now(timezone.utc)
        counts = FetchCounts()
        normalized_jobs = []

        for page in range(1, spec.max_pages + 1):
            payload = self._client.search_page(spec, page)
            results = payload.get("results") or []
            if not isinstance(results, list):
                raise ValueError(f"Expected 'results' list in Adzuna response for page {page}")
            if not results:
                break

            for raw_job in results:
                if not isinstance(raw_job, dict):
                    continue
                counts.raw += 1
                normalized = normalize_job(
                    raw_job,
                    fetched_at_utc=fetched_at,
                    hours=spec.hours,
                    country=spec.country,
                )
                if normalized.filters.within_window:
                    counts.within_window += 1
                if normalized.filters.title_matched:
                    counts.title_matched += 1
                if normalized.filters.included:
                    counts.included += 1
                    normalized_jobs.append(normalized)

        normalized_jobs.sort(
            key=lambda job: (
                job.created_at_provider_utc or "",
                job.title.lower(),
                job.origin_url or job.adzuna_redirect_url or "",
            ),
            reverse=True,
        )

        output = PocOutput(
            fetched_at_utc=fetched_at,
            query=spec,
            counts=counts,
            jobs=normalized_jobs,
        )
        return _serialize_output(output)


def _serialize_output(output: PocOutput) -> dict[str, Any]:
    return {
        "fetchedAtUtc": output.fetched_at_utc.isoformat().replace("+00:00", "Z"),
        "query": asdict(output.query),
        "counts": asdict(output.counts),
        "jobs": [
            {
                "adzunaId": job.adzuna_id,
                "adzunaRedirectUrl": job.adzuna_redirect_url,
                "originUrl": job.origin_url,
                "canonicalIdentity": asdict(job.canonical_identity) if job.canonical_identity else None,
                "title": job.title,
                "postingCompanyName": job.posting_company_name,
                "hiringCompanyName": job.hiring_company_name,
                "description": job.description,
                "remoteType": job.remote_type,
                "locations": job.locations,
                "createdAtProviderUtc": job.created_at_provider_utc,
                "filters": asdict(job.filters),
                "diagnostics": job.diagnostics,
                "raw": job.raw,
            }
            for job in output.jobs
        ],
    }
