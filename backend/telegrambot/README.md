# 1) Create .env
TELEGRAM_BOT_TOKEN=123456:ABC...

# 2) Install deps
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# 3) Run
python bot.py