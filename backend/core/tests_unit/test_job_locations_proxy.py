import importlib.util
import sys
from pathlib import Path

from flask import Flask


CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

MODULE_PATH = CORE_ROOT / "routes" / "ui_jobs_locations_bulk.py"
SPEC = importlib.util.spec_from_file_location("ui_jobs_locations_bulk_for_test", MODULE_PATH)
route_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(route_module)


class FakeAuth:
    def login_required(self, function):
        def wrapped(*args, **kwargs):
            return function(*args, context={"user": {"sub": "test-user"}}, **kwargs)

        return wrapped


class FakeResponse:
    def __init__(self, text, status_code=200, content_type="application/json"):
        self.text = text
        self.status_code = status_code
        self.headers = {"Content-Type": content_type}


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(route_module.create_blueprint(FakeAuth()))
    return app


def test_job_locations_proxy_forwards_unique_job_ids(monkeypatch):
    captured = {}

    monkeypatch.setattr(route_module, "get_in_app_user_id", lambda context: "user-1")
    monkeypatch.setattr(route_module, "jobs_base", lambda: "https://jobs.example/api")
    monkeypatch.setattr(
        route_module,
        "jobs_fx_headers",
        lambda context=None: {"X-User-Id": context["userId"]} if context else {},
    )

    def fake_post(url, headers, json_body):
        captured.update(url=url, headers=headers, json_body=json_body)
        return FakeResponse('{"activeLocationModel":"v2","locations":{},"locationsV2":{}}')

    monkeypatch.setattr(route_module, "fx_post_json", fake_post)

    response = _make_app().test_client().post(
        "/ui/jobs/locations",
        json={"jobIds": ["job-1", "job-1", "job-2"]},
    )

    assert response.status_code == 200
    assert captured == {
        "url": "https://jobs.example/api/jobs/locations",
        "headers": {"X-User-Id": "user-1"},
        "json_body": {"jobIds": ["job-1", "job-2"]},
    }


def test_job_locations_proxy_rejects_empty_job_ids():
    response = _make_app().test_client().post("/ui/jobs/locations", json={"jobIds": []})

    assert response.status_code == 400
    assert response.get_json()["error"] == "bad_request"
