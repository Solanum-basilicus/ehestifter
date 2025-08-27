import os
import requests

def jobs_base() -> str:
    """
    EHESTIFTER_JOBS_API_BASE_URL should point to the Functions '/api' root,
    e.g. https://<funcapp>.azurewebsites.net/api
    """
    base = os.getenv("EHESTIFTER_JOBS_API_BASE_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("EHESTIFTER_JOBS_API_BASE_URL is not configured")
    return base

def jobs_fx_headers(context=None) -> dict:
    """
    Always send x-functions-key if set.
    If we have a user context, pass X-User-Id; else tell upstream it's a system actor.
    """
    h = {"Accept":"application/json", "Content-Type":"application/json"}
    fxkey = os.getenv("EHESTIFTER_JOBS_FUNCTION_KEY")
    if fxkey:
        h["x-functions-key"] = fxkey
    if context and "userId" in context:
        h["X-User-Id"] = context["userId"]
    else:
        h["X-Actor-Type"] = "system"
    return h

def fx_get_json(url, headers, params=None, timeout=10):
    r = requests.get(url, headers=headers, params=params, timeout=timeout)
    r.raise_for_status()
    return r.json()

def fx_post_json(url, headers, json_body, timeout=15):
    # returns the raw Response; caller decides how to parse / handle status
    return requests.post(url, headers=headers, json=json_body, timeout=timeout)

def fx_delete(url, headers, timeout=15):
    # returns the raw Response; caller decides how to parse / handle status
    return requests.delete(url, headers=headers, timeout=timeout)