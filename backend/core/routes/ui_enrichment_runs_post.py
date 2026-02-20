# routes/ui_enrichment_runs_post.py
import logging
from flask import Blueprint, jsonify, request
from helpers.http import enrichers_base, enrichers_fx_headers, fx_post_json

logger = logging.getLogger(__name__)

def _safe_json(resp):
    try:
        return resp.json()
    except Exception:
        return None

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
            "userId": user_id,
            "enricherType": enricher_type,
        }

        url = f"{enrichers_base()}/enrichment/runs"
        headers = enrichers_fx_headers(context)

        logger.info("POST enrichers /enrichment/runs url=%s job=%s user=%s enricherType=%s",
                    url, job_id, user_id, enricher_type)

        r = fx_post_json(url, headers=headers, json_body=upstream_body)

        # Try parse JSON; if not, capture text (trim) and a few useful headers
        payload_json = _safe_json(r)
        text = (r.text or "").strip()
        text_preview = text[:2000]  # avoid spewing huge pages

        # Azure Functions / front door often emit some request IDs; keep a few common ones
        diag = {
            "status": r.status_code,
            "upstreamRequestId": r.headers.get("x-ms-request-id") or r.headers.get("x-ms-client-request-id"),
            "upstreamCorrelationId": r.headers.get("x-correlation-id") or r.headers.get("traceparent"),
        }

        if r.status_code >= 400:
            logger.error(
                "Upstream error: status=%s diag=%s body_len=%s body_preview=%r",
                r.status_code, diag, len(text), text_preview
            )
            return jsonify({
                "error": "Enricher run failed",
                "details": payload_json if payload_json is not None else {"text": text_preview},
                "diag": diag,
            }), r.status_code

        # Success path: return json if possible else raw text
        return jsonify(payload_json if payload_json is not None else {"text": text_preview, "diag": diag}), r.status_code

    return bp
