# validation.py

from datetime import datetime

# Define schema-like structure
JOB_SCHEMA = {
    "required": {
        "Source": 100,
        "ExternalId": 200,
        "Url": 1000,
        "HiringCompanyName": 300,
        "Title": 300,
        "Country": 100
    },
    "optional": {
        "ApplyUrl": 1000,
        "PostingCompanyName": 300,
        "Locality": 300,
        "RemoteType": 50,
        "Description": 5000,
        "PostedDate": "datetime"
    }
}


def validate_job_payload(data: dict, for_update=False) -> (bool, str):
    """
    Validates job data payload.

    :param data: dict from req.get_json()
    :param for_update: if True, required fields will be skipped (PATCH-style)
    :return: (True, "") if valid, else (False, "error message")
    """
    # Required fields
    if not for_update:
        for field, max_len in JOB_SCHEMA["required"].items():
            if field not in data:
                return False, f"Missing required field: {field}"
            if not isinstance(data[field], str):
                return False, f"Field '{field}' must be a string"
            if not data[field].strip():
                return False, f"Field '{field}' cannot be empty"
            if len(data[field]) > max_len:
                return False, f"Field '{field}' exceeds max length ({max_len})"

    else:
        # In updates, if required fields are present, validate them
        for field, max_len in JOB_SCHEMA["required"].items():
            if field in data:
                if not isinstance(data[field], str):
                    return False, f"Field '{field}' must be a string"
                if not data[field].strip():
                    return False, f"Field '{field}' cannot be empty"
                if len(data[field]) > max_len:
                    return False, f"Field '{field}' exceeds max length ({max_len})"

    # Optional fields
    for field, rule in JOB_SCHEMA["optional"].items():
        if field in data:
            value = data[field]
            if value is None:
                continue
            if rule == "datetime":
                try:
                    datetime.fromisoformat(value)
                except ValueError:
                    return False, f"Field '{field}' must be a valid ISO8601 datetime"
            else:
                if not isinstance(value, str):
                    return False, f"Field '{field}' must be a string"
                if len(value) > rule:
                    return False, f"Field '{field}' exceeds max length ({rule})"

    return True, ""
