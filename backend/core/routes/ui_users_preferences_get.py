from flask import Blueprint, jsonify

from helpers.users import get_cv


def create_blueprint(auth):
    bp = Blueprint("ui_users_cv_get", __name__)

    @bp.route("/ui/users/cv", methods=["GET"])
    @auth.login_required
    def ui_users_cv_get(*, context):
        try:
            data = get_cv(context)
            return jsonify(data), 200
        except Exception as exc:
            return jsonify({"error": "upstream_error", "message": str(exc)}), 502

    return bp
