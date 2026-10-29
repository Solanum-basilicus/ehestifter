from flask import Blueprint, request, jsonify
from urllib.parse import urlencode
import hashlib
import logging
import os

import requests

from helpers.analytics import emit_core_event
from helpers.cache import memo_get, memo_put
from helpers.http import jobs_base, jobs_fx_headers, fx_get_json_safe
from helpers.users import get_in_app_user_id
from helpers.timing import measure_call, set_label


_SEARCH_PARAM_NAMES = {
    "q",
    "query",
    "search",
    "searchTerm",
    "search_term",
}


def _has_search_term(params: dict) -> bool:
    return any(bool((params.get(name) or "").strip()) for name in _SEARCH_PARAM_NAMES)


def _cache_enabled():
    """Disable the list memo cache by an explicit Core environment setting."""
    return os.getenv("EHESTIFTER_JOBS_LIST_CACHE_ENABLED", "true").strip().lower() not in {
        "false", "0", "no", "off"
    }


def create_blueprint(auth):
    bp = Blueprint("ui_jobs_list", __name__)

    @bp.route("/ui/jobs", methods=["GET"])
    @auth.login_required
    def ui_jobs_list(*, context):
        try:
            limit = int(request.args.get("limit", 25))
            offset = int(request.args.get("offset", 0))
        except ValueError:
            return jsonify({"error": "bad_request", "message": "Invalid 'limit' or 'offset'"}), 400

        if limit not in {10, 25, 50, 100}:
            limit = 25
        if offset < 0:
            offset = 0

        try:
            uid = measure_call("identity", lambda: get_in_app_user_id(context))
        except Exception:
            uid = "anon"

        analytics_user_id = None if uid == "anon" else uid

        forward_params = {k: v for k, v in request.args.items() if k not in {"limit", "offset"}}
        if "category" not in forward_params:
            forward_params["category"] = "my"

        if forward_params:
            qs = urlencode(sorted(forward_params.items()))
            fp = hashlib.sha1(qs.encode("utf-8")).hexdigest()[:12]
            filter_key = f"f:{fp}"
        else:
            filter_key = "nofilter"

        category = (forward_params.get("category") or "my").strip() or "my"
        page = (offset // limit) + 1
        has_search_term = _has_search_term(forward_params)

        def emit_success_events():
            emit_core_event(
                "Job List Viewed",
                user_id=analytics_user_id,
                properties={
                    "category": category,
                    "page": page,
                },
            )

            if has_search_term:
                emit_core_event(
                    "Job Search Performed",
                    user_id=analytics_user_id,
                    properties={
                        "category": category,
                        "has_search_term": True,
                    },
                )

        cache_key = f"jobs:{uid}:{filter_key}:{limit}:{offset}"
        cache_enabled = _cache_enabled()
        set_label("list_cache_enabled", "1" if cache_enabled else "0")
        cached = measure_call("cache_get", lambda: memo_get(cache_key, ttl=30)) if cache_enabled else None
        if cached is not None:
            set_label("cache", "hit")
            measure_call("analytics", emit_success_events)
            return measure_call("response_build", lambda: jsonify(cached)), 200
        set_label("cache", "miss" if cache_enabled else "bypass")

        params = {"limit": str(limit), "offset": str(offset), **forward_params}
        headers = jobs_fx_headers(context={"userId": uid}) if uid != "anon" else jobs_fx_headers()

        # Call Jobs once. Repeating a slow list query can overload SQL.
        try:
            response, data = fx_get_json_safe(
                f"{jobs_base()}/jobs",
                headers=headers,
                params=params,
                timeout=20,
            )
        except requests.Timeout:
            return jsonify({
                "error": "jobs_service_timeout",
                "message": "The jobs request took too long. Try again later.",
            }), 504
        except requests.RequestException:
            logging.exception("Jobs list request failed")
            return jsonify({
                "error": "jobs_service_unavailable",
                "message": "Jobs service is unavailable. Try again later.",
            }), 502

        if response.status_code == 504:
            return jsonify({
                "error": "jobs_query_timeout",
                "message": "The jobs search took too long. Change the filters and try again.",
            }), 504
        if response.status_code != 200:
            if 400 <= response.status_code < 500:
                return jsonify({
                    "error": "jobs_request_failed",
                    "message": "Jobs rejected the request.",
                }), response.status_code
            logging.warning("Jobs list returned HTTP %s", response.status_code)
            return jsonify({
                "error": "jobs_service_unavailable",
                "message": "Jobs service is unavailable. Try again later.",
            }), 502

        if not isinstance(data, dict) or data.get("error"):
            return jsonify({
                "error": "jobs_invalid_response",
                "message": "Jobs returned an invalid response.",
            }), 502

        data.setdefault("limit", limit)
        data.setdefault("offset", offset)
        if cache_enabled:
            measure_call("cache_put", lambda: memo_put(cache_key, data))
        measure_call("analytics", emit_success_events)
        return measure_call("response_build", lambda: jsonify(data)), 200

    return bp
