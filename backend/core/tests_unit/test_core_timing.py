"""Check Core timing headers and Jobs timing propagation."""

from flask import Flask

from helpers.timing import begin_request, finish_request, jobs_call, measure_call, set_label


class Upstream:
    headers = {"Server-Timing": 'app;dur=30.5, sql;dur=10.25, dbconn;dur=5, sql_count;desc="2"'}


def test_core_aggregates_upstream_jobs_calls():
    app = Flask(__name__)
    app.before_request(begin_request)
    app.after_request(finish_request)

    @app.get("/test")
    def route():
        jobs_call(lambda: Upstream())
        jobs_call(lambda: Upstream())
        measure_call("analytics", lambda: None)
        set_label("cache", "miss")
        return {"ok": True}

    response = app.test_client().get("/test")
    header = response.headers["Server-Timing"]
    assert response.json == {"ok": True}
    assert 'attempts;desc="2"' in header
    assert 'jobs_sql_count;desc="4"' in header
    assert 'cache;desc="miss"' in header
    assert "jobs_sql;dur=20.50" in header
    assert "jobs_app;dur=61.00" in header
    assert "analytics;dur=" in header
    assert "core;dur=" in header


def test_failed_core_response_still_has_total_timing():
    app = Flask(__name__)
    app.before_request(begin_request)
    app.after_request(finish_request)

    @app.get("/bad")
    def bad():
        return {"error": "invalid"}, 400

    response = app.test_client().get("/bad")
    assert response.status_code == 400
    assert "core;dur=" in response.headers["Server-Timing"]
    assert "jobs_sql" not in response.headers["Server-Timing"]
