import importlib.util
import json
import sys
from pathlib import Path

import pytest

func = pytest.importorskip("azure.functions")
# The live HTTP suite can run without the local Functions runtime or ODBC.
try:
    import pyodbc
except ImportError:
    pytest.skip("Local Jobs route tests require pyodbc and unixODBC", allow_module_level=True)


JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from helpers.locations_v2 import LocationsV2Catalog
from helpers.validation import validate_job_payload


def _load_route(name):
    spec = importlib.util.spec_from_file_location(
        f"{name}_for_manual_location_test", JOBS_ROOT / "routes" / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


create_route = _load_route("jobs_create")
update_route = _load_route("jobs_update")
JOB_ID = "11111111-2222-3333-4444-555555555555"
USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
BERLIN = {"kind": "city", "locationId": "geonames:2950159"}
MUNICH = {"kind": "city", "locationId": "geonames:2867714"}
GERMANY = {"kind": "country", "locationId": "iso3166:DE"}
REGION = {"kind": "adminRegion", "locationId": "geonames:2951839"}
EUROPE = {"kind": "globalRegion", "locationId": "m49:150"}


class FakeApp:
    def route(self, **options):
        def register(function):
            self.handler = function
            return function
        return register


class FakeCursor:
    def __init__(self):
        self.executed = []
        self.many = []
        self.direct_id = 0
        self.locations_v2 = [("city", BERLIN["locationId"], "Berlin", "DE", "test-v2")]

    def execute(self, sql, *params):
        self.sql = " ".join(sql.split())
        self.params = params[0] if len(params) == 1 else params
        self.executed.append((self.sql, self.params))
        return self

    def fetchone(self):
        if "INSERT INTO dbo.JobOfferingLocationsV2" in self.sql:
            self.direct_id += 1
            return (self.direct_id,)
        if "INSERT INTO dbo.JobOfferings" in self.sql:
            return (JOB_ID,)
        return tuple(None for _ in update_route._MAPPING)

    def fetchall(self):
        if "FROM dbo.JobOfferingLocationsV2" in self.sql:
            return self.locations_v2
        if "FROM dbo.JobOfferingLocations " in self.sql:
            return [("Germany", "DE", "Legacy city", None)]
        return []

    def executemany(self, sql, rows):
        self.many.append((" ".join(sql.split()), list(rows)))


class FakeConnection:
    def __init__(self):
        self.cur = FakeCursor()
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


@pytest.fixture
def catalog():
    def item(selector, name, parent=None):
        return {
            "kind": selector["kind"], "id": selector["locationId"], "name": name,
            "countryCode": "DE" if selector["kind"] != "globalRegion" else None,
            "parentId": parent, "ancestors": [parent] if parent else [], "utcOffsets": [60, 120],
        }
    return LocationsV2Catalog({
        "schemaVersion": 2, "catalogVersion": "test-v2", "referenceYear": 2026,
        "regions": [item(EUROPE, "Europe")],
        "countries": [item(GERMANY, "Germany", EUROPE["locationId"])],
        "adminRegions": [item(REGION, "Bavaria", GERMANY["locationId"])],
        "cities": [item(BERLIN, "Berlin", GERMANY["locationId"]), item(MUNICH, "Munich", REGION["locationId"])],
    })


@pytest.fixture
def domain(monkeypatch, catalog):
    connection = FakeConnection()
    history = []
    for module in (create_route, update_route):
        monkeypatch.setattr(module, "get_connection", lambda: connection)
        monkeypatch.setattr(module, "load_locations_v2_catalog", lambda: catalog)
        monkeypatch.setattr(module, "detect_actor", lambda request: ("user", USER_ID))
        monkeypatch.setattr(module, "insert_history", lambda *args: history.append(args))
        monkeypatch.setattr(module, "emit_jobs_event", lambda *args, **kwargs: False)
    return connection, history


def _request(data, method):
    return func.HttpRequest(
        method=method, url="https://example.test/api/jobs", body=json.dumps(data).encode(),
        headers={"X-User-Id": USER_ID}, route_params={"id": JOB_ID},
    )


def _call(module, data, method):
    app = FakeApp()
    module.register(app)
    return app.handler(_request(data, method))


def _location_writes(cursor):
    return [(sql, params) for sql, params in cursor.executed if sql.startswith("INSERT INTO dbo.JobOfferingLocationsV2")]


def _assert_no_legacy_writes(cursor):
    for sql, _ in [*cursor.executed, *cursor.many]:
        assert not any(sql.startswith(f"{verb} dbo.JobOfferingLocations ") for verb in ("INSERT INTO", "DELETE FROM", "UPDATE"))


@pytest.mark.parametrize("locations", [[BERLIN], [BERLIN, MUNICH], [GERMANY], [REGION], [EUROPE], []])
def test_manual_create_writes_native_alternatives_without_legacy_rows(domain, locations):
    connection, _ = domain
    response = _call(create_route, {
        "url": "https://example.test/jobs/1", "externalId": "job-1", "hiringCompanyName": "Test company",
        "remoteType": "Hybrid", "locationsV2": locations,
    }, "POST")
    assert response.status_code == 201, response.get_body()
    assert connection.committed
    writes = _location_writes(connection.cur)
    assert [(params[1], params[2]) for _, params in writes] == [(item["kind"], item["locationId"]) for item in locations]
    assert all(params[5] is None for _, params in writes)
    _assert_no_legacy_writes(connection.cur)


@pytest.mark.parametrize("locations", [[MUNICH, EUROPE], []])
def test_manual_update_replaces_or_clears_v2_without_legacy_writes(domain, locations):
    connection, history = domain
    response = _call(update_route, {"locationsV2": locations}, "PUT")
    assert response.status_code == 200, response.get_body()
    assert connection.committed
    assert any(sql.startswith("DELETE FROM dbo.JobOfferingLocationsV2 ") for sql, _ in connection.cur.executed)
    assert [(params[1], params[2]) for _, params in _location_writes(connection.cur)] == [(item["kind"], item["locationId"]) for item in locations]
    assert "LocationsV2" in history[0][3]["changed"]
    _assert_no_legacy_writes(connection.cur)


def test_manual_update_rejects_unknown_canonical_id_before_database_access(domain, monkeypatch):
    def unexpected_connection():
        raise AssertionError("Invalid canonical identity must not start a write")
    monkeypatch.setattr(update_route, "get_connection", unexpected_connection)
    response = _call(update_route, {"locationsV2": [{"kind": "city", "locationId": "geonames:0"}]}, "PUT")
    assert response.status_code == 400
    assert b"not a valid canonical" in response.get_body()


def test_manual_create_rejects_unknown_canonical_id(domain):
    connection, _ = domain
    response = _call(create_route, {
        "url": "https://example.test/jobs/1", "externalId": "job-1", "hiringCompanyName": "Test company",
        "locationsV2": [{"kind": "city", "locationId": "geonames:0"}],
    }, "POST")
    assert response.status_code == 400
    assert not connection.committed
    assert _location_writes(connection.cur) == []
    assert connection.cur.executed == []


@pytest.mark.parametrize("value", [None, "not-a-list", ["not-an-object"], [{"kind": [], "locationId": "id"}], [{"kind": "city", "locationId": 123}]])
def test_invalid_v2_input_is_rejected_without_removing_selections(value):
    valid, message = validate_job_payload({"locationsV2": value}, for_update=True)
    assert not valid
    assert message.startswith("locationsV2")
