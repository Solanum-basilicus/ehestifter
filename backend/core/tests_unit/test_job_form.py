import sys
from pathlib import Path

CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

from helpers.job_form import clean_job_payload


def test_job_form_passes_v2_contract_without_display_metadata():
    result = clean_job_payload(
        {
            "url": "https://example.test/job/1",
            "locationsV2": [
                {
                    "kind": "city",
                    "locationId": "geonames:2950159",
                    "displayName": "Berlin",
                    "countryCode": "DE",
                }
            ],
            "workTimeConstraintsV2": [
                {
                    "offsetRangeStartMinutes": 0,
                    "offsetRangeEndMinutes": 240,
                    "label": "ignored",
                }
            ],
        }
    )

    assert result["locationsV2"] == [
        {"kind": "city", "locationId": "geonames:2950159"}
    ]
    assert result["workTimeConstraintsV2"] == [
        {"offsetRangeStartMinutes": 0, "offsetRangeEndMinutes": 240}
    ]


def test_job_form_keeps_explicit_empty_location_arrays():
    result = clean_job_payload(
        {
            "url": "https://example.test/job/1",
            "locations": [],
            "locationsV2": [],
            "workTimeConstraintsV2": [],
        },
        for_update=True,
    )

    assert "locations" not in result
    assert result["locationsV2"] == []
    assert result["workTimeConstraintsV2"] == []


def test_job_form_drops_legacy_locations_on_create_and_update():
    for for_update in (False, True):
        result = clean_job_payload(
            {"locations": [{"countryName": "Germany", "cityName": "Berlin"}]},
            for_update=for_update,
        )
        assert "locations" not in result


def test_job_form_keeps_invalid_v2_input_for_jobs_validation():
    for value in (None, "not-a-list", ["not-an-object"], [{"kind": [], "locationId": 123}]):
        result = clean_job_payload({"locationsV2": value}, for_update=True)
        assert result["locationsV2"] == value
