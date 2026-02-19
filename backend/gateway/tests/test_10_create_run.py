def test_10_create_run_in_core(
    core_base_url,
    core_auth_headers,
    post_json,
    default_job_id,
    default_user_id,
    enricher_type,
    shared_state,
):
    url = f"{core_base_url}/api/enrichment/runs"
    payload = {
        "jobOfferingId": default_job_id,
        "userId": default_user_id,
        "enricherType": enricher_type,
    }

    r = post_json(url, core_auth_headers, payload, label="CREATE_RUN")
    assert r.status_code in (200, 201), f"Expected 200/201, got {r.status_code}: {r.text}"
    data = r.json()

    # store for later tests
    shared_state["run"] = data
    shared_state["run_id"] = data["runId"]
    shared_state["subject_key"] = data["subjectKey"]
    shared_state["enricher_type"] = data["enricherType"]
