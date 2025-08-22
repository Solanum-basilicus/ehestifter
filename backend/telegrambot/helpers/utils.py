import uuid, logging
from ehestifter_api import ApiError
from typing import Tuple, Optional, Iterable

def _starts_with_any(s: str, prefixes: Iterable[str]) -> bool:
    s = s.strip().lower()
    return any(s.startswith(p) for p in prefixes)

def parse_status_and_query(text: str, status_options: list[str]) -> tuple[Optional[str], str]:
    """
    Try to parse a leading status from `text`. If no status matches exactly,
    return (None, text) unchanged — caller may choose to derive a fallback query.
    """
    t = (text or "").strip()
    if not t:
        return None, ""

    # Try exact leading match against known statuses (longest first)
    for status in sorted(status_options, key=len, reverse=True):
        if t.lower().startswith(status.lower()):
            return status, t[len(status):].strip()

    # No status match
    return None, t


def fallback_query_when_status_missing(raw_tail: str) -> str:
    """
    When user misspells status, skip the first 2 words by default,
    or 3 words if the text starts with 'hm', 'mo', or 're'. Always leave at least one word.
    """
    t = (raw_tail or "").strip()
    if not t:
        return ""

    words = t.split()
    skip = 3 if _starts_with_any(t, ("hm", "mo", "re")) else 2

    if len(words) <= skip:
        # Always leave at least one word
        return words[-1]

    return " ".join(words[skip:])

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
