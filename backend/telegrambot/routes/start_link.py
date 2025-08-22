import os
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, ContextTypes, filters
from helpers.deps import get_api
from helpers.utils import new_error_id, log_exception



def _parse_args(text: str) -> list[str]:
    return (text or "").strip().split()[1:]

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    api = get_api()
    APP_ROOT = os.environ["EHESTIFTER_APP_LINK"] or "UNSET"
    try:
        user = update.effective_user
        linked = await api.is_linked(user.id)
        if linked:
            await update.effective_chat.send_message(
                "Hi! Your account is linked. Use /applied <url>, /status <new_status> <search>, or /myjobs [search]."
            )
        else:
            await update.effective_chat.send_message(
                "Hi! Your account is not linked yet.\n"
                "Open [Ehestifter → /me]({APP_ROOT}/me), copy your link code, then send: /link YOURCODE"
            )
    except ApiError as e:
        err_id = new_error_id()
        # include API context in logs when available
        ctx = e.to_dict() if hasattr(e, "to_dict") else {"status": getattr(e, "status", None), "endpoint": getattr(e, "endpoint", None)}
        log_exception("start:is_linked", err_id, tg_user_id=getattr(update.effective_user, "id", None), api=ctx)
        msg = friendly_api_message(e) or f"Couldn't reach user service ❌\nError ID: {err_id}"
        await update.effective_chat.send_message(msg)
    except Exception:
        err_id = new_error_id()
        log_exception("start:is_linked", err_id, tg_user_id=getattr(update.effective_user, "id", None))
        await update.effective_chat.send_message(f"Oops, something went wrong. Error ID: {err_id}")


async def link(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    api = get_api()
    args = _parse_args(update.message.text or "")
    if not args:
        await update.message.reply_text("Usage: /link CODE")
        return
    code = args[0]
    try:
        await api.link_telegram(code, update.effective_user.id)
        await update.message.reply_text("Linked ✅")
    except ApiError as e:
        err_id = new_error_id()
        ctx = e.to_dict() if hasattr(e, "to_dict") else {"status": getattr(e, "status", None), "endpoint": getattr(e, "endpoint", None)}
        log_exception("link", err_id, tg_user_id=update.effective_user.id, code=code, api=ctx)
        msg = friendly_api_message(e) or f"Link failed ❌\nError ID: {err_id}"
        await update.message.reply_text(msg)
    except Exception:
        err_id = new_error_id()
        log_exception("link", err_id, tg_user_id=update.effective_user.id, code=code)
        await update.message.reply_text(f"Link failed ❌\nError ID: {err_id}")

async def help_hint(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        await update.message.reply_text("Try /applied, /status, or /myjobs.")

def register(app: Application):
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("link", link))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, help_hint))
