import importlib.util
import sys
from pathlib import Path

from flask import Flask


CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

MODULE_PATH = CORE_ROOT / "routes" / "ui_job_history_get.py"
SPEC = importlib.util.spec_from_file_location("ui_job_history_get_for_test", MODULE_PATH)
job_history_route = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(job_history_route)

USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
JOB_ID = "11111111-2222-3333-4444-555555555555"


class FakeAuth:
    def login_required(self, function):
        def wrapped(*args, **kwargs):
            return function(*args, context={"user": {"sub": "test-user"}}, **kwargs)

        return wrapped


class FakeResponse:
    status_code = 200
    text = ""

    def json(self):
        return {"items": [], "nextCursor": None}


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(job_history_route.create_blueprint(FakeAuth()))
    return app


def test_job_history_proxy_sends_current_user_id(monkeypatch):
    captured = {}

    monkeypatch.setattr(job_history_route, "get_in_app_user_id", lambda context: USER_ID)
    monkeypatch.setattr(job_history_route, "jobs_base", lambda: "https://jobs.example/api")

    def fake_headers(context=None):
        captured["header_context"] = context
        return {"X-User-Id": context["userId"]}

    def fake_get(url, headers, params, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["params"] = params
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(job_history_route, "jobs_fx_headers", fake_headers)
    monkeypatch.setattr(job_history_route.requests, "get", fake_get)

    client = _make_app().test_client()
    response = client.get(f"/ui/jobs/{JOB_ID}/history?limit=7&cursor=test-cursor")

    assert response.status_code == 200
    assert captured["header_context"] == {"userId": USER_ID}
    assert captured["headers"]["X-User-Id"] == USER_ID
    assert captured["url"] == f"https://jobs.example/api/jobs/{JOB_ID}/history"
    assert captured["params"] == {"limit": "7", "cursor": "test-cursor"}
    assert captured["timeout"] == 10


def test_job_history_proxy_stops_when_current_user_id_is_not_available(monkeypatch):
    def fail_user_lookup(context):
        raise ValueError("No user")

    def unexpected_get(*args, **kwargs):
        raise AssertionError("Jobs API must not be called without a user id")

    monkeypatch.setattr(job_history_route, "get_in_app_user_id", fail_user_lookup)
    monkeypatch.setattr(job_history_route.requests, "get", unexpected_get)

    client = _make_app().test_client()
    response = client.get(f"/ui/jobs/{JOB_ID}/history")

    assert response.status_code == 401
    assert response.get_json() == {"error": "Could not resolve in-app user id"}
