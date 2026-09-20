from flask import Blueprint, jsonify, request

from helpers.discovery_preferences import collect_location_selectors
from helpers.locations import lookup_locations
from helpers.users import (
    UpstreamHttpError,
    get_discovery_preferences,
    get_in_app_user_id,
    set_discovery_preferences,
)


def _lookup(context, document):
    selectors = collect_location_selectors(document)
    if not selectors:
        return {"catalogVersion": None, "items": [], "missing": []}
    user_id = get_in_app_user_id(context)
    response = lookup_locations({"userId": user_id}, selectors)
    try:
        payload = response.json()
    except ValueError:
        raise UpstreamHttpError(response.status_code, response.text)
    if not response.ok:
        raise UpstreamHttpError(response.status_code, response.text)
    return payload


def create_blueprint(auth):
    bp = Blueprint("ui_users_discovery_preferences", __name__)

    @bp.route("/ui/users/discovery-preferences", methods=["GET"])
    @auth.login_required
    def ui_discovery_preferences_get(*, context):
        try:
            document = get_discovery_preferences(context)
            resolved = _lookup(context, document)
            return jsonify({
                **document,
                "locationDetails": resolved.get("items", []),
                "missingLocations": resolved.get("missing", []),
                "locationCatalogVersion": resolved.get("catalogVersion"),
            }), 200
        except UpstreamHttpError as exc:
            return jsonify({"error": "upstream_error", "message": exc.body}), 502
        except Exception as exc:
            return jsonify({"error": "upstream_error", "message": str(exc)}), 502

    @bp.route("/ui/users/discovery-preferences", methods=["PUT"])
    @auth.login_required
    def ui_discovery_preferences_put(*, context):
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "bad_request", "message": "Body must be a JSON object"}), 400

        try:
            resolved = _lookup(context, body)
            missing = resolved.get("missing") or []
            if missing:
                return jsonify({
                    "error": "invalid_location",
                    "message": "One or more saved locations are not in the current catalog.",
                    "missingLocations": missing,
                }), 400

            saved = set_discovery_preferences(context, body)
            return jsonify({
                **saved,
                "locationDetails": resolved.get("items", []),
                "missingLocations": [],
                "locationCatalogVersion": resolved.get("catalogVersion"),
            }), 200
        except UpstreamHttpError as exc:
            status = exc.status if 400 <= exc.status < 500 else 502
            return jsonify({"error": "upstream_error", "message": exc.body}), status
        except Exception as exc:
            return jsonify({"error": "upstream_error", "message": str(exc)}), 502

    return bp
