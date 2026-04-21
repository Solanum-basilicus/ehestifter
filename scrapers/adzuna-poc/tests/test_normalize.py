from datetime import datetime, timezone

from adzuna_poc.normalize import normalize_job


def test_normalize_job_included_for_recent_project_manager_in_germany() -> None:
    raw_job = {
        "id": "1",
        "title": "Project Manager Digital Transformation",
        "description": "Hybrid role with home office in Berlin, Germany.",
        "created": "2026-04-20T12:00:00Z",
        "redirect_url": "https://www.adzuna.de/jobs/land/ad/123?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F987654",
        "company": {"display_name": "Acme GmbH"},
        "location": {
            "display_name": "Berlin",
            "area": ["Germany", "Berlin", "Berlin"],
        },
        "category": {"label": "IT Jobs"},
    }

    normalized = normalize_job(
        raw_job,
        fetched_at_utc=datetime(2026, 4, 21, 0, 0, tzinfo=timezone.utc),
        hours=24,
        country="de",
    )

    assert normalized.filters.within_window is True
    assert normalized.filters.title_matched is True
    assert normalized.filters.germany_relevant is True
    assert normalized.filters.included is True
    assert normalized.remote_type == "hybrid"
    assert normalized.canonical_identity is not None
    assert normalized.canonical_identity.provider == "greenhouse"
