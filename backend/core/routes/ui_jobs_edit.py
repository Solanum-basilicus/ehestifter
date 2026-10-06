from flask import Blueprint, request, jsonify, render_template, abort
from helpers.http import jobs_base, jobs_fx_headers, fx_get, fx_put_json
from helpers.users import get_in_app_user_id
from helpers.job_form import clean_job_payload
from helpers.locations import lookup_locations
from helpers.ids import normalize_guid  # robust, case-insensitive GUID compare

def _pick(d: dict, *keys):
    """Return first non-empty key from keys."""
    for k in keys:
        v = d.get(k)
        if v is not None and v != "":
            return v
    return None

def _map_api_job_to_initial(job: dict) -> dict:
    """Prepare initial JSON expected by job_edit.html shared form (case-agnostic)."""
    locs_v2 = _pick(job, "locationsV2", "LocationsV2") or []
    norm_locs_v2 = []
    if isinstance(locs_v2, list):
        for item in locs_v2:
            if not isinstance(item, dict):
                continue
            norm_locs_v2.append({
                "kind": _pick(item, "kind", "LocationKind") or "",
                "locationId": _pick(item, "locationId", "LocationId") or "",
            })

    work_time_v2 = _pick(job, "workTimeConstraintsV2", "WorkTimeConstraintsV2") or []
    norm_work_time_v2 = []
    if isinstance(work_time_v2, list):
        for item in work_time_v2:
            if not isinstance(item, dict):
                continue
            norm_work_time_v2.append({
                "offsetRangeStartMinutes": _pick(item, "offsetRangeStartMinutes", "OffsetRangeStartMinutes"),
                "offsetRangeEndMinutes": _pick(item, "offsetRangeEndMinutes", "OffsetRangeEndMinutes"),
            })

    return {
        "id": _pick(job, "id", "Id", "ID"),
        "url": _pick(job, "url", "Url", "OriginalUrl") or "",
        "title": _pick(job, "title", "Title") or "",
        "hiringCompanyName": _pick(job, "hiringCompanyName", "HiringCompanyName") or "",
        "postingCompanyName": _pick(job, "postingCompanyName", "PostingCompanyName") or "",
        "foundOn": _pick(job, "foundOn", "FoundOn") or "",
        "provider": _pick(job, "provider", "Provider") or "",
        "providerTenant": _pick(job, "providerTenant", "ProviderTenant") or "",
        "atsVendor": _pick(job, "atsVendor", "AtsVendor") or "",
        "externalId": _pick(job, "externalId", "ExternalId") or "",
        "remoteType": (_pick(job, "remoteType", "RemoteType") or "Unknown"),
        # HTML description (accept different casings)
        "descriptionHtml": _pick(job, "description", "Description") or "",
        "locationsV2": norm_locs_v2,
        "workTimeConstraintsV2": norm_work_time_v2,
    }

def _resolve_location_details(initial: dict, user_id: str) -> None:
    """Resolve display data without changing the stored location identities."""
    initial["locationDetails"] = []
    initial["locationLookupFailed"] = False
    selectors = initial["locationsV2"]
    if not selectors:
        return
    try:
        response = lookup_locations({"userId": user_id}, selectors)
        if not response.ok:
            raise ValueError("Location lookup failed")
        payload = response.json()
        details = payload.get("items")
        if not isinstance(details, list):
            raise ValueError("Location lookup returned invalid display data")
        initial["locationDetails"] = details
    except Exception:
        # Lookup is for display only. The user can still edit the job.
        initial["locationLookupFailed"] = True

def create_blueprint(auth):
    bp = Blueprint("ui_jobs_edit", __name__)

    @bp.route("/jobs/<job_id>/edit", methods=["GET"])
    @auth.login_required
    def ui_jobs_edit_page(job_id: str, *, context):
        # Load job from Jobs API (as the UI already does in details page)
        r = fx_get(f"{jobs_base()}/jobs/{job_id}", headers=jobs_fx_headers())
        if r.status_code == 404:
            abort(404)
        if r.status_code >= 400:
            abort(r.status_code)
        try:
            job = r.json()
        except ValueError:
            abort(502)

        # Authorization: only creator can edit (admin logic to be added later)
        try:
            uid = str(get_in_app_user_id(context) or "")
        except Exception:
            abort(401)

        # Accept multiple possible keys from Jobs API
        created_by_raw = (
            job.get("createdByUserId")
            or job.get("CreatedByUserId")
            or job.get("createdBy")
            or job.get("CreatedBy")
            or ""
        )
        uid_norm = normalize_guid(uid) if uid else (uid or "")
        created_norm = normalize_guid(str(created_by_raw)) if created_by_raw else (str(created_by_raw) or "")

        # Only creator can edit (admin roles to be added later if needed)
        if not uid_norm or not created_norm or uid_norm != created_norm:
            abort(403)

        initial = _map_api_job_to_initial(job)
        _resolve_location_details(initial, uid)
        return render_template(
            "job_edit.html",
            title="Edit job",
            # values consumed by templates/jobs/_job_form.html
            mode="edit",
            disable_ats=True,               # Canonical provider identity is read-only in edit.
            initial_json=initial,
            submit_label="Save changes",
            cancel_href=f"/jobs/{job_id}",
        )

    @bp.route("/ui/jobs/<job_id>", methods=["PUT"])
    @auth.login_required
    def ui_jobs_update(job_id: str, *, context):
        # Clean/whitelist and enforce read-only fields server-side
        body = request.get_json(silent=True) or {}
        payload = clean_job_payload(body, for_update=True)

        # Must have a URL (your API validation will also check, but we mirror UX)
        url = (payload.get("url") or "").strip()
        if not url or not (url.startswith("http://") or url.startswith("https://")):
            return jsonify({"error": "bad_request", "message": "Field 'url' (http/https) is required"}), 400

        # Forward to Jobs API
        try:
            uid = get_in_app_user_id(context)
            headers = jobs_fx_headers(context={"userId": uid})
        except Exception:
            headers = jobs_fx_headers()

        r = fx_put_json(f"{jobs_base()}/jobs/{job_id}", headers=headers, json_body=payload)
        # The Azure Function returns 200 text "Job updated" (no JSON).
        if r.status_code == 200:
            # Hand the UI the id so it can redirect to /jobs/<id>
            return jsonify({"id": job_id}), 200
        # Propagate upstream error
        return r.text, r.status_code, {"Content-Type": r.headers.get("Content-Type", "text/plain")}

    return bp
