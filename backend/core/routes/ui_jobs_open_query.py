from flask import Blueprint, jsonify, request

from helpers.http import fx_post_json, jobs_base, jobs_fx_headers
from helpers.users import get_in_app_user_id


def create_blueprint(auth):
    bp = Blueprint("ui_jobs_open_query", __name__)

    @bp.route("/ui/jobs/open/query", methods=["POST"])
    @auth.login_required
    def ui_jobs_open_query(*, context):
        body = request.get_json(silent=True)
        if body is None:
            body = {}
        if not isinstance(body, dict):
            return jsonify({"error": "bad_request", "message": "Body must be a JSON object"}), 400

        try:
            user_id = get_in_app_user_id(context)
        except Exception:
            return jsonify({"error": "unauthorized", "message": "User id is not available"}), 401

        response = fx_post_json(
            f"{jobs_base()}/jobs/open/query",
            headers=jobs_fx_headers(context={"userId": user_id}),
            json_body=body,
        )
        try:
            data = response.json()
        except ValueError:
            return response.text, response.status_code, {
                "Content-Type": response.headers.get("Content-Type", "text/plain")
            }
        return jsonify(data), response.status_code

    return bp
