"""Check that Core forwards the score to the structured Jobs query."""

import importlib.util
import sys
from pathlib import Path

from flask import Flask

CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

MODULE_PATH = CORE_ROOT / "routes" / "ui_jobs_open_query.py"
SPEC = importlib.util.spec_from_file_location("open_score_proxy_for_test", MODULE_PATH)
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class FakeAuth:
    def login_required(self, handler):
        def wrapped(*args, **kwargs):
            return handler(*args, context={"user": {"sub": "test-user"}}, **kwargs)
        return wrapped


class FakeResponse:
    status_code = 200
    def json(self):
        return {"items": [], "minCompatibilityScore": 7.5}


def test_structured_open_proxy_forwards_score_with_eligibility(monkeypatch):
    calls = []
    monkeypatch.setattr(proxy, "get_in_app_user_id", lambda context: "user-1")
    monkeypatch.setattr(proxy, "get_discovery_preferences", lambda context: {"eligibility": {"kind": "test"}})
    monkeypatch.setattr(proxy, "jobs_base", lambda: "https://jobs.test/api")
    monkeypatch.setattr(proxy, "jobs_fx_headers", lambda context: {"X-User-Id": context["userId"]})
    monkeypatch.setattr(proxy, "fx_post_json", lambda url, headers, json_body: (calls.append((url, headers, json_body)) or FakeResponse()))
    app = Flask(__name__)
    app.register_blueprint(proxy.create_blueprint(FakeAuth()))

    response = app.test_client().post("/ui/jobs/open/query", json={"limit": 10, "minCompatibilityScore": 7.5})

    assert response.status_code == 200
    assert response.get_json()["minCompatibilityScore"] == 7.5
    assert calls == [("https://jobs.test/api/jobs/open/query", {"X-User-Id": "user-1"}, {"limit": 10, "minCompatibilityScore": 7.5, "eligibility": {"kind": "test"}})]
