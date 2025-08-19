# tests/test_06_link_and_lookup_default_user_integration.py
import os
import json
import requests
import pytest

BOT_KEY = os.getenv("USERS_BOT_FUNCTION_KEY")

@pytest.mark.skipif(not BOT_KEY, reason="USERS_BOT_FUNCTION_KEY not set")
def test_06_link_then_lookup_and_cleanup(base_url, auth_headers, default_user):
    assert base_url and default_user

    s = requests.Session()
    s.headers.update({"Accept": "application/json"})

    # Ensure exists
    r_me = s.get(
        f"{base_url}/users/me",
        headers={**auth_headers, "x-user-sub": default_user, "x-user-email": "itest@ex.com", "x-user-name": "ITester"},
        timeout=20,
    )
    assert r_me.status_code == 200
    me = r_me.json()

    # Reset link
    s.post(
        f"{base_url}/users/unlink-telegram",
        headers={"x-functions-key": BOT_KEY},
        json={"b2c_object_id": default_user},
        timeout=20,
    )

    # Get link code
    r_code = s.get(
        f"{base_url}/users/link-code",
        headers={**auth_headers, "x-user-sub": default_user},
        timeout=20,
    )
    assert r_code.status_code == 200
    code = r_code.json()["code"]

    # Link as bot with a fake telegram id
    fake_tg_id = 161803398  # arbitrary int
    r_link = s.post(
        f"{base_url}/users/link-telegram",
        headers={"x-functions-key": BOT_KEY},
        json={"code": code, "telegram_user_id": fake_tg_id},
        timeout=20,
    )
    assert r_link.status_code == 200, f"link-telegram failed: {r_link.status_code} {r_link.text}"
    linked_payload = r_link.json()
    assert linked_payload.get("userId") == me["userId"]

    # Verify by-telegram requires bot key
    r_by_tg_no_key = s.get(f"{base_url}/users/by-telegram/{fake_tg_id}", timeout=20)
    assert r_by_tg_no_key.status_code == 401

    # Verify lookup works with bot key
    r_by_tg = s.get(
        f"{base_url}/users/by-telegram/{fake_tg_id}",
        headers={"x-functions-key": BOT_KEY},
        timeout=20,
    )
    assert r_by_tg.status_code == 200, f"by-telegram failed: {r_by_tg.status_code} {r_by_tg.text}"
    info = r_by_tg.json()
    assert info.get("userId") == me["userId"]

    # Link-code now shows linked=true
    r_code2 = s.get(
        f"{base_url}/users/link-code",
        headers={**auth_headers, "x-user-sub": default_user},
        timeout=20,
    )
    assert r_code2.status_code == 200
    payload2 = r_code2.json()
    assert payload2.get("linked") is True
    assert payload2.get("telegramUserId") == fake_tg_id

    # Cleanup: unlink again to keep tests idempotent
    r_unlink = s.post(
        f"{base_url}/users/unlink-telegram",
        headers={"x-functions-key": BOT_KEY},
        json={"telegram_user_id": fake_tg_id},
        timeout=20,
    )
    assert r_unlink.status_code == 200
