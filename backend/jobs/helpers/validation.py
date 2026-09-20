# validation.py
from datetime import datetime

def _is_iso8601(s: str) -> bool:
    try:
        datetime.fromisoformat(s)
        return True
    except Exception:
        return False

def _check_str(d, key, max_len):
    if key in d and d[key] is not None:
        if not isinstance(d[key], str):
            return False, f"Field '{key}' must be a string"
        if len(d[key]) > max_len:
            return False, f"Field '{key}' exceeds max length ({max_len})"
    return True, ""

def validate_job_payload(data: dict, for_update=False) -> (bool, str):
    if not isinstance(data, dict):
        return False, "Body must be a JSON object"

    # Required for create: url
    if not for_update:
        if "url" not in data or not isinstance(data["url"], str) or not data["url"].strip():
            return False, "Missing required field: url"

    # Strings max lengths
    rules = {
        "foundOn": 100,
        "provider": 100,
        "providerTenant": 200,
        "atsVendor": 100,
        "externalId": 200,
        "url": 1000,
        "applyUrl": 1000,
        "hiringCompanyName": 300,
        "postingCompanyName": 300,
        "title": 300,
        "remoteType": 50,
        # "description" left unchecked length-wise (NVARCHAR(MAX) in DB); but we can cap if you like
    }
    for k, n in rules.items():
        ok, msg = _check_str(data, k, n)
        if not ok:
            return False, msg

    # locations validation
    locs = data.get("locations")
    if locs is not None:
        if not isinstance(locs, list):
            return False, "locations must be an array"
        for i, loc in enumerate(locs):
            if not isinstance(loc, dict):
                return False, f"locations[{i}] must be an object"
            if not isinstance(loc.get("countryName"), str) or not loc["countryName"].strip():
                return False, f"locations[{i}].countryName is required"
            if "countryCode" in loc and loc["countryCode"] is not None:
                cc = loc["countryCode"]
                if not (isinstance(cc, str) and len(cc) == 2 and cc.isalpha()):
                    return False, f"locations[{i}].countryCode must be a 2-letter ISO code"
            if "cityName" in loc and loc["cityName"] is not None and not isinstance(loc["cityName"], str):
                return False, f"locations[{i}].cityName must be a string"

    # Locations v2 validation. Canonical ID existence is checked against the
    # local catalog in the persistence layer.
    locs_v2 = data.get("locationsV2")
    if locs_v2 is not None:
        if not isinstance(locs_v2, list):
            return False, "locationsV2 must be an array"
        for i, loc in enumerate(locs_v2):
            if not isinstance(loc, dict):
                return False, f"locationsV2[{i}] must be an object"
            kind = loc.get("kind")
            if kind not in {"city", "adminRegion", "country", "globalRegion"}:
                return False, f"locationsV2[{i}].kind is invalid"
            location_id = loc.get("locationId")
            if not isinstance(location_id, str) or not location_id.strip():
                return False, f"locationsV2[{i}].locationId is required"
            if len(location_id) > 64:
                return False, f"locationsV2[{i}].locationId exceeds max length (64)"

    work_time = data.get("workTimeConstraintsV2")
    if work_time is not None:
        if not isinstance(work_time, list):
            return False, "workTimeConstraintsV2 must be an array"
        for i, item in enumerate(work_time):
            if not isinstance(item, dict):
                return False, f"workTimeConstraintsV2[{i}] must be an object"
            start = item.get("offsetRangeStartMinutes")
            end = item.get("offsetRangeEndMinutes")
            if isinstance(start, bool) or not isinstance(start, int):
                return False, f"workTimeConstraintsV2[{i}].offsetRangeStartMinutes must be an integer"
            if isinstance(end, bool) or not isinstance(end, int):
                return False, f"workTimeConstraintsV2[{i}].offsetRangeEndMinutes must be an integer"
            if start < -840 or start > 840 or end < -840 or end > 840:
                return False, f"workTimeConstraintsV2[{i}] offsets must be between -840 and 840 minutes"
            if start > end:
                return False, f"workTimeConstraintsV2[{i}] start must not be greater than end"

    return True, ""
