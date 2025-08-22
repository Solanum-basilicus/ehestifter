import os, json
from fastapi import FastAPI, Request, Response
from http import HTTPStatus
from telegram import Update
from bot_factory import build_app

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "hook")  # e.g. a random slug
SECRET_TOKEN = os.environ.get("HEADERS_SECRET_TOKEN")

tg = build_app()

# ---- prefer lifespan over on_event in modern FastAPI
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # initialize and start PTB once per process
    await tg.initialize()
    await tg.start()
    try:
        yield
    finally:
        await tg.stop()
        await tg.shutdown()

app = FastAPI(lifespan=lifespan)

@app.get("/health")
async def health():
    return {"ok": True}

@app.post(f"/telegram/{WEBHOOK_SECRET}")
async def telegram_webhook(request: Request):    
    # optional header check if you set secret_token in setWebhook
    if request.headers.get("X-Telegram-Bot-Api-Secret-Token") != SECRET_TOKEN:
        return Response(status_code=403)
    data = await request.json()
    update = Update.de_json(data, tg.bot)
    await tg.process_update(update)
    return Response(status_code=HTTPStatus.NO_CONTENT)
