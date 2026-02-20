# routes/ui_enrichment_latest_get.py
from flask import Blueprint, jsonify, request
from helpers.http import enrichers_base, enrichers_fx_headers, fx_get_json

def create_blueprint(auth):
    bp = Blueprint("ui_enrichment_latest_get", __name__)

    @bp.route("/ui/enrichment/subjects/<job_id>/latest", methods=["GET"])
    @auth.login_required
    def ui_enrichment_latest(job_id: str, *, context):
        enricher_type = request.args.get("enricherType") or "compatibility.v1"

        # Get userId from context or claims; keep it server-side only
        user = context.get("user") or {}
        user_id = context.get("userId") or user.get("oid") or user.get("sub") or user.get("userId")
        if not user_id:
            return jsonify({"error": "Missing user id"}), 401

        url = f"{enrichers_base()}/enrichment/subjects/{job_id}/{user_id}/latest"
        data = fx_get_json(url, headers=enrichers_fx_headers(context), params={"enricherType": enricher_type})
        return jsonify(data), 200

    return bp
