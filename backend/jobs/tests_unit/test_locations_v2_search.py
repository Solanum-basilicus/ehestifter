import sys
from pathlib import Path

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from helpers.locations_v2 import LocationsV2Catalog


CATALOG = {
    "schemaVersion": 2,
    "catalogVersion": "search-test-v2",
    "referenceYear": 2026,
    "regions": [
        {"id": "m49:001", "kind": "globalRegion", "name": "World", "parentId": None, "ancestors": [], "utcOffsets": []},
        {"id": "m49:150", "kind": "globalRegion", "name": "Europe", "parentId": "m49:001", "ancestors": ["m49:001"], "utcOffsets": []},
        {"id": "m49:019", "kind": "globalRegion", "name": "Americas", "parentId": "m49:001", "ancestors": ["m49:001"], "utcOffsets": []},
    ],
    "countries": [
        {
            "id": "iso3166:GB",
            "kind": "country",
            "name": "United Kingdom of Great Britain and Northern Ireland",
            "aliases": ["United Kingdom"],
            "countryCode": "GB",
            "parentId": "m49:150",
            "ancestors": ["m49:150", "m49:001"],
            "utcOffsets": [],
        },
        {
            "id": "iso3166:CA",
            "kind": "country",
            "name": "Canada",
            "aliases": [],
            "countryCode": "CA",
            "parentId": "m49:019",
            "ancestors": ["m49:019", "m49:001"],
            "utcOffsets": [],
        },
    ],
    "adminRegions": [
        {
            "id": "geonames:england",
            "kind": "adminRegion",
            "name": "England",
            "aliases": [],
            "countryCode": "GB",
            "parentId": "iso3166:GB",
            "ancestors": ["iso3166:GB", "m49:150", "m49:001"],
            "utcOffsets": [],
        },
        {
            "id": "geonames:ontario",
            "kind": "adminRegion",
            "name": "Ontario",
            "aliases": [],
            "countryCode": "CA",
            "parentId": "iso3166:CA",
            "ancestors": ["iso3166:CA", "m49:019", "m49:001"],
            "utcOffsets": [],
        },
    ],
    "cities": [
        {
            "id": "geonames:london-gb",
            "kind": "city",
            "name": "London",
            "aliases": [],
            "countryCode": "GB",
            "admin1Id": "geonames:england",
            "parentId": "geonames:england",
            "ancestors": ["geonames:england", "iso3166:GB", "m49:150", "m49:001"],
            "population": 8961989,
            "utcOffsets": [],
        },
        {
            "id": "geonames:london-ca",
            "kind": "city",
            "name": "London",
            "aliases": [],
            "countryCode": "CA",
            "admin1Id": "geonames:ontario",
            "parentId": "geonames:ontario",
            "ancestors": ["geonames:ontario", "iso3166:CA", "m49:019", "m49:001"],
            "population": 422324,
            "utcOffsets": [],
        },
    ],
}


def test_search_ranks_more_populous_same_name_city_first():
    catalog = LocationsV2Catalog(CATALOG)

    results = catalog.search_locations("London", limit=8)

    assert [item["locationId"] for item in results[:2]] == [
        "geonames:london-gb",
        "geonames:london-ca",
    ]
    assert results[0]["label"] == "London, England, United Kingdom"
    assert results[1]["label"] == "London, Ontario, Canada"


def test_search_uses_hierarchy_text_to_disambiguate_city():
    catalog = LocationsV2Catalog(CATALOG)

    results = catalog.search_locations("London Ontario", limit=8)

    assert [item["locationId"] for item in results] == ["geonames:london-ca"]


def test_search_accepts_exact_country_code_and_uses_short_country_name():
    catalog = LocationsV2Catalog(CATALOG)

    results = catalog.search_locations("GB", limit=8)

    assert results == [
        {
            "kind": "country",
            "locationId": "iso3166:GB",
            "displayName": "United Kingdom",
            "adminRegionName": None,
            "countryCode": "GB",
            "countryName": "United Kingdom",
            "contextLabel": "",
            "label": "United Kingdom",
            "catalogVersion": "search-test-v2",
        }
    ]


def test_search_matches_city_and_non_adjacent_country_context():
    catalog = LocationsV2Catalog(CATALOG)

    results = catalog.search_locations("London Canada", limit=8)

    assert [item["locationId"] for item in results] == ["geonames:london-ca"]
