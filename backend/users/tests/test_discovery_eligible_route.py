import importlib.util
import json
import os
import sys
import types
import unittest
import uuid
from datetime import datetime
from pathlib import Path
from unittest.mock import patch


class FakeHttpResponse:
    def __init__(self, body="", status_code=200, mimetype=None):
        self.body = body
        self.status_code = status_code
        self.mimetype = mimetype


class FakeRequest:
    def __init__(self, params=None):
        self.params = params or {}


class FakeApp:
    def __init__(self):
        self.handler = None
        self.route_kwargs = None

    def route(self, **kwargs):
        self.route_kwargs = kwargs

        def decorate(function):
            self.handler = function
            return function

        return decorate


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.sql = None

    def execute(self, sql):
        self.sql = sql

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, rows):
        self.cursor_value = FakeCursor(rows)
        self.closed = False

    def cursor(self):
        return self.cursor_value

    def close(self):
        self.closed = True


def normalize_guid(value):
    return str(uuid.UUID(str(value))) if value not in (None, "") else None


def load_route_module(connection_factory):
    azure_module = types.ModuleType("azure")
    functions_module = types.ModuleType("azure.functions")
    functions_module.FunctionApp = object
    functions_module.HttpRequest = FakeRequest
    functions_module.HttpResponse = FakeHttpResponse
    functions_module.AuthLevel = types.SimpleNamespace(FUNCTION="FUNCTION")
    azure_module.functions = functions_module

    db_module = types.ModuleType("helpers.db")
    db_module.get_connection = connection_factory
    guid_module = types.ModuleType("helpers.guid")
    guid_module.normalize_guid = normalize_guid

    module_path = (
        Path(__file__).parents[1]
        / "routes"
        / "internal_discovery_eligible.py"
    )
    spec = importlib.util.spec_from_file_location(
        "phase6_internal_discovery_eligible",
        module_path,
    )
    module = importlib.util.module_from_spec(spec)
    with patch.dict(
        sys.modules,
        {
            "azure": azure_module,
            "azure.functions": functions_module,
            "helpers.db": db_module,
            "helpers.guid": guid_module,
        },
    ):
        spec.loader.exec_module(module)
    return module


class DiscoveryEligibleRouteTests(unittest.TestCase):
    def test_returns_bounded_metadata_without_cv_or_filter_text(self):
        user_id = "11111111-1111-4111-8111-111111111111"
        excluded_id = "22222222-2222-4222-8222-222222222222"
        cv_version = "a" * 64
        rows = [
            (
                user_id,
                cv_version,
                datetime(2026, 7, 24, 10, 0, 0),
                "33333333-3333-4333-8333-333333333333",
                json.dumps({"title": {"positive": ["Manager"]}}),
            ),
            (
                excluded_id,
                "b" * 64,
                datetime(2026, 7, 24, 10, 0, 0),
                "44444444-4444-4444-8444-444444444444",
                json.dumps({"title": {"positive": ["Engineer"]}}),
            ),
            # A joined second filter row must not double-count one exclusion.
            (
                excluded_id,
                "b" * 64,
                datetime(2026, 7, 24, 10, 0, 0),
                "55555555-5555-4555-8555-555555555555",
                "not-json",
            ),
        ]
        connection = FakeConnection(rows)
        module = load_route_module(lambda: connection)
        app = FakeApp()
        module.register(app)

        with patch.dict(
            os.environ,
            {"DISCOVERY_EXCLUDED_USER_IDS": excluded_id},
            clear=False,
        ):
            response = app.handler(FakeRequest({"limit": "25"}))

        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.body)
        self.assertEqual(payload["counts"]["eligible"], 1)
        self.assertEqual(payload["counts"]["excluded"], 1)
        self.assertEqual(payload["counts"]["limit"], 25)
        self.assertEqual(payload["users"][0]["userId"], user_id)
        self.assertEqual(payload["users"][0]["cvVersionId"], cv_version)
        self.assertEqual(payload["users"][0]["profiles"][0]["title"]["positive"], ["Manager"])
        serialized = json.dumps(payload).lower()
        self.assertNotIn("cvplaintext", serialized)
        self.assertNotIn("cvtextblobpath", serialized)
        self.assertNotIn("filtertext", serialized)
        self.assertIn("top (25)", connection.cursor_value.sql.lower())
        self.assertTrue(connection.closed)

    def test_invalid_limit_is_rejected_before_database_access(self):
        calls = []

        def connection_factory():
            calls.append(True)
            return FakeConnection([])

        module = load_route_module(connection_factory)
        app = FakeApp()
        module.register(app)
        response = app.handler(FakeRequest({"limit": "1001"}))
        self.assertEqual(response.status_code, 400)
        self.assertIn("between 1 and 1000", response.body)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
