import requests


def test_post_job_statuses_bulk(base_url, user_headers, shared_state, test_user_id):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]

    url = f"{base_url}/api/jobs/status"
    r = requests.post(url, headers=user_headers, json={"jobIds": [job_id]})

    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    data = r.json()
    assert "userId" in data
    assert data["userId"].lower() == test_user_id.lower()
    assert "statuses" in data
    assert isinstance(data["statuses"], dict)

    assert data["statuses"].get(job_id) in ("Applied", "Unset")