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


def test_catalog_resolves_country_short_name_for_presentation():
    catalog = LocationsV2Catalog(CATALOG)
    country = catalog.get_location("country", "iso3166:GB")

    presentation = catalog.location_presentation(country)

    assert presentation["displayName"] == "United Kingdom"
