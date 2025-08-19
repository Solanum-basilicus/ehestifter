# routes/ui_users_link_code.py
from flask import Blueprint, jsonify
from helpers.users import get_link_code  # you'll add this helper (see below)

def create_blueprint(auth):
    bp = Blueprint("ui_users_link_code", __name__)

    @bp.route("/ui/users/link-code", methods=["GET"])
    @auth.login_required
    def ui_users_link_code(*, context):
        """
        Proxy to Users Function: GET /api/users/link-code
        Requires the same B2C context as /ui/users/me.
        """
        try:
            data = get_link_code(context)  # helper performs upstream call, with retry/cache if you prefer
            # Pass-through JSON payload and 200; helper should raise on non-2xx if you want mapping here
            return jsonify(data), 200
        except TimeoutError:
            # Conservatively treat timeouts as warming-up to match your UX in /ui/users/me
            return jsonify({"error": "upstream_warming", "message": "User service is warming up. Please try again."}), 503
        except Exception as ex:
            # Generic upstream failure
            return jsonify({"error": "upstream_error", "message": "Unable to retrieve link code."}), 502

    return bp