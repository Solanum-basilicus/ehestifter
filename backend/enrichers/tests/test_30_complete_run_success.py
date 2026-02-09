def test_complete_run_success(base_url, auth_headers, post_json, shared_state):
    run_id = shared_state.get("run_id")
    assert run_id, "Missing run_id in shared_state"

    url = f"{base_url}/api/enrichment/runs/{run_id}/complete"

    # Again, tolerant of different shapes.
    payloads_to_try = [
        {
            "status": "Succeeded",
            "result": {"score": 8.5, "summary": "test summary", "debug": {"source": "pytest"}},
        },
        {
            "Status": "Succeeded",
            "Result": {"score": 8.5, "summary": "test summary", "debug": {"source": "pytest"}},
        },
        {
            "score": 8.5,
            "summary": "test summary",
            "result": {"debug": {"source": "pytest"}},
            "status": "Succeeded",
        },
    ]

    last = None
    for p in payloads_to_try:
        last = p
        r = post_json(url, auth_headers, p)
        if r.status_code in (200, 204):
            return

    assert False, f"Complete failed for all payloads. Last payload tried: {last}"
