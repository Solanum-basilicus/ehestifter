from flask import Blueprint, jsonify, request

from helpers.locations import search_locations
from helpers.users import get_in_app_user_id


def create_blueprint(auth):
    bp = Blueprint("ui_locations_search", __name__)

    @bp.route("/ui/locations/search", methods=["GET"])
    @auth.login_required
    def ui_locations_search(*, context):
        query = (request.args.get("q") or "").strip()
        try:
            limit = int(request.args.get("limit", 8))
        except ValueError:
            return jsonify({"error": "bad_request", "message": "limit must be an integer"}), 400

        try:
            user_id = get_in_app_user_id(context)
            response = search_locations({"userId": user_id}, query, limit)
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
