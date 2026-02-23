import logging
import os

def setup_logging() -> None:
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(message)s")

    # Quiet down very verbose SDK internals
    logging.getLogger("azure").setLevel(logging.WARNING)
    logging.getLogger("uamqp").setLevel(logging.WARNING)