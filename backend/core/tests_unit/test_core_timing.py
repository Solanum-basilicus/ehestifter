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


def test_enrichers_stages_and_gateway_metadata_are_propagated():
    from helpers.timing import enrichers_call

    class EnrichersResponse:
        headers = {"Server-Timing": (
            'app;dur=300, process_first;desc="1", step_run_create;dur=50, '
            'gateway_http;dur=210, gateway_app;dur=20, '
            'gateway_unattributed;dur=190, gateway_step_servicebus_send;dur=9, '
            'gateway_process_first;desc="1", bad;dur=1234'
        )}

    app = Flask(__name__)
    app.before_request(begin_request)
    app.after_request(finish_request)

    @app.get("/enrich")
    def route():
        enrichers_call(lambda: EnrichersResponse())
        return {"ok": True}

    header = app.test_client().get("/enrich").headers["Server-Timing"]
    assert "enrichers_app;dur=300.00" in header
    assert "enrichers_step_run_create;dur=50.00" in header
    assert "enrichers_gateway_step_servicebus_send;dur=9.00" in header
    assert 'enrichers_gateway_process_first;desc="1"' in header
    assert 'enrichers_process_first;desc="1"' in header
    assert "bad" not in header


def test_failed_downstream_attempt_keeps_http_time_without_handler_time():
    from helpers.timing import enrichers_call

    app = Flask(__name__)
    app.before_request(begin_request)
    app.after_request(finish_request)

    @app.get("/error")
    def route():
        try:
            enrichers_call(lambda: (_ for _ in ()).throw(RuntimeError("network")))
        except RuntimeError:
            return {"error": "network"}, 502

    response = app.test_client().get("/error")
    assert "enrichers_http;dur=" in response.headers["Server-Timing"]
    assert "enrichers_app;dur=" not in response.headers["Server-Timing"]
    assert "enrichers_unattributed;dur=" not in response.headers["Server-Timing"]


def test_retries_keep_first_process_and_catalog_miss_hints():
    from helpers.timing import jobs_call

    class Warm:
        headers = {"Server-Timing": (
            'app;dur=10, process_age;dur=400, process_first;desc="0", '
            'catalog_cache;desc="hit"'
        )}

    class Cold:
        headers = {"Server-Timing": (
            'app;dur=20, process_age;dur=2, process_first;desc="1", '
            'catalog_cache;desc="miss"'
        )}

    app = Flask(__name__)
    app.before_request(begin_request)
    app.after_request(finish_request)

    @app.get("/retry")
    def route():
        jobs_call(lambda: Cold())
        jobs_call(lambda: Warm())
        return {"ok": True}

    header = app.test_client().get("/retry").headers["Server-Timing"]
    assert 'jobs_process_first;desc="1"' in header
    assert 'jobs_catalog_cache;desc="miss"' in header
    assert 'jobs_process_age;dur=400.00' in header
    assert "jobs_app;dur=30.00" in header


def test_direct_users_and_nested_enrichers_users_metadata():
    from helpers.timing import users_call, enrichers_call

    class UsersResponse:
        headers = {"Server-Timing": (
            'app;dur=70, dbconn;dur=10, sql;dur=3, sql_count;desc="2", '
            'process_age;dur=100, process_first;desc="1", '
            'step_blob_download;dur=45, evil;dur=500'
        )}

    class EnrichersResponse:
        headers = {"Server-Timing": (
            'app;dur=200, step_cv_snapshot;dur=180, '
            'users_http;dur=150, users_app;dur=70, users_dbconn;dur=10, '
            'users_process_age;dur=100, users_process_first;desc="1", '
            'users_sql_count;desc="2", users_step_blob_download;dur=45, '
            'evil;dur=500'
        )}

    app = Flask(__name__)
    app.before_request(begin_request)
    app.after_request(finish_request)

    @app.get("/both")
    def route():
        users_call(lambda: UsersResponse())
        enrichers_call(lambda: EnrichersResponse())
        return {"ok": True}

    header = app.test_client().get("/both").headers["Server-Timing"]
    assert "users_app;dur=70.00" in header
    assert "users_step_blob_download;dur=45.00" in header
    assert "enrichers_users_app;dur=70.00" in header
    assert "enrichers_users_step_blob_download;dur=45.00" in header
    assert 'enrichers_users_process_first;desc="1"' in header
    assert "evil" not in header


def test_users_cache_hit_does_not_reuse_old_api_timings(monkeypatch):
    from flask import session
    from helpers import users
    import time

    app = Flask(__name__)
    app.secret_key = "testing"
    app.before_request(begin_request)
    app.after_request(finish_request)

    @app.get("/user")
    def route():
        return users.get_in_app_user({"user": {"sub": "fake"}})

    with app.test_client() as client:
        with client.session_transaction() as user_session:
            user_session["in_app_user_cache"] = {"data": {"userId": "fake"}, "ts": time.time()}
        response = client.get("/user")
    header = response.headers["Server-Timing"]
    assert 'users_cache;desc="hit"' in header
    assert "users_http" not in header


def test_users_retry_count_and_process_first_are_safe():
    from helpers.timing import users_call

    class Cold:
        headers = {"Server-Timing": 'app;dur=20, sql_count;desc="1", process_first;desc="1"'}

    class Warm:
        headers = {"Server-Timing": 'app;dur=10, sql_count;desc="2", process_first;desc="0"'}

    app = Flask(__name__)
    app.before_request(begin_request)
    app.after_request(finish_request)

    @app.get("/retry-users")
    def route():
        users_call(lambda: Cold())
        users_call(lambda: Warm())
        return {"ok": True}

    header = app.test_client().get("/retry-users").headers["Server-Timing"]
    assert "users_app;dur=30.00" in header
    assert 'users_sql_count;desc="3"' in header
    assert 'users_process_first;desc="1"' in header


def test_untrusted_users_timing_is_rejected():
    from helpers.timing import users_call

    class UpstreamUsers:
        headers = {"Server-Timing": (
            'app;dur=30, process_first;desc="invalid", sql_count;desc="secret", '
            'step_not_allowed;dur=999, step_blob_download;dur=25, '
            'process_age;dur=' + '9' * 400 + ', email;desc="private"'
        )}

    app = Flask(__name__)
    app.before_request(begin_request)
    app.after_request(finish_request)

    @app.get("/unsafe")
    def route():
        users_call(lambda: UpstreamUsers())
        return {"ok": True}

    header = app.test_client().get("/unsafe").headers["Server-Timing"]
    assert "users_app;dur=30.00" in header
    assert "users_step_blob_download;dur=25.00" in header
    assert "users_process_age" not in header
    assert "users_process_first" not in header
    assert "users_sql_count" not in header
    assert "email" not in header and "not_allowed" not in header
