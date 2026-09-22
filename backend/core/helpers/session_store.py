from __future__ import annotations

import hashlib
import logging
import os
from typing import Any, Mapping

from cachelib.file import FileSystemCache

from helpers.session_security import (
    AuthenticatedSessionCodec,
    SafeFileSystemSerializer,
    SessionConfigurationError,
    decode_session_encryption_key,
    generate_session_encryption_key,
)


logger = logging.getLogger(__name__)
_SESSION_THRESHOLD = 500
_LEGACY_AZURE_SESSION_DIR = "/home/data/ehestifter-core-sessions"


class EncryptedFileSystemSessionCache(FileSystemCache):
    """Store authenticated encrypted session records in CacheLib files."""

    serializer = SafeFileSystemSerializer()

    def __init__(self, cache_dir: str, encryption_key: bytes) -> None:
        self._session_codec = AuthenticatedSessionCodec(encryption_key)
        super().__init__(
            cache_dir=cache_dir,
            threshold=_SESSION_THRESHOLD,
            hash_method=hashlib.sha256,
        )

    def get(self, key: str) -> dict[str, Any] | int | None:
        raw_value = super().get(key)

        if key == self._fs_count_file:
            return raw_value if isinstance(raw_value, int) else None

        if not isinstance(raw_value, bytes):
            return None

        return self._session_codec.decrypt(key, raw_value)

    def set(
        self,
        key: str,
        value: Any,
        timeout: int | None = None,
        mgmt_element: bool = False,
    ) -> bool:
        if mgmt_element:
            return super().set(
                key,
                value,
                timeout=timeout,
                mgmt_element=True,
            )

        if not isinstance(value, dict):
            raise TypeError("session cache values must be dictionaries")
        if timeout is None:
            raise ValueError("session cache requires an explicit timeout")

        encrypted = self._session_codec.encrypt(key, value, timeout)
        return super().set(key, encrypted, timeout=timeout)


def configure_session_store(app: Any, environ: Mapping[str, str] | None = None) -> None:
    """Configure encrypted server-side sessions before identity initialization."""
    env = os.environ if environ is None else environ
    is_azure_app_service = bool((env.get("WEBSITE_SITE_NAME") or "").strip())

    cache_dir = str(app.config.get("SESSION_FILE_DIR") or "").strip()
    if not cache_dir:
        raise SessionConfigurationError("SESSION_FILE_DIR is empty")
    if is_azure_app_service and cache_dir == _LEGACY_AZURE_SESSION_DIR:
        raise SessionConfigurationError(
            "SESSION_FILE_DIR must not use the legacy plaintext Azure session directory"
        )

    encoded_key = (env.get("SESSION_ENCRYPTION_KEY") or "").strip()
    if encoded_key:
        encryption_key = decode_session_encryption_key(encoded_key)
    elif is_azure_app_service:
        raise SessionConfigurationError(
            "SESSION_ENCRYPTION_KEY is required in Azure App Service"
        )
    else:
        encryption_key = generate_session_encryption_key()
        logger.warning(
            "SESSION_ENCRYPTION_KEY is not set. Local sessions will not survive "
            "an application restart."
        )

    app.config["SESSION_TYPE"] = "cachelib"
    app.config["SESSION_CACHELIB"] = EncryptedFileSystemSessionCache(
        cache_dir=cache_dir,
        encryption_key=encryption_key,
    )

    logger.info(
        "Encrypted session storage configured azure_app_service=%s cache_dir=%s",
        is_azure_app_service,
        cache_dir,
    )
