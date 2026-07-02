from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request

from app.auth import AuthError, authenticate_request
from app.db import insert_event_with_dispatch
from app.distinct_id import build_distinct_id
from app.validation import ValidationError, validate_event_payload


bp = Blueprint("events", __name__)


@bp.post("/analytics/events")
def ingest_event():
    config = current_app.config["APP_CONFIG"]

    try:
        auth_context = authenticate_request(request, config)
        event = validate_event_payload(request.get_json(silent=True), auth_context, config)
        distinct_id = build_distinct_id(event["userId"], config.distinct_id_salt)
        event_id, duplicate = insert_event_with_dispatch(config, event, distinct_id)

    except AuthError as exc:
        return jsonify({"error": str(exc)}), 401

    except ValidationError as exc:
        if exc.code == "collection_disabled":
            status = 503
        elif exc.code in {"forbidden_key", "source_domain_key_mismatch"}:
            status = 403
        else:
            status = 400

        return jsonify({"error": exc.code, "message": exc.message}), status

    except Exception:
        current_app.logger.exception("analytics_ingest_failed")
        return jsonify({"error": "internal_error"}), 500

    return jsonify(
        {
            "eventId": event_id,
            "status": "accepted",
            "idempotent": duplicate,
        }
    ), 200 if duplicate else 202
