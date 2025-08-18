import requests

def test_ping(base_url, auth_headers):
    url = f"{base_url}/api/ping"
    r = requests.get(url, headers=auth_headers)
    print("Response text:", response.text, " with status ", response.status_code, end="")
    assert r.status_code == 200
    assert r.text.strip() == "pong"
