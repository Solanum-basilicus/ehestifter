import uuid

import requests


def test_job_locations_bulk_matches_active_location_model(base_url, user_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]

    detail_response = requests.get(f"{base_url}/api/jobs/{job_id}", headers=user_headers)
    assert detail_response.status_code == 200, detail_response.text
    detail = detail_response.json()
    active_model = detail.get("activeLocationModel")
    assert active_model in {"v1", "v2"}

    response = requests.post(
        f"{base_url}/api/jobs/locations",
        headers=user_headers,
        json={"jobIds": [job_id, job_id]},
    )
    print("Response text:", response.text, " with status ", response.status_code, end=" ")
    assert response.status_code == 200, response.text

    data = response.json()
    assert data.get("activeLocationModel") == active_model
    assert set(data.get("locations", {})) == {job_id}
    assert set(data.get("locationsV2", {})) == {job_id}

    if active_model == "v2":
        assert data["locationsV2"][job_id] == detail.get("locationsV2", [])
        assert data["locations"][job_id] == []
    else:
        assert data["locations"][job_id] == detail.get("locations", [])
        assert data["locationsV2"][job_id] == []


def test_job_locations_bulk_rejects_invalid_job_id(base_url, user_headers):
    invalid_id = f"not-a-guid-{uuid.uuid4()}"
    response = requests.post(
        f"{base_url}/api/jobs/locations",
        headers=user_headers,
        json={"jobIds": [invalid_id]},
    )

    assert response.status_code == 400
