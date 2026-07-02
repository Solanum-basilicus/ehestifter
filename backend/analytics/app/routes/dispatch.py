from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request
import logging
from app.auth import AuthError, authenticate_request
from app.dispatch import run_dispatch_once

logger = logging.getLogger(__name__)
bp = Blueprint("dispatch", __name__)


@bp.post("/analytics/dispatch/run")
def dispatch_run():
    logger.info("POST /analytics/dispatch/run")
    config = current_app.config["APP_CONFIG"]

    try:
        auth_context = authenticate_request(request, config)
        if not auth_context.can_dispatch and auth_context.key_name != "operator":
            return jsonify({"error": "forbidden_key"}), 403

        counters = run_dispatch_once(config)

    except AuthError as exc:
        return jsonify({"error": str(exc)}), 401

    except Exception:
        current_app.logger.exception("analytics_dispatch_failed")
        return jsonify({"error": "internal_error"}), 500

    return jsonify(counters.as_dict())
    