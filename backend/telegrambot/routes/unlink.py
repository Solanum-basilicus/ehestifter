from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes
from ehestifter_api import ApiError
from helpers.deps import get_api
from helpers.utils import new_error_id, log_exception, friendly_api_message

_CONFIRM = "unlink|confirm"
_CANCEL  = "unlink|cancel"

async def unlink_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Ask for confirmation
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("Unlink now ❗", callback_data=_CONFIRM)],
        [InlineKeyboardButton("Cancel",       callback_data=_CANCEL)],
    ])
    await update.effective_chat.send_message(
        "This will disconnect your Telegram from Ehestifter.\n"
        "You’ll need to /link again to use status updates, etc.",
        reply_markup=kb,
    )

async def unlink_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cq = update.callback_query
    data = (cq.data or "")
    await cq.answer()
    if data == _CANCEL:
        await cq.edit_message_text("Unlink canceled.")
        return

    api = get_api()
    try:
        await api.unlink_telegram(telegram_user_id=update.effective_user.id)
        await cq.edit_message_text("Unlinked ✅\nYou can now /link with a new code.")
    except ApiError as e:
        err_id = new_error_id()
        # Log with API context if available
        ctx = e.to_dict() if hasattr(e, "to_dict") else {"status": getattr(e, "status", None)}
        log_exception("unlink", err_id, tg_user_id=update.effective_user.id, api=ctx)
        msg = friendly_api_message(e) or f"Unlink failed ❌\nError ID: {err_id}"
        await cq.edit_message_text(msg)
    except Exception:
        err_id = new_error_id()
        log_exception("unlink", err_id, tg_user_id=update.effective_user.id)
        await cq.edit_message_text(f"Unlink failed ❌\nError ID: {err_id}")

def register(app: Application):
    app.add_handler(CommandHandler("unlink", unlink_cmd))
    app.add_handler(CallbackQueryHandler(unlink_callback, pattern=r"^unlink\|"))
