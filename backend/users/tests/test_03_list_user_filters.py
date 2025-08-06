import requests
import pytest


def test_list_user_filters(base_url, auth_headers, default_user, shared_state):
    if "filter_id" not in shared_state:
        pytest.fail("No filter_id in shared state from previous test")

    url = f"{base_url}/users/filters"
    headers = {
        "x-user-sub": default_user,
        **auth_headers
    }

    response = requests.get(url, headers=headers)
    print("List filters response:", response.status_code, response.text)
    assert response.status_code == 200
    filters = response.json()
    assert isinstance(filters, list)
    assert any(f["Id"] == shared_state["filter_id"] for f in filters)
    