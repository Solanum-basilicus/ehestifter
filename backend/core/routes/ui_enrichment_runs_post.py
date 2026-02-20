import logging
import uuid
from flask import Blueprint, jsonify, request
from helpers.http import enrichers_base, enrichers_fx_headers, fx_post_json

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

        user = context.get("user") or {}
        user_id = context.get("userId") or user.get("oid") or user.get("sub") or user.get("userId")
        if not user_id:
            return jsonify({"error": "Missing user id"}), 401

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

        logger.info("Enricher run start corr=%s job=%s user=%s enricherType=%s url=%s",
                    corr_id, job_id, user_id, enricher_type, url)

        r = fx_post_json(url, headers=headers, json_body=upstream_body)

        logger.info("User claims keys=%s", list((context.get("user") or {}).keys()))
        logger.info("Chosen user_id=%s oid=%s sub=%s",
                    user_id,
                    (context.get("user") or {}).get("oid"),
                    (context.get("user") or {}).get("sub"))

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
            logger.error("Enricher run failed corr=%s status=%s headers=%s body_len=%s body_preview=%r",
                         corr_id, r.status_code, resp_headers, len(text), text_preview)
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
