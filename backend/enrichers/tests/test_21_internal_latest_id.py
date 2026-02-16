def test_internal_latest_id(base_url, auth_headers, post_json, get_json, shared_state, job_id, default_user_id, enricher_type):
    # Create run
    r = post_json(f"{base_url}/api/enrichment/runs", auth_headers, {"jobOfferingId": job_id, "userId": default_user_id, "enricherType": enricher_type})
    assert r.status_code in (200, 201)
    run = r.json()
    subject_key = run["subjectKey"]

    # Get latest-id by subjectKey
    url = f"{base_url}/api/internal/enrichment/subjects/{subject_key}/{enricher_type}/latest-id"
    rr = get_json(url, auth_headers)
    assert rr.status_code == 200
    assert rr.json()["runId"].lower() == run["runId"].lower()

    shared_state["run_id"] = run["runId"]
    shared_state["subject_key"] = subject_key
