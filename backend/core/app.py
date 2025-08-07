import os
from flask import Flask, session, redirect, url_for, render_template, request
from flask_session import Session
import msal
import uuid
import logging
from datetime import datetime

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)
logger.addHandler(logging.StreamHandler())

app = Flask(__name__)

# Config for Flask session
app.config["SECRET_KEY"] = os.environ["FLASK_SECRET_KEY"]
app.config["SESSION_TYPE"] = "filesystem"
Session(app)

# MSAL / Entra ID Config
auth_config = {
    "CLIENT_ID": os.environ["CLIENT_ID"],
    "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET": os.environ["MICROSOFT_PROVIDER_AUTHENTICATION_SECRET"],
    "AUTHORITY": os.environ["AUTHORITY"],
    #"REDIRECT_PATH": "/getAToken",
    "REDIRECT_PATH": "/.auth/login/aad/callback",
    "SCOPE": os.environ["SCOPE"].split()
}

def build_msal_app(cache=None):
    return msal.ConfidentialClientApplication(
        auth_config["CLIENT_ID"],
        authority=auth_config["AUTHORITY"],
        client_credential=auth_config["MICROSOFT_PROVIDER_AUTHENTICATION_SECRET"],
        token_cache=cache
    )

def build_auth_url():
    return build_msal_app().get_authorization_request_url(
        scopes=auth_config["SCOPE"],
        state=str(uuid.uuid4()),
        redirect_uri=url_for("authorized", _external=True),
    )

@app.route("/")
def index():
    logging.info(f"User hit root giving index or redirecting to /me if logged in.")
    user = session.get("user")
    return render_template("index.html", user=user, now=datetime.utcnow())

@app.route("/login")
def login():
    try:
        login_url = build_auth_url()
        logging.debug(f"Redirecting to login URL: {login_url}")
        return redirect(login_url)
    except Exception as e:
        logging.exception("Failed to build login URL")
        return f"Internal error during login. Exception: {e}"

@app.route(auth_config["REDIRECT_PATH"])
def authorized():
    cache = msal.SerializableTokenCache()
    result = build_msal_app(cache).acquire_token_by_authorization_code(
        request.args['code'],
        scopes=auth_config["SCOPE"],
        redirect_uri=url_for("authorized", _external=True)
    )
    if "id_token_claims" in result:
        session["user"] = result["id_token_claims"]
    else:
        logging.error(f"MSAL login error: {result}")
        return f"Login failed: {result.get('error')}<br>{result.get('error_description')}"

    return redirect(url_for("me"))

@app.route("/me")
def me():
    user = session.get("user")
    if not user:
        return render_template("me.html", user=None, now=datetime.utcnow())
    return render_template("me.html", user=user, now=datetime.utcnow())

@app.route("/logout")
def logout():
    session.clear()
    return redirect(
        auth_config["AUTHORITY"] + "/oauth2/v2.0/logout" +
        f"?post_logout_redirect_uri={url_for('index', _external=True)}"
    )

@app.route("/debug/env")
def debug_env():
    return {
        "AUTHORITY": os.environ.get("AUTHORITY"),
        "CLIENT_ID": os.environ.get("CLIENT_ID"),
        "SCOPE": os.environ.get("SCOPE"),
        "SESSION": dict(session),
    }

if __name__ == '__main__':
    app.run(debug=True)
