"""Check the queued endpoint while a real worker can change the run state."""


def _check_queued_response(response, run_id):
    """Accept a queue result or a conflict with an active worker."""
    assert response.status_code in (200, 409), response.text
    data = response.json()
    assert isinstance(data.get("updated"), bool), data

    if response.status_code == 200:
        assert data.get("ok") is True, data
        run = data.get("run") or {}
        assert str(run.get("runId") or "").lower() == run_id.lower(), data
        # The worker can lease or complete the run before this GET ends.
        assert run.get("status") in (
            "Queued", "Leased", "Succeeded", "Failed", "Superseded", "Expired"
        ), data
    else:
        # A worker already moved the run beyond Pending or Queued.
        assert data.get("ok") is False, data
        assert data["updated"] is False, data
        assert data.get("status") in (
            "Leased", "Succeeded", "Failed", "Superseded", "Expired"
        ), data

    return data


def test_mark_queued_accepts_concurrent_worker(base_url, auth_headers, post_json, job_id, default_user_id, enricher_type):
    create_url = f"{base_url}/api/enrichment/runs"
    created = post_json(
        create_url, auth_headers,
        {"jobId": job_id, "userId": default_user_id, "enricherType": enricher_type},
    )
    assert created.status_code == 201, created.text
    run_id = created.json().get("runId")
    assert run_id, created.text

    # Dispatch can occur before the create request returns. Do not use a
    # Pending/Queued list to locate the run: it can already be Leased.
    url = f"{base_url}/api/enrichment/runs/{run_id}/queued"
    first = post_json(url, auth_headers, {})
    _check_queued_response(first, run_id)

    # A second request must not make the same transition again. If a worker
    # has leased the run, the endpoint must reject the stale request.
    second = post_json(url, auth_headers, {})
    second_data = _check_queued_response(second, run_id)
    assert second_data["updated"] is False, second_data
