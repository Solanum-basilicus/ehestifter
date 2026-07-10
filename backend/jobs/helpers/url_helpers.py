# helpers/url_helpers.py
from urllib.parse import parse_qs, urlparse
import hashlib
import re

MULTI_LEVEL_TLDS = {
    "co.uk", "com.au", "com.br", "co.nz", "com.sg", "com.tr", "com.mx",
    "co.jp", "co.kr", "com.cn", "com.hk", "com.tw", "com.pl",
}

GENERIC_JOB_LABELS = {
    "job", "jobs", "career", "careers",
    "karriere", "stellen", "stellenangebote", "arbeit",
    "emploi", "carriere", "carrieres",
    "praca", "kariera", "oferty", "ofertapracy", "ofertypracy", "oferta",
}

GENERIC_PATH_SEGMENTS = {
    "job", "jobs", "position", "positions", "career", "careers",
    "vacancy", "vacancies", "listing", "listings", "apply",
}

REFERRAL_KEYS = ["source", "src", "utm_source", "ref", "referrer"]

BOARD_DOMAINS = {
    "linkedin.com": "linkedin",
    "indeed.com": "indeed",
    "indeed.co.uk": "indeed",
    "indeed.de": "indeed",
    "indeed.fr": "indeed",
    "indeed.nl": "indeed",
    "indeed.es": "indeed",
    "indeed.it": "indeed",
    "indeed.ie": "indeed",
    "indeed.ca": "indeed",
    "stepstone.de": "stepstone",
    "stepstone.fr": "stepstone",
    "stepstone.nl": "stepstone",
    "stepstone.co.uk": "stepstone",
    "stepstone.com": "stepstone",
    "xing.com": "xing",
    "glassdoor.com": "glassdoor",
    "glassdoor.de": "glassdoor",
    "glassdoor.co.uk": "glassdoor",
    "glassdoor.fr": "glassdoor",
    "monster.com": "monster",
    "monster.de": "monster",
    "monster.co.uk": "monster",
    "monster.fr": "monster",
    "monster.it": "monster",
    "weworkremotely.com": "weworkremotely",
    "dynamitejobs.com": "dynamitejobs",
    "remotive.com": "remotive",
    "ziprecruiter.com": "ziprecruiter",
    "reed.co.uk": "reed",
    "totaljobs.com": "totaljobs",
    "totaljobs.com.au": "totaljobs",
    "cwjobs.co.uk": "totaljobs",
    "cv-library.co.uk": "cv-library",
    "nofluffjobs.com": "nofluffjobs",
    "pracuj.pl": "pracuj",
    "wellfound.com": "wellfound",
    "angel.co": "wellfound",
}

TALENT_AGENCY_DOMAINS = {
    "adecco.com",
    "randstad.com",
    "manpowergroup.com",
    "hays.com",
    "tietalent.com",
    "aerotek.com",
    "pagepersonnel.com",
    "michaelpage.com",
    "robertwalters.com",
    "kornferry.com",
    "reedglobal.com",
    "alfredtalke.com",
}


def _host_no_www(host: str) -> str:
    return (host or "").lower().strip(".").removeprefix("www.")


def _host_matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def _path_parts(path: str) -> list[str]:
    return [p for p in (path or "").split("/") if p]


def _last_path_segment(path: str) -> str:
    parts = _path_parts(path)
    return parts[-1] if parts else ""


def _first_after(path: str, token: str) -> str:
    parts = _path_parts(path)
    token = token.lower()
    for i, part in enumerate(parts):
        if part.lower() == token and i + 1 < len(parts):
            return parts[i + 1]
    return ""


def _looks_alnum_id(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9._-]{6,}", value or ""))


def _looks_numeric_id(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9]{6,}", value or ""))


def _is_generic_path_segment(value: str) -> bool:
    return (value or "").lower() in GENERIC_PATH_SEGMENTS or (value or "").lower() in GENERIC_JOB_LABELS


def _url_without_query(u) -> str:
    host = _host_no_www(u.hostname or "")
    return f"{u.scheme.lower()}://{host}{u.path or ''}"


def _hash_external_id(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


def _fallback_external_id(u) -> str:
    return _hash_external_id(_url_without_query(u))


def _base_labels(host: str) -> list[str]:
    host = _host_no_www(host)
    parts = host.split(".")
    if len(parts) <= 2:
        return parts
    return parts


def _public_suffix_len(host: str) -> int:
    parts = _host_no_www(host).split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in MULTI_LEVEL_TLDS:
        return 2
    return 1


def _company_from_host(host: str) -> str:
    host = _host_no_www(host)
    parts = host.split(".")
    if len(parts) < 2:
        return parts[0] if parts else host

    suffix_len = _public_suffix_len(host)
    stop = len(parts) - suffix_len - 1
    for i in range(stop, -1, -1):
        label = parts[i]
        if label and label not in GENERIC_JOB_LABELS:
            return label

    return parts[stop] if stop >= 0 else parts[0]


def _provider_from_host(host: str) -> str:
    host = _host_no_www(host)
    parts = host.split(".")
    if not parts or not parts[0]:
        return "corporate-site"
    if len(parts) == 1:
        return parts[0]

    suffix_len = _public_suffix_len(host)
    cutoff = len(parts) - suffix_len
    pre = parts[:cutoff]
    if not pre:
        return parts[0]

    candidate = pre[0]
    if candidate in GENERIC_JOB_LABELS and len(pre) > 1:
        candidate = pre[1]
    return candidate or parts[0]


def _normalize_source_name(value: str) -> str:
    source = (value or "").strip().lower()
    if source.startswith("http://") or source.startswith("https://"):
        try:
            source = urlparse(source).hostname or source
        except Exception:
            pass

    source = _host_no_www(source)
    if "." in source:
        source = source.split(".")[0]

    aliases = {
        "li": "linkedin",
        "lnkd": "linkedin",
        "angellist": "wellfound",
        "angel": "wellfound",
        "angelco": "wellfound",
        "stackoverflowjobs": "stackoverflow",
        "stack-overflow": "stackoverflow",
        "wwr": "weworkremotely",
        "cvlibrary": "cv-library",
    }
    return aliases.get(source, source)


def _found_on_from_params(u) -> str | None:
    qs = parse_qs(u.query or "")
    for key in REFERRAL_KEYS:
        if key in qs and qs[key]:
            found = _normalize_source_name(qs[key][0])
            if found:
                return found
    return None


def _posting_company_from_agency_host(host: str) -> str | None:
    for domain in TALENT_AGENCY_DOMAINS:
        if _host_matches(host, domain):
            return domain.split(".")[0]
    return None


def _result(
    *,
    provider: str,
    provider_tenant: str,
    external_id: str,
    found_on: str,
    hiring_company_name: str | None,
    posting_company_name: str | None = None,
) -> dict:
    return {
        "provider": provider,
        "providerTenant": provider_tenant or "",
        "externalId": external_id,
        "foundOn": found_on,
        "hiringCompanyName": hiring_company_name,
        "postingCompanyName": posting_company_name,
    }


def deduce_from_url(raw_url: str) -> dict:
    """
    Best-effort canonical identity for a job URL.

    Jobs domain is the authority for canonical identity. Browser/core/proxy code
    should call Jobs /jobs/exists?url=... instead of duplicating these rules.
    """
    try:
        u = urlparse(raw_url)
    except Exception:
        return {}

    host = _host_no_www(u.hostname or "")
    if not host:
        return {}

    path = u.path or ""
    found_on = _found_on_from_params(u)
    posting_company_name = _posting_company_from_agency_host(host)

    def ats_found_on() -> str:
        return found_on or "corporate-site"

    # Ashby:
    # jobs.ashbyhq.com/{tenant}/{externalId}
    # {tenant}.ashbyhq.com/{externalId}
    if _host_matches(host, "ashbyhq.com"):
        parts = _path_parts(path)
        host_tenant = host.split(".")[0]
        if host_tenant == "jobs" and len(parts) >= 2:
            tenant = parts[0]
            external_id = parts[1]
        else:
            tenant = host_tenant if host_tenant != "ashbyhq" else ""
            external_id = parts[-1] if parts else _fallback_external_id(u)

        return _result(
            provider="ashby",
            provider_tenant=tenant,
            external_id=external_id or _fallback_external_id(u),
            found_on=ats_found_on(),
            hiring_company_name=tenant or None,
            posting_company_name=posting_company_name,
        )

    # Greenhouse:
    # boards.greenhouse.io/{tenant}/jobs/{id}
    # job-boards.greenhouse.io/{tenant}/jobs/{id}
    # greenhouse.io/jobs/{id}
    if _host_matches(host, "greenhouse.io"):
        tenant = _first_after(path, "boards") or ""
        if not tenant:
            parts = _path_parts(path)
            if parts and parts[0].lower() not in {"jobs", "job", "embed"}:
                tenant = parts[0]
        external_id = _first_after(path, "jobs") or _last_path_segment(path) or _fallback_external_id(u)

        # Greenhouse embed shape: /embed/job_app?for=tenant&token=id
        qs = parse_qs(u.query or "")
        if "token" in qs and qs["token"]:
            external_id = qs["token"][0]
        if "for" in qs and qs["for"]:
            tenant = qs["for"][0]

        return _result(
            provider="greenhouse",
            provider_tenant=tenant,
            external_id=external_id,
            found_on=ats_found_on(),
            hiring_company_name=tenant or None,
            posting_company_name=posting_company_name,
        )

    # Lever:
    # jobs.lever.co/{tenant}/{externalId}
    # jobs.eu.lever.co/{tenant}/{externalId}
    # {tenant}.lever.co/{externalId}
    if _host_matches(host, "lever.co"):
        parts = _path_parts(path)
        host_prefix = host.removesuffix(".lever.co").strip(".")
        host_bits = [p for p in host_prefix.split(".") if p]
        if host_bits and host_bits[0] == "jobs":
            tenant = parts[0] if parts else ""
            external_id = parts[1] if len(parts) >= 2 else _fallback_external_id(u)
        else:
            tenant = host_bits[0] if host_bits else ""
            external_id = _last_path_segment(path) or _fallback_external_id(u)

        return _result(
            provider="lever",
            provider_tenant=tenant,
            external_id=external_id,
            found_on=ats_found_on(),
            hiring_company_name=tenant or None,
            posting_company_name=posting_company_name,
        )

    # Workday:
    # tenant.wd*.myworkdayjobs.com/.../{slug_or_requisition}
    if _host_matches(host, "myworkdayjobs.com"):
        tenant = host.split(".")[0]
        external_id = _last_path_segment(path) or _fallback_external_id(u)
        return _result(
            provider="workday",
            provider_tenant=tenant,
            external_id=external_id,
            found_on=ats_found_on(),
            hiring_company_name=tenant or None,
            posting_company_name=posting_company_name,
        )

    # Personio:
    if _host_matches(host, "jobs.personio.de") or _host_matches(host, "jobs.personio.com"):
        tenant = host.split(".")[0]
        external_id = _last_path_segment(path) or _fallback_external_id(u)
        return _result(
            provider="personio",
            provider_tenant=tenant,
            external_id=external_id,
            found_on=ats_found_on(),
            hiring_company_name=tenant or None,
            posting_company_name=posting_company_name,
        )

    # SmartRecruiters:
    if _host_matches(host, "smartrecruiters.com"):
        tenant = _first_after(path, "SmartRecruiters") or _first_after(path, "company") or ""
        external_id = _first_after(path, "job") or _last_path_segment(path) or _fallback_external_id(u)
        return _result(
            provider="smartrecruiters",
            provider_tenant=tenant,
            external_id=external_id,
            found_on=ats_found_on(),
            hiring_company_name=tenant or None,
            posting_company_name=posting_company_name,
        )

    # Join:
    if _host_matches(host, "join.com"):
        tenant = _first_after(path, "companies") or ""
        seg = _last_path_segment(path)
        match = re.match(r"^(\d+)(?:-|$)", seg or "")
        external_id = match.group(1) if match else (seg or _fallback_external_id(u))
        return _result(
            provider="join",
            provider_tenant=tenant,
            external_id=external_id,
            found_on=ats_found_on(),
            hiring_company_name=tenant or None,
            posting_company_name=posting_company_name,
        )

    ats_suffixes = [
        ("teamtailor.com", "teamtailor"),
        ("workable.com", "workable"),
        ("applytojob.com", "workable"),
        ("jazz.co", "jazzhr"),
        ("recruitee.com", "recruitee"),
        ("bamboohr.com", "bamboohr"),
        ("icims.com", "icims"),
        ("jobvite.com", "jobvite"),
        ("breezy.hr", "breezyhr"),
        ("comeet.co", "comeet"),
        ("pinpoint.jobs", "pinpoint"),
    ]

    for suffix, provider in ats_suffixes:
        if _host_matches(host, suffix):
            tenant = host.split(".")[0]
            if provider == "workable" and _host_matches(host, "applytojob.com"):
                tenant = ""
            if provider == "icims":
                tenant = ""
            external_id = _first_after(path, "jobs") or _last_path_segment(path) or _fallback_external_id(u)
            return _result(
                provider=provider,
                provider_tenant=tenant,
                external_id=external_id,
                found_on=ats_found_on(),
                hiring_company_name=tenant or None,
                posting_company_name=posting_company_name,
            )

    # Job boards.
    for domain, provider in BOARD_DOMAINS.items():
        if _host_matches(host, domain):
            qs = parse_qs(u.query or "")
            if provider == "linkedin":
                external_id = _first_after(path, "view") or _last_path_segment(path)
                if not _looks_numeric_id(external_id):
                    external_id = _fallback_external_id(u)
            elif provider == "indeed":
                external_id = (qs.get("jk") or qs.get("vjk") or [None])[0]
                external_id = external_id or _last_path_segment(path) or _fallback_external_id(u)
            elif provider == "join":
                external_id = _last_path_segment(path) or _fallback_external_id(u)
            else:
                external_id = _last_path_segment(path)
                if not external_id or _is_generic_path_segment(external_id):
                    external_id = _fallback_external_id(u)

            return _result(
                provider=provider,
                provider_tenant="",
                external_id=external_id,
                found_on=found_on or provider,
                hiring_company_name=None,
                posting_company_name=posting_company_name,
            )

    # Unknown corporate site.
    provider = _provider_from_host(host)
    company = None if posting_company_name else _company_from_host(host)
    after_job = _first_after(path, "job")
    if after_job:
        external_id = after_job
    else:
        seg = _last_path_segment(path)
        external_id = seg if seg and not _is_generic_path_segment(seg) else _fallback_external_id(u)

    return _result(
        provider=provider,
        provider_tenant="",
        external_id=external_id,
        found_on=found_on or "corporate-site",
        hiring_company_name=company,
        posting_company_name=posting_company_name,
    )