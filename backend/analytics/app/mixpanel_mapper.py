from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


class MappingError(Exception):
    pass


def map_event_to_mixpanel(row: dict[str, Any]) -> dict[str, Any]:
    distinct_id = _clean_optional(row.get("DistinctId"))
    if not distinct_id:
        raise MappingError("missing_distinct_id")

    event_id = str(row["EventId"])
    if len(event_id) > 36:
        raise MappingError("insert_id_too_long")

    properties = {
        "time": _unix_seconds(row["OccurredAtUtc"]),
        "distinct_id": distinct_id,
        "$insert_id": event_id,
        "schema_version": int(row["SchemaVersion"]),
        "source_domain": row["SourceDomain"],
        "source_surface": row["SourceSurface"],
        "subject_type": _clean_optional(row.get("SubjectType")),
        "subject_id": _clean_optional(row.get("SubjectId")),
        "ip": 0,
    }

    stored_properties = _load_properties(row.get("PropertiesJson"))
    for key, value in stored_properties.items():
        if value is not None:
            properties[key] = value

    return {
        "event": row["EventName"],
        "properties": _drop_nulls(properties),
    }


def _load_properties(raw: Any) -> dict[str, Any]:
    if raw is None or raw == "":
        return {}

    if isinstance(raw, dict):
        return raw

    parsed = json.loads(str(raw))
    if not isinstance(parsed, dict):
        raise MappingError("properties_json_not_object")

    return parsed


def _unix_seconds(value: Any) -> int:
    if isinstance(value, datetime):
        dt = value
    else:
        raw = str(value)
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    return int(dt.astimezone(timezone.utc).timestamp())


def _clean_optional(value: Any) -> str | None:
    if value is None:
        return None

    text = str(value).strip()
    return text or None


def _drop_nulls(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}
    