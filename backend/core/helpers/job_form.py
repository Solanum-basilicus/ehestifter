# helpers/job_form.py

# Fields the UI is allowed to send to the Jobs API for create/update
_ALLOWED = {
    "url", "title", "hiringCompanyName", "postingCompanyName",
    "foundOn", "provider", "providerTenant", "atsVendor", "externalId",
    "remoteType", "description", "locationsV2", "workTimeConstraintsV2"
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
        if k == "locationsV2":
            # Keep invalid values for Jobs validation. Do not silently remove
            # a selection or turn invalid input into an empty location list.
            if isinstance(v, list):
                selections = []
                for item in v:
                    if not isinstance(item, dict):
                        selections.append(item)
                        continue
                    identity = {}
                    for key in ("kind", "locationId"):
                        value = item.get(key)
                        identity[key] = value.strip() if isinstance(value, str) else value
                    selections.append(identity)
                out[k] = selections
            else:
                out[k] = v
            continue

        if v in ("", None):
            continue

        if k == "workTimeConstraintsV2":
            if isinstance(v, list):
                out[k] = [
                    {
                        "offsetRangeStartMinutes": item.get("offsetRangeStartMinutes"),
                        "offsetRangeEndMinutes": item.get("offsetRangeEndMinutes"),
                    }
                    for item in v
                    if isinstance(item, dict)
                ]
            continue

        out[k] = v.strip() if isinstance(v, str) else v

    return out
