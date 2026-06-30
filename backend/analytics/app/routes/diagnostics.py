from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request

from app.auth import AuthError, authenticate_request
from app.db import get_dispatch_status


bp = Blueprint("diagnostics", __name__)


@bp.get("/analytics/dispatch/status")
def dispatch_status():
    config = current_app.config["APP_CONFIG"]

    try:
        auth_context = authenticate_request(request, config)
        if not auth_context.can_status:
            return jsonify({"error": "forbidden_key"}), 403

        counters = get_dispatch_status(config)

    except AuthError as exc:
        return jsonify({"error": str(exc)}), 401

    except Exception:
        current_app.logger.exception("analytics_status_failed")
        return jsonify({"error": "internal_error"}), 500

    return jsonify(
        {
            "collectionEnabled": config.collection_enabled,
            "mixpanelExportEnabled": config.mixpanel_export_enabled,
            **counters,
        }
    )
