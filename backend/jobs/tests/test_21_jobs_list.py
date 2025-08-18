import requests

def test_jobs_list(base_url, auth_headers):
    url = f"{base_url}/api/jobs?limit=5&offset=0"
    r = requests.get(url, headers=auth_headers)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text
    items = r.json()
    assert isinstance(items, list)
    if items:
        # Each item in list view includes locations array
        assert "locations" in items[0]
