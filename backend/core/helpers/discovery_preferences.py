"""Pure helpers for Web discovery-preference orchestration."""

ARRANGEMENTS = ("remote", "hybrid", "onSite", "unknown")
LOCATION_FIELDS = ("includeLocations", "excludeLocations")


def collect_location_selectors(document) -> list[dict]:
    """Collect distinct canonical selectors from one preference document."""
    if not isinstance(document, dict):
        return []
    eligibility = document.get("eligibility")
    if not isinstance(eligibility, dict):
        return []

    selectors = []
    seen = set()
    for arrangement in ARRANGEMENTS:
        group = eligibility.get(arrangement)
        if not isinstance(group, dict):
            continue
        for field in LOCATION_FIELDS:
            values = group.get(field)
            if not isinstance(values, list):
                continue
            for value in values:
                if not isinstance(value, dict):
                    continue
                kind = value.get("kind")
                location_id = value.get("locationId")
                if not isinstance(kind, str) or not isinstance(location_id, str):
                    continue
                key = (kind, location_id)
                if key in seen:
                    continue
                seen.add(key)
                selectors.append({"kind": kind, "locationId": location_id})
    return selectors
