from flask import Blueprint, jsonify
from helpers.http import jobs_base, jobs_fx_headers, fx_post_json
from helpers.users import get_in_app_user_id

def create_blueprint(auth):
    bp = Blueprint("ui_job_status_get", __name__)

    @bp.route("/ui/jobs/<job_id>/status", methods=["GET"])
    @auth.login_required
    def ui_job_status_get(job_id, *, context):
        uid = get_in_app_user_id(context)
        headers = jobs_fx_headers(context={"userId": uid})
        r = fx_post_json(f"{jobs_base()}/jobs/status", headers=headers, json_body={"jobIds":[job_id]})
        try:
            data = r.json()
        except Exception:
            return jsonify({"error":"upstream_error","message": r.text[:200]}), r.status_code
        m = data.get("statuses", {})
        status = m.get(job_id) or m.get(job_id.lower(), "Unset")
        return jsonify({"jobId": job_id, "status": status}), 200

    return bp