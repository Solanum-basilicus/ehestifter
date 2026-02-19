from datetime import datetime, timezone

def test_20_dispatch_enqueues_message(
    gateway_base_url,
    gateway_auth_headers,
    post_json,
    sb_helpers,
    shared_state,
):
    run_id = shared_state["run_id"]
    subject_key = shared_state["subject_key"]
    enricher_type = shared_state["enricher_type"]

    url = f"{gateway_base_url}/api/gateway/dispatch"
    payload = {
        "runId": run_id,
        "enricherType": enricher_type,
        "subjectKey": subject_key,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        # suite marker (optional; harmless to gateway/worker)
        "suiteId": shared_state["suite_id"],
    }

    r = post_json(url, gateway_auth_headers, payload, label="DISPATCH")
    assert r.status_code == 202, f"Expected 202, got {r.status_code}: {r.text}"

    # Receive & validate message in SB
    got = sb_helpers["receive_matching"](
        predicate=lambda p: str(p.get("runId", "")).lower() == run_id.lower(),
        wait_seconds=25,
    )
    assert got is not None, "Did not receive matching SB message for dispatched runId"
    assert got.get("enricherType") == enricher_type
    assert got.get("subjectKey") == subject_key

    shared_state["sb_message"] = got
