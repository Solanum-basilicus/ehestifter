import os
import asyncio
from typing import Optional, Tuple, List
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import (
    Application, CommandHandler, MessageHandler, CallbackQueryHandler,
    ContextTypes, filters
)
from telegram.error import TelegramError
from ehestifter_api import EhestifterApi, ApiJob

load_dotenv()  # loads TELEGRAM_BOT_TOKEN from .env
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

api = EhestifterApi()  # configure base URLs & keys inside file/env

# Utilities -----

FINAL_STATUSES = {"offer_accepted", "rejected_unfortunately", "rejected_other"}

async def on_error(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # keep it minimal; you can log context.error
    try:
        await (update.effective_message.reply_text("Oops, something went wrong. Try again.")  # type: ignore
               if update and update.effective_message else asyncio.sleep(0))
    except TelegramError:
        pass  # avoid cascaded errors


def parse_args(text: str) -> List[str]:
    # naive splitter; good enough for our simple commands
    return text.strip().split()[1:]

# Commands -----

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    linked = await api.is_linked(user.id)
    if linked:
        await update.effective_chat.send_message(
            "Hi! Your account is linked. Use /applied <url>, /status <new_status> <search>, or /myjobs [search]."
        )
    else:
        await update.effective_chat.send_message(
            "Hi! Your account is not linked yet.\n"
            "Open Ehestifter → /me, copy your link code, then send: /link YOURCODE"
        )

async def link(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = parse_args(update.message.text or "")
    if not args:
        await update.message.reply_text("Usage: /link CODE")
        return
    code = args[0]
    ok, msg = await api.link_telegram(code, update.effective_user.id)
    await update.message.reply_text("Linked ✅" if ok else f"Link failed ❌: {msg}")

async def applied(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = parse_args(update.message.text or "")
    if not args:
        await update.message.reply_text("Usage: /applied https://job-url")
        return
    url = args[0]
    job, link = await api.mark_applied_by_url(
        telegram_user_id=update.effective_user.id, url=url
    )
    if job:
        await update.message.reply_text(
            f"Recorded ✅\n{job.company} — {job.title}\n{link}"
        )
    else:
        await update.message.reply_text("Couldn't find/create that job from the URL.")

async def status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = parse_args(update.message.text or "")
    if len(args) < 2:
        await update.message.reply_text("Usage: /status <new_status> <search terms>")
        return
    new_status = args[0]
    query = " ".join(args[1:])

    # Search jobs where this user has a status OR by public catalog, prioritizing user's
    matches = await api.search_jobs_for_user(
        telegram_user_id=update.effective_user.id, q=query, limit=10
    )

    if not matches:
        await update.message.reply_text("No matching jobs found.")
        return
    if len(matches) == 1:
        job = matches[0]
        ok, link = await api.update_user_status(
            telegram_user_id=update.effective_user.id, job_id=job.id, new_status=new_status
        )
        await update.message.reply_text(
            f"Updated to {new_status} ✅\n{job.company} — {job.title}\n{link}" if ok
            else "Update failed ❌"
        )
        return

    # multiple: ask user to choose
    kb = [
        [InlineKeyboardButton(f"{j.company} — {j.title}", callback_data=f"pick|{new_status}|{j.id}")]
        for j in matches
    ]
    await update.message.reply_text(
        "Multiple matches, pick one:", reply_markup=InlineKeyboardMarkup(kb)
    )

async def pick_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.callback_query or not update.callback_query.data:
        return
    _, new_status, job_id = update.callback_query.data.split("|", 2)
    ok, link = await api.update_user_status(
        telegram_user_id=update.effective_user.id, job_id=int(job_id), new_status=new_status
    )
    await update.callback_query.answer()
    await update.callback_query.edit_message_text(
        "Updated ✅\n" + (link or "") if ok else "Update failed ❌"
    )

async def myjobs(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = parse_args(update.message.text or "")
    q = " ".join(args) if args else None
    items, next_offset = await api.list_user_active_jobs(
        telegram_user_id=update.effective_user.id, q=q, limit=10, offset=0
    )
    if not items:
        await update.message.reply_text("No active applications.")
        return
    text = "\n\n".join(
        f"{it.company} — {it.title}\nStatus: {it.user_status}\nApplied: {it.first_seen_at}\n{it.link}"
        for it in items
    )
    kb = None
    if next_offset is not None:
        kb = InlineKeyboardMarkup(
            [[InlineKeyboardButton("Next 10 ▶️", callback_data=f"more|{q or ''}|{next_offset}")]]
        )
    await update.message.reply_text(text, reply_markup=kb)

async def more_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    _, q, offset = (update.callback_query.data or "").split("|", 2)
    items, next_offset = await api.list_user_active_jobs(
        telegram_user_id=update.effective_user.id,
        q=(q or None), limit=10, offset=int(offset)
    )
    if not items:
        await update.callback_query.answer("No more.")
        return
    text = "\n\n".join(
        f"{it.company} — {it.title}\nStatus: {it.user_status}\nApplied: {it.first_seen_at}\n{it.link}"
        for it in items
    )
    kb = None
    if next_offset is not None:
        kb = InlineKeyboardMarkup(
            [[InlineKeyboardButton("Next 10 ▶️", callback_data=f"more|{q}|{next_offset}")]]
        )
    await update.callback_query.edit_message_text(text, reply_markup=kb)

def main() -> None:
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("link", link))
    app.add_handler(CommandHandler("applied", applied))
    app.add_handler(CommandHandler("status", status))
    app.add_handler(CommandHandler("myjobs", myjobs))
    app.add_handler(CallbackQueryHandler(pick_callback, pattern=r"^pick\|"))
    app.add_handler(CallbackQueryHandler(more_callback, pattern=r"^more\|"))
    # Optional: reply to any plain text with a hint
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND,
                                   lambda u, c: u.message.reply_text("Try /applied, /status, or /myjobs.")))
    app.add_error_handler(on_error)
    app.run_polling()

if __name__ == "__main__":
    main()
