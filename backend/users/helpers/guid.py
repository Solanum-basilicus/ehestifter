import uuid
from typing import Optional

def normalize_guid(value) -> Optional[str]:
    """
    Return canonical lowercase hyphenated GUID string, or None if value is falsy.
    Accepts uuid.UUID or string-like. Raises ValueError if unparseable non-empty.
    """
    if value is None or value == "":
        return None
    if isinstance(value, uuid.UUID):
        return str(value)
    s = str(value).strip()
    # Strip braces or other adornments
    if s.startswith("{") and s.endswith("}"):
        s = s[1:-1]
    # Will raise ValueError if invalid -> caller may handle or let it propagate
    return str(uuid.UUID(s))

def try_normalize_guid(value) -> Optional[str]:
    """Best-effort normalization. Returns None if invalid/unparseable/falsy."""
    try:
        return normalize_guid(value)
    except Exception:
        return None