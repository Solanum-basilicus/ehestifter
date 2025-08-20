import os
import sys
import asyncio
import uuid
import logging
import argparse
from typing import Optional, Tuple, List
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import (
    Application, CommandHandler, MessageHandler, CallbackQueryHandler,
    ContextTypes, filters
)
from telegram.error import TelegramError
from ehestifter_api import EhestifterApi, ApiJob, ApiError


load_dotenv()  # loads TELEGRAM_BOT_TOKEN from .env
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

api = EhestifterApi()  # configure base URLs & keys inside file/env

# Utilities -----

# Allowed statuses exactly as in UI
STATUS_OPTIONS = [
    "Applied","Screening Booked","Screening Done","HM interview Booked","HM interview Done",
    "More interviews Booked","More interviews Done","Rejected with Filled","Rejected with Unfortunately",
    "Got Offer","Accepted Offer","Turned down Offer"
]
STATUS_OPTIONS_LOWER = [s.lower() for s in STATUS_OPTIONS]

def parse_status_and_query(full_text_after_command: str) -> tuple[str | None, str]:
    """
    Find the longest status option that matches the start of the text (case-insensitive).
    Returns (canonical_status_or_None, remaining_query_string).
    """
    t = (full_text_after_command or "").strip()
    if not t:
        return None, ""
    # try longest-first to disambiguate
    for status in sorted(STATUS_OPTIONS, key=len, reverse=True):
        sl = status.lower()
        if t.lower().startswith(sl):
            rest = t[len(status):].strip()
            return status, rest
    return None, t  # no match; treat all as query (will trigger usage)

def _new_error_id() -> str:
    return str(uuid.uuid4())[:8]

def _log_exception(where: str, err_id: str, **extra):
    # Logs full traceback to stderr, including a short error id and extra context
    logging.exception(f"[ErrorID {err_id}] {where} failed | context={extra}")

def _friendly_api_message(e: ApiError) -> str | None:
    # Return a custom, user-friendly message for known backend conditions.
    if e.status == 500 and e.body and "Could not connect to the database" in e.body:
        return "Warming up database, could take about 40 seconds. Please try again later."
    if e.status == 404 and getattr(e, "endpoint", "").endswith("/user-statuses"):
        return "Updating status isn't available yet. Please try again later."
    if e.status == 401 and getattr(e, "endpoint", "").endswith("/status"):
        if e.body and "X-User-Id" in e.body:
            return ("I couldn't verify your account for this action.\n"
                    "Use /start to check your link, or /link <code> to reconnect.")
        return "Unauthorized by jobs API. Please try again later."
    return None

async def _reply_oops(update: Update, err_id: str):
    try:
        if update and update.effective_message:
            await update.effective_message.reply_text(
                f"Oops, something went wrong. Try again.\nError ID: {err_id}"
            )
    except TelegramError:
        pass

async def on_error(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Global last-resort error handler
    err_id = _new_error_id()
    _log_exception("Unhandled exception", err_id, tg_user_id=getattr(update.effective_user, "id", None))
    await _reply_oops(update, err_id)


def parse_args(text: str) -> List[str]:
    # naive splitter; good enough for our simple commands
    return text.strip().split()[1:]

# Commands -----

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
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
                "Open Ehestifter → /me, copy your link code, then send: /link YOURCODE"
            )
    except ApiError as e:
        err_id = _new_error_id()
        _log_exception("start:is_linked", err_id, tg_user_id=update.effective_user.id, api=e.to_dict())
        await _reply_oops(update, err_id)

async def link(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = parse_args(update.message.text or "")
    if not args:
        await update.message.reply_text("Usage: /link CODE")
        return
    code = args[0]
    try:
        await api.link_telegram(code, update.effective_user.id)
        await update.message.reply_text("Linked ✅")
    except ApiError as e:
        # Deviation: wrong link code or backend problem
        err_id = _new_error_id()
        logging.warning(f"[ErrorID {err_id}] link failed | tg_user_id={update.effective_user.id} | code={code} | api={e.to_dict()}")
        await update.message.reply_text(f"Link failed ❌\nError ID: {err_id}")

async def applied(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = parse_args(update.message.text or "")
    if not args:
        await update.message.reply_text("Usage: /applied https://job-url")
        return
    url = args[0]
    try:
        job, link = await api.mark_applied_by_url(
            telegram_user_id=update.effective_user.id, url=url
        )
        await update.message.reply_text(
            f"Recorded ✅\n{job.company} — {job.title}\n{link}"
        )
    except ApiError as e:
        # Deviation: failed to create job / unauthorized / bad URL
        err_id = _new_error_id()
        _log_exception("applied:mark_applied_by_url", err_id,
                       tg_user_id=update.effective_user.id, url=url, api=e.to_dict())
        msg = _friendly_api_message(e) or f"Couldn't process that URL ❌\nError ID: {err_id}"
        await update.message.reply_text(msg)


async def status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Parse after the '/status ' prefix
    txt = update.message.text or ""
    # Everything after first space
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
        # Search jobs where this user has a status OR by public catalog, prioritizing user's
        matches = await api.search_jobs_for_user(
            telegram_user_id=update.effective_user.id, q=query, limit=10
        )
    except ApiError as e:
        err_id = _new_error_id()
        _log_exception("status:search_jobs_for_user", err_id,
                       tg_user_id=update.effective_user.id, query=query, api=e.to_dict())
        msg = _friendly_api_message(e) or f"Search failed ❌\nError ID: {err_id}"
        await update.message.reply_text(msg)
        return

    if not matches:
        await update.message.reply_text("No matching jobs found.")
        return
    if len(matches) == 1:
        job = matches[0]
        try:
            link = await api.update_user_status(
                telegram_user_id=update.effective_user.id, job_id=job.id, new_status=new_status
            )
            await update.message.reply_text(
                f"Updated to {new_status} ✅\n{job.company} — {job.title}\n{link}"
            )
        except ApiError as e:
            err_id = _new_error_id()
            _log_exception("status:update_user_status(single)", err_id,
                           tg_user_id=update.effective_user.id, job_id=job.id, new_status=new_status, api=e.to_dict())
            msg = _friendly_api_message(e) or f"Update failed ❌\nError ID: {err_id}"
            await update.message.reply_text(msg)
        return

    # multiple: ask user to choose
    status_idx = STATUS_OPTIONS.index(new_status)
    kb = [[
        InlineKeyboardButton(
            f"{j.company} — {j.title}",
            callback_data=f"pick|{status_idx}|{j.id}"
        )
    ] for j in matches]
    await update.message.reply_text(
        "Multiple matches, pick one:", reply_markup=InlineKeyboardMarkup(kb)
    )

async def pick_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.callback_query or not update.callback_query.data:
        return
    cq = update.callback_query
    _, status_idx_str, job_id = cq.data.split("|", 2)
    try:
        idx = int(status_idx_str)
        if idx < 0 or idx >= len(STATUS_OPTIONS):
            raise ValueError("Invalid status index")
        new_status = STATUS_OPTIONS[idx]
        link = await api.update_user_status(
            telegram_user_id=update.effective_user.id, job_id=job_id, new_status=new_status
        )
        await cq.answer()
        await cq.edit_message_text("Updated ✅\n" + (link or ""))
    except ApiError as e:
        err_id = _new_error_id()
        _log_exception("pick_callback:update_user_status", err_id,
                       tg_user_id=update.effective_user.id, job_id=job_id, status_idx=status_idx_str, api=e.to_dict())
        await cq.answer()
        msg = _friendly_api_message(e) or f"Update failed ❌\nError ID: {err_id}"
        await cq.edit_message_text(msg)
    except Exception as e:
        err_id = _new_error_id()
        _log_exception("pick_callback:decode", err_id,
                       tg_user_id=update.effective_user.id, raw=update.callback_query.data)
        await cq.answer()
        await cq.edit_message_text(f"Update failed ❌\nError ID: {err_id}")


async def myjobs(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = parse_args(update.message.text or "")
    q = " ".join(args) if args else None
    try:
        items, next_offset = await api.list_user_active_jobs(
            telegram_user_id=update.effective_user.id, q=q, limit=10, offset=0
        )
    except ApiError as e:
        err_id = _new_error_id()
        _log_exception("myjobs:list_user_active_jobs", err_id,
                       tg_user_id=update.effective_user.id, q=q, api=e.to_dict())
        msg = _friendly_api_message(e) or f"Oops, couldn't fetch jobs ❌\nError ID: {err_id}"
        await update.message.reply_text(msg)
        return

    # TEMP DEBUG: log what we got
    try:
        logging.warning("[DEBUG /myjobs client] mapped_items=%d next_offset=%s q=%s",
                        len(items), next_offset, q)
    except Exception:
        pass

    if not items:
        await update.message.reply_text("No active applications.")
        return
    def fmt(it):
        lines = []
        # Prefer showing company/title if present, else fall back gradually
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
        # Always include link as last line
        lines.append(it.link)
        return "\n".join(lines)
    text = "\n\n".join(fmt(it) for it in items)
    kb = None
    if next_offset is not None:
        kb = InlineKeyboardMarkup(
            [[InlineKeyboardButton("Next 10 ▶️", callback_data=f"more|{q or ''}|{next_offset}")]]
        )
    await update.message.reply_text(text, reply_markup=kb)

async def more_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    _, q, offset = (update.callback_query.data or "").split("|", 2)
    try:
        items, next_offset = await api.list_user_active_jobs(
            telegram_user_id=update.effective_user.id,
            q=(q or None), limit=10, offset=int(offset)
        )
    except ApiError as e:
        err_id = _new_error_id()
        _log_exception("more_callback:list_user_active_jobs", err_id,
                       tg_user_id=update.effective_user.id, q=q, offset=offset, api=e.to_dict())
        msg = _friendly_api_message(e) or f"Fetch failed ❌ ID: {err_id}"
        await update.callback_query.answer(msg)
        return
    if not items:
        await update.callback_query.answer("No more.")
        return
    def fmt(it):
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
    text = "\n\n".join(fmt(it) for it in items)
    kb = None
    if next_offset is not None:
        kb = InlineKeyboardMarkup(
            [[InlineKeyboardButton("Next 10 ▶️", callback_data=f"more|{q}|{next_offset}")]]
        )
    await update.callback_query.edit_message_text(text, reply_markup=kb)

def main() -> None:
    # Log everything to stderr - ACA and local both capture it
    parser = argparse.ArgumentParser()
    parser.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO"),
                        help="Root log level (e.g. DEBUG, INFO, WARNING, ERROR)")
    args = parser.parse_args()
    # Log to stderr - ACA and local both capture it
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stderr)],
    )
    # Mute chatty libraries at INFO
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("telegram.request").setLevel(logging.WARNING)
    logging.getLogger("telegram.ext._application").setLevel(logging.WARNING)
    logging.info("Starting Telegram bot (cold start)")
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
