import sys
from pathlib import Path

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from helpers.locations_search_index import (
    DEFAULT_INDEX_PATH,
    LocationsSearchIndex,
    load_locations_search_index,
)


def test_packaged_search_index_matches_catalog_manifest():
    index = load_locations_search_index()

    assert index.catalog_version == "1de6612eef2c100cf32d"
    assert DEFAULT_INDEX_PATH.is_file()


def test_search_index_disambiguates_london_ontario_in_both_word_orders():
    index = load_locations_search_index()

    forward = index.search("London Ontario", limit=8)
    reverse = index.search("Ontario London", limit=8)

    assert [item["locationId"] for item in forward] == ["geonames:6058560"]
    assert [item["locationId"] for item in reverse] == ["geonames:6058560"]
    assert forward[0]["label"] == "London, Ontario, Canada"


def test_search_index_accepts_exact_country_code():
    index = load_locations_search_index()

    results = index.search("GB", limit=8)

    assert results[0]["locationId"] == "iso3166:GB"
    assert results[0]["displayName"] == "United Kingdom"


def test_search_index_lookup_returns_missing_separately():
    index = LocationsSearchIndex(DEFAULT_INDEX_PATH, "1de6612eef2c100cf32d")

    items, missing = index.lookup(
        [
            ("globalRegion", "m49:150"),
            ("city", "geonames:6058560"),
            ("country", "iso3166:ZZ"),
        ]
    )

    assert [item["locationId"] for item in items] == ["m49:150", "geonames:6058560"]
    assert missing == [{"kind": "country", "locationId": "iso3166:ZZ"}]


def test_search_index_rejects_catalog_version_mismatch(tmp_path):
    import sqlite3
    import pytest

    path = tmp_path / "search.sqlite3"
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("INSERT INTO metadata VALUES ('catalogVersion', 'other-version')")
        conn.commit()
    finally:
        conn.close()

    with pytest.raises(ValueError, match="does not match"):
        LocationsSearchIndex(path, "expected-version")


def test_search_index_coverage_expands_region_and_marks_country_exclusion():
    index = load_locations_search_index()

    preview = index.coverage_preview(
        [("globalRegion", "m49:150")],
        [("country", "iso3166:BG")],
        False,
    )

    europe = next(item for item in preview["regions"] if item["locationId"] == "m49:150")
    by_code = {item["countryCode"]: item for item in europe["countries"]}
    assert by_code["BG"]["state"] == "excluded"
    assert by_code["DE"]["state"] == "included"
    assert preview["allowUnknownLocation"] is False


def test_search_index_coverage_marks_country_partial_for_narrow_rules():
    index = load_locations_search_index()

    included_city = index.coverage_preview(
        [("city", "geonames:6058560")],
        [],
        True,
    )
    canada = next(
        country
        for region in included_city["regions"]
        for country in region["countries"]
        if country["countryCode"] == "CA"
    )
    assert canada["state"] == "partial"
    assert canada["includedPlaces"][0]["label"] == "London, Ontario, Canada"

    excluded_city = index.coverage_preview(
        [("country", "iso3166:CA")],
        [("city", "geonames:6058560")],
        False,
    )
    canada = next(
        country
        for region in excluded_city["regions"]
        for country in region["countries"]
        if country["countryCode"] == "CA"
    )
    assert canada["state"] == "partial"
    assert canada["excludedPlaces"][0]["label"] == "London, Ontario, Canada"


def test_search_index_coverage_rejects_exact_include_exclude_conflict():
    import pytest

    index = load_locations_search_index()

    with pytest.raises(ValueError, match="cannot be included and excluded"):
        index.coverage_preview(
            [("globalRegion", "m49:150")],
            [("globalRegion", "m49:150")],
            False,
        )
