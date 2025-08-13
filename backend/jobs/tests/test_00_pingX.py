import requests

def test_pingX(base_url, auth_headers):
    url = f"{base_url}/api/pingX"
    response = requests.get(url, headers=auth_headers)

    print("Response text:", response.text, " with status ", response.status_code, end="")

    assert response.status_code == 200
    assert response.text.strip() == "pongX"
