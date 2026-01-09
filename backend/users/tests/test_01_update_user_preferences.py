import requests


def test_update_user_preferences(base_url, auth_headers, default_user, shared_state):
    assert shared_state["Has_connection"]
    url = f"{base_url}/users/preferences"
    headers = {
        "x-user-sub": default_user,
        **auth_headers
    }
    payload = {"CVBlobPath": "cv/test-user-latest.pdf"}

    response = requests.post(url, headers=headers, json=payload)
    print("Preferences update response:", response.status_code, response.text)
    assert response.status_code == 200
    assert "updated" in response.text.lower()
    