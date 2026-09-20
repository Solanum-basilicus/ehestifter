from flask import Blueprint, jsonify, request

from helpers.http import fx_post_json, jobs_base, jobs_fx_headers
from helpers.users import get_discovery_preferences, get_in_app_user_id


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

        unknown = set(body) - {"limit", "offset"}
        if unknown:
            return jsonify({
                "error": "bad_request",
                "message": f"Unsupported field: {sorted(unknown)[0]}",
            }), 400

        try:
            user_id = get_in_app_user_id(context)
            preferences = get_discovery_preferences(context)
        except Exception:
            return jsonify({"error": "upstream_error", "message": "User preferences are not available"}), 502

        jobs_body = {
            key: body[key]
            for key in ("limit", "offset")
            if key in body
        }
        jobs_body["eligibility"] = preferences.get("eligibility")

        response = fx_post_json(
            f"{jobs_base()}/jobs/open/query",
            headers=jobs_fx_headers(context={"userId": user_id}),
            json_body=jobs_body,
        )
        try:
            data = response.json()
        except ValueError:
            return response.text, response.status_code, {
                "Content-Type": response.headers.get("Content-Type", "text/plain")
            }
        return jsonify(data), response.status_code

    return bp
