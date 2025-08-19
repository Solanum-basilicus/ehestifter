# tests/test_07_negative_bot_auth_integration.py
import os
import requests
import pytest

BOT_KEY = os.getenv("USERS_BOT_FUNCTION_KEY")

@pytest.mark.skipif(not BOT_KEY, reason="USERS_BOT_FUNCTION_KEY not set")
def test_07_bot_endpoints_require_key(base_url):
    s = requests.Session()

    # by-telegram without key
    r = s.get(f"{base_url}/users/by-telegram/424242", timeout=20)
    assert r.status_code == 401

    # link-telegram without key
    r2 = s.post(
        f"{base_url}/users/link-telegram",
        json={"code": "NOPE", "telegram_user_id": 1},
        timeout=20,
    )
    assert r2.status_code == 401

    # unlink-telegram without key
    r3 = s.post(
        f"{base_url}/users/unlink-telegram",
        json={"telegram_user_id": 1},
        timeout=20,
    )
    assert r3.status_code == 401
