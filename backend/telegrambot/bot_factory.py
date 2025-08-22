import os
from telegram.ext import Application, CommandHandler, ContextTypes
from telegram import Update

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Hello from Ehestifter bot!")

def build_app() -> Application:
    TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not set. Add it as an App Setting in Azure.")    
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    return app
