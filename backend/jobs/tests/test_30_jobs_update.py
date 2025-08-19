# tests/test_30_jobs_update.py
import requests

def test_jobs_update_fields_and_locations(base_url, system_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}"
    payload = {
        "title": "Product Manager (Test)",
        "remoteType": "Remote",
        "locations": [
            {"countryName":"Germany","countryCode":"DE","cityName":"Berlin"},
            {"countryName":"Spain","countryCode":"ES","cityName":"Madrid"},
            {"countryName":"United Kingdom","countryCode":"GB","cityName":"London"},
        ]
    }
    r = requests.put(url, headers=system_headers, json=payload)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    # verify
    r2 = requests.get(url, headers=system_headers)
    #print("Response text:", response.text, " with status ", response.status_code, end="")
    assert r2.status_code == 200
    job = r2.json()
    assert job.get("Title") == "Product Manager (Test)"
    assert job.get("RemoteType") == "Remote"
    locs = job.get("locations") or []
    cities = {(l.get("countryCode"), l.get("cityName")) for l in locs}
    assert ("DE","Berlin") in cities and ("ES","Madrid") in cities and ("GB","London") in cities
