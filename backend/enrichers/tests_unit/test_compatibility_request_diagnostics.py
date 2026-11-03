"""Test safe request diagnostics without a network or database."""

import json
import logging
import uuid
from unittest.mock import Mock

import azure.functions as func

from helpers.compatibility_diagnostics import (
    SubjectLockError, classify_failure, safe_correlation_id,
)
from helpers.timing import timed_handler
from routes import enrichment_runs_post as route


JOB = "33333333-3333-4333-8333-333333333333"
USER = "11111111-1111-4111-8111-111111111111"
CORR = "22222222-2222-4222-8222-222222222222"
RUN = "44444444-4444-4444-8444-444444444444"


class TestApp:
    def route(self, **_kwargs):
        def decorator(handler):
            self.handler = timed_handler(handler)
            return handler
        return decorator


def request():
    return func.HttpRequest(
        method="POST", url="https://test/api/enrichment/runs",
        headers={"x-correlation-id": CORR, "x-source-surface": "system"},
        body=json.dumps({
            "jobOfferingId": JOB, "userId": USER, "enricherType": "compatibility.v1",
            "requestMode": "automatic",
        }).encode(),
    )


def created_run():
    return {
        "runId": RUN, "decision": "created", "jobOfferingId": JOB,
        "userId": USER, "enricherType": "compatibility.v1",
        "subjectKey": f"{JOB}:{USER}",
    }


def setup(monkeypatch):
    app = TestApp()
    reader = Mock()
    reader.get_run.return_value = {"runId": RUN, "status": "Pending"}
    monkeypatch.setattr(route, "RunsService", lambda: reader)
    monkeypatch.setattr(route, "create_run_db", lambda *_args, **_kwargs: created_run())
    route.register(app)
    return app.handler, reader


def test_database_failure_returns_safe_http_500(monkeypatch, caplog):
    handler, _ = setup(monkeypatch)
    def fail(*_args, **_kwargs):
        raise RuntimeError("CV PRIVATE EMAIL and SQL connection string")
    monkeypatch.setattr(route, "create_run_db", fail)
    with caplog.at_level(logging.ERROR):
        response = handler(request())
    assert response.status_code == 500
    assert response.headers["x-enrichment-failure-stage"] == "run_create"
    assert response.headers["x-enrichment-failure-category"] == "db_operation"
    assert "PRIVATE" not in response.get_body().decode()
    assert "PRIVATE" not in caplog.text
    assert f"corr={CORR}" in caplog.text
    assert len([entry for entry in caplog.records if "enrichment_run_failure" in entry.message]) == 1


def test_snapshot_failure_returns_pending_with_safe_diagnostics(monkeypatch, caplog):
    handler, reader = setup(monkeypatch)
    monkeypatch.setattr(route, "get_job_snapshot", Mock(side_effect=TimeoutError("PRIVATE CV DATA")))
    with caplog.at_level(logging.ERROR):
        response = handler(request())
    assert response.status_code == 201
    assert response.headers["x-enrichment-failure-stage"] == "job_snapshot"
    assert response.headers["x-enrichment-failure-category"] == "upstream_timeout"
    assert json.loads(response.get_body())["status"] == "Pending"
    assert "PRIVATE" not in caplog.text
    reader.get_run.assert_called_once_with(RUN)


def test_dispatch_failure_does_not_mark_queued(monkeypatch):
    handler, _ = setup(monkeypatch)
    monkeypatch.setattr(route, "get_job_snapshot", lambda *_: {
        "jobName": "Title", "jobDescription": "Description",
    })
    monkeypatch.setattr(route, "get_user_cv_snapshot", lambda *_: {"CVPlainText": "PRIVATE CV"})
    monkeypatch.setattr(route, "write_input_snapshot", lambda *_: "runs/id/input.json")
    dispatcher = Mock(side_effect=RuntimeError("PRIVATE GATEWAY RESPONSE"))
    queued = Mock()
    monkeypatch.setattr(route, "dispatch_via_gateway", dispatcher)
    monkeypatch.setattr(route, "mark_queued", queued)
    response = handler(request())
    assert response.status_code == 201
    assert response.headers["x-enrichment-failure-stage"] == "gateway_dispatch"
    assert response.headers["x-enrichment-failure-category"] == "gateway_dispatch"
    dispatcher.assert_called_once()
    queued.assert_not_called()
    assert "PRIVATE" not in response.get_body().decode()


def test_post_dispatch_failure_is_safe_http_500(monkeypatch, caplog):
    handler, _ = setup(monkeypatch)
    monkeypatch.setattr(route, "get_job_snapshot", lambda *_: {
        "jobName": "Title", "jobDescription": "Description",
    })
    monkeypatch.setattr(route, "get_user_cv_snapshot", lambda *_: {"CVPlainText": "PRIVATE CV"})
    monkeypatch.setattr(route, "write_input_snapshot", lambda *_: "runs/id/input.json")
    dispatcher = Mock()
    monkeypatch.setattr(route, "dispatch_via_gateway", dispatcher)
    monkeypatch.setattr(route, "mark_queued", Mock(side_effect=RuntimeError("PRIVATE SQL ERROR")))
    with caplog.at_level(logging.ERROR):
        response = handler(request())
    assert response.status_code == 500
    assert response.headers["x-enrichment-failure-stage"] == "mark_queued"
    assert response.headers["x-enrichment-failure-category"] == "db_operation"
    dispatcher.assert_called_once()
    assert "PRIVATE" not in response.get_body().decode()
    assert "PRIVATE" not in caplog.text


def test_reused_run_does_not_fetch_inputs_or_log_errors(monkeypatch, caplog):
    handler, reader = setup(monkeypatch)
    monkeypatch.setattr(route, "create_run_db", lambda *_args, **_kwargs: {
        "runId": RUN, "decision": "reused",
    })
    fetch = Mock()
    monkeypatch.setattr(route, "get_job_snapshot", fetch)
    with caplog.at_level(logging.ERROR):
        response = handler(request())
    assert response.status_code == 200
    assert json.loads(response.get_body())["decision"] == "reused"
    reader.get_run.assert_called_once_with(RUN)
    fetch.assert_not_called()
    assert not caplog.records


def test_invalid_correlation_does_not_enter_logs():
    corr = safe_correlation_id({"x-correlation-id": "PRIVATE NEWLINE\nEMAIL"})
    assert str(uuid.UUID(corr)) == corr
    assert safe_correlation_id({"x-correlation-id": CORR}) == CORR


def test_subject_lock_has_a_fixed_category():
    assert classify_failure(SubjectLockError("detail"), "run_create") == "db_subject_lock"


def test_sqlstate_is_limited_to_five_safe_characters():
    import pyodbc
    from helpers.compatibility_diagnostics import diagnostic, diagnostic_headers
    from helpers.db import DatabaseConnectionError, sql_state

    assert sql_state(pyodbc.OperationalError("HYT00", "private connection string")) == "HYT00"
    assert sql_state(pyodbc.OperationalError("PRIVATE SQL CONNECTION STRING")) is None
    safe = diagnostic("run_create", DatabaseConnectionError("operational", "HYT00"))
    assert diagnostic_headers(safe)["x-enrichment-failure-sqlstate"] == "HYT00"
    assert "private" not in str(safe).lower()


def test_bad_json_is_rejected_without_a_server_error(monkeypatch):
    handler, _ = setup(monkeypatch)
    bad = func.HttpRequest(
        method="POST", url="https://test/api/enrichment/runs",
        headers={}, body=b"[]",
    )
    assert handler(bad).status_code == 400


def test_snapshot_storage_failure_reports_the_inner_stage(monkeypatch):
    from helpers.timing import step

    handler, _ = setup(monkeypatch)
    monkeypatch.setattr(route, "get_job_snapshot", lambda *_: {
        "jobName": "Title", "jobDescription": "Description",
    })
    monkeypatch.setattr(route, "get_user_cv_snapshot", lambda *_: {"CVPlainText": "PRIVATE CV"})

    def failed_snapshot(*_args):
        with step("blob_upload"):
            raise RuntimeError("private upload token")

    monkeypatch.setattr(route, "write_input_snapshot", failed_snapshot)
    response = handler(request())
    assert response.status_code == 201
    assert response.headers["x-enrichment-failure-stage"] == "blob_upload"
    assert response.headers["x-enrichment-failure-category"] == "snapshot_storage"
    assert "private" not in response.get_body().decode()


def test_gateway_http_error_does_not_contain_response_body(monkeypatch):
    import pytest
    from helpers import runs_create
    from helpers.compatibility_diagnostics import GatewayHTTPError, diagnostic, diagnostic_headers

    monkeypatch.setattr(runs_create, "_selected_gateway_config", lambda: (
        "alternative", "https://gateway.example/api", "private-key",
    ))
    response = Mock(status_code=502, headers={}, text="PRIVATE CV BODY")
    monkeypatch.setattr(runs_create.requests, "post", Mock(return_value=response))
    with pytest.raises(GatewayHTTPError) as caught:
        runs_create.dispatch_via_gateway({
            **created_run(), "requestedAt": "2026-11-03T12:00:00Z",
        }, "runs/id/input.json", corr=CORR)
    assert "PRIVATE" not in str(caught.value)
    result = diagnostic("gateway_dispatch", caught.value)
    assert result == {
        "stage": "gateway_dispatch", "category": "gateway_http_5xx",
        "upstreamStatus": 502, "gatewayTarget": "alternative",
    }
    assert diagnostic_headers(result)["x-enrichment-failure-upstream-status"] == "502"
