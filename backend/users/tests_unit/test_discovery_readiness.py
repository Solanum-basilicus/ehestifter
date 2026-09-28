import json
import sys
from pathlib import Path

USERS_ROOT = Path(__file__).resolve().parents[1]
if str(USERS_ROOT) not in sys.path:
    sys.path.insert(0, str(USERS_ROOT))

from helpers.discovery_readiness import (
    build_discovery_readiness,
    has_usable_cv_text,
    parse_stored_discovery_preferences,
)


def _preferences(*, positive=None, patterns=None, negative=None):
    return {
        "schemaVersion": 1,
        "title": {
            "positive": positive or [],
            "positivePatterns": patterns or [],
            "negative": negative or [],
        },
        "eligibility": None,
    }


def test_cv_requires_non_whitespace_plaintext():
    assert not has_usable_cv_text(None)
    assert not has_usable_cv_text("")
    assert not has_usable_cv_text("\n")
    assert not has_usable_cv_text(" \r\n\t")
    assert has_usable_cv_text("Product manager\n")


def test_positive_phrase_and_pattern_each_enable_title_gate():
    phrase = build_discovery_readiness(
        cv_plain_text="CV\n",
        discovery_preferences=_preferences(positive=["Product Manager"]),
    )
    pattern = build_discovery_readiness(
        cv_plain_text="CV\n",
        discovery_preferences=_preferences(patterns=[{"type": "orderedGap"}]),
    )

    assert phrase["enabled"] is True
    assert phrase["hasPositiveTitleRule"] is True
    assert pattern["enabled"] is True
    assert pattern["hasPositiveTitleRule"] is True


def test_negative_only_preferences_do_not_enable_discovery():
    readiness = build_discovery_readiness(
        cv_plain_text="CV\n",
        discovery_preferences=_preferences(negative=["Intern"]),
    )

    assert readiness == {
        "enabled": False,
        "hasUsableCv": True,
        "hasPositiveTitleRule": False,
        "reasons": ["no_positive_title"],
    }


def test_readiness_reports_cv_and_title_blockers_together():
    readiness = build_discovery_readiness(
        cv_plain_text="\n",
        discovery_preferences=_preferences(),
    )

    assert readiness == {
        "enabled": False,
        "hasUsableCv": False,
        "hasPositiveTitleRule": False,
        "reasons": ["no_usable_cv", "no_positive_title"],
    }


def test_invalid_preferences_are_a_distinct_fail_closed_reason():
    readiness = build_discovery_readiness(
        cv_plain_text="CV\n",
        discovery_preferences=None,
        discovery_preferences_invalid=True,
    )

    assert readiness == {
        "enabled": False,
        "hasUsableCv": True,
        "hasPositiveTitleRule": False,
        "reasons": ["invalid_preferences"],
    }


def test_invalid_stored_preferences_fail_closed_before_readiness():
    preferences, invalid = parse_stored_discovery_preferences("{not-json")

    assert preferences is None
    assert invalid is True


def test_stored_preferences_allow_legacy_location_conflicts():
    stored = json.dumps({
        "schemaVersion": 1,
        "title": {"positive": ["engineer"], "negative": []},
        "eligibility": {
            "remote": {
                "includeLocations": [
                    {"kind": "globalRegion", "locationId": "m49:150"}
                ],
                "excludeLocations": [
                    {"kind": "globalRegion", "locationId": "m49:150"}
                ],
            }
        },
    })

    preferences, invalid = parse_stored_discovery_preferences(stored)

    assert invalid is False
    assert preferences["title"]["positive"] == ["engineer"]
