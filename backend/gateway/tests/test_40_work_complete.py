def test_40_work_complete_success_and_verify_core(
    gateway_base_url,
    gateway_auth_headers,
    core_base_url,
    core_auth_headers,
    post_json,
    get_json,
    shared_state,
    default_job_id,
    default_user_id,
):
    run_id = shared_state["run_id"]
    assert "lease_token" in shared_state, "Lease did not succeed; cannot run complete test"
    lease_token = shared_state["lease_token"]

    # Complete via Gateway
    url = f"{gateway_base_url}/api/work/complete"
    payload = {
        "runId": run_id,
        "leaseToken": lease_token,
        "result": {"score": 0.82, "summary": "pytest: ok"},
    }
    r = post_json(url, gateway_auth_headers, payload, label="COMPLETE")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"

    # Verify Core latest reflects Succeeded
    latest_url = f"{core_base_url}/api/enrichment/subjects/{default_job_id}/{default_user_id}/latest?enricherType={shared_state['enricher_type']}"
    rr = get_json(latest_url, core_auth_headers, label="CORE_LATEST")
    assert rr.status_code == 200, f"Expected 200, got {rr.status_code}: {rr.text}"
    latest = rr.json()

    assert latest["runId"].lower() == run_id.lower()
    assert latest["status"] == "Succeeded"
    assert latest.get("resultJson") is not None, "Expected resultJson to be set"
