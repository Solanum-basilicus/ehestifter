# helpers/job_form.py

# Fields the UI is allowed to send to the Jobs API for create/update
_ALLOWED = {
    "url", "title", "hiringCompanyName", "postingCompanyName",
    "foundOn", "provider", "providerTenant", "externalId",
    "remoteType", "description", "locations"
}

# Fields that must be treated read-only in EDIT mode (client also disables them)
_READONLY_ON_EDIT = {"provider", "providerTenant", "externalId"}

def clean_job_payload(body: dict, *, for_update: bool = False) -> dict:
    """Normalize and whitelist job form payload for UI -> API hop.
    - Drops empty strings / None
    - Normalizes locations list items
    - Strips read-only keys if for_update=True
    """
    if not isinstance(body, dict):
        return {}

    out = {}
    for k in list(body.keys()):
        if k not in _ALLOWED:
            continue
        if for_update and k in _READONLY_ON_EDIT:
            # server-side belt and suspenders: never pass these through on edit
            continue

        v = body[k]
        if v in ("", None):
            continue

        if k == "locations":
            # accept list of dicts with keys: countryName, countryCode, cityName, region
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
                if locs:
                    out[k] = locs
            continue

        out[k] = v.strip() if isinstance(v, str) else v

    return out
