import requests


def test_add_user_filter(base_url, auth_headers, default_user, shared_state):
    url = f"{base_url}/users/filters"
    headers = {
        "x-user-sub": default_user,
        **auth_headers
    }
    payload = {
        "FilterText": "python berlin remote",
        "NormalizedJson": '{"skills": ["python"], "location": "berlin", "remote": true}'
    }

    response = requests.post(url, headers=headers, json=payload)
    print("Add filter response:", response.status_code, response.text)
    assert response.status_code == 201
    data = response.json()
    assert "filterId" in data
    shared_state["filter_id"] = data["filterId"]
    