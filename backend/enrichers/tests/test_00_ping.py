def test_ping(base_url, auth_headers, get_json):
    url = f"{base_url}/api/ping"
    r = get_json(url, auth_headers)
    assert r.status_code == 200
    assert r.text.strip() == "pong"
