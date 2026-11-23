"""The summary must reject the job removed by test_90_cleanup."""

import requests


def test_deleted_job_has_no_company_application_summary(base_url, user_headers, shared_state):
    assert "job_id" in shared_state
    job_id = shared_state["job_id"]
    response = requests.get(
        f"{base_url}/api/jobs/{job_id}/company-application-summary",
        headers=user_headers,
        timeout=15,
    )
    assert response.status_code == 404, response.text
