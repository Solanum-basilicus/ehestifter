from flask import Blueprint, jsonify, request

from helpers.http import fx_post_json, jobs_base, jobs_fx_headers
from helpers.users import get_in_app_user_id


def create_blueprint(auth):
    bp = Blueprint("ui_jobs_locations_bulk", __name__)

    @bp.route("/ui/jobs/locations", methods=["POST"])
    @auth.login_required
    def ui_jobs_locations_bulk(*, context):
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            return jsonify({"error": "bad_request", "message": "Body must be a JSON object"}), 400

        job_ids = body.get("jobIds") or []
        if not isinstance(job_ids, list):
            return jsonify({"error": "bad_request", "message": "jobIds must be an array"}), 400

        job_ids = [str(value).strip() for value in job_ids if value]
        job_ids = list(dict.fromkeys(job_ids))

        if not job_ids:
            return jsonify({"error": "bad_request", "message": "jobIds required"}), 400

        try:
            user_id = get_in_app_user_id(context)
            headers = jobs_fx_headers(context={"userId": user_id})
        except Exception:
            headers = jobs_fx_headers()

        response = fx_post_json(
            f"{jobs_base()}/jobs/locations",
            headers=headers,
            json_body={"jobIds": job_ids},
        )
        content_type = response.headers.get("Content-Type", "application/json")
        return response.text, response.status_code, {"Content-Type": content_type}

    return bp
