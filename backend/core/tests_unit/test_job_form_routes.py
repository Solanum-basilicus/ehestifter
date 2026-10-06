import importlib.util
import json
import sys
from functools import wraps
from pathlib import Path

import pytest
from flask import Flask, render_template


CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))


def _load_route(name):
    spec = importlib.util.spec_from_file_location(
        f"{name}_for_job_form_test", CORE_ROOT / "routes" / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


create_route = _load_route("ui_jobs_create")
edit_route = _load_route("ui_jobs_edit")
USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
JOB_ID = "11111111-2222-3333-4444-555555555555"
BERLIN = {"kind": "city", "locationId": "geonames:2950159"}
MUNICH = {"kind": "city", "locationId": "geonames:2867714"}


class FakeAuth:
    def login_required(self, function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            return function(*args, context={"user": {"sub": "test-user"}}, **kwargs)
        return wrapped


class FakeResponse:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status_code = status
        self.ok = status < 400
        self.text = payload if isinstance(payload, str) else json.dumps(payload)
        self.headers = {"Content-Type": "application/json"}

    def json(self):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload


@pytest.fixture
def client(monkeypatch):
    app = Flask(__name__)
    for module in (create_route, edit_route):
        monkeypatch.setattr(module, "jobs_base", lambda: "https://jobs.example/api")
        monkeypatch.setattr(module, "get_in_app_user_id", lambda context: USER_ID)
        monkeypatch.setattr(module, "jobs_fx_headers", lambda context=None: {"X-User-Id": context["userId"]} if context else {})
        app.register_blueprint(module.create_blueprint(FakeAuth()))
    monkeypatch.setattr(create_route, "ensure_job_create_flow_id", lambda: "test-flow")
    # Keep this test independent of unrelated base-template context.
    monkeypatch.setattr(edit_route, "render_template", lambda name, **values: values["initial_json"])
    return app.test_client()


@pytest.mark.parametrize("method", ["post", "put"])
@pytest.mark.parametrize("locations", [[BERLIN], [BERLIN, MUNICH], []])
def test_job_form_routes_send_v2_identities_without_legacy_locations(client, monkeypatch, method, locations):
    captured = {}

    def send(url, headers, json_body):
        captured.update(url=url, headers=headers, body=json_body)
        return FakeResponse({"id": JOB_ID}, 201 if method == "post" else 200)

    module = create_route if method == "post" else edit_route
    monkeypatch.setattr(module, "fx_post_json" if method == "post" else "fx_put_json", send)
    response = getattr(client, method)(
        "/ui/jobs" if method == "post" else f"/ui/jobs/{JOB_ID}",
        json={
            "url": "https://example.test/jobs/1", "remoteType": "Hybrid",
            "locationsV2": [{**item, "label": "Display only"} for item in locations],
            "locations": [{"countryName": "France"}],
        },
    )
    assert response.status_code == (201 if method == "post" else 200)
    assert captured["body"]["locationsV2"] == locations
    assert "locations" not in captured["body"]
    assert captured["body"]["remoteType"] == "Hybrid"
    assert captured["headers"]["X-User-Id"] == USER_ID


def test_edit_page_resolves_stored_identities_after_creator_check(client, monkeypatch):
    calls = []
    job = {
        "id": JOB_ID, "createdByUserId": USER_ID, "locationsV2": [BERLIN, MUNICH],
        "locations": [{"countryName": "France"}],
    }
    monkeypatch.setattr(edit_route, "fx_get", lambda *args, **kwargs: FakeResponse(job))

    def lookup(context, selectors):
        calls.append((context, selectors))
        return FakeResponse({"items": [{**BERLIN, "label": "Berlin, Germany"}], "missing": [MUNICH]})

    monkeypatch.setattr(edit_route, "lookup_locations", lookup)
    response = client.get(f"/jobs/{JOB_ID}/edit")
    initial = response.get_json()
    assert response.status_code == 200
    assert calls == [({"userId": USER_ID}, [BERLIN, MUNICH])]
    assert initial["locationsV2"] == [BERLIN, MUNICH]
    assert initial["locationDetails"] == [{**BERLIN, "label": "Berlin, Germany"}]
    assert "locations" not in initial


@pytest.mark.parametrize("failure", ["timeout", "http_error", "invalid_json", "invalid_shape"])
def test_edit_page_keeps_identities_when_lookup_fails(client, monkeypatch, failure):
    monkeypatch.setattr(edit_route, "fx_get", lambda *args, **kwargs: FakeResponse({
        "id": JOB_ID, "createdByUserId": USER_ID, "locationsV2": [BERLIN, MUNICH],
    }))

    def lookup(*args):
        if failure == "timeout":
            raise TimeoutError("Test timeout")
        if failure == "http_error":
            return FakeResponse({}, 503)
        if failure == "invalid_json":
            response = FakeResponse({})
            response.payload = ValueError("Invalid JSON")
            return response
        return FakeResponse({"items": None})

    monkeypatch.setattr(edit_route, "lookup_locations", lookup)
    response = client.get(f"/jobs/{JOB_ID}/edit")
    assert response.status_code == 200
    initial = response.get_json()
    assert initial["locationsV2"] == [BERLIN, MUNICH]
    assert initial["locationDetails"] == []
    assert initial["locationLookupFailed"] is True


def test_legacy_only_edit_page_does_not_convert_or_lookup_locations(client, monkeypatch):
    monkeypatch.setattr(edit_route, "fx_get", lambda *args, **kwargs: FakeResponse({
        "id": JOB_ID, "createdByUserId": USER_ID,
        "locations": [{"countryName": "Germany", "cityName": "Berlin"}],
    }))

    def unexpected_lookup(*args):
        raise AssertionError("No canonical locations to resolve")

    monkeypatch.setattr(edit_route, "lookup_locations", unexpected_lookup)
    response = client.get(f"/jobs/{JOB_ID}/edit")
    assert response.status_code == 200
    assert response.get_json()["locationsV2"] == []
    assert response.get_json()["locationLookupFailed"] is False


def test_edit_page_stops_before_lookup_for_another_creator(client, monkeypatch):
    called = []
    monkeypatch.setattr(edit_route, "fx_get", lambda *args, **kwargs: FakeResponse({
        "id": JOB_ID, "createdByUserId": JOB_ID, "locationsV2": [BERLIN],
    }))
    monkeypatch.setattr(edit_route, "lookup_locations", lambda *args: called.append(args))
    assert client.get(f"/jobs/{JOB_ID}/edit").status_code == 403
    assert called == []


def test_edit_mapping_accepts_pascal_case_canonical_identities():
    initial = edit_route._map_api_job_to_initial({
        "LocationsV2": [{"LocationKind": "country", "LocationId": "iso3166:DE", "DisplayName": "Germany"}],
    })
    assert initial["locationsV2"] == [{"kind": "country", "locationId": "iso3166:DE"}]


@pytest.mark.parametrize("method", ["post", "put"])
def test_job_form_routes_keep_upstream_validation_error(client, monkeypatch, method):
    module = create_route if method == "post" else edit_route
    monkeypatch.setattr(module, "fx_post_json" if method == "post" else "fx_put_json", lambda *args, **kwargs: FakeResponse("Invalid canonical identity", 400))
    response = getattr(client, method)(
        "/ui/jobs" if method == "post" else f"/ui/jobs/{JOB_ID}",
        json={"url": "https://example.test/job", "locationsV2": [{"kind": "city", "locationId": "geonames:0"}]},
    )
    assert response.status_code == 400
    assert response.get_data(as_text=True) == "Invalid canonical identity"


@pytest.mark.parametrize("template", ["job_new.html", "job_edit.html"])
def test_job_form_templates_load_shared_picker_before_the_form(template):
    app = Flask(__name__, template_folder=str(CORE_ROOT / "templates"))
    for endpoint in ("index", "job_new", "me", "identity.logout"):
        app.add_url_rule(f"/{endpoint}", endpoint=endpoint, view_func=lambda: "")
    with app.test_request_context():
        html = render_template(
            template, mode="edit", disable_ats=True,
            initial_json={"id": JOB_ID, "locationsV2": [BERLIN]},
            submit_label="Save changes", cancel_href="/", title="Test form",
        )
    assert "css/location-picker.css" in html
    assert html.index("js/location-picker.js") < html.index("js/job-form.js")
    assert "geo-dict.js" not in html
    assert 'id="locations"' in html
    assert 'id="locationNotice"' in html
    assert "btnAddCountry" not in html
    assert "btnAddCity" not in html
