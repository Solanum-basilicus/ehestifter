# tests/test_50_job_history.py
import requests

def test_job_history_get(base_url, auth_headers, shared_state):
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}/history?limit=50"
    r = requests.get(url, headers=auth_headers)
    print("Response text:", response.text, " with status ", response.status_code, end="")
    assert r.status_code == 200, r.text
    data = r.json()
    assert "items" in data and isinstance(data["items"], list)
    # expect at least one record (create)
    assert len(data["items"]) >= 1
