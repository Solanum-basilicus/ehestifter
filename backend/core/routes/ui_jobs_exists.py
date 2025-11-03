# routes/ui_jobs_exists.py
from flask import Blueprint, jsonify, request, make_response
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

        url = (f"{jobs_base()}/jobs/exists"
               f"?provider={provider}"
               f"&providerTenant={provider_tenant}"
               f"&externalId={external_id}")

        def call():
            # GET always returns 200 with JSON payload {exists, id}
            return fx_get_json(url, headers=jobs_fx_headers())

        data = retry_until_ready(call, attempts=3, base_delay=0.5)

        # Optionally mirror Location header (useful for debugging/clients)
        resp = make_response(jsonify(data), 200)
        # If your Functions layer returns Location, fx_get_json won't carry headers,
        # but we don't actually need it because UI builds the link from id.
        return resp

    return bp
