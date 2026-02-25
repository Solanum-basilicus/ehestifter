import time
import math

def _find_run_in_items(items: list, run_id: str):
    rid = (run_id or "").lower()
    for it in items or []:
        if str(it.get("runId") or "").lower() == rid:
            return it
    return None

def _compute_tail_offset(total: int, tail: int = 10) -> int:
    # offset such that we get up to `tail` newest items assuming RequestedAt ASC ordering
    return max(0, total - tail)

def _list_status(base_url, auth_headers, get_json, status: str, limit: int, offset: int):
    url = f"{base_url}/api/enrichment/runs?status={status}&limit={limit}&offset={offset}"
    r = get_json(url, auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "items" in data and isinstance(data["items"], list)
    assert "total" in data and isinstance(data["total"], int)
    return data

def _tail_items(base_url, auth_headers, get_json, status: str, tail: int = 10):
    head = _list_status(base_url, auth_headers, get_json, status, limit=1, offset=0)
    total = head["total"]
    off = _compute_tail_offset(total, tail=tail)
    tail_page = _list_status(base_url, auth_headers, get_json, status, limit=tail, offset=off)
    return total, tail_page["items"]

def test_mark_queued_pending_then_noop(base_url, auth_headers, post_json, get_json, job_id, default_user_id, enricher_type):
    # 1) Create a run (should return 201; status Pending if dispatch fails)
    create_url = f"{base_url}/api/enrichment/runs"
    r = post_json(create_url, auth_headers, {"jobId": job_id, "userId": default_user_id, "enricherType": enricher_type})
    assert r.status_code in (200, 201), r.text
    data = r.json()
    run_id = data.get("runId")
    assert run_id, data

    # Give DB a moment
    time.sleep(0.2)

    # 2) Find run in Pending or Queued tail (newest 10)
    pending_total, pending_tail = _tail_items(base_url, auth_headers, get_json, "Pending", tail=10)
    in_pending = _find_run_in_items(pending_tail, run_id) is not None

    queued_total, queued_tail = _tail_items(base_url, auth_headers, get_json, "Queued", tail=10)
    in_queued = _find_run_in_items(queued_tail, run_id) is not None

    assert in_pending or in_queued, (
        f"Created run_id={run_id} not found in newest 10 Pending or Queued. "
        f"Pending total={pending_total}, Queued total={queued_total}. "
        f"Create response status={data.get('status')}"
    )

    # 3) Call /queued once
    url = f"{base_url}/api/enrichment/runs/{run_id}/queued"
    r1 = post_json(url, auth_headers, {})
    assert r1.status_code in (200, 409), r1.text

    if r1.status_code == 409:
        body = r1.json() if r1.headers.get("content-type", "").startswith("application/json") else r1.text
        assert False, f"/queued returned 409 for run {run_id}: {body}"

    d1 = r1.json()
    assert d1.get("ok") is True, d1
    assert (d1.get("run") or {}).get("status") == "Queued", d1

    # If it was Pending, should transition (updated=True). If already Queued, should be no-op (updated=False).
    if in_pending:
        assert d1.get("updated") is True, f"Expected Pending->Queued transition, got {d1}"
    else:
        assert d1.get("updated") is False, f"Expected no-op when already Queued, got {d1}"

    time.sleep(0.2)

    # 4) Call /queued again: must be strict no-op
    r2 = post_json(url, auth_headers, {})
    assert r2.status_code == 200, r2.text
    d2 = r2.json()
    assert d2.get("ok") is True, d2
    assert (d2.get("run") or {}).get("status") == "Queued", d2
    assert d2.get("updated") is False, f"Expected no-op on second /queued call, got {d2}"