import sys
from pathlib import Path

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from helpers.locations_v2 import LocationsV2Catalog, project_legacy_locations


CATALOG = {
    "schemaVersion": 2,
    "catalogVersion": "test-v2",
    "referenceYear": 2026,
    "regions": [
        {"id": "m49:001", "kind": "globalRegion", "name": "World", "parentId": None, "ancestors": [], "utcOffsets": [-480, -420, 60, 120]},
        {"id": "m49:150", "kind": "globalRegion", "name": "Europe", "parentId": "m49:001", "ancestors": ["m49:001"], "utcOffsets": [60, 120]},
        {"id": "m49:155", "kind": "globalRegion", "name": "Western Europe", "parentId": "m49:150", "ancestors": ["m49:150", "m49:001"], "utcOffsets": [60, 120]},
        {"id": "m49:019", "kind": "globalRegion", "name": "Americas", "parentId": "m49:001", "ancestors": ["m49:001"], "utcOffsets": [-480, -420]},
    ],
    "countries": [
        {"id": "iso3166:DE", "kind": "country", "name": "Germany", "aliases": [], "countryCode": "DE", "parentId": "m49:155", "ancestors": ["m49:155", "m49:150", "m49:001"], "utcOffsets": [60, 120]},
        {"id": "iso3166:US", "kind": "country", "name": "United States of America", "aliases": ["United States"], "countryCode": "US", "parentId": "m49:019", "ancestors": ["m49:019", "m49:001"], "utcOffsets": [-480, -420]},
    ],
    "adminRegions": [
        {"id": "geonames:10", "kind": "adminRegion", "name": "Bavaria", "aliases": [], "countryCode": "DE", "parentId": "iso3166:DE", "ancestors": ["iso3166:DE", "m49:155", "m49:150", "m49:001"], "utcOffsets": [60, 120]},
        {"id": "geonames:20", "kind": "adminRegion", "name": "Oregon", "aliases": [], "countryCode": "US", "parentId": "iso3166:US", "ancestors": ["iso3166:US", "m49:019", "m49:001"], "utcOffsets": [-480, -420]},
        {"id": "geonames:21", "kind": "adminRegion", "name": "Illinois", "aliases": [], "countryCode": "US", "parentId": "iso3166:US", "ancestors": ["iso3166:US", "m49:019", "m49:001"], "utcOffsets": [-360, -300]},
    ],
    "cities": [
        {"id": "geonames:100", "kind": "city", "name": "Hallbergmoos", "aliases": [], "countryCode": "DE", "admin1Id": "geonames:10", "parentId": "geonames:10", "ancestors": ["geonames:10", "iso3166:DE", "m49:155", "m49:150", "m49:001"], "utcOffsets": [60, 120]},
        {"id": "geonames:200", "kind": "city", "name": "Springfield", "aliases": [], "countryCode": "US", "admin1Id": "geonames:20", "parentId": "geonames:20", "ancestors": ["geonames:20", "iso3166:US", "m49:019", "m49:001"], "utcOffsets": [-480, -420]},
        {"id": "geonames:201", "kind": "city", "name": "Springfield", "aliases": [], "countryCode": "US", "admin1Id": "geonames:21", "parentId": "geonames:21", "ancestors": ["geonames:21", "iso3166:US", "m49:019", "m49:001"], "utcOffsets": [-360, -300]},
    ],
}


def test_city_projection_adds_ancestor_and_utc_facts():
    catalog = LocationsV2Catalog(CATALOG)
    result = project_legacy_locations(
        catalog,
        [{"id": 1, "countryName": "Germany", "countryCode": "DE", "cityName": "Hallbergmoos", "region": "Bavaria"}],
    )

    assert result["direct"] == [{
        "kind": "city",
        "locationId": "geonames:100",
        "displayName": "Hallbergmoos",
        "countryCode": "DE",
        "sourceLocationV1Id": 1,
    }]
    assert ("country", "iso3166:DE") in result["facts"]
    assert ("globalRegion", "m49:150") in result["facts"]
    assert result["utcOffsets"] == [60, 120]
    assert result["fallbackCount"] == 0


def test_ambiguous_city_falls_back_without_population_guessing():
    catalog = LocationsV2Catalog(CATALOG)
    result = project_legacy_locations(
        catalog,
        [{"id": 2, "countryName": "United States", "countryCode": "US", "cityName": "Springfield", "region": None}],
    )

    assert result["direct"][0]["locationId"] == "iso3166:US"
    assert result["fallbackCount"] == 1
    assert result["unresolvedCount"] == 0


def test_region_disambiguates_duplicate_city_name():
    catalog = LocationsV2Catalog(CATALOG)
    result = project_legacy_locations(
        catalog,
        [{"id": 3, "countryName": "United States", "countryCode": "US", "cityName": "Springfield", "region": "Oregon"}],
    )

    assert result["direct"][0]["locationId"] == "geonames:200"


def test_legacy_eu_maps_to_europe_region():
    catalog = LocationsV2Catalog(CATALOG)
    result = project_legacy_locations(
        catalog,
        [{"id": 4, "countryName": "European Union", "countryCode": "EU", "cityName": None, "region": None}],
    )

    assert result["direct"][0]["locationId"] == "m49:150"
    assert result["direct"][0]["kind"] == "globalRegion"


def test_unknown_country_keeps_no_false_geographic_fact():
    catalog = LocationsV2Catalog(CATALOG)
    result = project_legacy_locations(
        catalog,
        [{"id": 5, "countryName": "Unknownland", "countryCode": "ZZ", "cityName": "Somewhere", "region": None}],
    )

    assert result["direct"] == []
    assert result["facts"] == []
    assert result["utcOffsets"] == []
    assert result["unresolvedCount"] == 1


def test_legacy_country_name_variants_resolve_without_country_code():
    catalog = LocationsV2Catalog(CATALOG)

    cases = [
        ("US", "iso3166:US"),
        ("USA", "iso3166:US"),
        ("U.S.A", "iso3166:US"),
        ("Deutschland", "iso3166:DE"),
        ("Remote - Global", "m49:001"),
    ]

    for index, (country_name, expected_id) in enumerate(cases, start=10):
        result = project_legacy_locations(
            catalog,
            [{
                "id": index,
                "countryName": country_name,
                "countryCode": None,
                "cityName": None,
                "region": None,
            }],
        )

        assert result["direct"][0]["locationId"] == expected_id
        assert result["unresolvedCount"] == 0
