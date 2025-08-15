import os
import uuid
import requests
from flask import Flask, render_template, Blueprint, jsonify, session, request, current_app
from identity.flask import Auth
import app_config
import logging
import time,random
from werkzeug.exceptions import Unauthorized, BadRequest
from datetime import datetime
import bleach
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)
logger.addHandler(logging.StreamHandler())

# cache 
_MEMO = {}  # key -> {"data": ..., "ts": float}

def memo_get(key, ttl):
    item = _MEMO.get(key)
    if item and time.time() - item["ts"] < ttl:
        return item["data"]
    return None

def memo_put(key, data):
    _MEMO[key] = {"data": data, "ts": time.time()}


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
bp = Blueprint("ui_api", __name__)

JOB_FIELDS = [
    "Source", "ExternalId", "Url", "ApplyUrl",
    "HiringCompanyName", "PostingCompanyName", "Title",
    "Country", "Locality", "RemoteType", "Description", "PostedDate"
]

# --- Bleach config ---
ALLOWED_TAGS = [
    # basic text
    "p", "br", "hr", "span", "div",
    # emphasis
    "b", "strong", "i", "em", "u", "code", "pre", "blockquote",
    # lists
    "ul", "ol", "li",
    # headings
    "h1", "h2", "h3", "h4",
    # links + images (images limited to data: via post-pass)
    "a", "img",
]
ALLOWED_ATTRS = {
    "a": ["href", "title"],
    "img": ["src", "alt"],
    # allow class for prose styling if you use it server-side
    "*": ["class"],
}
ALLOWED_PROTOCOLS = ["http", "https", "mailto", "data"]

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

def _clean_payload(d: dict) -> dict:
    """
    Lightweight sanitation: keep only known fields, coerce to str where expected,
    trim whitespace, and normalize PostedDate if provided.
    Authoritative validation still happens in the Azure Function.
    """
    out = {}
    for k in JOB_FIELDS:
        if k not in d:
            continue
        v = d[k]
        if v is None:
            out[k] = None
            continue
        if k == "PostedDate":
            # Accept ISO-like strings; leave as-is and let upstream validate
            # If datetime-local (no zone) arrives, frontend should send proper ISO.
            out[k] = str(v).strip()
        else:
            out[k] = str(v).strip()
    return out

def sanitize_description_html(html: str) -> str:
    """
    1) Bleach-clean to drop scripts/iframes/unsafe tags/attrs.
    2) Remove <img> whose src is NOT data: (block external loads server-side).
    3) Force a/ links to open in new tab with safe rel.
    """
    if not html:
        return ""
    cleaned = bleach.clean(
        html,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        protocols=ALLOWED_PROTOCOLS,
        strip=True,
    )
    soup = BeautifulSoup(cleaned, "html.parser")

    # Drop non-data images (external requests blocked)
    for img in soup.find_all("img"):
        src = (img.get("src") or "").strip()
        if not src.startswith("data:"):
            img.decompose()

    # Normalize links (always new window, safe rel)
    for a in soup.find_all("a"):
        a["target"] = "_blank"
        # include nofollow per your spec
        a["rel"] = "noopener noreferrer nofollow"

    return str(soup)

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

def _get_in_app_user(context, *, ttl_seconds=600):
    """Return in-app user (with userId) from session cache or create it."""
    cached = session.get("in_app_user_cache")
    if cached and time.time() - cached.get("ts", 0) < ttl_seconds:
        return cached["data"]

    def call():
        return create_or_get_user(context['user'])

    data = _retry_until_ready(call, attempts=3, base_delay=0.5)
    session["in_app_user_cache"] = {"data": data, "ts": time.time()}
    return data

def _get_in_app_user_id(context) -> str:
    u = _get_in_app_user(context)
    uid = (u or {}).get("userId")
    if not uid:
        raise ValueError("In-app user is missing userId")
    return uid

# For user's status for a job offering
def call_jobs_status(job_ids, context, timeout=6):
    """
    POST /jobs/status with body {"jobIds": [...]}.
    - Adds X-User-Id from your in-app context
    - Adds x-functions-key if configured
    """
    base_url = os.getenv("EHESTIFTER_JOBS_API_BASE_URL", "").rstrip("/")
    function_key = os.getenv("EHESTIFTER_JOBS_FUNCTION_KEY")
    if not base_url:
        raise RuntimeError("EHESTIFTER_JOBS_API_BASE_URL is not configured")

    user_id = _get_in_app_user_id(context)

    url = f"{base_url}/jobs/status"
    headers = {
        "X-User-Id": user_id,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if function_key:
        headers["x-functions-key"] = function_key

    try:
        resp = requests.post(url, headers=headers, json={"jobIds": job_ids}, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except requests.HTTPError as e:
        # bubble useful info into logs
        logging.warning("call_jobs_status failed: %s - %s", getattr(e.response, "status_code", "?"), getattr(e.response, "text", ""))
        raise

def set_job_status(job_id, status, context, timeout=6):
    base_url = os.getenv("EHESTIFTER_JOBS_API_BASE_URL", "").rstrip("/")
    function_key = os.getenv("EHESTIFTER_JOBS_FUNCTION_KEY")
    if not base_url:
        raise RuntimeError("EHESTIFTER_JOBS_API_BASE_URL is not configured")

    user_id = _get_in_app_user_id(context)

    url = f"{base_url}/jobs/{job_id}/status"
    headers = {
        "X-User-Id": user_id,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if function_key:
        headers["x-functions-key"] = function_key

    try:
        resp = requests.put(url, headers=headers, json={"status": status}, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except requests.HTTPError as e:
        logging.warning("set_job_status failed: %s - %s", getattr(e.response, "status_code", "?"), getattr(e.response, "text", ""))
        raise

@bp.route("/ui/jobs/<job_id>/status", methods=["GET"])
@auth.login_required
def ui_job_status_get(job_id, *, context):
    """
    Returns {"jobId": ..., "status": "<value or Unset>"} for current user.
    """
    try:
        data = call_jobs_status([job_id], context=context)
        statuses = data.get("statuses", {})
        status = statuses.get(job_id) or {k.lower(): v for k, v in statuses.items()}.get(job_id.lower(), "Unset")
        return jsonify({"jobId": job_id, "status": status}), 200
    except requests.HTTPError as e:
        code = e.response.status_code if e.response is not None else 502
        msg  = e.response.text if e.response is not None else "upstream error"
        return jsonify({"error": "upstream_error", "message": msg}), code
    except Exception:
        return jsonify({"error": "upstream_warming", "message": "Status service is warming up. Please try again."}), 503


@bp.route("/ui/jobs/<job_id>/status", methods=["POST"])
@auth.login_required
def ui_job_status_set(job_id, *, context):
    """
    Body: {"status": "<string up to 100 chars>"}
    Returns {"jobId": ..., "status": "..."} (mirrors Function response, simplified).
    """
    body = request.get_json(silent=True) or {}
    status = (body.get("status") or "").strip()
    if not status: raise BadRequest("Missing 'status'")
    if len(status) > 100: raise BadRequest("Status too long (max 100)")

    try:
        data = set_job_status(job_id, status=status, context=context)
        return jsonify({"jobId": data.get("jobId", job_id), "status": data.get("status", status)}), 200
    except requests.HTTPError as e:
        code = e.response.status_code if e.response is not None else 502
        msg  = e.response.text if e.response is not None else "upstream error"
        return jsonify({"error": "upstream_error", "message": msg}), code
    except Exception:
        return jsonify({"error": "upstream_warming", "message": "Could not update status. Please try again."}), 503

@bp.route("/ui/jobs/status", methods=["POST"])
@auth.login_required
def ui_jobs_status_bulk(*, context):
    """
    Body: {"jobIds": ["GUID", ...]}
    Returns: {"userId": "...", "statuses": { jobId: "Status|Unset", ... }}
    """
    body = request.get_json(silent=True) or {}
    job_ids = body.get("jobIds") or []
    # basic trimming + de-dupe; keep original casing as function returns exact keys
    job_ids = [str(x).strip() for x in job_ids if x]
    job_ids = list(dict.fromkeys(job_ids))
    if not job_ids:
        return jsonify({"error":"bad_request","message":"jobIds required"}), 400

    try:
        data = call_jobs_status(job_ids, context=context)  # uses your existing helper
        # Safety: ensure Unset is returned when missing
        m = data.get("statuses") or {}
        for jid in job_ids:
            if jid not in m and jid.lower() not in m:
                m[jid] = "Unset"
        data["statuses"] = m
        return jsonify(data), 200
    except requests.HTTPError as e:
        code = e.response.status_code if e.response is not None else 502
        msg  = e.response.text if e.response is not None else "upstream error"
        return jsonify({"error":"upstream_error","message":msg}), code
    except Exception:
        return jsonify({"error":"upstream_warming","message":"Status service is warming up. Please try again."}), 503



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
        cached = memo_get(cache_key, ttl=30)
        if cached:
            return jsonify(cached), 200

        def call():
            items = _fetch_jobs_from_api(limit=limit, offset=offset)
            return {
                "items": items,
                "limit": limit,
                "offset": offset,
                "received": len(items)
            }

        data = _retry_until_ready(call, attempts=4, base_delay=0.75)
        if not data.get("error"):
            memo_put(cache_key, data)
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
        cached = memo_get(cache_key, ttl=60)
        if cached:
            return jsonify(cached), 200

        def call():
            job = _fetch_job_by_id_from_api(job_id)
            if job is None:
                return {"error": "not_found", "message": "Not found"}
            return job

        data = _retry_until_ready(call, attempts=4, base_delay=0.75)
        # --- server-side sanitize description HTML (recommended) ---
        try:
            desc = data.get("descriptionHtml") or data.get("DescriptionHtml") or data.get("Description") or ""
            if desc:
                data["descriptionHtml"] = sanitize_description_html(desc)
        except Exception:
            logging.exception("Description sanitize failed; returning raw")
        # -----------------------------------------------------------

        # normalizing to save headache. possibly
        data = {
            "Title": data.get("Title"),
            "HiringCompanyName": data.get("HiringCompanyName"),
            "PostingCompanyName": data.get("PostingCompanyName"),
            "Country": data.get("Country"),
            "Locality": data.get("Locality"),
            "RemoteType": data.get("RemoteType"),
            "FirstSeenAt": data.get("FirstSeenAt") or data.get("PostedDate") or data.get("CreatedAt"),
            "LastSeenAt": data.get("LastSeenAt") or data.get("UpdatedAt"),
            "RepostCount": data.get("RepostCount") or 0,
            "Url": data.get("Url"),
            "ApplyUrl": data.get("ApplyUrl"),
            "descriptionHtml": sanitize_description_html(
                data.get("descriptionHtml") or data.get("Description") or ""
            ),
        }        

        if not data.get("error"):
            memo_put(cache_key, data)
        status = 404 if data.get("error") == "not_found" else 200
        return jsonify(data), status

    except requests.exceptions.RequestException as e:
        logging.warning("Job details upstream issue: %s", e)
        return jsonify({"error":"upstream_warming", "message":"Jobs service is warming up. Please try again."}), 503
    except Exception:
        logging.exception("Job details proxy failure")
        return jsonify({"error":"server_error", "message":"Unexpected error"}), 500

@bp.route("/ui/jobs", methods=["POST"])
@auth.login_required
def ui_jobs_create(*, context):
    """Same-origin proxy to POST /jobs with light sanitation."""
    try:
        data = request.get_json(force=True, silent=False)
        if not isinstance(data, dict):
            return jsonify({"error":"bad_request","message":"JSON object required"}), 400

        payload = _clean_payload(data)
        if payload.get("Description"):
            payload["Description"] = sanitize_description_html(payload["Description"])        
        # basic presence check for required fields (avoid roundtrip if obviously missing)
        required = ["Source","ExternalId","Url","HiringCompanyName","Title","Country"]
        missing = [f for f in required if not payload.get(f)]
        if missing:
            return jsonify({"error":"bad_request","message":"Missing required: " + ", ".join(missing)}), 400

        base_url = os.getenv("EHESTIFTER_JOBS_API_BASE_URL")
        if not base_url:
            return jsonify({"error":"server_misconfig","message":"EHESTIFTER_JOBS_API_BASE_URL is not set"}), 500

        function_key = os.getenv("EHESTIFTER_JOBS_FUNCTION_KEY")
        headers = {"Content-Type":"application/json"}
        if function_key:
            headers["x-functions-key"] = function_key

        resp = requests.post(f"{base_url}/jobs", headers=headers, json=payload, timeout=15)
        if resp.status_code == 201:
            body = resp.json()
            return jsonify({"id": body.get("id")}), 201
        # surface upstream validation errors as-is
        return jsonify({"error":"upstream_error","status":resp.status_code,"message":resp.text}), resp.status_code

    except requests.exceptions.RequestException as e:
        logging.warning("Jobs create upstream issue: %s", e)
        return jsonify({"error":"upstream_warming","message":"Jobs service is warming up. Please try again."}), 503
    except Exception:
        logging.exception("Jobs create proxy failure")
        return jsonify({"error":"server_error","message":"Unexpected error"}), 500



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
