from flask import Blueprint, request, jsonify
from urllib.parse import urlencode
import hashlib
from helpers.cache import memo_get, memo_put
from helpers.http import jobs_base, jobs_fx_headers, fx_get_json
from helpers.retry import retry_until_ready
from helpers.users import get_in_app_user_id


def create_blueprint(auth):
    bp = Blueprint("ui_jobs_list", __name__)

    @bp.route("/ui/jobs", methods=["GET"])
    @auth.login_required
    def ui_jobs_list(*, context):
        try:
            limit  = int(request.args.get("limit", 25))
            offset = int(request.args.get("offset", 0))
        except ValueError:
            return jsonify({"error":"bad_request","message":"Invalid 'limit' or 'offset'"}), 400
        if limit not in {10,25,50,100}: limit = 25
        if offset < 0: offset = 0

        # Resolve current in-app user id (falls back to 'anon' if anything goes wrong)
        try:
            uid = get_in_app_user_id(context)
        except Exception:
            uid = "anon"

        # Collect passthrough query params for upstream (future filters/search). Exclude paging.
        forward_params = {k: v for k, v in request.args.items() if k not in {"limit", "offset"}}

        # Build a stable short fingerprint of filters so keys stay compact.
        # Use 'nofilter' if no extra params are provided to avoid collisions/ambiguity.
        if forward_params:
            qs = urlencode(sorted(forward_params.items()))
            fp = hashlib.sha1(qs.encode("utf-8")).hexdigest()[:12]
            filter_key = f"f:{fp}"
        else:
            filter_key = "nofilter"

        cache_key = f"jobs:{uid}:{filter_key}:{limit}:{offset}"
        cached = memo_get(cache_key, ttl=30)
        if cached:
            return jsonify(cached), 200

        def call():
            params = {"limit": str(limit), "offset": str(offset), **forward_params}
            # Pass user id in headers for provenance/authorization context (Jobs API may ignore today).
            headers = jobs_fx_headers(context={"userId": uid})
            items = fx_get_json(
                f"{jobs_base()}/jobs",
                headers=headers,
                params=params
            )
            return {"items": items, "limit": limit, "offset": offset, "received": len(items)}

        data = retry_until_ready(call, attempts=4, base_delay=0.75)
        if not data.get("error"): memo_put(cache_key, data)
        return jsonify(data), 200

    return bp