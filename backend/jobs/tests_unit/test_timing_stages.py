"""Check detailed Jobs timing with a small local catalog."""

import gzip
import json

import azure.functions as func

from helpers.locations_v2 import load_locations_v2_catalog
from helpers import locations_v2
from helpers.timing import timed_handler, step, record_elapsed
from time import perf_counter


def test_catalog_reports_parse_index_and_cache_state(tmp_path, monkeypatch):
    path = tmp_path / "catalog.json.gz"
    with gzip.open(path, "wt", encoding="utf-8") as output:
        json.dump({
            "schemaVersion": 2, "catalogVersion": "test",
            "regions": [], "countries": [], "adminRegions": [], "cities": [],
        }, output)
    monkeypatch.setattr(locations_v2, "catalog_path", lambda: path)
    load_locations_v2_catalog.cache_clear()

    from helpers.timing import catalog_call

    @timed_handler
    def route():
        with step("job_row"):
            record_elapsed("parse", perf_counter())
        catalog_call(load_locations_v2_catalog)
        return func.HttpResponse("ok")

    try:
        cold = route().headers["Server-Timing"]
        warm = route().headers["Server-Timing"]
        assert 'catalog_cache;desc="miss"' in cold
        assert "step_catalog_parse;dur=" in cold
        assert "step_catalog_index;dur=" in cold
        assert 'catalog_cache;desc="hit"' in warm
        assert "step_catalog_parse" not in warm
        assert "step_catalog_load;dur=" in warm
        assert "step_job_row;dur=" in cold
        assert 'process_first;desc="' in cold
    finally:
        load_locations_v2_catalog.cache_clear()


def test_failed_step_does_not_hide_failure():
    @timed_handler
    def route():
        with step("serialize"):
            raise ValueError("invalid output")

    import pytest
    with pytest.raises(ValueError, match="invalid output"):
        route()


def test_parallel_jobs_requests_do_not_share_stage_metrics():
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
        first = pool.submit(route, "job_row")
        second = pool.submit(route, "work_time")
        first_header = first.result(timeout=5).headers["Server-Timing"]
        second_header = second.result(timeout=5).headers["Server-Timing"]
    assert "step_job_row;dur=" in first_header
    assert "step_work_time;dur=" not in first_header
    assert "step_work_time;dur=" in second_header
    assert "step_job_row;dur=" not in second_header
