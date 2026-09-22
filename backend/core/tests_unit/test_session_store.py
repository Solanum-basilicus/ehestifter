import base64
import struct
import sys
import time
from pathlib import Path

import pytest


pytest.importorskip("cachelib")

CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

from helpers.session_security import SessionConfigurationError
from helpers.session_store import (
    EncryptedFileSystemSessionCache,
    configure_session_store,
)


KEY = bytes(range(32))


class FakeApp:
    def __init__(self, session_dir: Path):
        self.config = {"SESSION_FILE_DIR": str(session_dir)}


def test_encrypted_filesystem_cache_stores_and_reads_session(tmp_path):
    cache = EncryptedFileSystemSessionCache(str(tmp_path), KEY)
    store_id = "session:test-session-id"
    session_data = {"_logged_in_user": {"sub": "user-1"}, "_permanent": True}

    assert cache.set(store_id, session_data, timeout=300)
    assert cache.get(store_id) == session_data

    record_path = Path(cache._get_filename(store_id))
    record = record_path.read_bytes()
    assert b"user-1" not in record


def test_encrypted_filesystem_cache_rejects_swapped_session_file(tmp_path):
    cache = EncryptedFileSystemSessionCache(str(tmp_path), KEY)
    victim_id = "session:victim"
    attacker_id = "session:attacker"

    assert cache.set(victim_id, {"user": "victim"}, timeout=300)
    victim_path = Path(cache._get_filename(victim_id))
    attacker_path = Path(cache._get_filename(attacker_id))
    attacker_path.write_bytes(victim_path.read_bytes())

    assert cache.get(attacker_id) is None


def test_encrypted_filesystem_cache_uses_authenticated_expiry(tmp_path):
    cache = EncryptedFileSystemSessionCache(str(tmp_path), KEY)
    store_id = "session:test-session-id"
    cache._session_codec._clock = lambda: 1_000

    assert cache.set(store_id, {"user": "alice"}, timeout=1)

    record_path = Path(cache._get_filename(store_id))
    record = record_path.read_bytes()
    outer_future_expiry = int(time.time()) + 3600
    record_path.write_bytes(struct.pack("I", outer_future_expiry) + record[4:])
    cache._session_codec._clock = lambda: 1_002

    assert cache.get(store_id) is None


def test_azure_session_store_requires_encryption_key(tmp_path):
    fake_app = FakeApp(tmp_path)

    with pytest.raises(SessionConfigurationError, match="required in Azure App Service"):
        configure_session_store(
            fake_app,
            {
                "WEBSITE_SITE_NAME": "ehestifter",
            },
        )


def test_azure_session_store_rejects_legacy_plaintext_directory():
    fake_app = FakeApp(Path("/home/data/ehestifter-core-sessions"))

    with pytest.raises(SessionConfigurationError, match="legacy plaintext"):
        configure_session_store(
            fake_app,
            {
                "WEBSITE_SITE_NAME": "ehestifter",
                "SESSION_ENCRYPTION_KEY": base64.b64encode(KEY).decode("ascii"),
            },
        )


def test_azure_session_store_uses_persistent_encrypted_cache(tmp_path):
    fake_app = FakeApp(tmp_path)
    encoded_key = base64.b64encode(KEY).decode("ascii")

    configure_session_store(
        fake_app,
        {
            "WEBSITE_SITE_NAME": "ehestifter",
            "SESSION_ENCRYPTION_KEY": encoded_key,
        },
    )

    assert fake_app.config["SESSION_TYPE"] == "cachelib"
    assert fake_app.config["SESSION_CACHELIB"]._path == str(tmp_path)
    assert isinstance(
        fake_app.config["SESSION_CACHELIB"],
        EncryptedFileSystemSessionCache,
    )
