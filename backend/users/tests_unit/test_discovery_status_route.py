import importlib.util
import json
import sys
import types
from pathlib import Path
from unittest.mock import patch


class FakeHttpResponse:
    def __init__(self, body="", status_code=200, mimetype=None):
        self.body = body
        self.status_code = status_code
        self.mimetype = mimetype


class FakeRequest:
    pass


class FakeApp:
    def __init__(self):
        self.handler = None

    def route(self, **_kwargs):
        def decorate(function):
            self.handler = function
            return function

        return decorate


class FakeCursor:
    def __init__(self, row):
        self.row = row
        self.sql = None
        self.params = None

    def execute(self, sql, params):
        self.sql = sql
        self.params = params

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, row):
        self.cursor_value = FakeCursor(row)
        self.closed = False

    def cursor(self):
        return self.cursor_value

    def close(self):
        self.closed = True


def load_route(row, blob_texts=None):
    azure_module = types.ModuleType("azure")
    functions_module = types.ModuleType("azure.functions")
    functions_module.HttpRequest = FakeRequest
    functions_module.HttpResponse = FakeHttpResponse
    azure_module.functions = functions_module

    helpers_module = types.ModuleType("helpers")
    helpers_module.__path__ = []

    headers_module = types.ModuleType("helpers.b2c_headers")
    headers_module.get_b2c_headers = lambda _req: ("b2c-user", None, None)

    connection = FakeConnection(row)
    db_module = types.ModuleType("helpers.db")
    db_module.get_connection = lambda: connection

    blob_module = types.ModuleType("helpers.blob_storage")
    blob_texts = blob_texts or {}
    blob_module.download_text = lambda path: blob_texts.get(path)

    preferences_module = types.ModuleType("helpers.discovery_preferences")
    preferences_module.normalize_discovery_preferences = lambda value, **_kwargs: value

    readiness_path = Path(__file__).parents[1] / "helpers" / "discovery_readiness.py"
    readiness_spec = importlib.util.spec_from_file_location(
        "helpers.discovery_readiness", readiness_path
    )
    readiness_module = importlib.util.module_from_spec(readiness_spec)
    with patch.dict(
        sys.modules,
        {
            "helpers": helpers_module,
            "helpers.discovery_preferences": preferences_module,
        },
    ):
        readiness_spec.loader.exec_module(readiness_module)

    module_path = Path(__file__).parents[1] / "routes" / "discovery_status.py"
    spec = importlib.util.spec_from_file_location("discovery_status_for_test", module_path)
    module = importlib.util.module_from_spec(spec)
    modules = {
        "azure": azure_module,
        "azure.functions": functions_module,
        "helpers": helpers_module,
        "helpers.b2c_headers": headers_module,
        "helpers.db": db_module,
        "helpers.blob_storage": blob_module,
        "helpers.discovery_preferences": preferences_module,
        "helpers.discovery_readiness": readiness_module,
    }
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module, connection


def test_status_reports_both_actions_when_cv_and_positive_title_are_missing():
    module, connection = load_route(("user-id", None, None, None))
    app = FakeApp()
    module.register(app)

    response = app.handler(FakeRequest())

    assert response.status_code == 200
    assert json.loads(response.body) == {
        "schemaVersion": 1,
        "enabled": False,
        "hasUsableCv": False,
        "hasPositiveTitleRule": False,
        "reasons": ["no_usable_cv", "no_positive_title"],
    }
    assert connection.cursor_value.params == ("b2c-user",)
    assert connection.closed is True


def test_status_checks_saved_plaintext_instead_of_cv_metadata_only():
    preferences = json.dumps({
        "schemaVersion": 1,
        "title": {
            "positive": ["Manager"],
            "positivePatterns": [],
            "negative": [],
        },
        "eligibility": None,
    })
    module, _connection = load_route(
        ("user-id", "cv/text/current.txt", "version", preferences),
        {"cv/text/current.txt": "\n"},
    )
    app = FakeApp()
    module.register(app)

    response = app.handler(FakeRequest())

    payload = json.loads(response.body)
    assert payload["enabled"] is False
    assert payload["hasUsableCv"] is False
    assert payload["hasPositiveTitleRule"] is True
    assert payload["reasons"] == ["no_usable_cv"]
