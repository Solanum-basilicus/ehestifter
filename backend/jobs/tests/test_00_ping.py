import requests

def test_ping(base_url, auth_headers):
    url = f"{base_url}/api/ping"
    r = requests.get(url, headers=auth_headers)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200
    assert r.text.strip() == "pong"
