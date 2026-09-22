import base64
import io
import sys
from pathlib import Path

import pytest


CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

from helpers.session_security import (
    AuthenticatedSessionCodec,
    SafeFileSystemSerializer,
    SessionConfigurationError,
    decode_session_encryption_key,
)


KEY = bytes(range(32))
STORE_ID = "session:test-session-id"


class MutableClock:
    def __init__(self, value: float):
        self.value = value

    def __call__(self) -> float:
        return self.value


def test_session_codec_encrypts_and_reads_session_data():
    clock = MutableClock(1_000)
    codec = AuthenticatedSessionCodec(
        KEY,
        clock=clock,
        nonce_factory=lambda size: b"n" * size,
    )
    session_data = {
        "_logged_in_user": {"sub": "user-1", "name": "Test User"},
        "_token_cache": "sensitive-token-cache",
        "_permanent": True,
    }

    record = codec.encrypt(STORE_ID, session_data, 300)

    assert b"sensitive-token-cache" not in record
    assert codec.decrypt(STORE_ID, record) == session_data


def test_session_codec_rejects_modified_ciphertext():
    codec = AuthenticatedSessionCodec(
        KEY,
        clock=lambda: 1_000,
        nonce_factory=lambda size: b"n" * size,
    )
    record = bytearray(codec.encrypt(STORE_ID, {"user": "alice"}, 300))
    record[-1] ^= 1

    assert codec.decrypt(STORE_ID, bytes(record)) is None


def test_session_codec_rejects_record_copied_to_another_session():
    codec = AuthenticatedSessionCodec(
        KEY,
        clock=lambda: 1_000,
        nonce_factory=lambda size: b"n" * size,
    )
    record = codec.encrypt(STORE_ID, {"user": "alice"}, 300)

    assert codec.decrypt("session:attacker-session-id", record) is None


def test_session_codec_rejects_record_after_authenticated_expiry():
    clock = MutableClock(1_000)
    codec = AuthenticatedSessionCodec(
        KEY,
        clock=clock,
        nonce_factory=lambda size: b"n" * size,
    )
    record = codec.encrypt(STORE_ID, {"user": "alice"}, 10)

    clock.value = 1_011

    assert codec.decrypt(STORE_ID, record) is None


def test_session_encryption_key_requires_base64_encoded_32_bytes():
    encoded = base64.b64encode(KEY).decode("ascii")

    assert decode_session_encryption_key(encoded) == KEY

    with pytest.raises(SessionConfigurationError, match="valid Base64"):
        decode_session_encryption_key("not base64")

    with pytest.raises(SessionConfigurationError, match="exactly 32 bytes"):
        decode_session_encryption_key(base64.b64encode(b"short").decode("ascii"))


def test_safe_filesystem_serializer_stores_and_reads_bytes_and_cache_count():
    serializer = SafeFileSystemSerializer()

    bytes_stream = io.BytesIO()
    serializer.dump(b"encrypted-session", bytes_stream)
    bytes_stream.seek(0)
    assert serializer.load(bytes_stream) == b"encrypted-session"

    count_stream = io.BytesIO()
    serializer.dump(42, count_stream)
    count_stream.seek(0)
    assert serializer.load(count_stream) == 42


def test_safe_filesystem_serializer_rejects_pickle_data():
    serializer = SafeFileSystemSerializer()
    pickle_like_data = io.BytesIO(b"\x80\x05csome.module\nsome_function\n.")

    assert serializer.load(pickle_like_data) is None
