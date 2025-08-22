from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes
from helpers.deps import get_api
from helpers.utils import new_error_id, log_exception, friendly_api_message

def _fmt_item(it) -> str:
    lines = []
    header = None
    if it.company and it.title and it.company != "?" and it.title != "?":
        header = f"{it.company} — {it.title}"
    elif it.title and it.title != "?":
        header = it.title
    elif it.company and it.company != "?":
        header = it.company
    if header:
        lines.append(header)
    if getattr(it, "user_status", None):
        lines.append(f"Status: {it.user_status}")
    if getattr(it, "first_seen_at", None):
        lines.append(f"First seen: {it.first_seen_at}")
    lines.append(it.link)
    return "\n".join(lines)

async def myjobs(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    api = get_api()
    parts = (update.message.text or "").strip().split()
    q = " ".join(parts[1:]) if len(parts) > 1 else None
    try:
        items, next_offset = await api.list_user_active_jobs(
            telegram_user_id=update.effective_user.id, q=q, limit=10, offset=0
        )
    except Exception as e:
        err_id = new_error_id()
        log_exception("myjobs:list_user_active_jobs", err_id, tg_user_id=update.effective_user.id, q=q)
        msg = friendly_api_message(getattr(e, "api_error", e)) or f"Oops, couldn't fetch jobs ❌\nError ID: {err_id}"
        await update.message.reply_text(msg)
        return

    if not items:
        await update.message.reply_text("No active applications.")
        return

    text = "\n\n".join(_fmt_item(it) for it in items)
    kb = None
    if next_offset is not None:
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("Next 10 ▶️", callback_data=f"more|{q or ''}|{next_offset}")]])
    await update.message.reply_text(text, reply_markup=kb)

async def more_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    api = get_api()
    _, q, offset = (update.callback_query.data or "").split("|", 2)
    try:
        items, next_offset = await api.list_user_active_jobs(
            telegram_user_id=update.effective_user.id, q=(q or None), limit=10, offset=int(offset)
        )
    except Exception as e:
        err_id = new_error_id()
        log_exception("more_callback:list_user_active_jobs", err_id, tg_user_id=update.effective_user.id, q=q, offset=offset)
        msg = friendly_api_message(getattr(e, "api_error", e)) or f"Fetch failed ❌ ID: {err_id}"
        await update.callback_query.answer(msg)
        return

    if not items:
        await update.callback_query.answer("No more.")
        return

    text = "\n\n".join(_fmt_item(it) for it in items)
    kb = None
    if next_offset is not None:
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("Next 10 ▶️", callback_data=f"more|{q}|{next_offset}")]])
    await update.callback_query.edit_message_text(text, reply_markup=kb)

def register(app: Application):
    app.add_handler(CommandHandler("myjobs", myjobs))
    app.add_handler(CallbackQueryHandler(more_callback, pattern=r"^more\|"))
