def _extract_items(payload):
    # Accept both shapes:
    # 1) [ {run...}, ... ]
    # 2) { "items": [ ... ], "limit": ..., "offset": ... }
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("items"), list):
        return payload["items"]
    raise AssertionError(f"Unexpected history payload shape: {type(payload)} {payload}")


def test_latest_and_history(base_url, auth_headers, get_json, shared_state):
    run_id = shared_state.get("run_id")
    job_id = shared_state.get("job_id")
    user_id = shared_state.get("user_id")
    assert run_id and job_id and user_id, "Missing shared_state from create test"

    # latest
    latest_url = f"{base_url}/api/enrichment/subjects/{job_id}/{user_id}/latest"
    r1 = get_json(latest_url, auth_headers)
    assert r1.status_code == 200, r1.text
    latest = r1.json()

    latest_run_id = latest.get("runId") or latest.get("RunId") or latest.get("id") or latest.get("Id")
    assert str(latest_run_id).lower() == str(run_id).lower()

    # history
    history_url = f"{base_url}/api/enrichment/subjects/{job_id}/{user_id}/history"
    r2 = get_json(history_url, auth_headers)
    assert r2.status_code == 200, r2.text
    payload = r2.json()

    items = _extract_items(payload)

    ids = [
        str(it.get("runId") or it.get("RunId") or it.get("id") or it.get("Id")).lower()
        for it in items
        if isinstance(it, dict)
    ]
    assert str(run_id).lower() in ids
