import sys
from pathlib import Path

import pytest

USERS_ROOT = Path(__file__).resolve().parents[1]
if str(USERS_ROOT) not in sys.path:
    sys.path.insert(0, str(USERS_ROOT))

from helpers.discovery_preferences import normalize_discovery_preferences


def test_preferences_normalize_terms_selectors_and_ranges():
    normalized = normalize_discovery_preferences(
        {
            "schemaVersion": 1,
            "title": {
                "positive": ["  Product   Manager ", "Product Manager"],
                "negative": ["Junior Product Manager"],
            },
            "eligibility": {
                "remote": {
                    "includeLocations": [
                        {"kind": "city", "locationId": "geonames:6058560"},
                        {"kind": "city", "locationId": "geonames:6058560"},
                    ],
                    "excludeLocations": [],
                    "utcOffsetRanges": [
                        {"startMinutes": -300, "endMinutes": 120},
                        {"startMinutes": -300, "endMinutes": 120},
                    ],
                    "excludeWorkTimeRanges": [],
                    "allowUnknownLocation": True,
                }
            },
        }
    )

    assert normalized["title"]["positive"] == ["Product Manager"]
    assert normalized["eligibility"]["remote"]["includeLocations"] == [
        {"kind": "city", "locationId": "geonames:6058560"}
    ]
    assert normalized["eligibility"]["remote"]["utcOffsetRanges"] == [
        {"startMinutes": -300, "endMinutes": 120}
    ]


def test_preferences_reject_same_normalized_title_term_in_both_lists():
    with pytest.raises(ValueError, match="same title term"):
        normalize_discovery_preferences(
            {
                "schemaVersion": 1,
                "title": {
                    "positive": ["Product   Manager"],
                    "negative": [" product manager "],
                },
                "eligibility": None,
            }
        )


def test_preferences_keep_overlapping_but_different_title_terms():
    normalized = normalize_discovery_preferences(
        {
            "schemaVersion": 1,
            "title": {
                "positive": ["Product Manager"],
                "negative": ["Junior Product Manager"],
            },
            "eligibility": None,
        }
    )

    assert normalized["title"] == {
        "positive": ["Product Manager"],
        "negative": ["Junior Product Manager"],
    }


def test_preferences_reject_unknown_work_arrangement():
    with pytest.raises(ValueError, match="unsupported work arrangement"):
        normalize_discovery_preferences(
            {
                "schemaVersion": 1,
                "title": {"positive": [], "negative": []},
                "eligibility": {"office": {}},
            }
        )


def test_preferences_reject_out_of_range_utc_values():
    with pytest.raises(ValueError, match="between -840 and 840"):
        normalize_discovery_preferences(
            {
                "schemaVersion": 1,
                "title": {"positive": [], "negative": []},
                "eligibility": {
                    "hybrid": {
                        "utcOffsetRanges": [
                            {"startMinutes": -900, "endMinutes": 60}
                        ]
                    }
                },
            }
        )
