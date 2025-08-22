from telegram import Update
from telegram.ext import ContextTypes
from helpers.utils import new_error_id, log_exception

async def on_error(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    err_id = new_error_id()
    log_exception("Unhandled exception", err_id, tg_user_id=getattr(update.effective_user, "id", None))
    try:
        if update and update.effective_message:
            await update.effective_message.reply_text(
                f"Oops, something went wrong. Try again.\nError ID: {err_id}"
            )
    except Exception:
        pass
