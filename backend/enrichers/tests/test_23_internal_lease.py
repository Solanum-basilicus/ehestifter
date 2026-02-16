from datetime import datetime, timedelta, timezone
import uuid

def test_internal_lease(base_url, auth_headers, post_json, shared_state):
    run_id = shared_state["run_id"]

    lease_token = str(uuid.uuid4())
    lease_until = (datetime.now(timezone.utc) + timedelta(minutes=60)).isoformat()

    url = f"{base_url}/api/internal/enrichment/runs/{run_id}/lease"
    r = post_json(url, auth_headers, {"leaseToken": lease_token, "leaseUntil": lease_until})
    assert r.status_code in (200, 204)

    # leasing again should conflict
    r2 = post_json(url, auth_headers, {"leaseToken": str(uuid.uuid4()), "leaseUntil": lease_until})
    assert r2.status_code == 409
    assert r2.json().get("code") in ("ALREADY_LEASED", "NOT_LATEST", "INVALID_STATUS")
