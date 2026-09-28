from flask import Blueprint, jsonify

from helpers.users import UpstreamHttpError, get_discovery_status


def create_blueprint(auth):
    bp = Blueprint("ui_users_discovery_status", __name__)

    @bp.route("/ui/users/discovery-status", methods=["GET"])
    @auth.login_required
    def ui_discovery_status_get(*, context):
        try:
            return jsonify(get_discovery_status(context)), 200
        except UpstreamHttpError as exc:
            status = exc.status if 400 <= exc.status < 500 else 502
            return jsonify({"error": "upstream_error", "message": exc.body}), status
        except Exception as exc:
            return jsonify({"error": "upstream_error", "message": str(exc)}), 502

    return bp
