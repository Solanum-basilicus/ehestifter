from flask import Blueprint, request, jsonify
from helpers.http import jobs_base, jobs_fx_headers
import requests

def create_blueprint(auth):
    bp = Blueprint("ui_job_history_get", __name__)

    @bp.route("/ui/jobs/<job_id>/history", methods=["GET"])
    @auth.login_required
    def ui_job_history(job_id: str, *, context):
        params = {"limit": request.args.get("limit", "10")}
        cursor = request.args.get("cursor")
        if cursor: params["cursor"] = cursor

        r = requests.get(f"{jobs_base()}/jobs/{job_id}/history",
                         headers=jobs_fx_headers(), params=params, timeout=10)
        try:
            payload = r.json()
        except ValueError:
            payload = {"error":"bad-upstream","body": r.text[:400]}
        return jsonify(payload), r.status_code

    return bp