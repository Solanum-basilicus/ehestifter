from flask import Blueprint, jsonify
from helpers.cache import memo_get, memo_put
from helpers.http import jobs_base, jobs_fx_headers, fx_get_json
from helpers.retry import retry_until_ready
from helpers.sanitize import sanitize_description_html

def create_blueprint(auth):
    bp = Blueprint("ui_jobs_get", __name__)

    @bp.route("/ui/jobs/<job_id>", methods=["GET"])
    @auth.login_required
    def ui_job_details(job_id: str, *, context):
        cache_key = f"job:{job_id}"
        cached = memo_get(cache_key, ttl=60)
        if cached:
            return jsonify(cached), 200

        def call():
            job = fx_get_json(f"{jobs_base()}/jobs/{job_id}", headers=jobs_fx_headers())
            desc = job.get("descriptionHtml") or job.get("DescriptionHtml") or job.get("Description") or ""
            if desc:
                job["descriptionHtml"] = sanitize_description_html(desc)
            if "locations" not in job or not isinstance(job["locations"], list):
                job["locations"] = []
            return job

        data = retry_until_ready(call, attempts=4, base_delay=0.75)
        if not data.get("error"): memo_put(cache_key, data)
        return jsonify(data), 200

    return bp