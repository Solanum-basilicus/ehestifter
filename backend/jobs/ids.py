import re
import uuid

GUID_REGEX = re.compile(
    r"^[{]?[0-9a-fA-F]{8}[-]?[0-9a-fA-F]{4}[-]?[0-9a-fA-F]{4}[-]?[0-9a-fA-F]{4}[-]?[0-9a-fA-F]{12}[}]?$"
)

def normalize_guid(s: str) -> str:
    # canonical 8-4-4-4-12 lowercase form
    return str(uuid.UUID(s))

def normalize_guid_in_dict(d: dict, keys: list[str]) -> dict:
    for k in keys:
        v = d.get(k)
        if isinstance(v, str):
            try:
                d[k] = normalize_guid(v)
            except Exception:
                pass
    return d

def is_guid(s: str) -> bool:
    if not isinstance(s, str):
        return False
    if not GUID_REGEX.match(s):
        return False
    try:
        _ = uuid.UUID(s)
        return True
    except Exception:
        return False