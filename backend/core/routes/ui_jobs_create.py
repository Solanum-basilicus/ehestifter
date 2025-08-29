from flask import Blueprint, request, jsonify
from helpers.http import jobs_base, jobs_fx_headers, fx_post_json
from helpers.users import get_in_app_user_id
from helpers.job_form import clean_job_payload

def create_blueprint(auth):
    bp = Blueprint("ui_jobs_create", __name__)

    @bp.route("/ui/jobs", methods=["POST"])
    @auth.login_required
    def ui_jobs_create(*, context):
        body = request.get_json(silent=True) or {}
        payload = clean_job_payload(body, for_update=False)
        url = (payload.get("url") or "").strip()
        if not url or not (url.startswith("http://") or url.startswith("https://")):
            return jsonify({"error":"bad_request","message":"Field 'url' (http/https) is required"}), 400

        # Try to pass user id for provenance
        try:
            uid = get_in_app_user_id(context)
            headers = jobs_fx_headers(context={"userId": uid})
        except Exception:
            headers = jobs_fx_headers()

        r = fx_post_json(f"{jobs_base()}/jobs", headers=headers, json_body=payload)
        if r.status_code in (200,201):
            try:
                data = r.json()
            except ValueError:
                return jsonify({"error":"upstream_error","message": r.text[:400]}), r.status_code
            return jsonify({"id": data.get("id")}), 201
        return r.text, r.status_code, {"Content-Type": r.headers.get("Content-Type","text/plain")}

    return bp