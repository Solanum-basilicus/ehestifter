from typing import Optional, Tuple
import logging
from telegram import Update
from telegram.ext import ContextTypes
from helpers.utils import new_error_id

log = logging.getLogger("ehes.bot")

def _ids(u: Optional[Update]) -> Tuple[Optional[int], Optional[int], Optional[int]]:
    if not isinstance(u, Update):
        return None, None, None
    user_id = getattr(getattr(u, "effective_user", None), "id", None)
    chat_id = getattr(getattr(u, "effective_chat", None), "id", None)
    msg_id = getattr(getattr(u, "effective_message", None), "message_id", None)
    return user_id, chat_id, msg_id

async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    err_id = new_error_id()
    user_id, chat_id, msg_id = _ids(update if isinstance(update, Update) else None)

    # Log the *real* exception with traceback
    log.error(
        "[ErrorID %s] Unhandled exception | user=%s chat=%s msg=%s",
        err_id, user_id, chat_id, msg_id,
        exc_info=getattr(context, "error", None)
    )

    # Best-effort user-friendly reply
    try:
        if isinstance(update, Update) and getattr(update, "effective_message", None):
            await update.effective_message.reply_text(
                f"Oops, something went wrong. Try again.\nError ID: {err_id}"
            )
    except Exception:
        log.exception("[ErrorID %s] error handler failed while replying", err_id)
