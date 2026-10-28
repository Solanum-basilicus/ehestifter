"""Check Web Core log filtering without starting the application."""

import logging
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest


CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

from helpers.logging_config import configure_core_logging, core_log_level


@pytest.mark.parametrize(
    ("input_value", "expected"),
    [
        (None, logging.WARNING),
        ("debug", logging.DEBUG),
        (" INFO ", logging.INFO),
        ("error", logging.ERROR),
        ("CRITICAL", logging.CRITICAL),
        ("invalid", logging.WARNING),
        ("", logging.WARNING),
    ],
)
def test_core_log_level_uses_known_values_or_warning(monkeypatch, input_value, expected):
    if input_value is None:
        monkeypatch.delenv("CORE_LOG_LEVEL", raising=False)
    else:
        monkeypatch.setenv("CORE_LOG_LEVEL", input_value)
    assert core_log_level() == expected


def test_logging_configuration_changes_root_level_without_extra_handler(monkeypatch):
    root = logging.Logger("isolated-root", level=logging.DEBUG)
    handler = logging.NullHandler()
    root.addHandler(handler)
    basic_config = Mock()
    monkeypatch.setenv("CORE_LOG_LEVEL", "WARNING")
    monkeypatch.setattr(logging, "basicConfig", basic_config)
    monkeypatch.setattr(logging, "getLogger", lambda: root)

    configure_core_logging()
    configure_core_logging()

    assert root.level == logging.WARNING
    assert root.handlers == [handler]
    assert basic_config.call_count == 2
    assert all(call.kwargs == {"level": logging.WARNING} for call in basic_config.call_args_list)
