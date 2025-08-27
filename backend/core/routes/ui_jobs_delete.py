from flask import Blueprint, jsonify
from helpers.http import jobs_base, jobs_fx_headers, fx_delete
from helpers.users import get_in_app_user_id
from helpers.cache import memo_invalidate_prefix

def create_blueprint(auth):
    bp = Blueprint("ui_jobs_delete", __name__)

    @bp.route("/ui/jobs/<job_id>", methods=["DELETE"])
    @auth.login_required
    def ui_jobs_delete(job_id: str, *, context):
        if not job_id:
            return jsonify({"error": "bad_request", "message": "job_id is required"}), 400

        # Try to pass user id for provenance (Jobs API may ignore for now, but keep consistent)
        try:
            uid = get_in_app_user_id(context)
            headers = jobs_fx_headers(context={"userId": uid})
        except Exception:
            headers = jobs_fx_headers()
            uid = None

        upstream = fx_delete(f"{jobs_base()}/jobs/{job_id}", headers=headers)

        # 200/204 -> surface as 204 No Content for UI consistency
        if upstream.status_code in (200, 204):
            # Invalidate ALL cached job lists for this user so deleted job never reappears.
            # Our list cache keys begin with "jobs:{uid}:".
            try:
                if uid:
                    memo_invalidate_prefix(f"jobs:{uid}:")
            except Exception:
                # Cache invalidation is best-effort; do not block successful delete.
                pass            
            return ("", 204)

        # Bubble up upstream error body + content-type
        return (
            upstream.text,
            upstream.status_code,
            {"Content-Type": upstream.headers.get("Content-Type", "text/plain")},
        )

    return bp
