"""Active Jobs location model configuration."""

import logging
import os


VALID_LOCATION_MODELS = {"v1", "v2"}


def active_location_model() -> str:
    """Return the active location model. Use v1 for missing or invalid config."""
    value = (os.getenv("LOCATIONS_ACTIVE_MODEL") or "v1").strip().lower()
    if value in VALID_LOCATION_MODELS:
        return value
    logging.warning("Invalid LOCATIONS_ACTIVE_MODEL=%r. Using v1.", value)
    return "v1"
