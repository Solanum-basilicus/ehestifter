"""Validate and compile Locations v2 eligibility criteria for Jobs queries."""

from __future__ import annotations


ARRANGEMENT_SQL = {
    "remote": "LOWER(LTRIM(RTRIM(j.RemoteType))) = 'remote'",
    "hybrid": "LOWER(LTRIM(RTRIM(j.RemoteType))) = 'hybrid'",
    "onSite": "LOWER(LTRIM(RTRIM(j.RemoteType))) IN ('on-site', 'onsite', 'on site')",
    "unknown": "LOWER(LTRIM(RTRIM(COALESCE(j.RemoteType, 'Unknown')))) = 'unknown'",
}

GROUP_FIELDS = {
    "includeLocations",
    "excludeLocations",
    "utcOffsetRanges",
    "excludeWorkTimeRanges",
    "allowUnknownLocation",
}


def _validate_range(value: dict, path: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    start = value.get("startMinutes")
    end = value.get("endMinutes")
    if isinstance(start, bool) or not isinstance(start, int):
        raise ValueError(f"{path}.startMinutes must be an integer")
    if isinstance(end, bool) or not isinstance(end, int):
        raise ValueError(f"{path}.endMinutes must be an integer")
    if start < -840 or start > 840 or end < -840 or end > 840:
        raise ValueError(f"{path} must stay between -840 and 840 minutes")
    if start > end:
        raise ValueError(f"{path}.startMinutes must not be greater than endMinutes")
    return {"startMinutes": start, "endMinutes": end}


def _validate_selector(catalog, value: dict, path: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    kind = value.get("kind")
    location_id = value.get("locationId")
    if kind not in {"city", "adminRegion", "country", "globalRegion"}:
        raise ValueError(f"{path}.kind is invalid")
    if not isinstance(location_id, str) or not location_id.strip():
        raise ValueError(f"{path}.locationId is required")
    item = catalog.get_location(kind, location_id)
    if item is None:
        raise ValueError(f"{path} is not a valid canonical location")
    return {
        "kind": item["kind"],
        "locationId": item["id"],
        "catalogItem": item,
    }


def validate_eligibility(catalog, value: dict | None) -> dict | None:
    """Validate the Jobs-side discovery criteria contract."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("eligibility must be an object or null")

    unknown_groups = set(value) - set(ARRANGEMENT_SQL)
    if unknown_groups:
        raise ValueError(f"eligibility contains unsupported work arrangement: {sorted(unknown_groups)[0]}")

    result = {}
    for group_name, raw_group in value.items():
        path = f"eligibility.{group_name}"
        if not isinstance(raw_group, dict):
            raise ValueError(f"{path} must be an object")
        unknown_fields = set(raw_group) - GROUP_FIELDS
        if unknown_fields:
            raise ValueError(f"{path} contains unsupported field: {sorted(unknown_fields)[0]}")

        allow_unknown = raw_group.get("allowUnknownLocation", False)
        if not isinstance(allow_unknown, bool):
            raise ValueError(f"{path}.allowUnknownLocation must be a boolean")

        group = {"allowUnknownLocation": allow_unknown}
        for field in ("includeLocations", "excludeLocations"):
            raw_items = raw_group.get(field, [])
            if not isinstance(raw_items, list):
                raise ValueError(f"{path}.{field} must be an array")
            if len(raw_items) > 100:
                raise ValueError(f"{path}.{field} must contain at most 100 selectors")
            group[field] = [
                _validate_selector(catalog, item, f"{path}.{field}[{index}]")
                for index, item in enumerate(raw_items)
            ]

        for field in ("utcOffsetRanges", "excludeWorkTimeRanges"):
            raw_ranges = raw_group.get(field, [])
            if not isinstance(raw_ranges, list):
                raise ValueError(f"{path}.{field} must be an array")
            if len(raw_ranges) > 32:
                raise ValueError(f"{path}.{field} must contain at most 32 ranges")
            group[field] = [
                _validate_range(item, f"{path}.{field}[{index}]")
                for index, item in enumerate(raw_ranges)
            ]

        result[group_name] = group

    return result


def _selector_predicate(alias: str, selectors: list[dict]) -> tuple[str, list]:
    if not selectors:
        return "", []
    parts = []
    params = []
    for selector in selectors:
        parts.append(f"({alias}.LocationKind = ? AND {alias}.LocationId = ?)")
        params.extend([selector["kind"], selector["locationId"]])
    return " OR ".join(parts), params


def _remote_direct_candidates(catalog, selectors: list[dict]) -> list[dict]:
    candidates = {}
    for selector in selectors:
        for kind, location_id in catalog.facts_for_location(selector["catalogItem"]):
            candidates[(kind, location_id)] = {"kind": kind, "locationId": location_id}
    return [candidates[key] for key in sorted(candidates)]


def _compile_branch(catalog, arrangement: str, group: dict) -> tuple[str, list]:
    clauses = ["d.JobOfferingId = j.Id"]
    params = []

    include = group["includeLocations"]
    if include:
        fact_predicate, fact_params = _selector_predicate("fi", include)
        positive_parts = [
            f"""EXISTS (
                SELECT 1
                FROM dbo.JobOfferingLocationFactsV2 fi
                WHERE fi.DirectLocationV2Id = d.Id
                  AND ({fact_predicate})
            )"""
        ]
        positive_params = list(fact_params)

        if arrangement == "remote":
            direct_candidates = _remote_direct_candidates(catalog, include)
            direct_predicate, direct_params = _selector_predicate("d", direct_candidates)
            if direct_predicate:
                positive_parts.append(f"({direct_predicate})")
                positive_params.extend(direct_params)

        clauses.append("(" + " OR ".join(positive_parts) + ")")
        params.extend(positive_params)

    exclude = group["excludeLocations"]
    if exclude:
        negative_predicate, negative_params = _selector_predicate("fx", exclude)
        clauses.append(
            f"""NOT EXISTS (
                SELECT 1
                FROM dbo.JobOfferingLocationFactsV2 fx
                WHERE fx.DirectLocationV2Id = d.Id
                  AND ({negative_predicate})
            )"""
        )
        params.extend(negative_params)

    utc_ranges = group["utcOffsetRanges"]
    if utc_ranges:
        range_parts = []
        for value in utc_ranges:
            range_parts.append("uo.UtcOffsetMinutes BETWEEN ? AND ?")
            params.extend([value["startMinutes"], value["endMinutes"]])
        clauses.append(
            """EXISTS (
                SELECT 1
                FROM dbo.JobOfferingLocationUtcOffsetsV2 uo
                WHERE uo.DirectLocationV2Id = d.Id
                  AND ("""
            + " OR ".join(range_parts)
            + ")\n            )"
        )

    return " AND ".join(clauses), params


def _compile_group(catalog, arrangement: str, group: dict) -> tuple[str, list]:
    group_clauses = [ARRANGEMENT_SQL[arrangement]]
    params = []

    has_geo_criteria = bool(
        group["includeLocations"]
        or group["excludeLocations"]
        or group["utcOffsetRanges"]
    )
    if has_geo_criteria:
        branch_sql, branch_params = _compile_branch(catalog, arrangement, group)
        branch_exists = f"""EXISTS (
            SELECT 1
            FROM dbo.JobOfferingLocationsV2 d
            WHERE {branch_sql}
        )"""
        if group["allowUnknownLocation"]:
            group_clauses.append(
                "(" +
                "NOT EXISTS (SELECT 1 FROM dbo.JobOfferingLocationsV2 du WHERE du.JobOfferingId = j.Id)" +
                " OR " + branch_exists +
                ")"
            )
        else:
            group_clauses.append(branch_exists)
        params.extend(branch_params)

    excluded_work = group["excludeWorkTimeRanges"]
    if excluded_work:
        overlap_parts = []
        for value in excluded_work:
            overlap_parts.append(
                "(wt.OffsetRangeStartMinutes <= ? AND wt.OffsetRangeEndMinutes >= ?)"
            )
            params.extend([value["endMinutes"], value["startMinutes"]])
        group_clauses.append(
            """NOT EXISTS (
                SELECT 1
                FROM dbo.JobOfferingWorkTimeConstraintsV2 wt
                WHERE wt.JobOfferingId = j.Id
                  AND ("""
            + " OR ".join(overlap_parts)
            + ")\n            )"
        )

    return " AND ".join(f"({clause})" for clause in group_clauses), params


def compile_eligibility_sql(catalog, eligibility: dict | None) -> tuple[str, list]:
    """Compile validated criteria into SQL that uses indexed v2 facts."""
    if eligibility is None:
        return "1=1", []
    if not eligibility:
        return "1=0", []

    group_sql = []
    params = []
    for arrangement in ("remote", "hybrid", "onSite", "unknown"):
        group = eligibility.get(arrangement)
        if group is None:
            continue
        sql, group_params = _compile_group(catalog, arrangement, group)
        group_sql.append(f"({sql})")
        params.extend(group_params)
    return " OR ".join(group_sql) if group_sql else "1=0", params
