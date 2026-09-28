"""Build the authoritative discovery-readiness state for one user."""

from __future__ import annotations

import json
from typing import Any

from helpers.discovery_preferences import normalize_discovery_preferences


REASON_NO_USABLE_CV = "no_usable_cv"
REASON_NO_POSITIVE_TITLE = "no_positive_title"
REASON_INVALID_PREFERENCES = "invalid_preferences"


def parse_stored_discovery_preferences(raw: Any) -> tuple[dict | None, bool]:
    """Return normalized stored preferences and whether stored data is invalid."""
    if not raw:
        return None, False
    try:
        return normalize_discovery_preferences(
            json.loads(raw),
            reject_location_conflicts=False,
        ), False
    except (TypeError, ValueError, json.JSONDecodeError):
        return None, True


def has_usable_cv_text(value: Any) -> bool:
    """Return true when CV plaintext has at least one non-whitespace character."""
    return isinstance(value, str) and bool(value.strip())


def has_positive_title_rule(discovery_preferences: Any) -> bool:
    """Return true when preferences contain a positive phrase or pattern."""
    if not isinstance(discovery_preferences, dict):
        return False
    title = discovery_preferences.get("title")
    if not isinstance(title, dict):
        return False
    positive = title.get("positive")
    positive_patterns = title.get("positivePatterns")
    return bool(positive) or bool(positive_patterns)


def build_discovery_readiness(
    *,
    cv_plain_text: Any,
    discovery_preferences: Any,
    discovery_preferences_invalid: bool = False,
) -> dict:
    """Return one stable readiness result owned by the Users domain."""
    usable_cv = has_usable_cv_text(cv_plain_text)
    positive_title = (
        False
        if discovery_preferences_invalid
        else has_positive_title_rule(discovery_preferences)
    )

    reasons = []
    if not usable_cv:
        reasons.append(REASON_NO_USABLE_CV)
    if discovery_preferences_invalid:
        reasons.append(REASON_INVALID_PREFERENCES)
    elif not positive_title:
        reasons.append(REASON_NO_POSITIVE_TITLE)

    return {
        "enabled": not reasons,
        "hasUsableCv": usable_cv,
        "hasPositiveTitleRule": positive_title,
        "reasons": reasons,
    }
