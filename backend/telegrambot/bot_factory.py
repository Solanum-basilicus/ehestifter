import os
from telegram.ext import Application, CommandHandler, ContextTypes
from telegram import Update
from helpers.deps import set_api
import logging
import sys
from ehestifter_api import EhestifterApi

# route registrars
from routes.start_link import register as register_start_link
from routes.applied import register as register_applied
from routes.status import register as register_status
from routes.myjobs import register as register_myjobs
from routes.errors import on_error
from routes.unlink import register as register_unlink

def _setup_logging():
    level = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
        force=True,  # <-- override any prior config
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("telegram.request").setLevel(logging.WARNING)
    logging.getLogger("telegram.ext._application").setLevel(logging.WARNING)

def build_app() -> Application:
    _setup_logging()
    TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not set. Add it as an App Setting in Azure.")    

    # One shared API instance
    set_api(EhestifterApi())

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    # Register commands & callbacks
    register_start_link(app)
    register_applied(app)
    register_status(app)
    register_myjobs(app)
    register_unlink(app)

    # Global error handler
    app.add_error_handler(on_error)
    return app