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
        "positivePatterns": [],
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


def test_preferences_accept_flexible_positive_title_patterns():
    normalized = normalize_discovery_preferences(
        {
            "schemaVersion": 1,
            "title": {
                "positive": ["Head of Product"],
                "positivePatterns": [
                    {
                        "type": "orderedGap",
                        "left": [" Engineering ", "Engineering"],
                        "right": ["Manager", "Lead"],
                        "maxGapWords": 2,
                    }
                ],
                "negative": ["Intern"],
            },
            "eligibility": None,
        }
    )

    assert normalized["title"]["positivePatterns"] == [
        {
            "type": "orderedGap",
            "left": ["Engineering"],
            "right": ["Manager", "Lead"],
            "maxGapWords": 2,
        }
    ]


def test_preferences_reject_unsupported_title_pattern_gap():
    with pytest.raises(ValueError, match="maxGapWords must be 2"):
        normalize_discovery_preferences(
            {
                "schemaVersion": 1,
                "title": {
                    "positive": [],
                    "positivePatterns": [
                        {
                            "type": "orderedGap",
                            "left": ["Engineering"],
                            "right": ["Manager"],
                            "maxGapWords": 4,
                        }
                    ],
                    "negative": [],
                },
                "eligibility": None,
            }
        )


def test_preferences_accept_more_than_fifty_title_phrases_for_bulk_edit():
    terms = [f"Product role {index}" for index in range(60)]
    normalized = normalize_discovery_preferences(
        {
            "schemaVersion": 1,
            "title": {"positive": terms, "negative": []},
            "eligibility": None,
        }
    )

    assert normalized["title"]["positive"] == terms


def test_preferences_reject_same_location_in_include_and_exclude():
    with pytest.raises(ValueError, match="same location cannot be included and excluded"):
        normalize_discovery_preferences(
            {
                "schemaVersion": 1,
                "title": {"positive": [], "negative": []},
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
            }
        )


def test_preferences_allow_parent_include_and_child_exclude():
    normalized = normalize_discovery_preferences(
        {
            "schemaVersion": 1,
            "title": {"positive": [], "negative": []},
            "eligibility": {
                "remote": {
                    "includeLocations": [
                        {"kind": "globalRegion", "locationId": "m49:150"}
                    ],
                    "excludeLocations": [
                        {"kind": "country", "locationId": "iso3166:BG"}
                    ],
                }
            },
        }
    )

    assert normalized["eligibility"]["remote"]["includeLocations"][0]["locationId"] == "m49:150"
    assert normalized["eligibility"]["remote"]["excludeLocations"][0]["locationId"] == "iso3166:BG"
