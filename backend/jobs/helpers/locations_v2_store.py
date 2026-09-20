"""Persistence helpers for native and migrated Locations v2 data."""

from __future__ import annotations

from helpers.ids import normalize_guid


def canonicalize_locations_v2(catalog, locations: list[dict]) -> list[dict]:
    """Validate canonical location IDs and derive stored metadata."""
    result = []
    seen = set()
    for index, value in enumerate(locations):
        kind = str(value.get("kind") or "").strip()
        location_id = str(value.get("locationId") or "").strip()
        item = catalog.get_location(kind, location_id)
        if item is None:
            raise ValueError(
                f"locationsV2[{index}] is not a valid canonical {kind or 'location'} identifier"
            )
        key = (item["kind"], item["id"])
        if key in seen:
            continue
        seen.add(key)
        result.append(
            {
                "kind": item["kind"],
                "locationId": item["id"],
                "displayName": item["name"],
                "countryCode": item.get("countryCode"),
                "catalogItem": item,
            }
        )
    return result


def normalize_work_time_constraints_v2(rows: list[dict]) -> list[dict]:
    """Return unique work-time ranges in stable order."""
    unique = {
        (
            int(row["offsetRangeStartMinutes"]),
            int(row["offsetRangeEndMinutes"]),
        )
        for row in rows
    }
    return [
        {
            "offsetRangeStartMinutes": start,
            "offsetRangeEndMinutes": end,
        }
        for start, end in sorted(unique)
    ]


def _insert_direct_branch(cur, catalog, job_id: str, row: dict, source_location_v1_id=None) -> None:
    cur.execute(
        """
        INSERT INTO dbo.JobOfferingLocationsV2 (
            JobOfferingId,
            LocationKind,
            LocationId,
            DisplayName,
            CountryCode,
            SourceLocationV1Id,
            CatalogVersion
        )
        OUTPUT Inserted.Id
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id,
            row["kind"],
            row["locationId"],
            row["displayName"],
            row.get("countryCode"),
            source_location_v1_id,
            catalog.catalog_version,
        ),
    )
    direct_id = int(cur.fetchone()[0])

    item = row.get("catalogItem") or catalog.get_location(row["kind"], row["locationId"])
    if item is None:
        raise ValueError(f"Unknown canonical location: {row['kind']}:{row['locationId']}")

    facts = catalog.facts_for_location(item)
    if facts:
        cur.fast_executemany = True
        cur.executemany(
            """
            INSERT INTO dbo.JobOfferingLocationFactsV2 (
                DirectLocationV2Id,
                LocationKind,
                LocationId
            )
            VALUES (?, ?, ?)
            """,
            [(direct_id, kind, location_id) for kind, location_id in facts],
        )

    offsets = catalog.utc_offsets_for_location(item)
    if offsets:
        cur.fast_executemany = True
        cur.executemany(
            """
            INSERT INTO dbo.JobOfferingLocationUtcOffsetsV2 (
                DirectLocationV2Id,
                UtcOffsetMinutes
            )
            VALUES (?, ?)
            """,
            [(direct_id, offset) for offset in offsets],
        )


def replace_native_locations_v2(cur, catalog, job_id: str, locations: list[dict]) -> list[dict]:
    """Replace one job's direct v2 geography from authoritative native input."""
    canonical = canonicalize_locations_v2(catalog, locations)
    cur.execute("DELETE FROM dbo.JobOfferingLocationsV2 WHERE JobOfferingId = ?", (job_id,))
    for row in canonical:
        _insert_direct_branch(cur, catalog, job_id, row, source_location_v1_id=None)
    return canonical


def replace_legacy_projection_v2(cur, catalog, job_id: str, projection: dict) -> None:
    """Replace a legacy-generated v2 projection with branch-aware facts."""
    cur.execute("DELETE FROM dbo.JobOfferingLocationsV2 WHERE JobOfferingId = ?", (job_id,))
    for branch in projection.get("branches", []):
        direct = branch["direct"]
        row = {
            **direct,
            "catalogItem": catalog.get_location(direct["kind"], direct["locationId"]),
        }
        _insert_direct_branch(
            cur,
            catalog,
            job_id,
            row,
            source_location_v1_id=direct.get("sourceLocationV1Id"),
        )


def replace_work_time_constraints_v2(cur, job_id: str, rows: list[dict]) -> list[dict]:
    """Replace explicit work-time constraints for one job."""
    normalized = normalize_work_time_constraints_v2(rows)
    cur.execute("DELETE FROM dbo.JobOfferingWorkTimeConstraintsV2 WHERE JobOfferingId = ?", (job_id,))
    if normalized:
        cur.fast_executemany = True
        cur.executemany(
            """
            INSERT INTO dbo.JobOfferingWorkTimeConstraintsV2 (
                JobOfferingId,
                OffsetRangeStartMinutes,
                OffsetRangeEndMinutes
            )
            VALUES (?, ?, ?)
            """,
            [
                (
                    job_id,
                    row["offsetRangeStartMinutes"],
                    row["offsetRangeEndMinutes"],
                )
                for row in normalized
            ],
        )
    return normalized


def _read_location_v2(row, catalog=None) -> dict:
    result = {
        "kind": row[0],
        "locationId": row[1],
        "displayName": row[2],
        "countryCode": row[3],
        "catalogVersion": row[4],
    }
    if catalog is None:
        return result
    item = catalog.get_location(row[0], row[1])
    if item is None:
        return result
    presentation = catalog.location_presentation(item)
    presentation["catalogVersion"] = row[4]
    return presentation


def fetch_locations_v2(cur, job_id: str, catalog=None) -> list[dict]:
    cur.execute(
        """
        SELECT LocationKind, LocationId, DisplayName, CountryCode, CatalogVersion
        FROM dbo.JobOfferingLocationsV2
        WHERE JobOfferingId = ?
        ORDER BY LocationKind, DisplayName, LocationId
        """,
        (job_id,),
    )
    return [_read_location_v2(row, catalog) for row in cur.fetchall()]


def fetch_work_time_constraints_v2(cur, job_id: str) -> list[dict]:
    cur.execute(
        """
        SELECT OffsetRangeStartMinutes, OffsetRangeEndMinutes
        FROM dbo.JobOfferingWorkTimeConstraintsV2
        WHERE JobOfferingId = ?
        ORDER BY OffsetRangeStartMinutes, OffsetRangeEndMinutes
        """,
        (job_id,),
    )
    return [
        {
            "offsetRangeStartMinutes": int(row[0]),
            "offsetRangeEndMinutes": int(row[1]),
        }
        for row in cur.fetchall()
    ]


def fetch_locations_v2_map(cur, job_ids: list[str], catalog=None) -> dict[str, list[dict]]:
    result = {job_id: [] for job_id in job_ids}
    if not job_ids:
        return result
    placeholders = ",".join(["?"] * len(job_ids))
    cur.execute(
        f"""
        SELECT JobOfferingId, LocationKind, LocationId, DisplayName, CountryCode, CatalogVersion
        FROM dbo.JobOfferingLocationsV2
        WHERE JobOfferingId IN ({placeholders})
        ORDER BY JobOfferingId, LocationKind, DisplayName, LocationId
        """,
        job_ids,
    )
    for row in cur.fetchall():
        job_id = normalize_guid(str(row[0]))
        result.setdefault(job_id, []).append(
            _read_location_v2((row[1], row[2], row[3], row[4], row[5]), catalog)
        )
    return result


def fetch_work_time_constraints_v2_map(cur, job_ids: list[str]) -> dict[str, list[dict]]:
    result = {job_id: [] for job_id in job_ids}
    if not job_ids:
        return result
    placeholders = ",".join(["?"] * len(job_ids))
    cur.execute(
        f"""
        SELECT JobOfferingId, OffsetRangeStartMinutes, OffsetRangeEndMinutes
        FROM dbo.JobOfferingWorkTimeConstraintsV2
        WHERE JobOfferingId IN ({placeholders})
        ORDER BY JobOfferingId, OffsetRangeStartMinutes, OffsetRangeEndMinutes
        """,
        job_ids,
    )
    for row in cur.fetchall():
        job_id = normalize_guid(str(row[0]))
        result.setdefault(job_id, []).append(
            {
                "offsetRangeStartMinutes": int(row[1]),
                "offsetRangeEndMinutes": int(row[2]),
            }
        )
    return result
