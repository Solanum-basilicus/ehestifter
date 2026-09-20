from flask import Blueprint, jsonify, request

from helpers.users import set_cv


def create_blueprint(auth):
    bp = Blueprint("ui_users_cv_post", __name__)

    @bp.route("/ui/users/cv", methods=["POST"])
    @auth.login_required
    def ui_users_cv_post(*, context):
        body = request.get_json(silent=True) or {}
        cv_delta = body.get("CVQuillDelta")
        try:
            data = set_cv(context, cv_quill_delta=cv_delta)
            return jsonify(data), 200
        except Exception as exc:
            return jsonify({"error": "upstream_error", "message": str(exc)}), 502

    return bp
