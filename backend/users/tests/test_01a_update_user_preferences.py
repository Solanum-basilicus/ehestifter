import requests
import uuid


def test_update_user_preferences(base_url, auth_headers, default_user, shared_state):
    assert shared_state["Has_connection"]

    url = f"{base_url}/users/preferences"
    headers = {"x-user-sub": default_user, **auth_headers}

    marker = f"MARKER__CV_PIPELINE__{uuid.uuid4()}"
    shared_state["cv_marker"] = marker

    payload = {
        "CVQuillDelta": {
            "ops": [
                {"insert": "Jane Doe\n"},
                # include irregular spacing + marker so normalization is detectable
                {"insert": f"Skills:   Python   Azure   {marker}\n"},
                {"insert": "\n\n\nExperience\n"},
                {"insert": "2020-2025 Example Corp\n"},
            ]
        }
    }

    response = requests.post(url, headers=headers, json=payload)
    print("Preferences update response:", response.status_code, response.text)

    assert response.status_code == 200
    body = response.json()

    assert body["message"].lower().startswith("preferences updated")
    assert body["CVBlobPath"].endswith(".json")
    assert body["CVTextBlobPath"].endswith(".txt")
    assert len(body["CVVersionId"]) == 64  # sha256 hex

    # Persist for the GET test
    shared_state["cv_blob_path"] = body["CVBlobPath"]
    shared_state["cv_text_blob_path"] = body["CVTextBlobPath"]
    shared_state["cv_version_id"] = body["CVVersionId"]
