from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .canonical_identity import identity_to_dict, parse_canonical_identity, recover_origin_url
from .models import FilterFlags, NormalizedJob

REMOTE_MARKERS = (
    "remote",
    "work from home",
    "wfh",
    "home office",
    "hybrid",
)

HYBRID_MARKERS = ("hybrid",)
GERMANY_MARKERS = (
    "germany",
    "deutschland",
    "berlin",
    "hamburg",
    "munich",
    "münchen",
    "frankfurt",
    "cologne",
    "köln",
    "stuttgart",
    "düsseldorf",
)

NON_GERMANY_MARKERS = (
    "united kingdom",
    "london",
    "paris",
    "netherlands",
    "amsterdam",
    "spain",
    "madrid",
    "united states",
    "new york",
)


def normalize_job(raw_job: dict[str, Any], *, fetched_at_utc: datetime, hours: int, country: str) -> NormalizedJob:
    diagnostics: list[str] = []

    title = _clean_text(raw_job.get("title")) or ""
    description = _clean_text(raw_job.get("description"))
    company_name = _clean_text(((raw_job.get("company") or {}).get("display_name")))
    redirect_url = _clean_text(raw_job.get("redirect_url"))

    origin_url, origin_diagnostics = recover_origin_url(redirect_url)
    diagnostics.extend(origin_diagnostics)

    canonical_identity, identity_diagnostics = parse_canonical_identity(origin_url)
    diagnostics.extend(identity_diagnostics)

    created_at_raw = _clean_text(raw_job.get("created"))
    created_at = _parse_datetime(created_at_raw)
    within_window = created_at is not None and created_at >= fetched_at_utc - timedelta(hours=hours)
    if created_at is None:
        diagnostics.append("missing or invalid created timestamp")

    title_matched = "project manager" in title.lower()

    location = raw_job.get("location") or {}
    display_name = _clean_text(location.get("display_name"))
    area = [str(x).strip() for x in (location.get("area") or []) if str(x).strip()]

    location_blob = " | ".join([display_name or "", *area]).lower()
    search_blob = " ".join(filter(None, [title.lower(), (description or "").lower(), location_blob]))

    remote_hint = any(marker in search_blob for marker in REMOTE_MARKERS)
    germany_marker = (country.lower() == "de") or any(marker in search_blob for marker in GERMANY_MARKERS)
    non_germany_marker = any(marker in search_blob for marker in NON_GERMANY_MARKERS)
    germany_relevant = germany_marker or (remote_hint and not non_germany_marker)

    remote_type = "hybrid" if any(marker in search_blob for marker in HYBRID_MARKERS) else ("remote" if remote_hint else "unknown")

    if not company_name:
        diagnostics.append("missing company display_name")
    if not description:
        diagnostics.append("missing or empty description snippet")

    locations = [_normalize_location(country=country, display_name=display_name, area=area)]

    filters = FilterFlags(
        within_window=within_window,
        title_matched=title_matched,
        germany_relevant=germany_relevant,
        remote_hint=remote_hint,
        included=within_window and title_matched and germany_relevant,
    )

    return NormalizedJob(
        adzuna_id=_clean_text(raw_job.get("id")),
        adzuna_redirect_url=redirect_url,
        origin_url=origin_url,
        canonical_identity=canonical_identity,
        title=title,
        posting_company_name=company_name,
        hiring_company_name=None if company_name else "Unknown",
        description=description,
        remote_type=remote_type,
        locations=locations,
        created_at_provider_utc=created_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if created_at else None,
        filters=filters,
        diagnostics=diagnostics,
        raw={
            "adzunaLocationDisplayName": display_name,
            "adzunaLocationArea": area,
            "adzunaCategory": (raw_job.get("category") or {}).get("label"),
            "adzunaCompanyDisplayName": company_name,
            "canonicalIdentity": identity_to_dict(canonical_identity),
        },
    )


def _normalize_location(*, country: str, display_name: str | None, area: list[str]) -> dict[str, str | None]:
    region = area[1] if len(area) > 1 else None
    city = area[-1] if area else None
    country_name = {"de": "Germany"}.get(country.lower(), country.upper())
    return {
        "country": country_name,
        "region": region,
        "city": city,
        "displayText": display_name or city or region or country_name,
    }


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text if text else None


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        return datetime.fromisoformat(value)
    except ValueError:
        return None
