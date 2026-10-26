import sys
from pathlib import Path

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from helpers.locations_v2 import LocationsV2Catalog
from helpers.locations_v2_store import fetch_locations_v2


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
            "aliases": ["U.K", "United Kingdom", "Britain", "Reino Unido"],
            "countryCode": "GB",
            "parentId": "m49:150",
            "ancestors": ["m49:150", "m49:001"],
            "utcOffsets": [],
        },
        {
            "id": "iso3166:CA",
            "kind": "country",
            "name": "Canada",
            "aliases": ["CA", "ካናዳ"],
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


def test_catalog_resolves_country_short_name_for_presentation():
    catalog = LocationsV2Catalog(CATALOG)
    country = catalog.get_location("country", "iso3166:GB")

    presentation = catalog.location_presentation(country)

    assert presentation["displayName"] == "United Kingdom"


def test_country_display_names_use_english_catalog_names():
    cases = [
        ("DE", "Germany", ["Đức", "Deutschland", "DE"], "Germany"),
        (
            "GB",
            "United Kingdom of Great Britain and Northern Ireland",
            ["U.K", "GB", "Britain", "United Kingdom"],
            "United Kingdom",
        ),
        ("US", "United States of America", ["US", "USA", "United States"], "United States"),
        ("CA", "Canada", ["CA", "ካናዳ"], "Canada"),
        ("IR", "Iran (Islamic Republic of)", ["ایران", "Iran"], "Iran"),
        ("TR", "Türkiye", ["Turkey", "TR"], "Türkiye"),
    ]
    countries = [
        {
            "id": f"iso3166:{code}",
            "kind": "country",
            "name": name,
            "aliases": aliases,
            "countryCode": code,
        }
        for code, name, aliases, _ in cases
    ]
    catalog = LocationsV2Catalog({
        "schemaVersion": 2,
        "catalogVersion": "display-test-v2",
        "countries": countries,
    })

    for code, _, aliases, expected_name in cases:
        assert catalog.country_display_name(code) == expected_name
        country = catalog.get_location("country", f"iso3166:{code}")
        presentation = catalog.location_presentation(country)
        assert presentation["displayName"] == expected_name
        assert presentation["countryName"] == expected_name
        assert presentation["countryCode"] == code
        assert presentation["locationId"] == country["id"]
        assert catalog.resolve_country(None, aliases[0]) is country

    assert catalog.country_display_name("ZZ") is None
    assert catalog.country_display_name(None) is None


def test_city_and_region_presentations_use_english_country_name():
    catalog = LocationsV2Catalog(CATALOG)
    city = catalog.get_location("city", "geonames:london-gb")
    region = catalog.get_location("adminRegion", "geonames:england")

    city_presentation = catalog.location_presentation(city)
    assert city_presentation["countryName"] == "United Kingdom"
    assert city_presentation["label"] == "London, England, United Kingdom"
    assert city_presentation["contextLabel"] == "England · United Kingdom"
    assert city_presentation["locationId"] == city["id"]
    assert catalog.facts_for_location(city) == sorted([
        ("city", city["id"]),
        ("adminRegion", region["id"]),
        ("country", "iso3166:GB"),
        ("globalRegion", "m49:150"),
        ("globalRegion", "m49:001"),
    ])

    region_presentation = catalog.location_presentation(region)
    assert region_presentation["countryName"] == "United Kingdom"
    assert region_presentation["label"] == "England, United Kingdom"
    assert region_presentation["countryCode"] == "GB"


def test_job_location_reads_replace_stored_names_with_catalog_names():
    class FakeCursor:
        def execute(self, sql, params):
            assert "JobOfferingLocationsV2" in sql
            assert params == ("job-id",)

        def fetchall(self):
            return [
                ("country", "iso3166:GB", "U.K", "GB", "search-test-v2"),
                ("city", "geonames:london-gb", "London", "GB", "search-test-v2"),
            ]

    rows = fetch_locations_v2(FakeCursor(), "job-id", LocationsV2Catalog(CATALOG))

    assert rows[0]["displayName"] == "United Kingdom"
    assert rows[0]["countryName"] == "United Kingdom"
    assert rows[1]["countryName"] == "United Kingdom"
    assert rows[1]["label"] == "London, England, United Kingdom"
