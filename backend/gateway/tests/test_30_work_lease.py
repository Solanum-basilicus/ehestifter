def test_30_work_lease(
    gateway_base_url,
    gateway_auth_headers,
    post_json,
    shared_state,
    sb_helpers,
):
    # The only safe correlation we have (unique): run id returned by dispatch
    dispatched_run_id = shared_state["run_id"]

    # Consume the SB message (simulate worker)
    sb_env = sb_helpers["receive_by_run_id"](dispatched_run_id, wait_seconds=20)
    assert sb_env is not None, f"Did not receive SB message for runId={dispatched_run_id}"

    # Optional: verify message content (body may or may not have runId)
    shared_state["sb_env"] = sb_env

    # Optional: extra safety checks (prevents accidentally grabbing something else)
    matched = False

    if str(sb_env.get("message_id") or "").lower() == dispatched_run_id.lower():
        matched = True

    body = sb_env.get("body") or {}
    if isinstance(body, dict) and str(body.get("runId") or "").lower() == dispatched_run_id.lower():
        matched = True

    props = sb_env.get("application_properties") or {}
    for k in ("runId", "run_id", "RunId", "messageId"):
        if str(props.get(k) or "").lower() == dispatched_run_id.lower():
            matched = True

    assert matched, f"Peeked message did not actually match runId={dispatched_run_id}. Got sb_env={sb_env}"


    url = f"{gateway_base_url}/api/work/lease"
    r = post_json(url, gateway_auth_headers, {"runId": dispatched_run_id}, label="LEASE")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"

    data = r.json()
    assert data["runId"].lower() == dispatched_run_id.lower()
    assert "leaseToken" in data and data["leaseToken"]
    assert "leaseUntil" in data and data["leaseUntil"]
    assert "input" in data and isinstance(data["input"], dict)

    shared_state["lease"] = data
    shared_state["lease_token"] = data["leaseToken"]