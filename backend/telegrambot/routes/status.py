from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes
from helpers.deps import get_api
from helpers.constants import STATUS_OPTIONS
from helpers.utils import (
    parse_status_and_query,
    fallback_query_when_status_missing,
    new_error_id, log_exception, friendly_api_message
)

def _status_keyboard(job_id: str) -> InlineKeyboardMarkup:
    rows = []
    for idx, st in enumerate(STATUS_OPTIONS):
        rows.append([InlineKeyboardButton(st, callback_data=f"setstatus|{job_id}|{idx}")])
    return InlineKeyboardMarkup(rows)

def _jobs_keyboard_for_next_status(matches) -> InlineKeyboardMarkup:
    # User will pick job first, then we ask for status
    rows = []
    for j in matches:
        rows.append([InlineKeyboardButton(f"{j.company} — {j.title}", callback_data=f"pickjob|{j.id}")])
    return InlineKeyboardMarkup(rows)

async def status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    api = get_api()
    txt = update.message.text or ""
    _, _, tail = txt.partition(" ")
    new_status, query = parse_status_and_query(tail)
    if not new_status:
        await update.message.reply_text(
            "Usage: /status <status> <search terms>\n"
            "Examples:\n"
            "  /status Screening Booked Molex\n"
            "  /status Rejected with Unfortunately Senior Engineer\n\n"
            "Available statuses:\n- " + "\n- ".join(STATUS_OPTIONS)
        )
        return
    try:
        matches = await api.search_jobs_for_user(telegram_user_id=update.effective_user.id, q=query, limit=10)
    except Exception as e:
        err_id = new_error_id()
        log_exception("status:search_jobs_for_user", err_id, tg_user_id=update.effective_user.id, query=query)
        msg = friendly_api_message(getattr(e, "api_error", e)) or f"Search failed ❌\nError ID: {err_id}"
        await update.message.reply_text(msg)
        return

    if not matches:
        await update.message.reply_text("No matching jobs found.")
        return

    if len(matches) == 1:
        job = matches[0]
        try:
            link = await api.update_user_status(telegram_user_id=update.effective_user.id, job_id=job.id, new_status=new_status)
            await update.message.reply_text(f"Updated to {new_status} ✅\n{job.company} — {job.title}\n{link}")
        except Exception as e:
            err_id = new_error_id()
            log_exception("status:update_user_status(single)", err_id, tg_user_id=update.effective_user.id, job_id=job.id, new_status=new_status)
            msg = friendly_api_message(getattr(e, "api_error", e)) or f"Update failed ❌\nError ID: {err_id}"
            await update.message.reply_text(msg)
        return

    status_idx = STATUS_OPTIONS.index(new_status)
    kb = [[InlineKeyboardButton(f"{j.company} — {j.title}", callback_data=f"pick|{status_idx}|{j.id}")]
          for j in matches]
    await update.message.reply_text("Multiple matches, pick one:", reply_markup=InlineKeyboardMarkup(kb))

async def pick_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # “status known” flow: pick|<statusIdx>|<jobId>
    api = get_api()
    if not update.callback_query or not update.callback_query.data:
        return
    cq = update.callback_query
    try:
        _, status_idx_str, job_id = cq.data.split("|", 2)
        idx = int(status_idx_str)
        if idx < 0 or idx >= len(STATUS_OPTIONS):
            raise ValueError("Invalid status index")
        new_status = STATUS_OPTIONS[idx]
        link = await api.update_user_status(telegram_user_id=update.effective_user.id, job_id=job_id, new_status=new_status)
        await cq.answer()
        await cq.edit_message_text("Updated ✅\n" + (link or ""))
    except Exception as e:
        err_id = new_error_id()
        log_exception("pick_callback:update_user_status", err_id, tg_user_id=update.effective_user.id, raw=update.callback_query.data)
        await cq.answer()
        await cq.edit_message_text(f"Update failed ❌\nError ID: {err_id}")

async def pickjob_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # New first step when status was missing: pickjob|<jobId>
    if not update.callback_query or not update.callback_query.data:
        return
    cq = update.callback_query
    try:
        _, job_id = cq.data.split("|", 1)
        await cq.answer()
        await cq.edit_message_text("And to what status?", reply_markup=_status_keyboard(job_id))
    except Exception:
        # If anything goes wrong, just show usage again
        await cq.answer()
        await cq.edit_message_text("Something went wrong. Please try /status again.")

async def setstatus_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # New second step when status was missing: setstatus|<jobId>|<statusIdx>
    api = get_api()
    if not update.callback_query or not update.callback_query.data:
        return
    cq = update.callback_query
    try:
        _, job_id, status_idx_str = cq.data.split("|", 2)
        idx = int(status_idx_str)
        if idx < 0 or idx >= len(STATUS_OPTIONS):
            raise ValueError("Invalid status index")
        new_status = STATUS_OPTIONS[idx]
        link = await api.update_user_status(telegram_user_id=update.effective_user.id, job_id=job_id, new_status=new_status)
        await cq.answer()
        await cq.edit_message_text("Updated ✅\n" + (link or ""))
    except Exception as e:
        err_id = new_error_id()
        log_exception("setstatus_callback:update_user_status", err_id, tg_user_id=update.effective_user.id, raw=update.callback_query.data)
        await cq.answer()
        await cq.edit_message_text(f"Update failed ❌\nError ID: {err_id}")


def register(app: Application):
    app.add_handler(CommandHandler("status", status))
    app.add_handler(CallbackQueryHandler(pick_callback, pattern=r"^pick\|"))
    app.add_handler(CallbackQueryHandler(pickjob_callback, pattern=r"^pickjob\|"))
    app.add_handler(CallbackQueryHandler(setstatus_callback, pattern=r"^setstatus\|"))
