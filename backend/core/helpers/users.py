import os, time, logging, requests
from flask import session
from .retry import retry_until_ready

base_url = os.getenv("EHESTIFTER_USERS_API_BASE_URL")
fxkey    = os.getenv("EHESTIFTER_USERS_FUNCTION_KEY")

def create_or_get_user(msal_user: dict):
    b2c_object_id = msal_user.get("sub")
    useremail = msal_user.get("preferred_username")
    username = msal_user.get("name")
    if not (b2c_object_id and useremail and username):
        raise ValueError("Missing identity claims (sub/preferred_username/name)")
    
    if not base_url or not fxkey:
        raise ValueError("Users API env is not configured")

    url = f"{base_url}/users/me"
    headers = {
        "x-user-sub": b2c_object_id,
        "x-functions-key": fxkey,
        "x-user-email": useremail,
        "x-user-name": username,
        "Content-Type": "application/json"
    }
    r = requests.get(url, headers=headers, timeout=10)
    r.raise_for_status()
    return r.json()

def get_in_app_user(context, ttl_seconds=600):
    cached = session.get("in_app_user_cache")
    if cached and time.time() - cached.get("ts", 0) < ttl_seconds:
        return cached["data"]
    def call():
        return create_or_get_user(context["user"])
    data = retry_until_ready(call, attempts=3, base_delay=0.5)
    session["in_app_user_cache"] = {"data": data, "ts": time.time()}
    return data

def get_in_app_user_id(context) -> str:
    u = get_in_app_user(context)
    uid = (u or {}).get("userId")
    if not uid:
        raise ValueError("In-app user is missing userId")
    return uid

def _b2c_headers_from_context(context: dict) -> dict:
    h = {
        "x-user-sub": context["user"]["sub"],
        "x-user-email": context["user"].get("email") or "",
        "x-user-name": context["user"].get("name") or context["user"].get("preferred_username") or "",
        "Accept": "application/json",
    }
    if fxkey:
        h["x-functions-key"] = fxkey
    return h

class UpstreamHttpError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"Upstream status {status}")
        self.status = status
        self.body = body

def _do_get_link_code(url: str, headers: dict) -> dict:
    r = requests.get(url, headers=headers, timeout=5)
    if r.status_code == 200:
        return r.json()
    if r.status_code in (500, 502, 503, 504):
        raise TimeoutError(f"Upstream unavailable: {r.status_code}")
    # Surface other statuses (401/403/404/etc.)
    raise UpstreamHttpError(r.status_code, r.text)

def get_link_code(context: dict) -> dict:
    url = f"{base_url}/users/link-code"
    headers = _b2c_headers_from_context(context)
    return retry_until_ready(lambda: _do_get_link_code(url, headers), attempts=4, base_delay=0.75)

