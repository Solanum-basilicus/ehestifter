from flask import Blueprint, jsonify
from helpers.users import get_preferences

def create_blueprint(auth):
    bp = Blueprint("ui_users_preferences_get", __name__)

    @bp.route("/ui/users/preferences", methods=["GET"])
    @auth.login_required
    def ui_users_preferences_get(*, context):
        try:
            data = get_preferences(context)
            return jsonify(data), 200
        except Exception as e:
            # Keep it simple: surface a safe message
            return jsonify({"error": "upstream_error", "message": str(e)}), 502

    return bp
