from __future__ import annotations

import re
from dataclasses import asdict
from typing import Callable
from urllib.parse import parse_qs, unquote, urlparse

from .models import CanonicalIdentity


Rule = Callable[[str], CanonicalIdentity | None]


_GREENHOUSE_JOB_RE = re.compile(r"/jobs/(?P<job_id>\d+)")
_LEVER_JOB_RE = re.compile(r"/(?P<slug>[^/?#]+)/(?P<job_id>[a-f0-9]{8,})", re.IGNORECASE)
_JOIN_JOB_RE = re.compile(r"/companies/(?P<tenant>[^/]+)/jobs/(?P<job_id>[^/?#]+)", re.IGNORECASE)
_WORKDAY_JOB_RE = re.compile(r"/job/(?P<tenant>[^/]+)/(?P<tail>[^?#]+)", re.IGNORECASE)
_ASHBY_JOB_RE = re.compile(r"/(?P<tenant>[^/]+)/jobs/(?P<job_id>[a-zA-Z0-9-]+)", re.IGNORECASE)
_SMARTR_JOB_RE = re.compile(r"/jobs/(?P<tenant>[^/]+)/(?P<job_id>[^/?#]+)", re.IGNORECASE)
_PERSONIO_JOB_RE = re.compile(r"/job/(?P<job_id>[^/?#]+)", re.IGNORECASE)
_RECRUITEE_JOB_RE = re.compile(r"/o/(?P<job_id>[^/?#]+)", re.IGNORECASE)


def parse_canonical_identity(origin_url: str | None) -> tuple[CanonicalIdentity | None, list[str]]:
    diagnostics: list[str] = []
    if not origin_url:
        diagnostics.append("missing origin URL")
        return None, diagnostics

    parsed = urlparse(origin_url)
    host = (parsed.hostname or "").lower()
    if not host:
        diagnostics.append("origin URL has no hostname")
        return None, diagnostics

    rules: list[Rule] = [
        _greenhouse,
        _lever,
        _join,
        _workday,
        _ashby,
        _smartrecruiters,
        _personio,
        _recruitee,
        _corporate_site,
    ]
    for rule in rules:
        identity = rule(origin_url)
        if identity is not None:
            return identity, diagnostics

    diagnostics.append(f"no parser matched host {host}")
    return None, diagnostics


def identity_to_dict(identity: CanonicalIdentity | None) -> dict[str, str] | None:
    return asdict(identity) if identity else None


def recover_origin_url(redirect_url: str | None) -> tuple[str | None, list[str]]:
    diagnostics: list[str] = []
    if not redirect_url:
        diagnostics.append("missing redirect URL")
        return None, diagnostics

    parsed = urlparse(redirect_url)
    query = parse_qs(parsed.query)
    candidates = []
    for key in ("url", "redirect_url", "redirectUrl", "dest", "destination", "r"):
        candidates.extend(query.get(key, []))

    for candidate in candidates:
        value = unquote(candidate).strip()
        if value.startswith("http://") or value.startswith("https://"):
            return value, diagnostics

    diagnostics.append("could not recover origin URL from Adzuna redirect query params")
    return None, diagnostics


def _greenhouse(url: str) -> CanonicalIdentity | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "greenhouse.io" not in host:
        return None
    match = _GREENHOUSE_JOB_RE.search(parsed.path)
    if not match:
        return None
    tenant = parsed.path.strip("/").split("/")[0] if parsed.path.strip("/") else host.split(".")[0]
    return CanonicalIdentity("greenhouse", tenant.lower(), match.group("job_id"))


def _lever(url: str) -> CanonicalIdentity | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "jobs.lever.co" not in host and not host.endswith(".lever.co"):
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        return None
    tenant = parts[0].lower()
    match = _LEVER_JOB_RE.search(parsed.path)
    if not match:
        job_id = parts[-1]
    else:
        job_id = match.group("job_id")
    return CanonicalIdentity("lever", tenant, job_id)


def _join(url: str) -> CanonicalIdentity | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "join.com" not in host:
        return None
    match = _JOIN_JOB_RE.search(parsed.path)
    if not match:
        return None
    return CanonicalIdentity("join", match.group("tenant").lower(), match.group("job_id"))


def _workday(url: str) -> CanonicalIdentity | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "workday" not in host:
        return None
    match = _WORKDAY_JOB_RE.search(parsed.path)
    if not match:
        return None
    tail = match.group("tail").strip("/")
    external_id = tail.split("/")[-1]
    return CanonicalIdentity("workday", match.group("tenant").lower(), external_id)


def _ashby(url: str) -> CanonicalIdentity | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "ashbyhq.com" not in host:
        return None
    match = _ASHBY_JOB_RE.search(parsed.path)
    if not match:
        return None
    return CanonicalIdentity("ashby", match.group("tenant").lower(), match.group("job_id"))


def _smartrecruiters(url: str) -> CanonicalIdentity | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "smartrecruiters.com" not in host:
        return None
    match = _SMARTR_JOB_RE.search(parsed.path)
    if not match:
        return None
    return CanonicalIdentity("smartrecruiters", match.group("tenant").lower(), match.group("job_id"))


def _personio(url: str) -> CanonicalIdentity | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "personio" not in host:
        return None
    match = _PERSONIO_JOB_RE.search(parsed.path)
    if not match:
        return None
    tenant = host.split(".")[0]
    return CanonicalIdentity("personio", tenant.lower(), match.group("job_id"))


def _recruitee(url: str) -> CanonicalIdentity | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "recruitee.com" not in host:
        return None
    match = _RECRUITEE_JOB_RE.search(parsed.path)
    if not match:
        return None
    tenant = host.split(".")[0]
    return CanonicalIdentity("recruitee", tenant.lower(), match.group("job_id"))


def _corporate_site(url: str) -> CanonicalIdentity | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host:
        return None
    path = parsed.path.rstrip("/") or "/"
    if path == "/":
        return None
    external_id = re.sub(r"[^a-zA-Z0-9_-]+", "-", path.strip("/")).strip("-").lower()
    if not external_id:
        return None
    tenant = host.removeprefix("www.")
    return CanonicalIdentity("corporate-site", tenant, external_id)
