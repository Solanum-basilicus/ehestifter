import os
import sys
from pathlib import Path

import pytest

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from helpers.location_eligibility import compile_eligibility_sql, validate_eligibility
from helpers.location_mode import active_location_model
from helpers.locations_v2 import LocationsV2Catalog
from helpers.locations_v2_store import replace_native_locations_v2
from helpers.validation import validate_job_payload


CATALOG = {
    "schemaVersion": 2,
    "catalogVersion": "test-v2",
    "referenceYear": 2026,
    "regions": [
        {"id": "m49:001", "kind": "globalRegion", "name": "World", "parentId": None, "ancestors": [], "utcOffsets": [-480, 60, 120]},
        {"id": "m49:150", "kind": "globalRegion", "name": "Europe", "parentId": "m49:001", "ancestors": ["m49:001"], "utcOffsets": [60, 120]},
        {"id": "m49:155", "kind": "globalRegion", "name": "Western Europe", "parentId": "m49:150", "ancestors": ["m49:150", "m49:001"], "utcOffsets": [60, 120]},
    ],
    "countries": [
        {"id": "iso3166:DE", "kind": "country", "name": "Germany", "aliases": [], "countryCode": "DE", "parentId": "m49:155", "ancestors": ["m49:155", "m49:150", "m49:001"], "utcOffsets": [60, 120]},
        {"id": "iso3166:FR", "kind": "country", "name": "France", "aliases": [], "countryCode": "FR", "parentId": "m49:155", "ancestors": ["m49:155", "m49:150", "m49:001"], "utcOffsets": [60, 120]},
    ],
    "adminRegions": [
        {"id": "geonames:2950157", "kind": "adminRegion", "name": "Berlin", "aliases": [], "countryCode": "DE", "parentId": "iso3166:DE", "ancestors": ["iso3166:DE", "m49:155", "m49:150", "m49:001"], "utcOffsets": [60, 120]},
    ],
    "cities": [
        {"id": "geonames:2950159", "kind": "city", "name": "Berlin", "aliases": [], "countryCode": "DE", "admin1Id": "geonames:2950157", "parentId": "geonames:2950157", "ancestors": ["geonames:2950157", "iso3166:DE", "m49:155", "m49:150", "m49:001"], "utcOffsets": [60, 120]},
    ],
}


class FakeCursor:
    def __init__(self):
        self.executed = []
        self.executemany_calls = []
        self.fast_executemany = False
        self._next_direct_id = 41

    def execute(self, sql, params=()):
        self.executed.append((" ".join(sql.split()), tuple(params) if isinstance(params, (list, tuple)) else params))
        return self

    def fetchone(self):
        self._next_direct_id += 1
        return (self._next_direct_id,)

    def executemany(self, sql, rows):
        self.executemany_calls.append((" ".join(sql.split()), list(rows)))
        return self


def test_validate_job_payload_accepts_v2_contract_and_empty_lists():
    ok, message = validate_job_payload(
        {
            "url": "https://example.test/job/1",
            "locationsV2": [{"kind": "country", "locationId": "iso3166:DE"}],
            "workTimeConstraintsV2": [
                {"offsetRangeStartMinutes": 0, "offsetRangeEndMinutes": 240}
            ],
        }
    )

    assert ok, message

    ok, message = validate_job_payload(
        {
            "url": "https://example.test/job/1",
            "locationsV2": [],
            "workTimeConstraintsV2": [],
        }
    )
    assert ok, message


def test_validate_job_payload_rejects_invalid_v2_range():
    ok, message = validate_job_payload(
        {
            "url": "https://example.test/job/1",
            "workTimeConstraintsV2": [
                {"offsetRangeStartMinutes": 240, "offsetRangeEndMinutes": 0}
            ],
        }
    )

    assert not ok
    assert "start must not be greater than end" in message


def test_active_location_model_defaults_to_v1_and_accepts_v2(monkeypatch):
    monkeypatch.delenv("LOCATIONS_ACTIVE_MODEL", raising=False)
    assert active_location_model() == "v1"

    monkeypatch.setenv("LOCATIONS_ACTIVE_MODEL", "v2")
    assert active_location_model() == "v2"

    monkeypatch.setenv("LOCATIONS_ACTIVE_MODEL", "bad-value")
    assert active_location_model() == "v1"


def test_native_v2_write_keeps_facts_on_each_direct_branch():
    catalog = LocationsV2Catalog(CATALOG)
    cursor = FakeCursor()

    replace_native_locations_v2(
        cursor,
        catalog,
        "11111111-1111-1111-1111-111111111111",
        [
            {"kind": "city", "locationId": "geonames:2950159"},
            {"kind": "country", "locationId": "iso3166:FR"},
        ],
    )

    fact_rows = [
        rows
        for sql, rows in cursor.executemany_calls
        if "INSERT INTO dbo.JobOfferingLocationFactsV2" in sql
    ]
    assert len(fact_rows) == 2
    first_direct_ids = {row[0] for row in fact_rows[0]}
    second_direct_ids = {row[0] for row in fact_rows[1]}
    assert len(first_direct_ids) == 1
    assert len(second_direct_ids) == 1
    assert first_direct_ids != second_direct_ids
    assert any(row[1:] == ("country", "iso3166:DE") for row in fact_rows[0])
    assert any(row[1:] == ("country", "iso3166:FR") for row in fact_rows[1])


def test_eligibility_rejects_unknown_canonical_selector():
    catalog = LocationsV2Catalog(CATALOG)
    with pytest.raises(ValueError, match="valid canonical location"):
        validate_eligibility(
            catalog,
            {
                "onSite": {
                    "includeLocations": [
                        {"kind": "country", "locationId": "iso3166:ZZ"}
                    ]
                }
            },
        )


def test_on_site_include_and_exclude_use_the_same_direct_branch():
    catalog = LocationsV2Catalog(CATALOG)
    eligibility = validate_eligibility(
        catalog,
        {
            "onSite": {
                "includeLocations": [
                    {"kind": "country", "locationId": "iso3166:DE"}
                ],
                "excludeLocations": [
                    {"kind": "country", "locationId": "iso3166:FR"}
                ],
            }
        },
    )

    sql, params = compile_eligibility_sql(catalog, eligibility)

    assert sql.count("DirectLocationV2Id = d.Id") >= 2
    assert "NOT EXISTS" in sql
    assert ["country", "iso3166:DE"] == params[0:2]
    assert ["country", "iso3166:FR"] == params[-2:]


def test_remote_include_expands_user_selector_to_broader_job_scope():
    catalog = LocationsV2Catalog(CATALOG)
    eligibility = validate_eligibility(
        catalog,
        {
            "remote": {
                "includeLocations": [
                    {"kind": "country", "locationId": "iso3166:DE"}
                ]
            }
        },
    )

    sql, params = compile_eligibility_sql(catalog, eligibility)

    assert "d.LocationKind = ? AND d.LocationId = ?" in sql
    pairs = list(zip(params[0::2], params[1::2]))
    assert ("country", "iso3166:DE") in pairs
    assert ("globalRegion", "m49:150") in pairs
    assert ("globalRegion", "m49:001") in pairs


def test_eligibility_uses_branch_utc_and_job_level_work_time_exclusion():
    catalog = LocationsV2Catalog(CATALOG)
    eligibility = validate_eligibility(
        catalog,
        {
            "hybrid": {
                "utcOffsetRanges": [{"startMinutes": 60, "endMinutes": 120}],
                "excludeWorkTimeRanges": [{"startMinutes": -480, "endMinutes": -420}],
                "allowUnknownLocation": True,
            }
        },
    )

    sql, params = compile_eligibility_sql(catalog, eligibility)

    assert "JobOfferingLocationUtcOffsetsV2" in sql
    assert "uo.DirectLocationV2Id = d.Id" in sql
    assert "JobOfferingWorkTimeConstraintsV2" in sql
    assert "NOT EXISTS (SELECT 1 FROM dbo.JobOfferingLocationsV2 du" in sql
    assert params == [60, 120, -420, -480]
