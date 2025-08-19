from flask import Blueprint, request, jsonify
from helpers.http import jobs_base, jobs_fx_headers
from helpers.users import get_in_app_user_id
import requests

def create_blueprint(auth):
    bp = Blueprint("ui_job_status_set", __name__)

    @bp.route("/ui/jobs/<job_id>/status", methods=["POST"])
    @auth.login_required
    def ui_job_status_set(job_id, *, context):
        body = request.get_json(silent=True) or {}
        status = (body.get("status") or "").trim() if hasattr(str, "trim") else (body.get("status") or "").strip()
        if not status:
            return jsonify({"error":"bad_request","message":"Missing 'status'"}), 400
        if len(status) > 100:
            return jsonify({"error":"bad_request","message":"Status too long (max 100)"}), 400

        uid = get_in_app_user_id(context)
        headers = jobs_fx_headers(context={"userId": uid})

        r = requests.put(f"{jobs_base()}/jobs/{job_id}/status", headers=headers, json={"status": status}, timeout=10)
        if not r.ok:
            return r.text, r.status_code, {"Content-Type": r.headers.get("Content-Type","text/plain")}
        data = r.json()
        return jsonify({"jobId": data.get("jobId", job_id), "status": data.get("status", status)}), 200

    return bp