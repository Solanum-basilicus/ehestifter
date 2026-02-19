def test_30_work_lease(
    gateway_base_url,
    gateway_auth_headers,
    post_json,
    shared_state,
):
    run_id = shared_state["run_id"]

    url = f"{gateway_base_url}/api/work/lease"
    r = post_json(url, gateway_auth_headers, {"runId": run_id}, label="LEASE")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"

    data = r.json()
    assert data["runId"].lower() == run_id.lower()
    assert "leaseToken" in data and data["leaseToken"]
    assert "leaseUntil" in data and data["leaseUntil"]
    assert "input" in data and isinstance(data["input"], dict)

    shared_state["lease"] = data
    shared_state["lease_token"] = data["leaseToken"]
