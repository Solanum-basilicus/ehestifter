import time

def test_create_enrichment_run(base_url, auth_headers, post_json, shared_state, job_id, default_user_id, enricher_type):
    url = f"{base_url}/api/enrichment/runs"

    # We try a couple likely shapes to match your implementation
    payloads_to_try = [
        {"jobId": job_id, "userId": default_user_id, "enricherType": enricher_type},
        {"job_id": job_id, "user_id": default_user_id, "enricher_type": enricher_type},
        # Some APIs use header X-User-Id and body jobId/enricherType only
        {"jobId": job_id, "enricherType": enricher_type},
    ]

    last = None
    for p in payloads_to_try:
        last = p
        r = post_json(url, auth_headers, p)
        if r.status_code in (200, 201):
            data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            run_id = data.get("runId") or data.get("RunId") or data.get("id") or data.get("Id")
            assert run_id, f"Create returned {data}, but no run id field found"
            shared_state["run_id"] = run_id
            shared_state["job_id"] = job_id
            shared_state["user_id"] = default_user_id
            # tiny pause avoids eventual consistency issues if your DB/logic is async-ish
            time.sleep(0.2)
            return

    assert False, f"Could not create run. Last payload tried: {last}"
