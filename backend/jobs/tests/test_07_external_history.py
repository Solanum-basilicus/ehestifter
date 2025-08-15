# tests/test_08_external_history.py
import pytest
import requests
import uuid

def test_08_external_history(base_url, auth_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "shared_state['job_id'] must be set by test_01_create_job"

    url = f"{base_url}/api/jobs/{job_id}/history"

    # 1) Post an external "enrichment_requested"
    req_id = str(uuid.uuid4())
    body_requested = {
        "action": "enrichment_requested",
        "details": {
            "enricher": "JDClassifier",
            "requestId": req_id
        }
        # no actorType/actorId to verify default 'system' actor detection
    }
    r1 = requests.post(url, headers=auth_headers, json=body_requested)
    print("(EXT-HIST requested:", r1.status_code, r1.text[:200], ")", end="")
    assert r1.status_code == 200
    assert r1.json().get("ok") is True

    # 2) Post a matching "enrichment_finished"
    body_finished = {
        "action": "enrichment_finished",
        "details": {
            "enricher": "JDClassifier",
            "requestId": req_id,
            "metrics": {"latencyMs": 123}
        }
    }
    r2 = requests.post(url, headers=auth_headers, json=body_finished)
    print("(EXT-HIST finished:", r2.status_code, r2.text[:200], ")", end="")
    assert r2.status_code == 200
    assert r2.json().get("ok") is True

    # 3) Read newest 2 history items and verify they are these two, newest-first
    rget = requests.get(url, headers=auth_headers, params={"limit": 2})
    print("(HISTORY after external:", rget.status_code, rget.text[:300], ")", end="")
    assert rget.status_code == 200
    payload = rget.json()
    items = payload.get("items", [])
    assert len(items) >= 2, "Expected at least two history items after posting external events"

    first, second = items[0], items[1]

    # Newest should be 'enrichment_finished'
    assert first.get("kind") == "enrichment_finished"
    assert first.get("actorType") == "system"
    assert first.get("actorId") is None
    assert first.get("data", {}).get("enricher") == "JDClassifier"
    assert first.get("data", {}).get("requestId") == req_id
    assert isinstance(first.get("data", {}).get("metrics", {}).get("latencyMs"), int)

    # Next should be the earlier 'enrichment_requested'
    assert second.get("kind") == "enrichment_requested"
    assert second.get("actorType") == "system"
    assert second.get("actorId") is None
    assert second.get("data", {}).get("enricher") == "JDClassifier"
    assert second.get("data", {}).get("requestId") == req_id
