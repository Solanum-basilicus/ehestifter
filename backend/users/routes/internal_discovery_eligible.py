from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

import azure.functions as func

from helpers.db import get_connection
from helpers.discovery_filters import normalize_discovery_profile
from helpers.guid import normalize_guid


def _excluded_user_ids() -> set[str]:
    raw = os.getenv("DISCOVERY_EXCLUDED_USER_IDS", "")
    output: set[str] = set()
    for token in raw.replace(";", ",").split(","):
        value = token.strip()
        if not value:
            continue
        try:
            output.add(normalize_guid(value).lower())
        except Exception:
            logging.warning(
                "Ignoring invalid DISCOVERY_EXCLUDED_USER_IDS value"
            )
    return output


def _iso(value):
    if value is None:
        return None
    try:
        if isinstance(value, datetime) and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    except Exception:
        return str(value)


def _limit(req: func.HttpRequest) -> int:
    raw = (req.params or {}).get("limit", "100")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValueError("limit must be an integer")
    if value <= 0 or value > 1000:
        raise ValueError("limit must be between 1 and 1000")
    return value


def register(app: func.FunctionApp):
    @app.route(
        route="users/internal/discovery-eligible",
        methods=["GET"],
        auth_level=func.AuthLevel.FUNCTION,
    )
    def get_discovery_eligible_users(req: func.HttpRequest) -> func.HttpResponse:
        """Return bounded discovery profiles for users with an available CV.

        CV text and blob paths intentionally never cross this API boundary.
        A user with no saved filters receives a match-all default profile in
        the scanner. A user whose saved filters are all malformed remains
        visible with ``hasSavedFilters=true`` and no valid profiles, allowing
        the scanner to fail closed for that user.
        """

        logging.info("USERS/internal/discovery-eligible processed a request")
        try:
            limit = _limit(req)
        except ValueError as exc:
            return func.HttpResponse(str(exc), status_code=400)

        conn = None
        try:
            excluded = _excluded_user_ids()
            excluded_actual: set[str] = set()
            conn = get_connection()
            cursor = conn.cursor()
            cursor.execute(
                f"""
                WITH EligibleUsers AS (
                    SELECT TOP ({limit})
                        u.Id,
                        p.CVVersionId,
                        p.LastUpdated
                    FROM dbo.Users AS u
                    INNER JOIN dbo.UserPreferences AS p
                        ON p.UserId = u.Id
                    WHERE p.CVTextBlobPath IS NOT NULL
                      AND LTRIM(RTRIM(p.CVTextBlobPath)) <> ''
                      AND p.CVVersionId IS NOT NULL
                      AND LTRIM(RTRIM(p.CVVersionId)) <> ''
                    ORDER BY u.Id
                ),
                RankedFilters AS (
                    SELECT
                        f.Id,
                        f.UserId,
                        f.NormalizedJson,
                        ROW_NUMBER() OVER (
                            PARTITION BY f.UserId
                            ORDER BY f.CreatedAt DESC, f.Id DESC
                        ) AS FilterRank
                    FROM dbo.UserPreferenceFilters AS f
                    INNER JOIN EligibleUsers AS u
                        ON u.Id = f.UserId
                )
                SELECT
                    u.Id,
                    u.CVVersionId,
                    u.LastUpdated,
                    f.Id,
                    f.NormalizedJson
                FROM EligibleUsers AS u
                LEFT JOIN RankedFilters AS f
                    ON f.UserId = u.Id
                   AND f.FilterRank <= 20
                ORDER BY u.Id, f.FilterRank
                """
            )

            users_by_id: dict[str, dict] = {}
            for row in cursor.fetchall():
                user_id = normalize_guid(row[0])
                if user_id.lower() in excluded:
                    excluded_actual.add(user_id.lower())
                    continue
                user = users_by_id.setdefault(
                    user_id,
                    {
                        "userId": user_id,
                        "cvVersionId": str(row[1]).strip(),
                        "cvLastUpdatedUtc": _iso(row[2]),
                        "hasSavedFilters": False,
                        "profiles": [],
                        "invalidProfileCount": 0,
                    },
                )
                filter_id = row[3]
                if filter_id is None:
                    continue
                user["hasSavedFilters"] = True
                profile = normalize_discovery_profile(filter_id, row[4])
                if profile is None:
                    user["invalidProfileCount"] += 1
                    continue
                user["profiles"].append(profile)

            users = sorted(users_by_id.values(), key=lambda item: item["userId"])
            payload = {
                "schemaVersion": 1,
                "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
                "users": users,
                "counts": {
                    "eligible": len(users),
                    "withSavedFilters": sum(
                        1 for user in users if user["hasSavedFilters"]
                    ),
                    "withValidProfiles": sum(
                        1 for user in users if user["profiles"]
                    ),
                    "invalidProfiles": sum(
                        user["invalidProfileCount"] for user in users
                    ),
                    "excluded": len(excluded_actual),
                    "excludedConfigured": len(excluded),
                    "limit": limit,
                },
            }
            return func.HttpResponse(
                json.dumps(payload),
                status_code=200,
                mimetype="application/json",
            )
        except Exception as exc:
            logging.exception("USERS/discovery-eligible failed")
            return func.HttpResponse(
                f"Error: {str(exc)}",
                status_code=500,
            )
        finally:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass
