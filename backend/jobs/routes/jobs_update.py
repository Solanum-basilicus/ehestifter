import json
import logging
import azure.functions as func
from helpers.db import get_connection
from helpers.auth import detect_actor
from helpers.history import insert_history
from helpers.validation import validate_job_payload
from typing import List, Dict, Any, Optional

# mapping: JSON -> DB column
_MAPPING = {
    "foundOn":"FoundOn","provider":"Provider","providerTenant":"ProviderTenant","externalId":"ExternalId",
    "url":"Url","applyUrl":"ApplyUrl","hiringCompanyName":"HiringCompanyName","postingCompanyName":"PostingCompanyName",
    "title":"Title","remoteType":"RemoteType","description":"Description"
}

def _canon_loc(loc: Dict[str, Any]) -> Dict[str, Optional[str]]:
    # Normalize to avoid false diffs: trim strings, map "" -> None, uppercase countryCode.
    def _nz(v):
        if v is None: return None
        v = str(v).strip()
        return v if v else None
    code = _nz(loc.get("countryCode"))
    return {
        "countryName": _nz(loc.get("countryName")),
        "countryCode": code.upper() if code else None,
        "cityName":   _nz(loc.get("cityName")),
        "region":     _nz(loc.get("region")),
    }

def _canon_locs(locs: List[Dict[str, Any]]) -> List[Dict[str, Optional[str]]]:
    items = [_canon_loc(x) for x in (locs or [])]
    # Stable order so reordering same items doesn't produce noise
    items.sort(key=lambda x: (x["countryCode"] or "", x["countryName"] or "", x["region"] or "", x["cityName"] or ""))
    return items


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

            # read locations before
            cur.execute("""
                SELECT CountryName, CountryCode, CityName, Region
                FROM dbo.JobOfferingLocations
                WHERE JobOfferingId = ?
            """, job_id)
            before_locs_raw = [
                {"countryName": r[0], "countryCode": r[1], "cityName": r[2], "region": r[3]}
                for r in cur.fetchall()
            ]
            before_locs = _canon_locs(before_locs_raw)

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
            locs_changed_flag = False
            new_locs: List[Dict[str, Optional[str]]] = []
            if "locations" in data and isinstance(data["locations"], list):
                # Canonicalize incoming for diff
                new_locs = _canon_locs(data["locations"])
                # Diff against "before"
                locs_changed_flag = (new_locs != before_locs)
                # Persist (replace strategy kept)
                cur.execute("DELETE FROM dbo.JobOfferingLocations WHERE JobOfferingId = ?", job_id)
                if new_locs:
                    cur.fast_executemany = True
                    cur.executemany("""
                        INSERT INTO dbo.JobOfferingLocations (JobOfferingId, CountryName, CountryCode, CityName, Region)
                        VALUES (?, ?, ?, ?, ?)
                    """, [
                        (job_id, nl["countryName"], nl["countryCode"], nl["cityName"], nl["region"])
                        for nl in new_locs
                    ])
                # If only locations changed, still bump UpdatedAt
                if locs_changed_flag and not sets:
                    cur.execute("UPDATE dbo.JobOfferings SET UpdatedAt = SYSDATETIME() WHERE Id = ?", job_id)

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

            # include locations diff
            if "locations" in data and isinstance(data["locations"], list) and locs_changed_flag:
                changed["Locations"] = {"from": before_locs, "to": new_locs}

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
