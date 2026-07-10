# routes/ui_jobs_exists.py
from flask import Blueprint, jsonify, request, make_response

from helpers.analytics import (
    emit_core_event,
    ensure_job_create_flow_id,
    get_user_id_for_analytics,
)
from helpers.http import jobs_base, jobs_fx_headers, fx_get_json
from helpers.retry import retry_until_ready


def create_blueprint(auth):
    bp = Blueprint("ui_jobs_exists", __name__)

    @bp.route("/ui/jobs/exists", methods=["GET"])
    @auth.login_required
    def ui_jobs_exists(*, context):
        url_param = (request.args.get("url") or "").strip()
        provider = (request.args.get("provider") or "").strip()
        provider_tenant = (request.args.get("providerTenant") or "").strip()
        external_id = (request.args.get("externalId") or "").strip()

        if url_param:
            params = {"url": url_param}
            identity_inferred = True
        else:
            if not provider or external_id == "":
                return jsonify({
                    "error": "Missing required query params: url OR provider, providerTenant, externalId"
                }), 400
            params = {
                "provider": provider,
                "providerTenant": provider_tenant,
                "externalId": external_id,
            }
            identity_inferred = False

        user_id = get_user_id_for_analytics(context)
        correlation_id = ensure_job_create_flow_id()

        def call():
            headers = jobs_fx_headers(context={"userId": user_id}) if user_id else jobs_fx_headers()
            return fx_get_json(
                f"{jobs_base()}/jobs/exists",
                headers=headers,
                params=params,
            )

        data = retry_until_ready(call, attempts=3, base_delay=0.5)

        duplicate_found = bool((data or {}).get("exists"))
        duplicate_job_id = (data or {}).get("id") if duplicate_found else None

        # Deliberately do not emit raw URL or externalId.
        analytics_provider = (data or {}).get("provider") or provider
        analytics_tenant = (data or {}).get("providerTenant") or provider_tenant

        properties = {
            "duplicate_found": duplicate_found,
            "identity_inferred": identity_inferred,
        }
        if analytics_provider:
            properties["provider"] = analytics_provider
        if analytics_tenant:
            properties["provider_tenant"] = analytics_tenant

        emit_core_event(
            "Job Duplicate Checked",
            user_id=user_id,
            subject_type="job" if duplicate_job_id else None,
            subject_id=str(duplicate_job_id) if duplicate_job_id else None,
            correlation_id=correlation_id,
            properties=properties,
        )

        return make_response(jsonify(data), 200)

    return bp