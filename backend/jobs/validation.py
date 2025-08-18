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

    return True, ""
