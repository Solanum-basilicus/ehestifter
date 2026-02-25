import time

from tests._helpers import find_run_in_items, compute_tail_offset

def _list_status(base_url, auth_headers, get_json, status: str, limit: int, offset: int):
    url = f"{base_url}/api/enrichment/runs?status={status}&limit={limit}&offset={offset}"
    r = get_json(url, auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "items" in data and isinstance(data["items"], list)
    assert "total" in data and isinstance(data["total"], int)
    return data

def test_mark_queued_pending_then_noop(base_url, auth_headers, get_json, post_json, shared_state):
    # Requires test_10_create_run.py to have created a run
    run_id = shared_state.get("run_id")
    assert run_id, "Missing shared_state['run_id']; ensure test_10_create_run ran"

    # 1) Determine whether our run is in Pending or already Queued by checking newest 10 in each status.
    # Since /enrichment/runs is sorted RequestedAt ASC, newest are at the tail.
    status_guess = None

    # Check Pending tail
    pending_head = _list_status(base_url, auth_headers, get_json, "Pending", limit=1, offset=0)
    pending_total = pending_head["total"]
    pending_tail_offset = compute_tail_offset(pending_total, tail=10)
    pending_tail = _list_status(base_url, auth_headers, get_json, "Pending", limit=10, offset=pending_tail_offset)
    if find_run_in_items(pending_tail["items"], run_id):
        status_guess = "Pending"

    # If not in Pending tail, check Queued tail
    if status_guess is None:
        queued_head = _list_status(base_url, auth_headers, get_json, "Queued", limit=1, offset=0)
        queued_total = queued_head["total"]
        queued_tail_offset = compute_tail_offset(queued_total, tail=10)
        queued_tail = _list_status(base_url, auth_headers, get_json, "Queued", limit=10, offset=queued_tail_offset)
        if find_run_in_items(queued_tail["items"], run_id):
            status_guess = "Queued"

    # If we didn't find it, it's either older than tail window (unlikely in low load),
    # or it was transitioned to another status. Fail with useful context.
    assert status_guess is not None, (
        f"Could not find run_id={run_id} in newest 10 Pending or Queued runs. "
        f"(Pending total={pending_total}, Queued total={queued_total if 'queued_total' in locals() else 'n/a'})"
    )

    # 2) Call /queued once
    url = f"{base_url}/api/enrichment/runs/{run_id}/queued"
    r1 = post_json(url, auth_headers, {})
    assert r1.status_code in (200, 409), r1.text

    if r1.status_code == 409:
        body = r1.json() if r1.headers.get("content-type", "").startswith("application/json") else r1.text
        assert False, f"/queued returned 409 for run {run_id}: {body}"

    data1 = r1.json()
    assert data1.get("ok") is True, data1
    assert (data1.get("run") or {}).get("status") == "Queued", data1
    assert ((data1.get("run") or {}).get("runId") or "").lower() == run_id.lower()

    # If it was Pending, first call should be a real transition (updated=True).
    if status_guess == "Pending":
        assert data1.get("updated") is True, f"Expected Pending->Queued transition, got {data1}"
    else:
        # If already queued, it should be no-op (updated=False)
        assert data1.get("updated") is False, f"Expected no-op when already Queued, got {data1}"

    time.sleep(0.2)

    # 3) Call /queued again - must be idempotent no-op
    r2 = post_json(url, auth_headers, {})
    assert r2.status_code == 200, r2.text
    data2 = r2.json()
    assert data2.get("ok") is True, data2
    assert (data2.get("run") or {}).get("status") == "Queued", data2
    assert data2.get("updated") is False, f"Expected no-op on second /queued call, got {data2}"