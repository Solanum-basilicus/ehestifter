# routes/ui_enrichment_history_get.py
from flask import Blueprint, jsonify, request
from helpers.http import enrichers_base, enrichers_fx_headers, fx_get_json
from helpers.users import get_in_app_user_id

def create_blueprint(auth):
    bp = Blueprint("ui_enrichment_history_get", __name__)

    @bp.route("/ui/enrichment/subjects/<job_id>/history", methods=["GET"])
    @auth.login_required
    def ui_enrichment_history(job_id: str, *, context):
        enricher_type = request.args.get("enricherType") or "compatibility.v1"

        try:
            user_id = get_in_app_user_id(context)
        except Exception as e:
            return jsonify({"error": "Could not resolve in-app user id"}), 401

        url = f"{enrichers_base()}/enrichment/subjects/{job_id}/{user_id}/history"
        data = fx_get_json(url, headers=enrichers_fx_headers(context), params={"enricherType": enricher_type})
        return jsonify(data), 200

    return bp
