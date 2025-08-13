import os
import uuid
import requests
from flask import Flask, render_template, Blueprint, jsonify, session, g
from identity.flask import Auth
import app_config
import logging
import time,random
from werkzeug.exceptions import Unauthorized
from datetime import datetime

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)
logger.addHandler(logging.StreamHandler())


app = Flask(__name__)
app.config.from_object(app_config)
auth = Auth(
    app,
    authority=os.getenv("AUTHORITY"),
    client_id=os.getenv("CLIENT_ID"),
    client_credential=os.getenv("CLIENT_SECRET"),
    redirect_uri=os.getenv("REDIRECT_URI"),
    oidc_authority=os.getenv("OIDC_AUTHORITY"),
    b2c_tenant_name=os.getenv('B2C_TENANT_NAME'),
    b2c_signup_signin_user_flow=os.getenv('SIGNUPSIGNIN_USER_FLOW'),
    b2c_edit_profile_user_flow=os.getenv('EDITPROFILE_USER_FLOW'),
    b2c_reset_password_user_flow=os.getenv('RESETPASSWORD_USER_FLOW'),
)
bp = Blueprint("ui_api", __name__)

in_app_users = {}
def create_or_get_user(msal_user: dict):
    b2c_object_id = msal_user.get("sub")
    if not b2c_object_id:
        raise ValueError("Missing 'sub' claim from identity token")
    useremail = msal_user.get("preferred_username")
    if not useremail:
        raise ValueError("Missing 'preferred_username' claim from identity token. We use it as email and it should be mandatory")
    username = msal_user.get("name")
    if not username:
        raise ValueError("Missing 'name' claim from identity token. We use it as username and it should be mandatory")

    base_url = os.getenv("EHESTIFTER_USERS_API_BASE_URL")
    function_key = os.getenv("EHESTIFTER_USERS_FUNCTION_KEY")

    if not base_url or not function_key:
        raise ValueError("Missing EHESTIFTER_USERS_API_BASE_URL or EHESTIFTER_USERS_FUNCTION_KEY environment variables")

    url = f"{base_url}/users/me"
    headers = {
        "x-user-sub": b2c_object_id,
        "x-functions-key": function_key,
        "x-user-email": useremail,
        "x-user-name": username,
        "Content-Type": "application/json"
    }

    try:
        resp = requests.get(url, headers=headers, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.RequestException as e:
        logging.error("Failed to create or retrieve user from API: %s", e)
        raise

def _retry_until_ready(fn, *, attempts=4, base_delay=0.75):
    last_exc = None
    for i in range(1, attempts + 1):
        try:
            return fn()
        except Exception as e:
            last_exc = e
            # jittered exponential backoff: 0.75, 1.5, 3, 6 (+ jitter)
            sleep_s = base_delay * (2 ** (i - 1)) + random.uniform(0, 0.25)
            logging.warning("in-app user attempt %s/%s failed: %s - sleeping %.2fs",
                            i, attempts, e, sleep_s)
            time.sleep(sleep_s)
    raise last_exc

@bp.route("/ui/users/me", methods=["GET"])
@auth.login_required
def ui_users_me(*, context):
    try:
        # simple 10 minute session cache to avoid hitting slow cold starts on every page view
        cached = session.get("in_app_user_cache")
        if cached and time.time() - cached.get("ts", 0) < 600:
            return jsonify(cached["data"]), 200

        def call():
            # your function already has per-call timeout
            return create_or_get_user(context['user'])

        data = _retry_until_ready(call, attempts=4, base_delay=0.75)
        session["in_app_user_cache"] = {"data": data, "ts": time.time()}
        return jsonify(data), 200

    except Unauthorized as e:
        return jsonify({"error": "unauthorized", "message": str(e)}), 401
    except Exception as e:
        # Present a user-friendly message - do not leak internals
        return jsonify({
            "error": "upstream_warming",
            "message": "User service is warming up. Please try again."
        }), 503

app.register_blueprint(bp)

@app.route("/")
@auth.login_required
def index(*, context):
    return render_template(
        'index.html',
        user=context['user'],
        edit_profile_url=auth.get_edit_profile_url(),
        api_endpoint=os.getenv("ENDPOINT"),
        title=f"Ehestifter application tracking app",
        now=datetime.utcnow()
    )

@app.route("/me")
@auth.login_required
def me(*, context):
    return render_template(
        "me.html", 
        user=context['user'], 
        title="Your profile",
        now=datetime.utcnow())

if __name__ == '__main__':
    app.run(debug=True)
