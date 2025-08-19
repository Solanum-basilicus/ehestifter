from flask import Blueprint, request, jsonify
from helpers.http import jobs_base, jobs_fx_headers, fx_post_json
from helpers.users import get_in_app_user_id

_ALLOWED = {"url","title","hiringCompanyName","postingCompanyName",
            "foundOn","provider","providerTenant","externalId",
            "remoteType","description","locations"}

def _clean(body: dict) -> dict:
    out = {}
    for k in list(body.keys()):
        if k in _ALLOWED:
            v = body[k]
            if v in ("", None): 
                continue
            if k == "locations":
                # accept list of dicts with keys countryName,countryCode,cityName,region
                if isinstance(v, list):
                    locs = []
                    for item in v:
                        if not isinstance(item, dict): 
                            continue
                        locs.append({
                            "countryName": (item.get("countryName") or "").strip(),
                            "countryCode": (item.get("countryCode") or None),
                            "cityName": (item.get("cityName") or None),
                            "region": (item.get("region") or None),
                        })
                    if locs: out[k] = locs
                continue
            out[k] = v.strip() if isinstance(v, str) else v
    return out

def create_blueprint(auth):
    bp = Blueprint("ui_jobs_create", __name__)

    @bp.route("/ui/jobs", methods=["POST"])
    @auth.login_required
    def ui_jobs_create(*, context):
        body = request.get_json(silent=True) or {}
        payload = _clean(body)
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