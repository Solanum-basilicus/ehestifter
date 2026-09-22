from __future__ import annotations

import base64
import binascii
import math
import os
import pickle
import time
from typing import Any, BinaryIO, Callable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


_SESSION_RECORD_MAGIC = b"EHS1"
_NONCE_BYTES = 12
_AES_KEY_BYTES = 32
_MAX_SESSION_PLAINTEXT_BYTES = 1024 * 1024
_MAX_CACHE_VALUE_BYTES = _MAX_SESSION_PLAINTEXT_BYTES + 4096
_CACHE_BYTES_TAG = b"B"
_CACHE_INT_TAG = b"I"
_SESSION_ENVELOPE_VERSION = 1


class SessionConfigurationError(RuntimeError):
    """Raised when secure session storage cannot be configured."""


def decode_session_encryption_key(value: str) -> bytes:
    """Decode one Base64-encoded 256-bit AES key."""
    raw = (value or "").strip()
    if not raw:
        raise SessionConfigurationError("SESSION_ENCRYPTION_KEY is empty")

    try:
        decoded = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SessionConfigurationError(
            "SESSION_ENCRYPTION_KEY must be valid Base64"
        ) from exc

    if len(decoded) != _AES_KEY_BYTES:
        raise SessionConfigurationError(
            "SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes"
        )

    return decoded


def generate_session_encryption_key() -> bytes:
    """Generate one ephemeral 256-bit AES key."""
    return AESGCM.generate_key(bit_length=256)


class AuthenticatedSessionCodec:
    """Encrypt, authenticate, and validate one server-side session record."""

    def __init__(
        self,
        encryption_key: bytes,
        *,
        clock: Callable[[], float] = time.time,
        nonce_factory: Callable[[int], bytes] = os.urandom,
    ) -> None:
        if len(encryption_key) != _AES_KEY_BYTES:
            raise ValueError("encryption_key must contain exactly 32 bytes")

        self._aesgcm = AESGCM(encryption_key)
        self._clock = clock
        self._nonce_factory = nonce_factory

    def encrypt(
        self,
        store_id: str,
        session_data: dict[str, Any],
        timeout_seconds: int | float,
    ) -> bytes:
        """Return one authenticated encrypted session record."""
        timeout = _positive_timeout_seconds(timeout_seconds)
        expires_at = int(self._clock()) + timeout
        envelope = {
            "version": _SESSION_ENVELOPE_VERSION,
            "expires_at": expires_at,
            "session": session_data,
        }
        plaintext = pickle.dumps(envelope, protocol=pickle.HIGHEST_PROTOCOL)
        if len(plaintext) > _MAX_SESSION_PLAINTEXT_BYTES:
            raise ValueError("session data is too large")

        nonce = self._nonce_factory(_NONCE_BYTES)
        if len(nonce) != _NONCE_BYTES:
            raise ValueError("nonce_factory returned an invalid nonce length")

        ciphertext = self._aesgcm.encrypt(
            nonce,
            plaintext,
            _associated_data(store_id),
        )
        return _SESSION_RECORD_MAGIC + nonce + ciphertext

    def decrypt(self, store_id: str, record: bytes) -> dict[str, Any] | None:
        """Return session data only when the record is authentic and current."""
        if not isinstance(record, bytes):
            return None
        if len(record) > _MAX_CACHE_VALUE_BYTES:
            return None

        minimum_size = len(_SESSION_RECORD_MAGIC) + _NONCE_BYTES + 16
        if len(record) < minimum_size or not record.startswith(_SESSION_RECORD_MAGIC):
            return None

        nonce_start = len(_SESSION_RECORD_MAGIC)
        ciphertext_start = nonce_start + _NONCE_BYTES
        nonce = record[nonce_start:ciphertext_start]
        ciphertext = record[ciphertext_start:]

        try:
            plaintext = self._aesgcm.decrypt(
                nonce,
                ciphertext,
                _associated_data(store_id),
            )
        except (InvalidTag, ValueError):
            return None

        if len(plaintext) > _MAX_SESSION_PLAINTEXT_BYTES:
            return None

        try:
            envelope = pickle.loads(plaintext)
        except Exception:
            return None

        if not isinstance(envelope, dict):
            return None
        if envelope.get("version") != _SESSION_ENVELOPE_VERSION:
            return None

        expires_at = envelope.get("expires_at")
        if isinstance(expires_at, bool) or not isinstance(expires_at, int):
            return None
        if expires_at <= int(self._clock()):
            return None

        session_data = envelope.get("session")
        if not isinstance(session_data, dict):
            return None

        return session_data


class SafeFileSystemSerializer:
    """Serialize CacheLib files without deserializing attacker-controlled pickle."""

    def dump(self, value: Any, stream: BinaryIO, protocol: int | None = None) -> None:
        del protocol

        if isinstance(value, bytes):
            if len(value) > _MAX_CACHE_VALUE_BYTES:
                raise ValueError("cache value is too large")
            stream.write(_CACHE_BYTES_TAG + value)
            return

        if isinstance(value, int) and not isinstance(value, bool):
            encoded = str(value).encode("ascii")
            if len(encoded) > 32:
                raise ValueError("cache integer is too large")
            stream.write(_CACHE_INT_TAG + encoded)
            return

        raise TypeError("filesystem session cache accepts only bytes and integers")

    def load(self, stream: BinaryIO) -> bytes | int | None:
        data = stream.read(_MAX_CACHE_VALUE_BYTES + 2)
        if not data or len(data) > _MAX_CACHE_VALUE_BYTES + 1:
            return None

        tag = data[:1]
        payload = data[1:]

        if tag == _CACHE_BYTES_TAG:
            return payload

        if tag == _CACHE_INT_TAG:
            if not payload or len(payload) > 32:
                return None
            try:
                return int(payload.decode("ascii"))
            except (UnicodeDecodeError, ValueError):
                return None

        return None


def _positive_timeout_seconds(value: int | float) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("session timeout must be a number")
    if not math.isfinite(float(value)) or value <= 0:
        raise ValueError("session timeout must be greater than zero")
    return max(1, math.ceil(float(value)))


def _associated_data(store_id: str) -> bytes:
    if not isinstance(store_id, str) or not store_id:
        raise ValueError("store_id must be a non-empty string")
    return b"ehestifter-core-session:v1:" + store_id.encode("utf-8")
