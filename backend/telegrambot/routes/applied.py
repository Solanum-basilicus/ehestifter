from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes
from helpers.deps import get_api
from helpers.utils import new_error_id, log_exception, friendly_api_message

async def applied(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    api = get_api()
    parts = (update.message.text or "").strip().split()
    if len(parts) < 2:
        await update.message.reply_text("Usage: /applied https://job-url")
        return
    url = parts[1]
    try:
        job, link = await api.mark_applied_by_url(telegram_user_id=update.effective_user.id, url=url)
        await update.message.reply_text(f"Recorded ✅\n{job.company} — {job.title}\n{link}")
    except Exception as e:
        err_id = new_error_id()
        log_exception("applied:mark_applied_by_url", err_id, tg_user_id=update.effective_user.id, url=url)
        msg = friendly_api_message(getattr(e, "api_error", e)) or f"Couldn't process that URL ❌\nError ID: {err_id}"
        await update.message.reply_text(msg)

def register(app: Application):
    app.add_handler(CommandHandler("applied", applied))
