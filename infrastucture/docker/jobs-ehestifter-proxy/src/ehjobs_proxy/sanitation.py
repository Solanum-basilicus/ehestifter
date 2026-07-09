from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

from fastapi import HTTPException


_FORBIDDEN_HOSTNAMES = {"localhost", "localhost.localdomain"}
_ALLOWED_SCHEMES = {"http", "https"}


def validate_public_http_url(url: str | None, *, field_name: str = "url") -> str | None:
    if url is None:
        return None
    normalized = url.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail={"code": "bad_url", "field": field_name})

    parsed = urlparse(normalized)
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        raise HTTPException(status_code=400, detail={"code": "bad_url_scheme", "field": field_name})
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail={"code": "bad_url_host", "field": field_name})

    host = parsed.hostname.lower().strip(".")
    if host in _FORBIDDEN_HOSTNAMES or host.endswith(".localhost") or host.endswith(".local"):
        raise HTTPException(status_code=400, detail={"code": "bad_url_host", "field": field_name})

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return normalized

    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        raise HTTPException(status_code=400, detail={"code": "bad_url_ip", "field": field_name})
    return normalized


def truncate_text(value: str | None, max_chars: int) -> tuple[str | None, bool]:
    if value is None:
        return None, False
    if max_chars < 0:
        max_chars = 0
    if len(value) <= max_chars:
        return value, False
    return value[:max_chars], True
