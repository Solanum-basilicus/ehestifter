from flask import Blueprint, jsonify

from helpers.analytics import emit_core_event
from helpers.cache import memo_get, memo_put
from helpers.http import jobs_base, jobs_fx_headers, fx_get_json
from helpers.retry import retry_until_ready
from helpers.sanitize import sanitize_description_html
from helpers.users import get_in_app_user_id


def create_blueprint(auth):
    bp = Blueprint("ui_jobs_get", __name__)

    @bp.route("/ui/jobs/<job_id>", methods=["GET"])
    @auth.login_required
    def ui_job_details(job_id: str, *, context):
        try:
            uid = get_in_app_user_id(context)
        except Exception:
            uid = None

        def emit_success_event():
            emit_core_event(
                "Job Detail Viewed",
                user_id=uid,
                subject_type="job",
                subject_id=job_id,
                properties={
                    "job_id": job_id,
                },
            )

        cache_key = f"job:{job_id}"
        cached = memo_get(cache_key, ttl=60)
        if cached:
            emit_success_event()
            return jsonify(cached), 200

        def call():
            headers = jobs_fx_headers(context={"userId": uid}) if uid else jobs_fx_headers()
            job = fx_get_json(f"{jobs_base()}/jobs/{job_id}", headers=headers)

            desc = job.get("descriptionHtml") or job.get("DescriptionHtml") or job.get("Description") or ""
            if desc:
                job["descriptionHtml"] = sanitize_description_html(desc)

            if "locations" not in job or not isinstance(job["locations"], list):
                job["locations"] = []

            return job

        data = retry_until_ready(call, attempts=4, base_delay=0.75)

        if not data.get("error"):
            memo_put(cache_key, data)
            emit_success_event()

        return jsonify(data), 200

    return bp