from flask import Blueprint, request, jsonify
from helpers.users import set_preferences

def create_blueprint(auth):
    bp = Blueprint("ui_users_preferences_post", __name__)

    @bp.route("/ui/users/preferences", methods=["POST"])
    @auth.login_required
    def ui_users_preferences_post(*, context):
        body = request.get_json(silent=True) or {}
        cv_delta = body.get("CVQuillDelta", None)

        try:
            data = set_preferences(context, cv_quill_delta=cv_delta)
            return jsonify(data), 200
        except Exception as e:
            return jsonify({"error": "upstream_error", "message": str(e)}), 502

    return bp
