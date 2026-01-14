import requests


def test_get_user_preferences_includes_cv_content(base_url, auth_headers, default_user, shared_state):
    assert shared_state["Has_connection"]

    # Ensure test_01 ran and set values
    marker = shared_state.get("cv_marker")
    cv_blob_path = shared_state.get("cv_blob_path")
    cv_text_blob_path = shared_state.get("cv_text_blob_path")
    cv_version_id = shared_state.get("cv_version_id")

    assert marker is not None
    assert cv_blob_path is not None
    assert cv_text_blob_path is not None
    assert cv_version_id is not None

    url = f"{base_url}/users/preferences"
    headers = {"x-user-sub": default_user, **auth_headers}

    r_get = requests.get(url, headers=headers)
    print("Preferences get response:", r_get.status_code, r_get.text)

    assert r_get.status_code == 200
    body = r_get.json()

    # Pointers should match what POST returned
    assert body["CVBlobPath"] == cv_blob_path
    assert body["CVTextBlobPath"] == cv_text_blob_path
    assert body["CVVersionId"] == cv_version_id

    # Quill delta should be present
    assert body["CVQuillDelta"] is not None
    assert "ops" in body["CVQuillDelta"]

    # Plain text should include marker and show normalization happened
    plain = body["CVPlainText"]
    assert plain is not None
    assert marker in plain

    # normalization checks: collapsed spaces
    assert "Skills: Python Azure" in plain
    # normalization checks: no triple newlines
    assert "\n\n\n" not in plain
