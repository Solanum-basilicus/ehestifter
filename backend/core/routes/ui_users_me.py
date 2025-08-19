from flask import Blueprint, jsonify
from helpers.users import get_in_app_user

def create_blueprint(auth):
    bp = Blueprint("ui_users_me", __name__)

    @bp.route("/ui/users/me", methods=["GET"])
    @auth.login_required
    def ui_users_me(*, context):
        try:
            data = get_in_app_user(context)  # has session cache + retry inside
            return jsonify(data), 200
        except Exception:
            return jsonify({"error":"upstream_warming","message":"User service is warming up. Please try again."}), 503

    return bp