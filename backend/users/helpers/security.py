import os

BOT_FUNCTION_KEY = os.getenv("USERS_BOT_FUNCTION_KEY")

def require_bot_key(req) -> bool:
    # Bot calls must include the x-functions-key header and match our env
    provided = req.headers.get("x-functions-key")
    return (BOT_FUNCTION_KEY is not None) and (provided == BOT_FUNCTION_KEY)