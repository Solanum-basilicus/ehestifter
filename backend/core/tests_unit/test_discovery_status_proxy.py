import importlib.util
import sys
from pathlib import Path

from flask import Flask


CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

MODULE_PATH = CORE_ROOT / "routes" / "ui_users_discovery_status.py"
SPEC = importlib.util.spec_from_file_location("ui_users_discovery_status_for_test", MODULE_PATH)
route_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(route_module)


class FakeAuth:
    def login_required(self, function):
        def wrapped(*args, **kwargs):
            return function(*args, context={"user": {"sub": "test-user"}}, **kwargs)

        return wrapped


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(route_module.create_blueprint(FakeAuth()))
    return app


def test_discovery_status_proxy_returns_users_owned_status(monkeypatch):
    expected = {
        "schemaVersion": 1,
        "enabled": False,
        "hasUsableCv": False,
        "hasPositiveTitleRule": True,
        "reasons": ["no_usable_cv"],
    }
    captured = {}

    def fake_get(context):
        captured["context"] = context
        return expected

    monkeypatch.setattr(route_module, "get_discovery_status", fake_get)

    response = _make_app().test_client().get("/ui/users/discovery-status")

    assert response.status_code == 200
    assert response.get_json() == expected
    assert captured["context"] == {"user": {"sub": "test-user"}}
