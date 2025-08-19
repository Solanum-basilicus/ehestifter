import os
from flask import Flask, render_template
from identity.flask import Auth
import app_config
import logging
from datetime import datetime
from routes import register_all


logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)
logger.addHandler(logging.StreamHandler())

app = Flask(__name__, static_folder="static", template_folder="templates")
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

# Register all /ui API routes
register_all(app, auth)

# -----------------------------
# Views
# -----------------------------
@app.route("/")
@auth.login_required
def index(*, context):
    return render_template(
        'index.html',
        user=context['user'],
        edit_profile_url=auth.get_edit_profile_url(),
        api_endpoint=os.getenv("ENDPOINT"),
        title=f"Ehestifter application tracking app",
        now=datetime.utcnow(),
    )

@app.route("/jobs/<job_id>")
@auth.login_required
def job_details(job_id: str, *, context):
    """Render details page; data is fetched client-side via /ui/jobs/<id>."""
    return render_template(
        "job.html",
        user=context['user'],
        title=f"Job {job_id}",
        job_id=job_id,
        now=datetime.utcnow(),
    )

@app.route("/jobs/new")
@auth.login_required
def job_new(*, context):
    return render_template(
        "job_new.html",
        user=context['user'],
        title="Create job offering",
        now=datetime.utcnow(),
    )

@app.route("/me")
@auth.login_required
def me(*, context):
    return render_template(
        "me.html", 
        user=context['user'], 
        title="Your profile",
        now=datetime.utcnow(),
    )

if __name__ == '__main__':
    app.run(debug=True)
