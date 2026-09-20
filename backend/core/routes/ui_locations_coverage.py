from flask import Blueprint, jsonify, request

from helpers.locations import coverage_locations
from helpers.users import get_in_app_user_id


def create_blueprint(auth):
    bp = Blueprint("ui_locations_coverage", __name__)

    @bp.route("/ui/locations/coverage", methods=["POST"])
    @auth.login_required
    def ui_locations_coverage(*, context):
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "bad_request", "message": "Body must be a JSON object"}), 400

        try:
            user_id = get_in_app_user_id(context)
            response = coverage_locations({"userId": user_id}, body)
        except Exception as exc:
            return jsonify({"error": "upstream_error", "message": str(exc)}), 502

        try:
            payload = response.json()
        except ValueError:
            return response.text, response.status_code, {
                "Content-Type": response.headers.get("Content-Type", "text/plain")
            }
        return jsonify(payload), response.status_code

    return bp
