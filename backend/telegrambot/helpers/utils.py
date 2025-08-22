import uuid, logging
from helpers.constants import STATUS_OPTIONS
from ehestifter_api import ApiError

def parse_status_and_query(text: str) -> tuple[str | None, str]:
    t = (text or "").strip()
    if not t:
        return None, ""
    for status in sorted(STATUS_OPTIONS, key=len, reverse=True):
        if t.lower().startswith(status.lower()):
            return status, t[len(status):].strip()
    return None, t

def new_error_id() -> str:
    return str(uuid.uuid4())[:8]

def log_exception(where: str, err_id: str, **extra):
    logging.exception(f"[ErrorID {err_id}] {where} failed | context={extra}")

def friendly_api_message(e: ApiError) -> str | None:
    if e.status == 500 and e.body and "Could not connect to the database" in e.body:
        return "Warming up database, could take about 40 seconds. Please try again later."
    if e.status == 404 and getattr(e, "endpoint", "").endswith("/user-statuses"):
        return "Updating status isn't available yet. Please try again later."
    if e.status == 401 and getattr(e, "endpoint", "").endswith("/status"):
        if e.body and "X-User-Id" in e.body:
            return ("I couldn't verify your account for this action.\n"
                    "Use /start to check your link, or /link <code> to reconnect.")
        return "Unauthorized by jobs API. Please try again later."
    # NEW: generic service warm-up for your backends
    if e.status == 500 and any(svc in str(getattr(e, "endpoint", "")) for svc in ("ehestifter-users", "ehestifter-jobs")):
        return "Our backend is waking up. Please try again in ~30–60 seconds."
    return None
