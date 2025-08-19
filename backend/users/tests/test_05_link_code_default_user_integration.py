# tests/test_05_link_code_default_user_integration.py
import os
import json
import uuid
import requests
import pytest

BOT_KEY = os.getenv("USERS_BOT_FUNCTION_KEY")

@pytest.mark.skipif(not BOT_KEY, reason="USERS_BOT_FUNCTION_KEY not set")
def test_05_link_code_for_default_user(base_url, auth_headers, default_user):
    assert base_url and default_user

    s = requests.Session()
    s.headers.update({"Accept": "application/json"})

    # 1) Ensure default user exists (creates if necessary)
    r_me = s.get(
        f"{base_url}/api/users/me",
        headers={**auth_headers, "x-user-sub": default_user, "x-user-email": "itest@ex.com", "x-user-name": "ITester"},
        timeout=20,
    )
    assert r_me.status_code == 200, f"/users/me failed: {r_me.status_code} {r_me.text}"
    me = r_me.json()
    assert "userId" in me

    # 2) Make sure user is unlinked first (idempotent)
    r_unlink = s.post(
        f"{base_url}/api/users/unlink-telegram",
        headers={"x-functions-key": BOT_KEY},
        json={"b2c_object_id": default_user},
        timeout=20,
    )
    assert r_unlink.status_code == 200, f"unlink failed: {r_unlink.status_code} {r_unlink.text}"

    # 3) Get link code for the user (should be unlinked -> returns code)
    r_code = s.get(
        f"{base_url}/api/users/link-code",
        headers={**auth_headers, "x-user-sub": default_user},
        timeout=20,
    )
    assert r_code.status_code == 200, f"link-code failed: {r_code.status_code} {r_code.text}"
    payload = r_code.json()
    assert payload.get("linked") is False
    code = payload.get("code")
    assert code and isinstance(code, str) and len(code) == 8

    # 4) Call again - should return same code (stable until consumed)
    r_code2 = s.get(
        f"{base_url}/api/users/link-code",
        headers={**auth_headers, "x-user-sub": default_user},
        timeout=20,
    )
    assert r_code2.status_code == 200
    payload2 = r_code2.json()
    assert payload2.get("linked") is False
    assert payload2.get("code") == code
