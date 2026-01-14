import requests


def test_update_user_preferences(base_url, auth_headers, default_user, shared_state):
    assert shared_state["Has_connection"]
    url = f"{base_url}/users/preferences"
    headers = {
        "x-user-sub": default_user,
        **auth_headers
    }

    payload = {
        "CVQuillDelta": {
            "ops": [
                {"insert": "Jane Doe\n"},
                {"insert": "Backend Engineer\n"},
                {"insert": "\nExperience\n"},
                {"insert": "2020-2025 Example Corp\n"},
            ]
        }
    }

    response = requests.post(url, headers=headers, json=payload)
    print("Preferences update response:", response.status_code, response.text)

    assert response.status_code == 200
    body = response.json()
    assert body["message"].lower().startswith("preferences updated")
    assert "CVBlobPath" in body
    assert "CVTextBlobPath" in body
    assert "CVVersionId" in body
