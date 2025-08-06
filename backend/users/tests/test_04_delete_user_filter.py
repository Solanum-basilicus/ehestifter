import requests
import pytest


def test_delete_user_filter(base_url, auth_headers, default_user, shared_state):
    if "filter_id" not in shared_state:
        pytest.fail("No filter_id in shared state from previous test")

    url = f"{base_url}/users/filters/{shared_state['filter_id']}"
    headers = {
        "x-user-sub": default_user,
        **auth_headers
    }

    response = requests.delete(url, headers=headers)
    print("Delete filter response:", response.status_code, response.text)
    assert response.status_code == 200
    assert "deleted" in response.text.lower()
    