"""Check that Core sends one Jobs list request and reports failures."""

import importlib.util
import sys
from pathlib import Path

import pytest
import requests
from flask import Flask

CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

SPEC = importlib.util.spec_from_file_location(
    "ui_jobs_list_timeout_for_test", CORE_ROOT / "routes" / "ui_jobs_list.py"
)
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class FakeAuth:
    def login_required(self, handler):
        def wrapped(*args, **kwargs):
            return handler(*args, context={"user": {"sub": "test-user"}}, **kwargs)
        return wrapped


class FakeResponse:
    def __init__(self, status_code=200):
        self.status_code = status_code


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(proxy, "get_in_app_user_id", lambda context: "user-1")
    monkeypatch.setattr(proxy, "jobs_base", lambda: "https://jobs.test/api")
    monkeypatch.setattr(proxy, "jobs_fx_headers", lambda context=None: {"X-User-Id": "user-1"})
    monkeypatch.setattr(proxy, "memo_get", lambda *args, **kwargs: None)
    saved = []
    events = []
    monkeypatch.setattr(proxy, "memo_put", lambda *args: saved.append(args))
    monkeypatch.setattr(proxy, "emit_core_event", lambda *args, **kwargs: events.append((args, kwargs)))
    app = Flask(__name__)
    app.register_blueprint(proxy.create_blueprint(FakeAuth()))
    return app.test_client(), saved, events


def test_jobs_list_sends_one_request_and_caches_success(monkeypatch, client):
    web_client, saved, events = client
    calls = []

    def send(url, headers, params, timeout):
        calls.append((url, params, timeout))
        return FakeResponse(), {"items": [], "total": 0}

    monkeypatch.setattr(proxy, "fx_get_json_safe", send)
    response = web_client.get("/ui/jobs?category=my&q=developer")

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0][2] == 20
    assert calls[0][1]["q"] == "developer"
    assert response.get_json()["limit"] == 25
    assert len(saved) == 1
    assert len(events) == 2


@pytest.mark.parametrize("status", [400, 500, 504])
def test_jobs_list_does_not_retry_or_cache_failed_response(monkeypatch, client, status):
    web_client, saved, events = client
    calls = []

    def send(*args, **kwargs):
        calls.append(1)
        return FakeResponse(status), {"error": "jobs_query_timeout"}

    monkeypatch.setattr(proxy, "fx_get_json_safe", send)
    response = web_client.get("/ui/jobs?q=developer")

    assert response.status_code == {400: 400, 500: 502, 504: 504}[status]
    assert len(calls) == 1
    assert not saved
    assert not events
    if status == 504:
        assert response.get_json()["error"] == "jobs_query_timeout"


@pytest.mark.parametrize(
    "error,expected_status",
    [(requests.Timeout("timeout"), 504), (requests.ConnectionError("lost"), 502)],
)
def test_jobs_list_does_not_retry_connection_failures(monkeypatch, client, error, expected_status):
    web_client, saved, events = client
    calls = []

    def send(*args, **kwargs):
        calls.append(1)
        raise error

    monkeypatch.setattr(proxy, "fx_get_json_safe", send)
    response = web_client.get("/ui/jobs?category=open")

    assert response.status_code == expected_status
    assert len(calls) == 1
    assert not saved
    assert not events


def test_list_cache_can_be_disabled_without_changing_source(monkeypatch, client):
    web_client, saved, events = client
    cache_reads = []
    calls = []
    monkeypatch.setenv("EHESTIFTER_JOBS_LIST_CACHE_ENABLED", "false")
    monkeypatch.setattr(proxy, "memo_get", lambda *args, **kwargs: cache_reads.append(1))
    monkeypatch.setattr(proxy, "fx_get_json_safe", lambda *args, **kwargs: (
        calls.append(1) or FakeResponse(), {"items": [], "total": 0}
    ))

    for _ in range(2):
        response = web_client.get("/ui/jobs?category=my")
        assert response.status_code == 200

    assert not cache_reads
    assert not saved
    assert len(calls) == 2
    assert len(events) == 2


def test_list_cache_stays_enabled_by_default(monkeypatch, client):
    web_client, saved, _ = client
    monkeypatch.delenv("EHESTIFTER_JOBS_LIST_CACHE_ENABLED", raising=False)
    monkeypatch.setattr(proxy, "memo_get", lambda *args, **kwargs: {"items": [], "total": 3})
    monkeypatch.setattr(proxy, "fx_get_json_safe", lambda *args, **kwargs: (
        __import__("pytest").fail("Cache hit must not call Jobs")
    ))

    response = web_client.get("/ui/jobs")
    assert response.get_json()["total"] == 3
    assert not saved
