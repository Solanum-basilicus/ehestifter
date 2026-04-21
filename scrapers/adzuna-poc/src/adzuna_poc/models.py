from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class QuerySpec:
    country: str
    what: str
    hours: int
    max_pages: int
    results_per_page: int
    sort_by: str = "date"


@dataclass
class FetchCounts:
    raw: int = 0
    within_window: int = 0
    title_matched: int = 0
    included: int = 0


@dataclass
class CanonicalIdentity:
    provider: str
    provider_tenant: str
    external_id: str


@dataclass
class FilterFlags:
    within_window: bool
    title_matched: bool
    germany_relevant: bool
    remote_hint: bool
    included: bool


@dataclass
class NormalizedJob:
    adzuna_id: str | None
    adzuna_redirect_url: str | None
    origin_url: str | None
    canonical_identity: CanonicalIdentity | None
    title: str
    posting_company_name: str | None
    hiring_company_name: str | None
    description: str | None
    remote_type: str
    locations: list[dict[str, str | None]]
    created_at_provider_utc: str | None
    filters: FilterFlags
    diagnostics: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class PocOutput:
    fetched_at_utc: datetime
    query: QuerySpec
    counts: FetchCounts
    jobs: list[NormalizedJob]
