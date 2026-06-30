from __future__ import annotations

import base64
import hashlib
import hmac


def build_distinct_id(user_id: str | None, salt: str) -> str | None:
    if not user_id:
        return None

    normalized_user_id = user_id.strip().lower()
    digest = hmac.new(
        key=salt.encode("utf-8"),
        msg=normalized_user_id.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).digest()

    encoded = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"u_{encoded[:43]}"
