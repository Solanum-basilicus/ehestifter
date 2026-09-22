from flask import Blueprint, request, jsonify
from helpers.http import jobs_base, jobs_fx_headers
from helpers.users import get_in_app_user_id
import requests


def create_blueprint(auth):
    bp = Blueprint("ui_job_history_get", __name__)

    @bp.route("/ui/jobs/<job_id>/history", methods=["GET"])
    @auth.login_required
    def ui_job_history(job_id: str, *, context):
        params = {"limit": request.args.get("limit", "10")}
        cursor = request.args.get("cursor")
        if cursor:
            params["cursor"] = cursor

        try:
            user_id = get_in_app_user_id(context)
        except Exception:
            return jsonify({"error": "Could not resolve in-app user id"}), 401

        headers = jobs_fx_headers(context={"userId": user_id})
        r = requests.get(
            f"{jobs_base()}/jobs/{job_id}/history",
            headers=headers,
            params=params,
            timeout=10,
        )
        try:
            payload = r.json()
        except ValueError:
            payload = {"error": "bad-upstream", "body": r.text[:400]}
        return jsonify(payload), r.status_code

    return bp
