import os
#import msal
import uuid
import requests
from flask import Flask, render_template
from identity.flask import Auth
import app_config
import logging
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

'''# MSAL / Entra ID Config
auth_config = {
    "CLIENT_ID": os.environ["CLIENT_ID"],
    "CLIENT_SECRET": os.environ["CLIENT_SECRET"],
    "AUTHORITY": os.environ["AUTHORITY"],
    #"REDIRECT_PATH": "/getAToken",
    "REDIRECT_PATH": "/.auth/login/aad/callback",
    "SCOPE": os.environ["SCOPE"].split()
}'''

'''def build_msal_app(cache=None):
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
    )'''

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
        now=datetime.utcnow())

@app.route("/call_api")
@auth.login_required(scopes=os.getenv("SCOPE", "").split())
def call_downstream_api(*, context):
    api_result = requests.get(  # Use access token to call a web api
        os.getenv("ENDPOINT"),
        headers={'Authorization': 'Bearer ' + context['access_token']},
        timeout=30,
    ).json() if context.get('access_token') else "Did you forget to set the SCOPE environment variable?"
    return render_template('display.html', title="API Response", result=api_result)

'''@app.route("/login")
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

    return redirect(url_for("me"))'''


'''@app.route("/logout")
def logout():
    session.clear()
    return redirect(
        auth_config["AUTHORITY"] + "/oauth2/v2.0/logout" +
        f"?post_logout_redirect_uri={url_for('index', _external=True)}"
    )'''

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
