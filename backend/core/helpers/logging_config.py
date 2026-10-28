"""Set the Web Core log level for normal and diagnostic operation."""

import logging
import os


_LEVELS = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
}


def core_log_level() -> int:
    """Use WARNING when CORE_LOG_LEVEL is not set or is invalid."""
    name = os.getenv("CORE_LOG_LEVEL", "WARNING").strip().upper()
    return _LEVELS.get(name, logging.WARNING)


def configure_core_logging() -> None:
    """Filter routine logs without adding a second application handler."""
    level = core_log_level()
    logging.basicConfig(level=level)
    # Gunicorn or Azure instrumentation can install a handler first.
    # basicConfig then does nothing, so set the root threshold explicitly.
    logging.getLogger().setLevel(level)
