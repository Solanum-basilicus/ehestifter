def test_latest_after_complete(base_url, auth_headers, get_json, shared_state):
    run_id = shared_state.get("run_id")
    job_id = shared_state.get("job_id")
    user_id = shared_state.get("user_id")
    assert run_id and job_id and user_id, "Missing shared_state from previous tests"

    latest_url = f"{base_url}/api/enrichment/subjects/{job_id}/{user_id}/latest"
    r = get_json(latest_url, auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()

    latest_run_id = data.get("RunId") or data.get("runId") or data.get("Id") or data.get("id")
    assert str(latest_run_id).lower() == str(run_id).lower()

    status = data.get("Status") or data.get("status")
    assert status is not None, f"No status field in latest: {data}"
    assert str(status).lower() in ("succeeded", "success"), f"Expected Succeeded, got {status}"

    # optional check: result fields presence (depending on your schema)
    # We accept either flattened fields or nested "Result"
    if "Result" in data or "result" in data:
        res = data.get("Result") or data.get("result") or {}
        assert isinstance(res, (dict, str)), f"Unexpected Result type: {type(res)}"
    else:
        # If you expose score/summary directly, validate at least one exists
        score = data.get("Score") or data.get("score")
        summary = data.get("Summary") or data.get("summary")
        assert (score is not None) or (summary is not None), f"Neither Result nor (Score/Summary) present: {data}"
