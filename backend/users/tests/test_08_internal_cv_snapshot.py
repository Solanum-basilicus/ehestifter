# tests/test_08_internal_cv_snapshot.py
import requests
import uuid


def _get_user_id_via_link_code(base_url, auth_headers, default_user) -> str:
    """
    Users API already exposes userId via GET /users/link-code (B2C-authenticated).
    We use it in tests to discover the GUID userId that the internal endpoint expects.
    """
    url = f"{base_url}/users/link-code"
    headers = {"x-user-sub": default_user, **auth_headers}

    r = requests.get(url, headers=headers)
    print("LINK-CODE:", r.status_code, r.text)
    assert r.status_code == 200

    body = r.json()
    assert "userId" in body
    return body["userId"]


def test_08_internal_cv_snapshot_ok(base_url, auth_headers, default_user, shared_state):
    assert shared_state["Has_connection"]

    # Ensure we have the DB userId GUID available
    user_id = shared_state.get("user_id")
    if not user_id:
        user_id = _get_user_id_via_link_code(base_url, auth_headers, default_user)
        shared_state["user_id"] = user_id

    # Call the INTERNAL service endpoint (function-key only)
    url = f"{base_url}/users/internal/{user_id}/cv-snapshot"
    r = requests.get(url, headers={**auth_headers})
    print("CV-SNAPSHOT:", r.status_code, r.text)

    assert r.status_code == 200
    body = r.json()

    # Basic shape
    assert body["UserId"].lower() == user_id.lower()
    assert "CVPlainText" in body
    assert isinstance(body["CVPlainText"], str)
    assert body["CVPlainText"].strip() != ""

    # If earlier preference-update test ran, validate marker + version id
    marker = shared_state.get("cv_marker")
    if marker:
        assert marker in body["CVPlainText"]

    expected_ver = shared_state.get("cv_version_id")
    if expected_ver:
        assert body.get("CVVersionId") == expected_ver


def test_08_internal_cv_snapshot_unauthorized_without_key(base_url, default_user, shared_state):
    assert shared_state["Has_connection"]

    # We still need a valid userId to ensure the auth failure is specifically about missing key.
    # Re-use link-code but WITHOUT function key should fail, so we generate a dummy GUID and just
    # assert 401/403. (Functions typically returns 401 or 403 depending on host config.)
    dummy_user_id = str(uuid.uuid4())
    url = f"{base_url}/users/internal/{dummy_user_id}/cv-snapshot"

    r = requests.get(url)  # no x-functions-key
    print("CV-SNAPSHOT no key:", r.status_code, r.text)

    assert r.status_code in (401, 403)


def test_08_internal_cv_snapshot_invalid_userid_400(base_url, auth_headers, shared_state):
    assert shared_state["Has_connection"]

    url = f"{base_url}/users/internal/not-a-guid/cv-snapshot"
    r = requests.get(url, headers={**auth_headers})
    print("CV-SNAPSHOT invalid userId:", r.status_code, r.text)

    assert r.status_code == 400


def test_08_internal_cv_snapshot_unknown_user_404(base_url, auth_headers, shared_state):
    assert shared_state["Has_connection"]

    # Valid GUID format but (almost certainly) not in DB
    unknown_user_id = str(uuid.uuid4())
    url = f"{base_url}/users/internal/{unknown_user_id}/cv-snapshot"

    r = requests.get(url, headers={**auth_headers})
    print("CV-SNAPSHOT unknown user:", r.status_code, r.text)

    assert r.status_code == 404