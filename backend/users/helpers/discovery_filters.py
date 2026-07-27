from __future__ import annotations

import json
from typing import Any, Iterable, Optional

MAX_TERMS_PER_FIELD = 50
MAX_TERM_LENGTH = 120


def _first_mapping(value: Any, *keys: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, dict):
            return candidate
    return {}


def _string_terms(value: Any) -> list[str]:
    if value is None:
        return []
    values: Iterable[Any]
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, list):
        values = value
    else:
        return []

    output: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            continue
        term = raw.strip()
        if not term or len(term) > MAX_TERM_LENGTH:
            continue
        key = term.casefold()
        if key in seen:
            continue
        seen.add(key)
        output.append(term)
        if len(output) >= MAX_TERMS_PER_FIELD:
            break
    return output


def _terms_from(mapping: dict[str, Any], *keys: str) -> list[str]:
    for key in keys:
        if key in mapping:
            return _string_terms(mapping.get(key))
    return []


def _parse_json(value: Any) -> Optional[dict[str, Any]]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def normalize_discovery_profile(
    filter_id: Any,
    normalized_json: Any,
) -> Optional[dict[str, Any]]:
    """Project a saved filter into the bounded ATS Discovery filter contract.

    The UI/normalizer has changed shape over time, so a small set of snake_case
    and camelCase aliases is accepted. Unknown fields are ignored. A saved
    filter with no recognized usable constraints is rejected rather than
    becoming an accidental match-all profile.
    """

    raw = _parse_json(normalized_json)
    if raw is None:
        return None
    root = raw.get("filters") if isinstance(raw.get("filters"), dict) else raw

    title = _first_mapping(
        root,
        "title",
        "titleFilter",
        "title_filter",
        "titleKeywords",
        "title_keywords",
    )
    location = _first_mapping(
        root,
        "location",
        "locationFilter",
        "location_filter",
        "locationKeywords",
        "location_keywords",
    )
    company = _first_mapping(
        root,
        "company",
        "companyFilter",
        "company_filter",
        "companies",
    )

    remote_raw = None
    for key in ("remoteTypes", "remote_types", "workModes", "work_modes"):
        if key in root:
            remote_raw = root.get(key)
            break
    if remote_raw is None:
        remote = _first_mapping(root, "remote", "remoteFilter", "remote_filter")
        remote_raw = remote.get("allow") or remote.get("types")

    profile = {
        "profileId": str(filter_id) if filter_id is not None else None,
        "title": {
            "positive": _terms_from(
                title,
                "positive",
                "include",
                "allow",
                "required",
                "keywords",
            ),
            "negative": _terms_from(
                title,
                "negative",
                "exclude",
                "block",
                "forbidden",
            ),
        },
        "location": {
            "alwaysAllow": _terms_from(
                location,
                "alwaysAllow",
                "always_allow",
            ),
            "allow": _terms_from(
                location,
                "allow",
                "include",
                "positive",
            ),
            "block": _terms_from(
                location,
                "block",
                "exclude",
                "negative",
            ),
        },
        "company": {
            "allow": _terms_from(
                company,
                "allow",
                "include",
                "positive",
            ),
            "block": _terms_from(
                company,
                "block",
                "exclude",
                "negative",
            ),
        },
        "remoteTypes": _string_terms(remote_raw),
    }

    has_constraint = any(
        profile[section][field]
        for section, fields in (
            ("title", ("positive", "negative")),
            ("location", ("alwaysAllow", "allow", "block")),
            ("company", ("allow", "block")),
        )
        for field in fields
    ) or bool(profile["remoteTypes"])

    return profile if has_constraint else None
