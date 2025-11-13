# url_helpers.py
from urllib.parse import urlparse, parse_qs
import hashlib

MULTI_LEVEL_TLDS = {
    "co.uk","com.au","com.br","co.nz","com.sg","com.tr","com.mx","co.jp","co.kr","com.cn","com.hk","com.tw","com.pl"
}

GENERIC_JOB_LABELS = {
    "job","jobs","career","careers",
    "karriere","stellen","stellenangebote","arbeit",   # de
    "emploi","carriere","carrieres",                   # fr
    "praca","kariera","oferty","ofertapracy","ofertypracy","oferta"  # pl
}

REFERRAL_KEYS = ["source","src","utm_source","ref","referrer"]

ATS_DOMAINS = {
    "myworkdayjobs.com": "workday",
    "greenhouse.io": "greenhouse",
    "boards.greenhouse.io": "greenhouse",
    "lever.co": "lever",
    "jobs.personio.de": "personio",
    "jobs.personio.com": "personio",
    "smartrecruiters.com": "smartrecruiters",
    "teamtailor.com": "teamtailor",
    "workable.com": "workable",
    "applytojob.com": "workable",   # also used by JazzHR sometimes
    "jazz.co": "jazzhr",
    "ashbyhq.com": "ashby",
    "recruitee.com": "recruitee",
    "bamboohr.com": "bamboohr",
    "icims.com": "icims",
    "jobvite.com": "jobvite",
    "breezy.hr": "breezyhr",
    "comeet.co": "comeet",
    "pinpoint.jobs": "pinpoint",
    "join.com": "join",
}

BOARD_DOMAINS = {
    "linkedin.com": "linkedin",
    "indeed.com": "indeed",
    "indeed.de": "indeed",
    "stepstone.de": "stepstone",
    "stepstone.fr": "stepstone",
    "stepstone.nl": "stepstone",
    "xing.com": "xing",
    "weworkremotely.com": "weworkremotely",
    "dynamitejobs.com": "dynamitejobs",
    "remotive.com": "remotive",
    "ziprecruiter.com": "ziprecruiter",
    "reed.co.uk": "reed",
    "totaljobs.com": "totaljobs",
    "cv-library.co.uk": "cv-library",
    "nofluffjobs.com": "nofluffjobs",
    "pracuj.pl": "pracuj",
}

def _base_labels(host: str):
    host = host.lower()
    parts = host.split(".")
    if len(parts) <= 2:
        return parts
    last_two = ".".join(parts[-2:])
    if last_two in MULTI_LEVEL_TLDS:
        # keep three labels for something like a.b.co.uk
        return parts
    return parts

def _company_from_host(host: str) -> str:
    parts = _base_labels(host)
    # walk leftward from registrable base, skipping generic job labels
    # choose the label right before the public suffix
    # e.g., jobs.hygraph.com -> hygraph; careers.microsoft.com -> microsoft
    if len(parts) < 2:
        return host.split(".")[0]
    # last label is TLD; second last is base; prior are subdomains
    # start from second last - 1 and walk left
    stop = len(parts) - 2
    for i in range(stop, -1, -1):
        label = parts[i]
        if label and label not in GENERIC_JOB_LABELS:
            return label
    return parts[-2]  # fallback

def _provider_from_host(host: str) -> str:
    """
    Choose provider from host when it is not a known ATS/board:
      - Take the left-most label before the public suffix (e.g. bosch.newats.ai -> 'bosch')
      - If that label is a generic jobs/career label (jobs, careers, karriere, ...),
        fall back to the next one to the right (jobs.siemens.com -> 'siemens').
    """
    host = (host or "").lower().lstrip("www.")
    parts = host.split(".")
    if not parts or not parts[0]:
        return "corporate-site"
    if len(parts) == 1:
        return parts[0]

    # determine public suffix length: 2 for known multi-level, otherwise 1
    if len(parts) >= 3 and ".".join(parts[-2:]) in MULTI_LEVEL_TLDS:
        ps_len = 2
    else:
        ps_len = 1

    cutoff = len(parts) - ps_len
    if cutoff <= 0:
        return parts[0]

    pre = parts[:cutoff]  # labels before suffix
    candidate = pre[0]
    if candidate in GENERIC_JOB_LABELS and len(pre) > 1:
        candidate = pre[1]
    return candidate or parts[0]

def _normalize_source_name(v: str) -> str:
    s = (v or "").strip().lower()
    # if it's a URL or domain-like, strip www. and take base
    if s.startswith("http://") or s.startswith("https://"):
        try:
            s = urlparse(s).hostname or s
        except Exception:
            pass
    s = s.replace("www.", "")
    if "." in s:
        s = s.split(".")[0]
    aliases = {
        "li": "linkedin", "lnkd": "linkedin",
        "angellist": "wellfound", "angel": "wellfound", "angelco": "wellfound",
        "stackoverflowjobs": "stackoverflow", "stack-overflow": "stackoverflow",
        "wwr": "weworkremotely",
        "cvlibrary": "cv-library",
    }
    return aliases.get(s, s)

def _found_on_from_params(u) -> str | None:
    qs = parse_qs(u.query or "")
    for k in REFERRAL_KEYS:
        if k in qs and qs[k]:
            val = _normalize_source_name(qs[k][0])
            if val:
                return val
    return None

def _last_path_segment(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    return parts[-1] if parts else ""

def _first_after(path: str, token: str) -> str:
    parts = [p for p in path.split("/") if p]
    token = token.lower()
    for i, p in enumerate(parts):
        if p.lower() == token and i+1 < len(parts):
            return parts[i+1]
    return ""

def _hash_external_id(s: str) -> str:
    # short stable hash
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]

def deduce_from_url(raw_url: str) -> dict:
    """
    Returns:
      {
        "provider": str,
        "providerTenant": str,
        "externalId": str,
        "foundOn": str,                # favor referral params; else board domain; else 'corporate-site'
        "hiringCompanyName": str | None
      }
    """
    try:
        u = urlparse(raw_url)
    except Exception:
        return {}

    host = (u.hostname or "").lower().lstrip("www.")
    path = u.path or ""
    found_on = _found_on_from_params(u)

    # ATS?
    provider = None
    provider_tenant = ""
    for dom, pname in ATS_DOMAINS.items():
        if host == dom or host.endswith("." + dom):
            provider = pname
            # tenant extraction
            if pname == "workday":
                # azenta.wd1.myworkdayjobs.com -> azenta (first label)
                provider_tenant = host.split(".")[0]
                ext = _last_path_segment(path) or _hash_external_id(u.scheme + "://" + host + path)
                external_id = ext
                company = provider_tenant
            elif pname == "recruitee":
                # <tenant>.recruitee.com/o/<slug-or-id>
                provider_tenant = host.split(".")[0]
                seg = _last_path_segment(path)
                external_id = seg or _hash_external_id(u.scheme + "://" + host + path)
                company = provider_tenant
            elif pname == "join":
                # join.com/companies/<company>/<id>-<slug>
                company = _first_after(path, "companies") or _company_from_host(host)
                provider_tenant = company or ""
                seg = _last_path_segment(path)
                if seg and seg[0].isdigit():
                    external_id = seg.split("-", 1)[0]
                else:
                    external_id = seg or _hash_external_id(u.scheme + "://" + host + path)
            elif pname == "greenhouse":
                company = _first_after(path, "boards") or _company_from_host(host)
                provider_tenant = company or ""
                ext = _first_after(path, "jobs") or _last_path_segment(path)
                external_id = ext or _hash_external_id(u.scheme + "://" + host + path)
            elif pname == "lever":
                provider_tenant = host.split(".")[0]
                company = provider_tenant
                ext = _first_after(path, "jobs") or _last_path_segment(path)
                external_id = ext or _hash_external_id(u.scheme + "://" + host + path)
            else:
                provider_tenant = host.split(".")[0]
                company = provider_tenant
                external_id = _last_path_segment(path) or _hash_external_id(u.scheme + "://" + host + path)

            # FoundOn: prefer referral; else keep 'found_on' from board param or default to ATS name only if no referral
            if not found_on:
                found_on = "corporate-site"
            return {
                "provider": provider,
                "providerTenant": provider_tenant or "",
                "externalId": external_id,
                "foundOn": found_on,
                "hiringCompanyName": company
            }

    # Boards?
    for dom, sname in BOARD_DOMAINS.items():
        if host == dom or host.endswith("." + dom):
            provider = sname  # when the board *is* the only host we know
            provider_tenant = ""
            # external id heuristics
            seg = _last_path_segment(path)
            if sname == "linkedin":
                # /jobs/view/<digits>/
                ext = _first_after(path, "view") or seg
                if not ext or not ext.isdigit():
                    ext = _hash_external_id(u.scheme + "://" + host + path)
            else:
                ext = seg or _hash_external_id(u.scheme + "://" + host + path)
            # FoundOn: board
            found = found_on or sname
            company = _company_from_host(host)
            return {
                "provider": provider,
                "providerTenant": provider_tenant,
                "externalId": ext,
                "foundOn": found,
                "hiringCompanyName": None  # unknown from board alone
            }

    # Corporate site (unknown host)
    provider = _provider_from_host(host)
    provider_tenant = ""
    company = _company_from_host(host)
    seg = _last_path_segment(path)
    ext = seg if seg and seg.lower() not in GENERIC_JOB_LABELS else _hash_external_id(u.scheme + "://" + host + path)
    found = found_on or "corporate-site"

    return {
        "provider": provider,
        "providerTenant": provider_tenant,
        "externalId": ext,
        "foundOn": found,
        "hiringCompanyName": company
    }
