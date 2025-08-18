import json
import logging
import azure.functions as func
from db import get_connection
from auth import detect_actor
from history import insert_history
from validation import validate_job_payload

# mapping: JSON -> DB column
_MAPPING = {
    "foundOn":"FoundOn","provider":"Provider","providerTenant":"ProviderTenant","externalId":"ExternalId",
    "url":"Url","applyUrl":"ApplyUrl","hiringCompanyName":"HiringCompanyName","postingCompanyName":"PostingCompanyName",
    "title":"Title","remoteType":"RemoteType","description":"Description"
}

def register(app: func.FunctionApp):

    @app.route(route="jobs/{id}", methods=["PUT"])
    def update_job(req: func.HttpRequest) -> func.HttpResponse:
        job_id = req.route_params.get("id")
        logging.info(f"PUT /jobs/{job_id}")
        conn = None
        try:
            data = req.get_json()
            is_valid, error = validate_job_payload(data, for_update=True)
            if not is_valid:
                return func.HttpResponse(error, status_code=400)

            conn = get_connection()
            cur = conn.cursor()
            actor_type, actor_id = detect_actor(req)

            # read before
            cur.execute("SELECT " + ",".join(_MAPPING.values()) + " FROM dbo.JobOfferings WHERE Id = ?", job_id)
            rb = cur.fetchone()
            if not rb:
                return func.HttpResponse("Job not found", status_code=404)
            before = dict(zip(_MAPPING.values(), rb))

            # update provided fields
            sets, vals = [], []
            for k, col in _MAPPING.items():
                if k in data:
                    sets.append(f"{col} = ?")
                    vals.append(data.get(k))
            if sets:
                sets.append("UpdatedAt = SYSDATETIME()")
                cur.execute(f"UPDATE dbo.JobOfferings SET {', '.join(sets)} WHERE Id = ?", (*vals, job_id))

            # replace locations if provided
            if "locations" in data and isinstance(data["locations"], list):
                cur.execute("DELETE FROM dbo.JobOfferingLocations WHERE JobOfferingId = ?", job_id)
                params = []
                for loc in data["locations"]:
                    params.append((
                        job_id,
                        loc.get("countryName"),
                        (loc.get("countryCode") or None),
                        (loc.get("cityName") or None),
                        (loc.get("region") or None),
                    ))
                if params:
                    cur.fast_executemany = True
                    cur.executemany("""
                        INSERT INTO dbo.JobOfferingLocations (JobOfferingId, CountryName, CountryCode, CityName, Region)
                        VALUES (?, ?, ?, ?, ?)
                    """, params)

            # diff for history (omit Description content)
            changed, desc_changed = {}, False
            for k, col in _MAPPING.items():
                if k in data:
                    newv = data.get(k)
                    oldv = before.get(col)
                    if col == "Description":
                        if oldv != newv:
                            desc_changed = True
                    elif oldv != newv:
                        changed[col] = {"from": oldv, "to": newv}

            if changed or desc_changed:
                details = {"changed": changed}
                if desc_changed:
                    details["descriptionChanged"] = True
                insert_history(cur, job_id, "job_updated", details, actor_type, actor_id)

            conn.commit()
            return func.HttpResponse("Job updated", status_code=200)

        except Exception as e:
            logging.exception("PUT /jobs error")
            try:
                if conn: conn.rollback()
            except Exception:
                pass
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
