"""Check Enrichers HTTP timing without remote calls."""

import azure.functions as func

from helpers.timing import gateway_response_timing, timed_handler, step, current


def test_run_stages_and_gateway_metadata_keep_known_fields():
    @timed_handler
    def route():
        with step("run_create"):
            pass
        with step("gateway_dispatch"):
            gateway_response_timing(
                'app;dur=30.5, process_age;dur=100, process_first;desc="1", '
                'step_servicebus_send;dur=10, unknown;dur=999, code;desc="secret"',
                55,
            )
        return func.HttpResponse("ok")

    header = route().headers["Server-Timing"]
    assert "step_run_create;dur=" in header
    assert "gateway_http;dur=55.00" in header
    assert "gateway_app;dur=30.50" in header
    assert "gateway_unattributed;dur=24.50" in header
    assert 'gateway_process_first;desc="1"' in header
    assert "gateway_step_servicebus_send;dur=10.00" in header
    assert "unknown" not in header
    assert "secret" not in header
    assert current() is None


def test_exception_does_not_leak_request_context():
    import pytest

    @timed_handler
    def route():
        with step("run_create"):
            raise RuntimeError("failed")

    with pytest.raises(RuntimeError, match="failed"):
        route()
    assert current() is None


def test_parallel_enrichers_requests_have_separate_stages():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    barrier = Barrier(2)

    @timed_handler
    def route(stage_name):
        barrier.wait(timeout=5)
        with step(stage_name):
            pass
        return func.HttpResponse("ok")

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(route, "job_snapshot")
        second = pool.submit(route, "cv_snapshot")
        first_header = first.result(timeout=5).headers["Server-Timing"]
        second_header = second.result(timeout=5).headers["Server-Timing"]
    assert "step_job_snapshot;dur=" in first_header
    assert "step_cv_snapshot;dur=" not in first_header
    assert "step_cv_snapshot;dur=" in second_header
    assert "step_job_snapshot;dur=" not in second_header


def test_users_snapshot_forwards_only_safe_metrics(monkeypatch):
    from helpers import snapshot_clients

    class Response:
        headers = {"Server-Timing": (
            'app;dur=70, dbconn;dur=4, sql_count;desc="1", '
            'step_blob_download;dur=40, process_first;desc="1", '
            'userId;desc="private", evil;dur=500'
        )}

        def raise_for_status(self):
            pass

        def json(self):
            return {"CVPlainText": "private CV"}

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr(snapshot_clients, "USERS_BASE", "https://users.example/api")
    monkeypatch.setattr(snapshot_clients.httpx, "Client", Client)

    @timed_handler
    def route():
        assert snapshot_clients.get_user_cv_snapshot("user") == {"CVPlainText": "private CV"}
        return func.HttpResponse("ok")

    header = route().headers["Server-Timing"]
    assert "users_http;dur=" in header
    assert "users_app;dur=70.00" in header
    assert "users_step_blob_download;dur=40.00" in header
    assert 'users_sql_count;desc="1"' in header
    assert "private" not in header and "evil" not in header


def test_users_transport_failure_keeps_http_duration(monkeypatch):
    import pytest
    from helpers import snapshot_clients

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, *args, **kwargs):
            raise TimeoutError("timeout")

    monkeypatch.setattr(snapshot_clients, "USERS_BASE", "https://users.example/api")
    monkeypatch.setattr(snapshot_clients.httpx, "Client", Client)

    @timed_handler
    def route():
        with pytest.raises(TimeoutError):
            snapshot_clients.get_user_cv_snapshot("user")
        return func.HttpResponse("error", status_code=502)

    header = route().headers["Server-Timing"]
    assert "users_http;dur=" in header
    assert "users_app" not in header


def test_users_invalid_header_has_bounded_numeric_fields():
    from helpers.timing import users_response_timing

    @timed_handler
    def route():
        users_response_timing(
            'app;dur=12, sql_count;desc="secret", '
            'process_first;desc="bad", step_blob_download;dur=' + '9' * 350,
            18,
        )
        return func.HttpResponse("ok")

    header = route().headers["Server-Timing"]
    assert "users_http;dur=18.00" in header
    assert "users_app;dur=12.00" in header
    assert "users_unattributed;dur=6.00" in header
    assert "users_sql_count" not in header
    assert "users_process_first" not in header
    assert "users_step_blob_download" not in header
