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
