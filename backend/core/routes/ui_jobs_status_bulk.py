from flask import Blueprint, request, jsonify
from helpers.http import jobs_base, jobs_fx_headers, fx_post_json
from helpers.users import get_in_app_user_id

def create_blueprint(auth):
    bp = Blueprint("ui_jobs_status_bulk", __name__)

    @bp.route("/ui/jobs/status", methods=["POST"])
    @auth.login_required
    def ui_jobs_status_bulk(*, context):
        body = request.get_json(silent=True) or {}
        job_ids = body.get("jobIds") or []
        job_ids = [str(x).strip() for x in job_ids if x]
        job_ids = list(dict.fromkeys(job_ids))
        if not job_ids:
            return jsonify({"error":"bad_request","message":"jobIds required"}), 400

        try:
            uid = get_in_app_user_id(context)
            headers = jobs_fx_headers(context={"userId": uid})
        except Exception:
            headers = jobs_fx_headers()

        r = fx_post_json(f"{jobs_base()}/jobs/status", headers=headers, json_body={"jobIds": job_ids})
        ctype = r.headers.get("Content-Type", "application/json")
        return r.text, r.status_code, {"Content-Type": ctype}

    return bp