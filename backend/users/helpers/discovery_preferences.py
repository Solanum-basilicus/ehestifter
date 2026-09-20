"""Validate and normalize user discovery preferences."""

from __future__ import annotations

import re
from typing import Any


SCHEMA_VERSION = 1
MAX_TITLE_TERMS = 300
MAX_TITLE_TERM_LENGTH = 120
MAX_TITLE_PATTERNS = 50
MAX_PATTERN_ALTERNATIVES = 10
PATTERN_GAP_WORDS = 2
MAX_LOCATION_SELECTORS = 100
MAX_RANGES = 32
SUPPORTED_KINDS = {"city", "adminRegion", "country", "globalRegion"}
SUPPORTED_ARRANGEMENTS = {"remote", "hybrid", "onSite", "unknown"}
GROUP_FIELDS = {
    "includeLocations",
    "excludeLocations",
    "utcOffsetRanges",
    "excludeWorkTimeRanges",
    "allowUnknownLocation",
}


def default_discovery_preferences() -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "title": {"positive": [], "positivePatterns": [], "negative": []},
        "eligibility": None,
    }


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def _normalize_terms(value: Any, path: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{path} must be an array")
    if len(value) > MAX_TITLE_TERMS:
        raise ValueError(f"{path} must contain at most {MAX_TITLE_TERMS} items")

    result = []
    seen = set()
    for index, raw in enumerate(value):
        if not isinstance(raw, str):
            raise ValueError(f"{path}[{index}] must be a string")
        term = _normalize_text(raw)
        if not term:
            raise ValueError(f"{path}[{index}] must not be empty")
        if len(term) > MAX_TITLE_TERM_LENGTH:
            raise ValueError(
                f"{path}[{index}] must contain at most {MAX_TITLE_TERM_LENGTH} characters"
            )
        key = term.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(term)
    return result


def _normalize_pattern_terms(value: Any, path: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{path} must be an array")
    if not value or len(value) > MAX_PATTERN_ALTERNATIVES:
        raise ValueError(
            f"{path} must contain between 1 and {MAX_PATTERN_ALTERNATIVES} items"
        )
    result = []
    seen = set()
    for index, raw in enumerate(value):
        if not isinstance(raw, str):
            raise ValueError(f"{path}[{index}] must be a string")
        term = _normalize_text(raw)
        if not term:
            raise ValueError(f"{path}[{index}] must not be empty")
        if len(term) > MAX_TITLE_TERM_LENGTH:
            raise ValueError(
                f"{path}[{index}] must contain at most {MAX_TITLE_TERM_LENGTH} characters"
            )
        key = term.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(term)
    return result


def _normalize_positive_patterns(value: Any, path: str) -> list[dict]:
    if not isinstance(value, list):
        raise ValueError(f"{path} must be an array")
    if len(value) > MAX_TITLE_PATTERNS:
        raise ValueError(f"{path} must contain at most {MAX_TITLE_PATTERNS} items")
    result = []
    seen = set()
    for index, raw in enumerate(value):
        item_path = f"{path}[{index}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{item_path} must be an object")
        unknown = set(raw) - {"type", "left", "right", "maxGapWords"}
        if unknown:
            raise ValueError(
                f"{item_path} contains unsupported field: {sorted(unknown)[0]}"
            )
        if raw.get("type") != "orderedGap":
            raise ValueError(f"{item_path}.type must be orderedGap")
        if raw.get("maxGapWords") != PATTERN_GAP_WORDS:
            raise ValueError(
                f"{item_path}.maxGapWords must be {PATTERN_GAP_WORDS}"
            )
        left = _normalize_pattern_terms(raw.get("left"), f"{item_path}.left")
        right = _normalize_pattern_terms(raw.get("right"), f"{item_path}.right")
        key = (
            tuple(value.casefold() for value in left),
            tuple(value.casefold() for value in right),
            PATTERN_GAP_WORDS,
        )
        if key in seen:
            continue
        seen.add(key)
        result.append(
            {
                "type": "orderedGap",
                "left": left,
                "right": right,
                "maxGapWords": PATTERN_GAP_WORDS,
            }
        )
    return result


def _normalize_selector(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    unknown = set(value) - {"kind", "locationId"}
    if unknown:
        raise ValueError(f"{path} contains unsupported field: {sorted(unknown)[0]}")
    kind = value.get("kind")
    location_id = value.get("locationId")
    if kind not in SUPPORTED_KINDS:
        raise ValueError(f"{path}.kind is invalid")
    if not isinstance(location_id, str) or not location_id.strip():
        raise ValueError(f"{path}.locationId is required")
    location_id = location_id.strip()
    if len(location_id) > 64:
        raise ValueError(f"{path}.locationId must contain at most 64 characters")
    return {"kind": kind, "locationId": location_id}


def _normalize_selectors(value: Any, path: str) -> list[dict]:
    if not isinstance(value, list):
        raise ValueError(f"{path} must be an array")
    if len(value) > MAX_LOCATION_SELECTORS:
        raise ValueError(
            f"{path} must contain at most {MAX_LOCATION_SELECTORS} selectors"
        )
    result = []
    seen = set()
    for index, raw in enumerate(value):
        selector = _normalize_selector(raw, f"{path}[{index}]")
        key = (selector["kind"], selector["locationId"])
        if key in seen:
            continue
        seen.add(key)
        result.append(selector)
    return result


def _normalize_range(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    unknown = set(value) - {"startMinutes", "endMinutes"}
    if unknown:
        raise ValueError(f"{path} contains unsupported field: {sorted(unknown)[0]}")
    start = value.get("startMinutes")
    end = value.get("endMinutes")
    if isinstance(start, bool) or not isinstance(start, int):
        raise ValueError(f"{path}.startMinutes must be an integer")
    if isinstance(end, bool) or not isinstance(end, int):
        raise ValueError(f"{path}.endMinutes must be an integer")
    if start < -840 or start > 840 or end < -840 or end > 840:
        raise ValueError(f"{path} must stay between -840 and 840 minutes")
    if start > end:
        raise ValueError(f"{path}.startMinutes must not be greater than endMinutes")
    return {"startMinutes": start, "endMinutes": end}


def _normalize_ranges(value: Any, path: str) -> list[dict]:
    if not isinstance(value, list):
        raise ValueError(f"{path} must be an array")
    if len(value) > MAX_RANGES:
        raise ValueError(f"{path} must contain at most {MAX_RANGES} ranges")
    result = []
    seen = set()
    for index, raw in enumerate(value):
        normalized = _normalize_range(raw, f"{path}[{index}]")
        key = (normalized["startMinutes"], normalized["endMinutes"])
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def _normalize_group(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    unknown = set(value) - GROUP_FIELDS
    if unknown:
        raise ValueError(f"{path} contains unsupported field: {sorted(unknown)[0]}")

    allow_unknown = value.get("allowUnknownLocation", False)
    if not isinstance(allow_unknown, bool):
        raise ValueError(f"{path}.allowUnknownLocation must be a boolean")

    include_locations = _normalize_selectors(
        value.get("includeLocations", []), f"{path}.includeLocations"
    )
    exclude_locations = _normalize_selectors(
        value.get("excludeLocations", []), f"{path}.excludeLocations"
    )
    include_keys = {(item["kind"], item["locationId"]) for item in include_locations}
    exclude_keys = {(item["kind"], item["locationId"]) for item in exclude_locations}
    contradiction = sorted(include_keys & exclude_keys)
    if contradiction:
        kind, location_id = contradiction[0]
        raise ValueError(
            f"The same location cannot be included and excluded in {path}: "
            f"{kind}:{location_id}"
        )

    return {
        "includeLocations": include_locations,
        "excludeLocations": exclude_locations,
        "utcOffsetRanges": _normalize_ranges(
            value.get("utcOffsetRanges", []), f"{path}.utcOffsetRanges"
        ),
        "excludeWorkTimeRanges": _normalize_ranges(
            value.get("excludeWorkTimeRanges", []), f"{path}.excludeWorkTimeRanges"
        ),
        "allowUnknownLocation": allow_unknown,
    }


def normalize_discovery_preferences(value: Any) -> dict:
    """Return the stable persisted discovery-preference document."""
    if not isinstance(value, dict):
        raise ValueError("Discovery preferences must be a JSON object")
    unknown = set(value) - {"schemaVersion", "title", "eligibility"}
    if unknown:
        raise ValueError(f"Unsupported field: {sorted(unknown)[0]}")
    if value.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"schemaVersion must be {SCHEMA_VERSION}")

    raw_title = value.get("title", {})
    if not isinstance(raw_title, dict):
        raise ValueError("title must be an object")
    unknown_title = set(raw_title) - {"positive", "positivePatterns", "negative"}
    if unknown_title:
        raise ValueError(f"title contains unsupported field: {sorted(unknown_title)[0]}")
    positive = _normalize_terms(raw_title.get("positive", []), "title.positive")
    positive_patterns = _normalize_positive_patterns(
        raw_title.get("positivePatterns", []), "title.positivePatterns"
    )
    negative = _normalize_terms(raw_title.get("negative", []), "title.negative")

    positive_keys = {term.casefold() for term in positive}
    negative_keys = {term.casefold() for term in negative}
    contradiction = sorted(positive_keys & negative_keys)
    if contradiction:
        raise ValueError(
            f"The same title term cannot be included and excluded: {contradiction[0]}"
        )

    raw_eligibility = value.get("eligibility")
    if raw_eligibility is None:
        eligibility = None
    else:
        if not isinstance(raw_eligibility, dict):
            raise ValueError("eligibility must be an object or null")
        unknown_groups = set(raw_eligibility) - SUPPORTED_ARRANGEMENTS
        if unknown_groups:
            raise ValueError(
                "eligibility contains unsupported work arrangement: "
                f"{sorted(unknown_groups)[0]}"
            )
        eligibility = {
            group_name: _normalize_group(
                group_value, f"eligibility.{group_name}"
            )
            for group_name, group_value in raw_eligibility.items()
        }

    return {
        "schemaVersion": SCHEMA_VERSION,
        "title": {
            "positive": positive,
            "positivePatterns": positive_patterns,
            "negative": negative,
        },
        "eligibility": eligibility,
    }
