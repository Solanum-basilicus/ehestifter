import os, json
from fastapi import FastAPI, Request, Response
from http import HTTPStatus
from telegram import Update
from bot_factory import build_app

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "hook")  # e.g. a random slug
SECRET_TOKEN = os.environ.get("HEADERS_SECRET_TOKEN")

tg = build_app()
app = FastAPI()

@app.get("/health")
async def health():
    return {"ok": True}

@app.post(f"/telegram/{WEBHOOK_SECRET}")
async def telegram_webhook(request: Request):
    data = await request.json()
    if request.headers.get("X-Telegram-Bot-Api-Secret-Token") != os.environ["SECRET_TOKEN"]:
        return Response(status_code=403)
    update = Update.de_json(data, tg.bot)
    await tg.process_update(update)
    return Response(status_code=HTTPStatus.NO_CONTENT)
