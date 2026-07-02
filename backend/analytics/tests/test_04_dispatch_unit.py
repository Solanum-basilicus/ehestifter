from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

from app.config import AppConfig
from app.dispatch import run_dispatch_once


def _config(export_enabled: bool = True) -> AppConfig:
    return AppConfig(
        collection_enabled=True,
        mixpanel_export_enabled=export_enabled,
        allow_unknown_events=False,
        distinct_id_salt="test-salt",
        sql_connection_string="not-used-in-monkeypatch-tests",
        mixpanel_project_id="12345",
        mixpanel_api_base_url="https://api-eu.mixpanel.com",
        mixpanel_service_account_username="not-used",
        mixpanel_service_account_password="not-used",
        mixpanel_strict=True,
        mixpanel_batch_size=500,
        mixpanel_max_attempts=8,
        key_bindings=(),
    )


def _row(**overrides):
    row = {
        "DispatchId": "11111111-1111-1111-1111-111111111111",
        "EventId": "22222222-2222-2222-2222-222222222222",
        "Sink": "mixpanel",
        "Status": "pending",
        "AttemptCount": 0,
        "OccurredAtUtc": datetime(2026, 6, 30, 12, 30, 0),
        "SourceDomain": "jobs",
        "SourceSurface": "web",
        "DistinctId": "u_test_distinct_id",
        "EventName": "Job Status Changed",
        "SubjectType": "job",
        "SubjectId": "33333333-3333-3333-3333-333333333333",
        "SchemaVersion": 1,
        "PropertiesJson": (
            '{"job_id":"33333333-3333-3333-3333-333333333333",'
            '"new_status":"Applied","is_final_status":false}'
        ),
    }
    row.update(overrides)
    return row


def _patch_noop_db_markers(monkeypatch, calls):
    monkeypatch.setattr(
        "app.dispatch.mark_dispatch_sending",
        lambda config, ids: calls["sending"].extend(ids),
    )
    monkeypatch.setattr(
        "app.dispatch.mark_dispatch_sent",
        lambda config, ids: calls["sent"].extend(ids),
    )
    monkeypatch.setattr(
        "app.dispatch.mark_dispatch_dead",
        lambda config, ids, error_code, error_json: calls["dead"].append(
            {
                "ids": ids,
                "error_code": error_code,
                "error_json": error_json,
            }
        ),
    )
    monkeypatch.setattr(
        "app.dispatch.mark_dispatch_retry",
        lambda config, ids, error_code, error_json, delay_seconds: calls["retry"].append(
            {
                "ids": ids,
                "error_code": error_code,
                "error_json": error_json,
                "delay_seconds": delay_seconds,
            }
        ),
    )


def test_dispatch_disabled_does_not_touch_db_or_mixpanel(monkeypatch):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("This dependency should not be called when export is disabled.")

    monkeypatch.setattr("app.dispatch.fetch_due_dispatch_rows", fail_if_called)
    monkeypatch.setattr("app.dispatch.MixpanelClient", fail_if_called)

    counters = run_dispatch_once(_config(export_enabled=False))

    assert counters.as_dict() == {
        "attempted": 0,
        "sent": 0,
        "retry": 0,
        "dead": 0,
        "skipped": 0,
        "exportEnabled": False,
    }


def test_dispatch_200_marks_rows_sent(monkeypatch):
    calls = {
        "sending": [],
        "sent": [],
        "dead": [],
        "retry": [],
        "mixpanel_events": None,
    }

    monkeypatch.setattr(
        "app.dispatch.fetch_due_dispatch_rows",
        lambda config, limit: [_row()],
    )
    _patch_noop_db_markers(monkeypatch, calls)

    class FakeMixpanelClient:
        def __init__(self, config):
            self.config = config

        def import_events(self, events):
            calls["mixpanel_events"] = events
            return SimpleNamespace(status_code=200, text='{"status":"ok"}', json_body={"status": "ok"})

    monkeypatch.setattr("app.dispatch.MixpanelClient", FakeMixpanelClient)

    counters = run_dispatch_once(_config(export_enabled=True))

    assert counters.attempted == 1
    assert counters.sent == 1
    assert counters.retry == 0
    assert counters.dead == 0

    assert calls["sending"] == ["11111111-1111-1111-1111-111111111111"]
    assert calls["sent"] == ["11111111-1111-1111-1111-111111111111"]
    assert calls["dead"] == []
    assert calls["retry"] == []

    assert calls["mixpanel_events"] is not None
    event = calls["mixpanel_events"][0]
    assert event["event"] == "Job Status Changed"
    assert event["properties"]["distinct_id"] == "u_test_distinct_id"
    assert event["properties"]["$insert_id"] == "22222222-2222-2222-2222-222222222222"
    assert event["properties"]["ip"] == 0
    assert event["properties"]["new_status"] == "Applied"


def test_dispatch_400_marks_rows_dead(monkeypatch):
    calls = {
        "sending": [],
        "sent": [],
        "dead": [],
        "retry": [],
    }

    monkeypatch.setattr(
        "app.dispatch.fetch_due_dispatch_rows",
        lambda config, limit: [_row()],
    )
    _patch_noop_db_markers(monkeypatch, calls)

    class FakeMixpanelClient:
        def __init__(self, config):
            pass

        def import_events(self, events):
            return SimpleNamespace(
                status_code=400,
                text='{"error":"validation failed"}',
                json_body={"error": "validation failed"},
            )

    monkeypatch.setattr("app.dispatch.MixpanelClient", FakeMixpanelClient)

    counters = run_dispatch_once(_config(export_enabled=True))

    assert counters.attempted == 1
    assert counters.sent == 0
    assert counters.retry == 0
    assert counters.dead == 1

    assert calls["sent"] == []
    assert calls["retry"] == []
    assert len(calls["dead"]) == 1
    assert calls["dead"][0]["ids"] == ["11111111-1111-1111-1111-111111111111"]
    assert calls["dead"][0]["error_code"] == "http_400"


def test_dispatch_429_marks_rows_retry(monkeypatch):
    calls = {
        "sending": [],
        "sent": [],
        "dead": [],
        "retry": [],
    }

    monkeypatch.setattr(
        "app.dispatch.fetch_due_dispatch_rows",
        lambda config, limit: [_row(AttemptCount=2)],
    )
    _patch_noop_db_markers(monkeypatch, calls)

    class FakeMixpanelClient:
        def __init__(self, config):
            pass

        def import_events(self, events):
            return SimpleNamespace(
                status_code=429,
                text='{"error":"rate limited"}',
                json_body={"error": "rate limited"},
            )

    monkeypatch.setattr("app.dispatch.MixpanelClient", FakeMixpanelClient)

    counters = run_dispatch_once(_config(export_enabled=True))

    assert counters.attempted == 1
    assert counters.sent == 0
    assert counters.retry == 1
    assert counters.dead == 0

    assert calls["sent"] == []
    assert calls["dead"] == []
    assert len(calls["retry"]) == 1
    assert calls["retry"][0]["ids"] == ["11111111-1111-1111-1111-111111111111"]
    assert calls["retry"][0]["error_code"] == "http_429"
    assert calls["retry"][0]["delay_seconds"] > 0


def test_missing_distinct_id_marks_row_dead_without_mixpanel_call(monkeypatch):
    calls = {
        "sending": [],
        "sent": [],
        "dead": [],
        "retry": [],
    }

    monkeypatch.setattr(
        "app.dispatch.fetch_due_dispatch_rows",
        lambda config, limit: [_row(DistinctId=None)],
    )
    _patch_noop_db_markers(monkeypatch, calls)

    class FakeMixpanelClient:
        def __init__(self, config):
            pass

        def import_events(self, events):
            raise AssertionError("Mixpanel should not be called for unmappable rows.")

    monkeypatch.setattr("app.dispatch.MixpanelClient", FakeMixpanelClient)

    counters = run_dispatch_once(_config(export_enabled=True))

    assert counters.attempted == 0
    assert counters.sent == 0
    assert counters.retry == 0
    assert counters.dead == 1

    assert calls["sending"] == []
    assert calls["sent"] == []
    assert calls["retry"] == []
    assert len(calls["dead"]) == 1
    assert calls["dead"][0]["ids"] == ["11111111-1111-1111-1111-111111111111"]
    assert calls["dead"][0]["error_code"].startswith("mapping:")
    