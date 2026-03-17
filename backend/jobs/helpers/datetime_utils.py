# helpers/datetime_utils.py
from datetime import datetime, timezone


def parse_required_iso_datetime_to_utc_naive(value: str, field_name: str = "datetime") -> datetime:
    """
    Accept ISO-8601 datetime with timezone, normalize to UTC, then return naive UTC.
    This is useful when SQL columns are DATETIME2 (no timezone info).
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty ISO datetime string")

    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"

    try:
        dt = datetime.fromisoformat(text)
    except Exception:
        raise ValueError(f"{field_name} must be a valid ISO datetime string")

    if dt.tzinfo is None:
        raise ValueError(f"{field_name} must include timezone info")

    # Normalize to UTC, then drop tzinfo so it matches SQL DATETIME2 values
    return dt.astimezone(timezone.utc).replace(tzinfo=None)