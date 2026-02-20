import logging
import uuid
from flask import Blueprint, jsonify, request
from helpers.http import enrichers_base, enrichers_fx_headers, fx_get_json_safe
from helpers.users import get_in_app_user_id

logger = logging.getLogger(__name__)

def create_blueprint(auth):
    bp = Blueprint("ui_enrichment_latest_get", __name__)

    @bp.route("/ui/enrichment/subjects/<job_id>/latest", methods=["GET"])
    @auth.login_required
    def ui_enrichment_latest(job_id: str, *, context):
        enricher_type = request.args.get("enricherType") or "compatibility.v1"

        try:
            user_id = get_in_app_user_id(context)
        except Exception as e:
            return jsonify({"error": "Could not resolve in-app user id"}), 401

        corr_id = str(uuid.uuid4())

        url = f"{enrichers_base()}/enrichment/subjects/{job_id}/{user_id}/latest"
        headers = enrichers_fx_headers(context)
        headers["x-correlation-id"] = corr_id
        headers["x-ms-client-request-id"] = corr_id

        r, data = fx_get_json_safe(url, headers=headers, params={"enricherType": enricher_type})

        resp_headers = {k: r.headers.get(k) for k in [
            "date","server","content-type","content-length",
            "x-ms-request-id","x-ms-correlation-request-id",
            "x-functions-execution-id","traceparent","request-context"
        ] if r.headers.get(k) is not None}

        diag = {"status": r.status_code, "corrId": corr_id, "upstreamHeaders": resp_headers}

        if r.status_code == 404:
            return jsonify({"error": "Not found", "diag": diag}), 404

        if r.status_code >= 400:
            text = (r.text or "").strip()[:2000]
            logger.error("Latest failed corr=%s status=%s headers=%s body_preview=%r",
                         corr_id, r.status_code, resp_headers, text)
            return jsonify({"error": "Latest failed", "details": (data if data is not None else {"text": text}), "diag": diag}), r.status_code

        # Success: return parsed JSON if we have it; else text
        if data is not None:
            return jsonify(data), 200
        return jsonify({"text": (r.text or ""), "diag": diag}), 200

    return bp
