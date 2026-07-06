from flask import Blueprint, request, jsonify
from urllib.parse import urlencode
import hashlib

from helpers.analytics import emit_core_event
from helpers.cache import memo_get, memo_put
from helpers.http import jobs_base, jobs_fx_headers, fx_get_json
from helpers.retry import retry_until_ready
from helpers.users import get_in_app_user_id


_SEARCH_PARAM_NAMES = {
    "q",
    "query",
    "search",
    "searchTerm",
    "search_term",
}


def _has_search_term(params: dict) -> bool:
    return any(bool((params.get(name) or "").strip()) for name in _SEARCH_PARAM_NAMES)


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
            uid = get_in_app_user_id(context)
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
        cached = memo_get(cache_key, ttl=30)
        if cached:
            emit_success_events()
            return jsonify(cached), 200

        def call():
            params = {"limit": str(limit), "offset": str(offset), **forward_params}
            headers = jobs_fx_headers(context={"userId": uid}) if uid != "anon" else jobs_fx_headers()

            envelope = fx_get_json(
                f"{jobs_base()}/jobs",
                headers=headers,
                params=params
            )

            if isinstance(envelope, dict):
                envelope.setdefault("limit", limit)
                envelope.setdefault("offset", offset)

            return envelope

        data = retry_until_ready(call, attempts=4, base_delay=0.75)

        if not data.get("error"):
            memo_put(cache_key, data)
            emit_success_events()

        return jsonify(data), 200

    return bp