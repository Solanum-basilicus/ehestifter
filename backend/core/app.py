import os
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



@app.route("/")
@auth.login_required
def index(*, context):
    in_app_user = create_or_get_user(context['user'])

    return render_template(
        'index.html',
        user=context['user'],
        in_app_user=in_app_user,
        edit_profile_url=auth.get_edit_profile_url(),
        api_endpoint=os.getenv("ENDPOINT"),
        title=f"Ehestifter application tracking app",
        now=datetime.utcnow()
    )

@app.route("/me")
@auth.login_required
def me(*, context):
    in_app_user = create_or_get_user(context['user'])

    return render_template(
        "me.html", 
        user=context['user'], 
        in_app_user=in_app_user,
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

if __name__ == '__main__':
    app.run(debug=True)
