# auth.py
import uuid
import azure.functions as func
from helpers.ids import is_guid, normalize_guid

class UnauthorizedError(Exception):
    pass

def get_current_user_id(req: func.HttpRequest) -> str:
    user_id = req.headers.get("X-User-Id")
    if not user_id or not is_guid(user_id):
        raise UnauthorizedError("Missing or invalid X-User-Id")
    return normalize_guid(user_id)

def detect_actor(req: func.HttpRequest):
    """
    Returns (actor_type, actor_id or None).
    Prefers user; else X-Actor-Type: system.
    """
    try:
        uid = get_current_user_id(req)
        return "user", uid
    except UnauthorizedError:
        at = (req.headers.get("X-Actor-Type") or "").lower()
        if at == "system":
            aid = req.headers.get("X-Actor-Id")
            if not (aid and is_guid(aid)):
                aid = None
            return "system", aid
        return "system", None
