"""Check indexed locations in the list and bulk location routes."""

import json
import sys
from pathlib import Path

import azure.functions as func
import pytest

JOBS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = JOBS_ROOT.parents[1]
for directory in (JOBS_ROOT, REPO_ROOT):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from routes import jobs_list, job_locations_bulk
from helpers.locations_v2 import LocationsV2Catalog
from helpers.locations_search_index import LocationsSearchIndex
from tests_unit.test_locations_v2_search import CATALOG
from tools.build_locations_v2_catalog import _write_search_index

JOB_ID = "01234567-89ab-4cde-8f01-23456789abcd"
USER_ID = "12345678-1234-4234-8234-123456789abc"


class FakeApp:
    def __init__(self):
        self.routes = {}

    def route(self, route, methods):
        def register(handler):
            self.routes[route] = handler
            return handler
        return register


class FakeCursor:
    def __init__(self, fail=False):
        self.fail = fail
        self.query = ""
        self.description = []
        self.queries = []
        self.closed = False

    def execute(self, sql, params=()):
        self.query = sql
        self.queries.append(sql)
        if self.fail:
            raise RuntimeError("SQL failed")
        if "SELECT" in sql and "j.ExternalId" in sql:
            self.description = [(name,) for name in (
                "Id", "Title", "ExternalId", "FoundOn", "AtsVendor", "HiringCompanyName",
                "PostingCompanyName", "RemoteType", "FirstSeenAt", "CreatedAt",
                "UpdatedAt", "UserStatus", "UserStatusLastUpdated", "LastUpdateAt",
            )]
        return self

    def fetchone(self):
        return (1,)

    def fetchall(self):
        if "SELECT" in self.query and "j.ExternalId" in self.query:
            return [(JOB_ID, "Developer", None, None, None, None, None, "Remote",
                     None, None, None, None, None, None)]
        if "FROM dbo.JobOfferingLocationsV2" in self.query:
            return [(JOB_ID, "country", "iso3166:GB", "stored", "GB", "old-version")]
        if "FROM dbo.JobOfferingLocations" in self.query:
            return []
        return []

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, fail=False):
        self.cur = FakeCursor(fail)
        self.closed = False
        self.timeout = None

    def cursor(self):
        return self.cur

    def close(self):
        self.closed = True


@pytest.fixture
def index(tmp_path):
    path = tmp_path / "index.sqlite3"
    _write_search_index(path, CATALOG)
    return LocationsSearchIndex(path, CATALOG["catalogVersion"])


def request(method, path, params=None, body=None):
    from urllib.parse import urlencode
    suffix = f"?{urlencode(params)}" if params else ""
    return func.HttpRequest(
        method=method, url=f"https://jobs.example/api/{path}{suffix}",
        headers={"x-user-id": USER_ID}, params=params or {},
        body=json.dumps(body).encode() if body is not None else b"",
    )


def test_open_list_presents_locations_without_full_catalog(monkeypatch, index):
    connection = FakeConnection()
    monkeypatch.setattr(jobs_list, "get_connection", lambda: connection)
    monkeypatch.setattr(jobs_list, "active_location_model", lambda: "v2")
    monkeypatch.setattr(jobs_list, "load_locations_search_index", lambda: index)
    monkeypatch.setattr(jobs_list, "load_locations_v2_catalog", lambda: pytest.fail("No catalog read"))
    app = FakeApp()
    jobs_list.register(app)

    response = app.routes["jobs"](request("GET", "jobs", {"category": "open", "country": "GB"}))

    assert response.status_code == 200
    payload = json.loads(response.get_body())
    assert payload["items"][0]["locationsV2"] == [{
        **index.lookup([("country", "iso3166:GB")])[0][0], "catalogVersion": "old-version"
    }]
    assert connection.closed and connection.cur.closed
    assert any("JobOfferingLocationFactsV2" in sql for sql in connection.cur.queries)
    assert len(connection.cur.queries) == 4


def test_bulk_locations_uses_one_index_lookup_and_closes_connection(monkeypatch, index):
    connection = FakeConnection()
    monkeypatch.setattr(job_locations_bulk, "get_connection", lambda: connection)
    monkeypatch.setattr(job_locations_bulk, "active_location_model", lambda: "v2")
    monkeypatch.setattr(job_locations_bulk, "load_locations_search_index", lambda: index)
    monkeypatch.setattr(job_locations_bulk, "load_locations_v2_catalog", lambda: pytest.fail("No catalog read"))
    app = FakeApp()
    job_locations_bulk.register(app)

    response = app.routes["jobs/locations"](request("POST", "jobs/locations", body={"jobIds": [JOB_ID]}))

    assert response.status_code == 200
    payload = json.loads(response.get_body())
    assert payload["locationsV2"][JOB_ID][0]["displayName"] == "United Kingdom"
    assert payload["locationsV2"][JOB_ID][0]["catalogVersion"] == "old-version"
    assert connection.closed


def test_bulk_locations_uses_catalog_fallback(monkeypatch, index):
    connection = FakeConnection()
    monkeypatch.setattr(job_locations_bulk, "get_connection", lambda: connection)
    monkeypatch.setattr(job_locations_bulk, "active_location_model", lambda: "v2")
    monkeypatch.setattr(job_locations_bulk, "load_locations_search_index", lambda: (_ for _ in ()).throw(FileNotFoundError()))
    monkeypatch.setattr(job_locations_bulk, "load_locations_v2_catalog", lambda: LocationsV2Catalog(CATALOG))
    app = FakeApp()
    job_locations_bulk.register(app)
    response = app.routes["jobs/locations"](request("POST", "jobs/locations", body={"jobIds": [JOB_ID]}))
    assert response.status_code == 200
    assert json.loads(response.get_body())["locationsV2"][JOB_ID][0]["displayName"] == "United Kingdom"
    assert connection.closed


def test_bulk_locations_closes_connection_on_query_failure(monkeypatch):
    connection = FakeConnection(fail=True)
    monkeypatch.setattr(job_locations_bulk, "get_connection", lambda: connection)
    monkeypatch.setattr(job_locations_bulk, "active_location_model", lambda: "v2")
    app = FakeApp()
    job_locations_bulk.register(app)
    response = app.routes["jobs/locations"](request("POST", "jobs/locations", body={"jobIds": [JOB_ID]}))
    assert response.status_code == 500
    assert connection.closed


def test_open_list_uses_catalog_when_index_is_missing(monkeypatch):
    connection = FakeConnection()
    monkeypatch.setattr(jobs_list, "get_connection", lambda: connection)
    monkeypatch.setattr(jobs_list, "active_location_model", lambda: "v2")
    monkeypatch.setattr(
        jobs_list, "load_locations_search_index",
        lambda: (_ for _ in ()).throw(FileNotFoundError("Index unavailable")),
    )
    monkeypatch.setattr(jobs_list, "load_locations_v2_catalog", lambda: LocationsV2Catalog(CATALOG))
    app = FakeApp()
    jobs_list.register(app)

    response = app.routes["jobs"](request("GET", "jobs", {"category": "open", "country": "GB"}))

    assert response.status_code == 200
    payload = json.loads(response.get_body())
    assert payload["total"] == 1
    assert payload["items"][0]["locationsV2"][0]["displayName"] == "United Kingdom"
    assert connection.closed


def test_open_list_reports_index_and_query_timings(monkeypatch, index):
    from helpers.timing import TimedRoutes

    connection = FakeConnection()
    monkeypatch.setattr(jobs_list, "get_connection", lambda: connection)
    monkeypatch.setattr(jobs_list, "active_location_model", lambda: "v2")
    monkeypatch.setattr(jobs_list, "load_locations_search_index", lambda: index)
    app = FakeApp()
    jobs_list.register(TimedRoutes(app))

    response = app.routes["jobs"](request("GET", "jobs", {"category": "open", "country": "GB"}))

    assert response.status_code == 200
    header = response.headers["Server-Timing"]
    for step_name in ("count_query", "page_query", "country_lookup", "location_lookup", "location_v2_query"):
        assert f"step_{step_name};dur=" in header
    assert 'country_lookup_source;desc="index"' in header
    assert 'location_display;desc="index"' in header
    assert "step_catalog_load" not in header
