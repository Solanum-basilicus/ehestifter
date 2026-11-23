"""Offline tests for the user-specific company application summary proxy."""

import importlib.util
import sys
from pathlib import Path

from flask import Flask

CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

MODULE_PATH = CORE_ROOT / "routes" / "ui_job_company_applications_get.py"
SPEC = importlib.util.spec_from_file_location("company_application_proxy_for_test", MODULE_PATH)
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)

USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
JOB_ID = "11111111-2222-3333-4444-555555555555"


class FakeAuth:
    def login_required(self, function):
        def wrapped(*args, **kwargs):
            return function(*args, context={"user": {"sub": "session-user"}}, **kwargs)
        return wrapped


class FakeResponse:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self.ok = status < 400
        self.payload = payload

    def json(self):
        if self.payload is None:
            raise ValueError("Bad JSON")
        return self.payload


def make_client():
    app = Flask(__name__)
    app.register_blueprint(proxy.create_blueprint(FakeAuth()))
    return app.test_client()


def test_proxy_passes_authenticated_user_and_does_not_cache(monkeypatch):
    calls = []
    monkeypatch.setattr(proxy, "get_in_app_user_id", lambda context: USER_ID)
    monkeypatch.setattr(proxy, "jobs_base", lambda: "https://jobs.example/api")
    monkeypatch.setattr(proxy, "jobs_fx_headers", lambda context: {"X-User-Id": context["userId"]})

    def fake_get(url, headers, timeout):
        calls.append((url, headers, timeout))
        return FakeResponse(200, {"available": True, "last90Days": 1, "last365Days": 3})

    monkeypatch.setattr(proxy, "fx_get", fake_get)
    client = make_client()
    for _ in range(2):
        response = client.get(f"/ui/jobs/{JOB_ID}/company-application-summary?userId=wrong-user")
        assert response.status_code == 200
        assert response.get_json()["last90Days"] == 1

    assert calls == [
        (f"https://jobs.example/api/jobs/{JOB_ID}/company-application-summary",
         {"X-User-Id": USER_ID}, 10),
    ] * 2


def test_proxy_rejects_missing_identity_before_calling_jobs(monkeypatch):
    def no_user(_context):
        raise ValueError("No user")

    def no_jobs_call(*args, **kwargs):
        raise AssertionError("Jobs must not be called without a user")

    monkeypatch.setattr(proxy, "get_in_app_user_id", no_user)
    monkeypatch.setattr(proxy, "fx_get", no_jobs_call)
    response = make_client().get(f"/ui/jobs/{JOB_ID}/company-application-summary")
    assert response.status_code == 401


def test_proxy_preserves_jobs_errors(monkeypatch):
    monkeypatch.setattr(proxy, "get_in_app_user_id", lambda context: USER_ID)
    monkeypatch.setattr(proxy, "jobs_base", lambda: "https://jobs.example/api")
    monkeypatch.setattr(proxy, "jobs_fx_headers", lambda context: {"X-User-Id": context["userId"]})
    monkeypatch.setattr(proxy, "fx_get", lambda *args, **kwargs: FakeResponse(404, None))
    response = make_client().get(f"/ui/jobs/{JOB_ID}/company-application-summary")
    assert response.status_code == 404
    assert response.get_json() == {"error": "bad-upstream"}


def test_proxy_rejects_success_without_json(monkeypatch):
    monkeypatch.setattr(proxy, "get_in_app_user_id", lambda context: USER_ID)
    monkeypatch.setattr(proxy, "jobs_base", lambda: "https://jobs.example/api")
    monkeypatch.setattr(proxy, "jobs_fx_headers", lambda context: {"X-User-Id": context["userId"]})
    monkeypatch.setattr(proxy, "fx_get", lambda *args, **kwargs: FakeResponse(200, None))
    response = make_client().get(f"/ui/jobs/{JOB_ID}/company-application-summary")
    assert response.status_code == 502
    assert response.get_json() == {"error": "bad-upstream"}
