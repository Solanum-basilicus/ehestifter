"""Check indexed Jobs detail presentation without a live SQL database."""

import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

JOBS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = JOBS_ROOT.parents[1]
for directory in (JOBS_ROOT, REPO_ROOT):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from helpers.locations_search_index import LocationsSearchIndex
from helpers.locations_v2 import LocationsV2Catalog
from helpers.locations_v2_store import (
    present_locations_v2_from_catalog,
    present_locations_v2_from_index,
)
from helpers.timing import TimedRoutes
from routes import jobs_get
from tests_unit.test_locations_v2_search import CATALOG
from tools.build_locations_v2_catalog import _write_search_index


STORED = [
    {"kind": "city", "locationId": "geonames:london-gb", "displayName": "Old London", "countryCode": "GB", "catalogVersion": "stored-v1"},
    {"kind": "adminRegion", "locationId": "geonames:ontario", "displayName": "Old Ontario", "countryCode": "CA", "catalogVersion": "stored-v1"},
    {"kind": "country", "locationId": "iso3166:GB", "displayName": "U.K.", "countryCode": "GB", "catalogVersion": "stored-v1"},
    {"kind": "globalRegion", "locationId": "m49:150", "displayName": "Europe", "countryCode": None, "catalogVersion": "stored-v1"},
    {"kind": "city", "locationId": "unknown-city", "displayName": "Unknown", "countryCode": "GB", "catalogVersion": "unknown-v1"},
    {"kind": "city", "locationId": "geonames:london-gb", "displayName": "Old London", "countryCode": "GB", "catalogVersion": "stored-v2"},
]


@pytest.fixture
def index(tmp_path):
    path = tmp_path / "locations.search.sqlite3"
    _write_search_index(path, CATALOG)
    return LocationsSearchIndex(path, CATALOG["catalogVersion"])


def test_index_presentation_matches_catalog_and_keeps_sql_row_order(index):
    catalog = LocationsV2Catalog(CATALOG)
    from_index = present_locations_v2_from_index(STORED, index)
    from_catalog = present_locations_v2_from_catalog(STORED, catalog)

    assert from_index == from_catalog
    assert [item["locationId"] for item in from_index] == [
        item["locationId"] for item in STORED
    ]
    assert from_index[-2] == STORED[-2]
    assert from_index[0]["catalogVersion"] == "stored-v1"
    assert from_index[-1]["catalogVersion"] == "stored-v2"
    assert from_index[2]["displayName"] == "United Kingdom"


def test_index_presentation_does_not_mutate_input(index):
    before = json.loads(json.dumps(STORED))
    assert present_locations_v2_from_index([], index) == []
    assert present_locations_v2_from_index(STORED, index)
    assert STORED == before


def test_index_lookup_is_safe_for_concurrent_reads(index):
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: present_locations_v2_from_index(STORED, index), range(8)))
    assert all(result == results[0] for result in results)


class FakeApp:
    def route(self, route, methods):
        assert route == "jobs/{id:guid}"
        assert methods == ["GET"]
        def register(handler):
            self.handler = handler
            return handler
        return register


class FakeCursor:
    def __init__(self, *, missing=False, failure=None, locations=None):
        self.missing = missing
        self.failure = failure
        self.locations = locations if locations is not None else STORED
        self.description = [("Id",), ("CreatedByUserId",)]
        self.query = None

    def execute(self, query, *params):
        if self.failure and self.failure in query:
            raise RuntimeError("SQL read failed")
        self.query = query
        return self

    def fetchone(self):
        return None if self.missing else ("job-1", None)

    def fetchall(self):
        if "JobOfferingLocationsV2" in self.query:
            return [
                (item["kind"], item["locationId"], item["displayName"], item["countryCode"], item["catalogVersion"])
                for item in self.locations
            ]
        if "JobOfferingLocations" in self.query:
            return [("Canada", "CA", "London", "Ontario")]
        return [(0, 120)]


class FakeConnection:
    def __init__(self, **options):
        self.cur = FakeCursor(**options)
        self.close_count = 0

    def cursor(self):
        return self.cur

    def close(self):
        self.close_count += 1


def invoke(monkeypatch, connection, *, mode="v2", index=None):
    monkeypatch.setattr(jobs_get, "get_connection", lambda: connection)
    monkeypatch.setattr(jobs_get, "active_location_model", lambda: mode)
    if index is not None:
        monkeypatch.setattr(jobs_get, "load_locations_search_index", index)
    app = FakeApp()
    jobs_get.register(TimedRoutes(app))
    from types import SimpleNamespace
    return app.handler(SimpleNamespace(route_params={"id": "job-1"}))


def test_get_job_uses_index_and_closes_sql_connection(monkeypatch, index):
    connection = FakeConnection()
    monkeypatch.setattr(jobs_get, "load_locations_v2_catalog", lambda: pytest.fail("Catalog must not load"))
    response = invoke(monkeypatch, connection, index=lambda: index)

    assert response.status_code == 200
    payload = json.loads(response.get_body())
    assert payload["locationsV2"] == present_locations_v2_from_catalog(STORED, LocationsV2Catalog(CATALOG))
    assert payload["locations"] == [{"countryName": "Canada", "countryCode": "CA", "cityName": "London", "region": "Ontario"}]
    assert payload["workTimeConstraintsV2"] == [{"offsetRangeStartMinutes": 0, "offsetRangeEndMinutes": 120}]
    assert payload["activeLocationModel"] == "v2"
    assert connection.close_count == 1
    header = response.headers["Server-Timing"]
    assert "step_location_lookup;dur=" in header
    assert 'location_display;desc="index"' in header
    assert "step_catalog_load;dur=" not in header


def test_get_job_uses_catalog_if_index_is_missing(monkeypatch):
    connection = FakeConnection()
    catalog = LocationsV2Catalog(CATALOG)
    monkeypatch.setattr(jobs_get, "load_locations_v2_catalog", lambda: catalog)

    def no_index():
        raise FileNotFoundError("Missing packaged index")

    response = invoke(monkeypatch, connection, index=no_index)
    assert response.status_code == 200
    assert json.loads(response.get_body())["locationsV2"] == present_locations_v2_from_catalog(STORED, catalog)
    assert 'location_display;desc="fallback"' in response.headers["Server-Timing"]
    assert "step_catalog_load;dur=" in response.headers["Server-Timing"]
    assert connection.close_count == 1


def test_get_job_uses_catalog_if_index_query_fails(monkeypatch):
    connection = FakeConnection()
    catalog = LocationsV2Catalog(CATALOG)
    monkeypatch.setattr(jobs_get, "load_locations_v2_catalog", lambda: catalog)

    class InvalidIndex:
        def lookup(self, selectors):
            raise sqlite3.OperationalError("locations table is missing")

    response = invoke(monkeypatch, connection, index=lambda: InvalidIndex())
    assert response.status_code == 200
    assert json.loads(response.get_body())["locationsV2"] == present_locations_v2_from_catalog(STORED, catalog)
    assert 'location_display;desc="fallback"' in response.headers["Server-Timing"]
    assert connection.close_count == 1


def test_get_job_closes_connection_if_both_display_sources_fail(monkeypatch):
    connection = FakeConnection()
    def unavailable():
        raise FileNotFoundError("No reference data")

    monkeypatch.setattr(jobs_get, "load_locations_v2_catalog", unavailable)
    response = invoke(monkeypatch, connection, index=unavailable)
    assert response.status_code == 500
    assert connection.close_count == 1


def test_get_job_skips_index_without_v2_rows(monkeypatch):
    connection = FakeConnection(locations=[])
    monkeypatch.setattr(jobs_get, "load_locations_search_index", lambda: pytest.fail("Index must not load"))
    monkeypatch.setattr(jobs_get, "load_locations_v2_catalog", lambda: pytest.fail("Catalog must not load"))

    response = invoke(monkeypatch, connection)
    assert response.status_code == 200
    assert json.loads(response.get_body())["locationsV2"] == []
    assert 'location_display;desc="stored"' in response.headers["Server-Timing"]
    assert connection.close_count == 1


def test_get_job_keeps_v1_storage_without_index(monkeypatch):
    connection = FakeConnection()
    monkeypatch.setattr(jobs_get, "load_locations_search_index", lambda: pytest.fail("Index must not load"))
    response = invoke(monkeypatch, connection, mode="v1")
    assert response.status_code == 200
    assert json.loads(response.get_body())["locationsV2"] == STORED
    assert connection.close_count == 1


@pytest.mark.parametrize("options, status", [
    ({"missing": True}, 404),
    ({"failure": "JobOfferingLocations"}, 500),
    ({"failure": "JobOfferingWorkTimeConstraintsV2"}, 500),
])
def test_get_job_closes_sql_on_early_return_and_failure(monkeypatch, options, status):
    connection = FakeConnection(**options)
    response = invoke(monkeypatch, connection, mode="v1")
    assert response.status_code == status
    assert connection.close_count == 1


def test_get_job_can_fail_before_connection_exists(monkeypatch):
    def fail():
        raise RuntimeError("Connection failed")
    monkeypatch.setattr(jobs_get, "get_connection", fail)
    app = FakeApp()
    jobs_get.register(app)
    from types import SimpleNamespace
    response = app.handler(SimpleNamespace(route_params={"id": "job-1"}))
    assert response.status_code == 500


def test_get_job_closes_connection_if_cursor_creation_fails(monkeypatch):
    class InvalidConnection(FakeConnection):
        def cursor(self):
            raise RuntimeError("Cursor failed")

    connection = InvalidConnection()
    response = invoke(monkeypatch, connection)
    assert response.status_code == 500
    assert connection.close_count == 1
