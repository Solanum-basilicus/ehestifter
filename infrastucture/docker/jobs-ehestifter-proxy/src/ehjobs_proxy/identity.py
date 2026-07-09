from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import parse_qs, urlparse


Confidence = Literal["high", "medium", "none"]


@dataclass(frozen=True)
class CanonicalIdentity:
    provider: str
    providerTenant: str
    externalId: str


@dataclass(frozen=True)
class IdentityResult:
    identity: CanonicalIdentity | None
    confidence: Confidence
    warnings: list[str]

    @property
    def ok(self) -> bool:
        return self.identity is not None


_GREENHOUSE_HOSTS = {"boards.greenhouse.io", "job-boards.greenhouse.io"}
_LEVER_HOST_SUFFIXES = ("jobs.lever.co", "jobs.eu.lever.co")
_ASHBY_HOST = "jobs.ashbyhq.com"
_SMARTRECRUITERS_HOSTS = {"jobs.smartrecruiters.com", "www.smartrecruiters.com"}


def parse_identity_from_url(url: str) -> IdentityResult:
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()
    path_parts = [part for part in parsed.path.split("/") if part]
    query = parse_qs(parsed.query)

    if host in _GREENHOUSE_HOSTS:
        return _parse_greenhouse(path_parts, query)

    if host.endswith(_LEVER_HOST_SUFFIXES):
        return _parse_lever(path_parts)

    if host == _ASHBY_HOST:
        return _parse_ashby(path_parts)

    if host.endswith(".myworkdayjobs.com"):
        return _parse_workday(host, path_parts)

    if host in _SMARTRECRUITERS_HOSTS:
        return _parse_smartrecruiters(path_parts)

    return IdentityResult(identity=None, confidence="none", warnings=["unsupported_provider_url"])


def _parse_greenhouse(path_parts: list[str], query: dict[str, list[str]]) -> IdentityResult:
    # Common form: /<tenant>/jobs/<job_id>
    if len(path_parts) >= 3 and path_parts[1] == "jobs":
        return IdentityResult(
            identity=CanonicalIdentity(
                provider="greenhouse",
                providerTenant=path_parts[0],
                externalId=path_parts[2],
            ),
            confidence="high",
            warnings=[],
        )

    # Embedded app form: /embed/job_app?for=<tenant>&token=<job_id>
    tenant = _first(query.get("for"))
    token = _first(query.get("token"))
    if tenant and token:
        return IdentityResult(
            identity=CanonicalIdentity(provider="greenhouse", providerTenant=tenant, externalId=token),
            confidence="high",
            warnings=[],
        )

    return IdentityResult(identity=None, confidence="none", warnings=["greenhouse_identity_not_found"])


def _parse_lever(path_parts: list[str]) -> IdentityResult:
    # Common form: /<tenant>/<job_id>
    if len(path_parts) >= 2:
        return IdentityResult(
            identity=CanonicalIdentity(provider="lever", providerTenant=path_parts[0], externalId=path_parts[1]),
            confidence="high",
            warnings=[],
        )
    return IdentityResult(identity=None, confidence="none", warnings=["lever_identity_not_found"])


def _parse_ashby(path_parts: list[str]) -> IdentityResult:
    # Common form: /<tenant>/<job_id-or-slug>
    if len(path_parts) >= 2:
        return IdentityResult(
            identity=CanonicalIdentity(provider="ashby", providerTenant=path_parts[0], externalId=path_parts[1]),
            confidence="high",
            warnings=[],
        )
    return IdentityResult(identity=None, confidence="none", warnings=["ashby_identity_not_found"])


def _parse_workday(host: str, path_parts: list[str]) -> IdentityResult:
    # Common host: <tenant>.wd1.myworkdayjobs.com or <tenant>.wd3.myworkdayjobs.com
    provider_tenant = host.split(".", 1)[0]
    if not path_parts:
        return IdentityResult(identity=None, confidence="none", warnings=["workday_identity_not_found"])

    last_part = path_parts[-1]
    # Common Workday detail URL ends with slug_JR12345 or slug_R-12345.
    match = re.search(r"_([A-Za-z]+[-_]?\d+[A-Za-z0-9_-]*)$", last_part)
    external_id = match.group(1) if match else last_part
    confidence: Confidence = "high" if match else "medium"
    warnings = [] if match else ["workday_external_id_inferred_from_last_path_segment"]

    return IdentityResult(
        identity=CanonicalIdentity(provider="workday", providerTenant=provider_tenant, externalId=external_id),
        confidence=confidence,
        warnings=warnings,
    )


def _parse_smartrecruiters(path_parts: list[str]) -> IdentityResult:
    # Common form: /<tenant>/<external_id>-<slug>
    if len(path_parts) >= 2:
        external_id = path_parts[1].split("-", 1)[0]
        return IdentityResult(
            identity=CanonicalIdentity(provider="smartrecruiters", providerTenant=path_parts[0], externalId=external_id),
            confidence="medium",
            warnings=["smartrecruiters_external_id_inferred_from_slug_prefix"],
        )
    return IdentityResult(identity=None, confidence="none", warnings=["smartrecruiters_identity_not_found"])


def _first(values: list[str] | None) -> str | None:
    if not values:
        return None
    value = values[0].strip()
    return value or None
