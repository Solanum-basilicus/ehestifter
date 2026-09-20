import sys
from pathlib import Path

CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

from helpers.discovery_preferences import collect_location_selectors


def test_collect_location_selectors_deduplicates_across_groups():
    selector = {"kind": "city", "locationId": "geonames:6058560"}
    document = {
        "eligibility": {
            "remote": {
                "includeLocations": [selector],
                "excludeLocations": [],
            },
            "hybrid": {
                "includeLocations": [],
                "excludeLocations": [selector],
            },
        }
    }

    assert collect_location_selectors(document) == [selector]


def test_collect_location_selectors_leaves_malformed_values_for_users_validation():
    document = {
        "eligibility": {
            "remote": {
                "includeLocations": [
                    {"kind": "city", "locationId": 123},
                    "not-an-object",
                ]
            }
        }
    }

    assert collect_location_selectors(document) == []
