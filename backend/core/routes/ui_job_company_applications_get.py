"""Authenticated, user-specific proxy for company application counts."""

from flask import Blueprint, jsonify

from helpers.http import fx_get, jobs_base, jobs_fx_headers
from helpers.users import get_in_app_user_id
from helpers.timing import measure_call


def create_blueprint(auth):
    bp = Blueprint("ui_job_company_applications_get", __name__)

    @bp.route("/ui/jobs/<job_id>/company-application-summary", methods=["GET"])
    @auth.login_required
    def ui_job_company_applications(job_id: str, *, context):
        try:
            uid = measure_call("identity", lambda: get_in_app_user_id(context))
        except Exception:
            return jsonify({"error": "Could not resolve in-app user id"}), 401

        response = fx_get(
            f"{jobs_base()}/jobs/{job_id}/company-application-summary",
            headers=jobs_fx_headers(context={"userId": uid}),
            timeout=10,
        )
        try:
            payload = measure_call("json_parse", response.json)
        except ValueError:
            status = response.status_code if not response.ok else 502
            return jsonify({"error": "bad-upstream"}), status
        return jsonify(payload), response.status_code

    return bp
