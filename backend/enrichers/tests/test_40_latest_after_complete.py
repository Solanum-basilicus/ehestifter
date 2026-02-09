def test_latest_after_complete(base_url, auth_headers, get_json, shared_state):
    run_id = shared_state.get("run_id")
    job_id = shared_state.get("job_id")
    user_id = shared_state.get("user_id")
    assert run_id and job_id and user_id, "Missing shared_state from previous tests"

    latest_url = f"{base_url}/api/enrichment/subjects/{job_id}/{user_id}/latest"
    r = get_json(latest_url, auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()

    latest_run_id = data.get("runId") or data.get("RunId") or data.get("id") or data.get("Id")
    assert str(latest_run_id).lower() == str(run_id).lower()

    status = data.get("status") or data.get("Status")
    assert status is not None, f"No status field in latest: {data}"
    assert str(status).lower() in ("succeeded", "success"), f"Expected Succeeded, got {status}"

    result = data.get("result")
    assert isinstance(result, dict), f"Expected result object, got {type(result)}: {result}"

    assert result.get("score") is not None, f"Missing result.score in: {result}"
    assert result.get("summary") is not None, f"Missing result.summary in: {result}"
