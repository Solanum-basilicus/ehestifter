import sys
from pathlib import Path

CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

import app_config


def test_local_host_uses_existing_session_directory(monkeypatch):
    monkeypatch.delenv("SESSION_FILE_DIR", raising=False)
    monkeypatch.delenv("WEBSITE_SITE_NAME", raising=False)

    assert app_config._get_session_file_dir() == "flask_session"


def test_azure_app_service_uses_persistent_session_directory(monkeypatch):
    monkeypatch.delenv("SESSION_FILE_DIR", raising=False)
    monkeypatch.setenv("WEBSITE_SITE_NAME", "ehestifter")

    assert app_config._get_session_file_dir() == "/home/data/ehestifter-core-sessions"


def test_session_directory_override_has_priority(monkeypatch):
    monkeypatch.setenv("WEBSITE_SITE_NAME", "ehestifter")
    monkeypatch.setenv("SESSION_FILE_DIR", "/tmp/test-sessions")

    assert app_config._get_session_file_dir() == "/tmp/test-sessions"
