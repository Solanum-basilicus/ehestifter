from helpers.timing import measure_call
import logging
import uuid
from flask import Blueprint, jsonify, request
from helpers.http import enrichers_base, enrichers_fx_headers, fx_post_json
from helpers.users import get_in_app_user_id

logger = logging.getLogger(__name__)

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

        try:
            user_id = measure_call("identity", lambda: get_in_app_user_id(context))
        except Exception as e:
            return jsonify({"error": "Could not resolve in-app user id"}), 401

        corr_id = str(uuid.uuid4())

        upstream_body = {
            "jobOfferingId": job_id,
            "userId": user_id,
            "enricherType": enricher_type,
        }

        url = f"{enrichers_base()}/enrichment/runs"
        headers = enrichers_fx_headers(context)
        # propagate correlation to enrichers
        headers["x-correlation-id"] = corr_id
        headers["x-ms-client-request-id"] = corr_id

        logger.debug("Enricher run start corr=%s type=%s", corr_id, enricher_type)

        r = fx_post_json(url, headers=headers, json_body=upstream_body)

        # capture some headers even if empty body
        resp_headers = {k: r.headers.get(k) for k in [
            "date", "server", "content-type", "content-length",
            "x-ms-request-id", "x-ms-correlation-request-id",
            "x-functions-execution-id", "traceparent", "request-context"
        ] if r.headers.get(k) is not None}

        text = (r.text or "").strip()
        text_preview = text[:2000]

        diag = {
            "status": r.status_code,
            "corrId": corr_id,
            "upstreamHeaders": resp_headers,
        }

        if r.status_code >= 400:
            logger.error("Enricher run failed corr=%s status=%s",
                         corr_id, r.status_code)
            return jsonify({
                "error": "Enricher run failed",
                "details": {"text": text_preview},
                "diag": diag,
            }), r.status_code

        # success
        try:
            return jsonify(r.json()), r.status_code
        except Exception:
            return jsonify({"text": text_preview, "diag": diag}), r.status_code

    return bp
