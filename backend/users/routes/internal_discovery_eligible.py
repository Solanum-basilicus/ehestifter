from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

import azure.functions as func

from helpers.db import get_connection
from helpers.discovery_filters import normalize_discovery_profile
from helpers.discovery_readiness import (
    build_discovery_readiness,
    parse_stored_discovery_preferences,
)
from helpers.blob_storage import download_texts
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
        """Return bounded discovery profiles and Users-owned readiness state.

        CV text and blob paths intentionally never cross this API boundary.
        Users checks the current CV plaintext and positive title rules before
        ATS Discovery can enable matching for a user.
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
                WITH BoundedUsers AS (
                    SELECT TOP ({limit})
                        u.Id,
                        p.CVVersionId,
                        p.CVTextBlobPath,
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
                    INNER JOIN BoundedUsers AS u
                        ON u.Id = f.UserId
                )
                SELECT
                    u.Id,
                    u.CVVersionId,
                    u.CVTextBlobPath,
                    u.LastUpdated,
                    f.Id,
                    f.NormalizedJson,
                    dp.PreferencesJson,
                    dp.LastUpdated
                FROM BoundedUsers AS u
                LEFT JOIN RankedFilters AS f
                    ON f.UserId = u.Id
                   AND f.FilterRank <= 20
                LEFT JOIN dbo.UserDiscoveryPreferences AS dp
                    ON dp.UserId = u.Id
                ORDER BY u.Id, f.FilterRank
                """
            )

            users_by_id: dict[str, dict] = {}
            for row in cursor.fetchall():
                user_id = normalize_guid(row[0])
                if user_id.lower() in excluded:
                    excluded_actual.add(user_id.lower())
                    continue
                user = users_by_id.get(user_id)
                if user is None:
                    discovery_preferences, discovery_preferences_invalid = (
                        parse_stored_discovery_preferences(row[6])
                    )
                    user = {
                        "userId": user_id,
                        "cvVersionId": str(row[1]).strip(),
                        "_cvTextBlobPath": row[2],
                        "cvLastUpdatedUtc": _iso(row[3]),
                        "hasSavedFilters": False,
                        "profiles": [],
                        "invalidProfileCount": 0,
                        "discoveryPreferences": discovery_preferences,
                        "discoveryPreferencesInvalid": discovery_preferences_invalid,
                        "discoveryPreferencesLastUpdatedUtc": _iso(row[7]),
                    }
                    users_by_id[user_id] = user
                filter_id = row[4]
                if filter_id is None:
                    continue
                user["hasSavedFilters"] = True
                profile = normalize_discovery_profile(filter_id, row[5])
                if profile is None:
                    user["invalidProfileCount"] += 1
                    continue
                user["profiles"].append(profile)

            users = sorted(users_by_id.values(), key=lambda item: item["userId"])
            cv_texts = download_texts(
                [user["_cvTextBlobPath"] for user in users]
            )
            for user in users:
                cv_path = user.pop("_cvTextBlobPath")
                cv_plain_text = cv_texts.get(cv_path)
                user["discoveryEligibility"] = build_discovery_readiness(
                    cv_plain_text=cv_plain_text,
                    discovery_preferences=user["discoveryPreferences"],
                    discovery_preferences_invalid=user["discoveryPreferencesInvalid"],
                )

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
                    "invalidDiscoveryPreferences": sum(
                        1 for user in users if user["discoveryPreferencesInvalid"]
                    ),
                    "discoveryEnabled": sum(
                        1 for user in users if user["discoveryEligibility"]["enabled"]
                    ),
                    "disabledNoUsableCv": sum(
                        1 for user in users
                        if "no_usable_cv" in user["discoveryEligibility"]["reasons"]
                    ),
                    "disabledNoPositiveTitle": sum(
                        1 for user in users
                        if "no_positive_title" in user["discoveryEligibility"]["reasons"]
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
