# routes/ui_enrichment_runs_post.py
from flask import Blueprint, jsonify, request
from helpers.http import enrichers_base, enrichers_fx_headers, fx_post_json

def create_blueprint(auth):
    bp = Blueprint("ui_enrichment_runs_post", __name__)

    @bp.route("/ui/enrichment/runs", methods=["POST"])
    @auth.login_required
    def ui_enrichment_run(*, context):
        body = request.get_json(silent=True) or {}
        job_id = body.get("jobOfferingId") or body.get("jobId")
        enricher_type = body.get("enricherType") or "compatibility.v1"

        if not job_id:
            return jsonify({"error": "Missing jobOfferingId/jobId"}), 400

        user = context.get("user") or {}
        user_id = context.get("userId") or user.get("oid") or user.get("sub") or user.get("userId")
        if not user_id:
            return jsonify({"error": "Missing user id"}), 401

        upstream_body = {
            "jobOfferingId": job_id,
            "userId": user_id,                # injected server-side
            "enricherType": enricher_type
        }

        url = f"{enrichers_base()}/enrichment/runs"
        r = fx_post_json(url, headers=enrichers_fx_headers(context), json_body=upstream_body)

        # Pass through status and JSON if possible
        try:
            payload = r.json()
        except Exception:
            payload = {"text": r.text}

        return jsonify(payload), r.status_code

    return bp
