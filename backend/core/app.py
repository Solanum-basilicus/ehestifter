import os
import uuid
import requests
from flask import Flask, render_template, Blueprint, jsonify, session, g, request
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

# -----------------------------
# Helpers
# -----------------------------
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

# -----------------------------
# In-app user bootstrap 
# -----------------------------
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

# -----------------------------
# Jobs proxy 
# -----------------------------
def _fetch_jobs_from_api(*, limit:int, offset:int):
    base_url = os.getenv("EHESTIFTER_JOBS_API_BASE_URL")
    function_key = os.getenv("EHESTIFTER_JOBS_FUNCTION_KEY") 
    url = f"{base_url}/jobs"
    params = {"limit": str(limit), "offset": str(offset)}
    headers = {}
    if function_key:
        headers["x-functions-key"] = function_key

    resp = requests.get(url, params=params, headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.json()

def _fetch_job_by_id_from_api(job_id:str):
    base_url = os.getenv("EHESTIFTER_JOBS_API_BASE_URL")
    function_key = os.getenv("EHESTIFTER_JOBS_FUNCTION_KEY")
    url = f"{base_url}/jobs/{job_id}"
    headers = {}
    if function_key:
        headers["x-functions-key"] = function_key

    resp = requests.get(url, headers=headers, timeout=10)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()

@bp.route("/ui/jobs", methods=["GET"])
@auth.login_required
def ui_jobs(*, context):
    """
    Same-origin proxy to Jobs API with small in-session cache and warm-up retries.
    Query params:
      - limit: int (10,25,50,100) default 25
      - offset: int (>=0) default 0
    Response shape:
      { "items": [...], "limit": n, "offset": m, "received": k }
    Note: total count is not available from upstream today.
    """
    try:
        try:
            limit = int(request.args.get("limit", 25))
            offset = int(request.args.get("offset", 0))
        except ValueError:
            return jsonify({"error":"bad_request", "message":"Invalid 'limit' or 'offset'"}), 400

        # clamp page size to allowed set
        allowed_sizes = {10,25,50,100}
        if limit not in allowed_sizes:
            limit = 25
        if offset < 0:
            offset = 0

        # tiny 30s cache keyed by limit+offset to cushion repeated navigations
        cache_key = f"jobs:{limit}:{offset}"
        cached = session.get(cache_key)
        if cached and time.time() - cached.get("ts", 0) < 30:
            return jsonify(cached["data"]), 200

        def call():
            items = _fetch_jobs_from_api(limit=limit, offset=offset)
            return {
                "items": items,
                "limit": limit,
                "offset": offset,
                "received": len(items)
            }

        data = _retry_until_ready(call, attempts=4, base_delay=0.75)
        session[cache_key] = {"data": data, "ts": time.time()}
        return jsonify(data), 200

    except requests.exceptions.RequestException as e:
        logging.warning("Jobs upstream warming/failure: %s", e)
        return jsonify({"error":"upstream_warming", "message":"Jobs service is warming up. Please try again."}), 503
    except Exception as e:
        logging.exception("Jobs proxy failure")
        return jsonify({"error":"server_error", "message":"Unexpected error"}), 500

@bp.route("/ui/jobs/<job_id>", methods=["GET"])
@auth.login_required
def ui_job_details(job_id: str, *, context):
    """Same-origin proxy to GET /jobs/{id}."""
    try:
        cache_key = f"job:{job_id}"
        cached = session.get(cache_key)
        if cached and time.time() - cached.get("ts", 0) < 60:
            return jsonify(cached["data"]), 200

        def call():
            job = _fetch_job_by_id_from_api(job_id)
            if job is None:
                return {"error": "not_found", "message": "Not found"}
            return job

        data = _retry_until_ready(call, attempts=4, base_delay=0.75)
        if not data.get("error"):
            session[cache_key] = {"data": data, "ts": time.time()}
        status = 404 if data.get("error") == "not_found" else 200
        return jsonify(data), status

    except requests.exceptions.RequestException as e:
        logging.warning("Job details upstream issue: %s", e)
        return jsonify({"error":"upstream_warming", "message":"Jobs service is warming up. Please try again."}), 503
    except Exception:
        logging.exception("Job details proxy failure")
        return jsonify({"error":"server_error", "message":"Unexpected error"}), 500

app.register_blueprint(bp)

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
        now=datetime.utcnow()
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
