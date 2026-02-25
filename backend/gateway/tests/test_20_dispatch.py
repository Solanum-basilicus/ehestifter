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
    got = sb_helpers["peek_matching"](
        predicate=lambda env: (
            str(env.get("message_id") or "").lower() == run_id.lower()
            or str((env.get("body") or {}).get("runId") or "").lower() == run_id.lower()
        ),
        wait_seconds=10,
    )
    assert got is not None, "Did not observe dispatched message in SB via peek"
    shared_state["sb_peeked"] = got
