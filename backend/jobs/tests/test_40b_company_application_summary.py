"""Read-only production integration check after the status test."""

import requests


def test_company_application_summary(base_url, user_headers, shared_state):
    assert "job_id" in shared_state
    job_id = shared_state["job_id"]
    response = requests.get(
        f"{base_url}/api/jobs/{job_id}/company-application-summary",
        headers=user_headers,
        timeout=15,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert isinstance(payload["available"], bool)
    if payload["available"]:
        assert payload["companyName"]
        assert payload["matchBasis"] in ("hiring", "posting")
        assert 0 <= payload["last90Days"] <= payload["last365Days"]
    else:
        assert payload["companyName"] is None
        assert payload["last90Days"] is None
        assert payload["last365Days"] is None
    assert payload["asOfUtc"].endswith("Z")
