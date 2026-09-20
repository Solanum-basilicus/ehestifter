import requests


def _stored_document(payload):
    return {
        "schemaVersion": payload["schemaVersion"],
        "title": payload["title"],
        "eligibility": payload["eligibility"],
    }


def test_put_and_get_neutral_discovery_preferences(
    base_url,
    auth_headers,
    default_user,
    shared_state,
):
    assert shared_state["Has_connection"]
    url = f"{base_url}/users/discovery-preferences"
    headers = {"x-user-sub": default_user, **auth_headers}
    neutral = {
        "schemaVersion": 1,
        "title": {"positive": [], "negative": []},
        "eligibility": None,
    }

    original_response = requests.get(url, headers=headers)
    assert original_response.status_code == 200
    original = _stored_document(original_response.json())

    try:
        put_response = requests.put(url, headers=headers, json=neutral)
        print(
            "Discovery preference update response:",
            put_response.status_code,
            put_response.text,
        )
        assert put_response.status_code == 200
        assert put_response.json()["eligibility"] is None

        get_response = requests.get(url, headers=headers)
        print(
            "Discovery preference get response:",
            get_response.status_code,
            get_response.text,
        )
        assert get_response.status_code == 200
        body = get_response.json()
        assert body["schemaVersion"] == 1
        assert body["title"] == {"positive": [], "negative": []}
        assert body["eligibility"] is None
    finally:
        restore_response = requests.put(url, headers=headers, json=original)
        assert restore_response.status_code == 200
