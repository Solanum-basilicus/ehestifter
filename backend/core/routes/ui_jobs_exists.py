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
        provider = (request.args.get("provider") or "").strip()
        provider_tenant = (request.args.get("providerTenant") or "").strip()
        external_id = (request.args.get("externalId") or "").strip()

        if not provider or external_id == "":
            return jsonify({"error": "Missing required query params: provider, providerTenant, externalId"}), 400

        user_id = get_user_id_for_analytics(context)
        correlation_id = ensure_job_create_flow_id()

        url = (f"{jobs_base()}/jobs/exists"
               f"?provider={provider}"
               f"&providerTenant={provider_tenant}"
               f"&externalId={external_id}")

        def call():
            # GET always returns 200 with JSON payload {exists, id}
            headers = jobs_fx_headers(context={"userId": user_id}) if user_id else jobs_fx_headers()
            return fx_get_json(url, headers=headers)

        data = retry_until_ready(call, attempts=3, base_delay=0.5)

        duplicate_found = bool((data or {}).get("exists"))
        duplicate_job_id = (data or {}).get("id") if duplicate_found else None

        # Deliberately do not emit raw URL or externalId.
        properties = {
            "duplicate_found": duplicate_found,
            "provider": provider,
            "identity_inferred": True,
        }
        if provider_tenant:
            properties["provider_tenant"] = provider_tenant

        emit_core_event(
            "Job Duplicate Checked",
            user_id=user_id,
            subject_type="job" if duplicate_job_id else None,
            subject_id=str(duplicate_job_id) if duplicate_job_id else None,
            correlation_id=correlation_id,
            properties=properties,
        )

        resp = make_response(jsonify(data), 200)
        return resp

    return bp