"""Verify that failed enrichment requests log only operational metadata."""

import importlib.util
import logging
import sys
from pathlib import Path

from flask import Flask


CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))


def _load_route(name):
    spec = importlib.util.spec_from_file_location(
        f"{name}_telemetry_test", CORE_ROOT / "routes" / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


run_route = _load_route("ui_enrichment_runs_post")
latest_route = _load_route("ui_enrichment_latest_get")


class FakeAuth:
    def login_required(self, handler):
        def wrapped(*args, **kwargs):
            return handler(*args, context={"user": {"sub": "test-user"}}, **kwargs)

        return wrapped


class FakeResponse:
    status_code = 502
    text = "PRIVATE-UPSTREAM-ERROR"
    headers = {"server": "PRIVATE-UPSTREAM-HEADER"}


def _make_client(route):
    app = Flask(__name__)
    app.register_blueprint(route.create_blueprint(FakeAuth()))
    return app.test_client()


def test_run_failure_logs_status_without_body_or_headers(monkeypatch, caplog):
    monkeypatch.setattr(run_route, "get_in_app_user_id", lambda context: "user-1")
    monkeypatch.setattr(run_route, "enrichers_base", lambda: "https://enrichers.example")
    monkeypatch.setattr(run_route, "enrichers_fx_headers", lambda context: {})
    monkeypatch.setattr(run_route, "fx_post_json", lambda *args, **kwargs: FakeResponse())

    with caplog.at_level(logging.ERROR):
        response = _make_client(run_route).post(
            "/ui/enrichment/runs", json={"jobId": "job-1"}
        )

    assert response.status_code == 502
    assert response.json["details"]["text"] == FakeResponse.text
    assert "Enricher run failed" in caplog.text
    assert "status=502" in caplog.text
    assert "PRIVATE-UPSTREAM" not in caplog.text


def test_latest_failure_logs_status_without_body_or_headers(monkeypatch, caplog):
    monkeypatch.setattr(latest_route, "get_in_app_user_id", lambda context: "user-1")
    monkeypatch.setattr(latest_route, "enrichers_base", lambda: "https://enrichers.example")
    monkeypatch.setattr(latest_route, "enrichers_fx_headers", lambda context: {})
    monkeypatch.setattr(
        latest_route, "fx_get_json_safe", lambda *args, **kwargs: (FakeResponse(), None)
    )

    with caplog.at_level(logging.ERROR):
        response = _make_client(latest_route).get(
            "/ui/enrichment/subjects/job-1/latest"
        )

    assert response.status_code == 502
    assert response.json["details"]["text"] == FakeResponse.text
    assert "Latest failed" in caplog.text
    assert "status=502" in caplog.text
    assert "PRIVATE-UPSTREAM" not in caplog.text
