from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Optional

from flask import Request

from app.config import AppConfig, KeyBinding


@dataclass(frozen=True)
class AuthContext:
    key_name: str
    source_domain: Optional[str]
    can_ingest: bool
    can_status: bool
    can_dispatch: bool


class AuthError(Exception):
    pass


def authenticate_request(req: Request, config: AppConfig) -> AuthContext:
    presented = req.headers.get("x-functions-key", "")

    if not presented:
        raise AuthError("missing_function_key")

    for binding in config.key_bindings:
        if binding.value and hmac.compare_digest(presented, binding.value):
            return _to_context(binding)

    raise AuthError("invalid_function_key")


def _to_context(binding: KeyBinding) -> AuthContext:
    return AuthContext(
        key_name=binding.name,
        source_domain=binding.source_domain,
        can_ingest=binding.can_ingest,
        can_status=binding.can_status,
        can_dispatch=binding.can_dispatch,
    )
