import requests


def test_get_or_create_user(base_url, auth_headers, default_user, shared_state):
    url = f"{base_url}/users/me"
    headers = {
        "x-user-sub": default_user,
        **auth_headers
    }

    response = requests.get(url, headers=headers)
    print("(MEE response:", response.status_code, response.text, ")", end="")
    if "Could not connect to the database" in response.text:
        raise AssertionError(
            f"Azure Function failed to connect to SQL DB: {response.text} (status {response.status_code})"
        )    
    assert response.status_code == 200, f"Expected 200, got {response.status_code}"

    data = response.json()
    assert "userId" in data, "Missing 'userId' in response"
    assert isinstance(data["userId"], str)
    assert len(data["userId"]) > 0

    # Save to shared state for other tests
    shared_state["user_id"] = data["userId"]
