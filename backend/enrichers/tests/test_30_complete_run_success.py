def test_complete_run_creates_projection_dispatch(base_url, auth_headers, post_json, get_json, shared_state):
    run_id = shared_state.get("run_id")
    assert run_id, "Missing run_id in shared_state"

    complete_url = f"{base_url}/api/enrichment/runs/{run_id}/complete"
    payload = {
        "status": "Succeeded",
        "result": {
            "score": 8.5,
            "summary": "test summary",
            "debug": {"source": "pytest"},
        },
        "enrichmentAttributes": {
            "testAttr": True
        }
    }

    r = post_json(complete_url, auth_headers, payload)
    assert r.status_code in (200, 204), r.text

    dispatch_url = f"{base_url}/api/internal/enrichment/runs/{run_id}/projection-dispatches"
    r2 = get_json(dispatch_url, auth_headers)
    assert r2.status_code == 200, r2.text

    body = r2.json()
    items = body.get("items", [])
    assert len(items) >= 1, body

    dispatch = items[0]
    assert dispatch["runId"].lower() == run_id.lower()
    assert dispatch["projectionType"] == "job-list.compatibility-score.v1"
    assert dispatch["targetDomain"] == "jobs"
    assert dispatch["status"] in ("Pending", "Delivered")