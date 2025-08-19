# routes/ui_users_link_code.py
from flask import Blueprint, jsonify, Response
from helpers.users import get_link_code, UpstreamHttpError

def create_blueprint(auth):
    bp = Blueprint("ui_users_link_code", __name__)

    @bp.route("/ui/users/link-code", methods=["GET"])
    @auth.login_required
    def ui_users_link_code(*, context):
        try:
            data = get_link_code(context)
            return jsonify(data), 200
        except TimeoutError:
            return jsonify({"error":"upstream_warming","message":"User service is warming up. Please try again."}), 503
        except UpstreamHttpError as e:
            # Pass through actual upstream status & body to make debugging obvious
            return Response(e.body, status=e.status, mimetype="application/json")
        except Exception:
            return jsonify({"error":"upstream_error","message":"Unable to retrieve link code."}), 502

    return bp