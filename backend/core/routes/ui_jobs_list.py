from flask import Blueprint, request, jsonify
from helpers.cache import memo_get, memo_put
from helpers.http import jobs_base, jobs_fx_headers, fx_get_json
from helpers.retry import retry_until_ready

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

        cache_key = f"jobs:{limit}:{offset}"
        cached = memo_get(cache_key, ttl=30)
        if cached:
            return jsonify(cached), 200

        def call():
            items = fx_get_json(f"{jobs_base()}/jobs",
                               headers=jobs_fx_headers(),
                               params={"limit": str(limit), "offset": str(offset)})
            return {"items": items, "limit": limit, "offset": offset, "received": len(items)}

        data = retry_until_ready(call, attempts=4, base_delay=0.75)
        if not data.get("error"): memo_put(cache_key, data)
        return jsonify(data), 200

    return bp