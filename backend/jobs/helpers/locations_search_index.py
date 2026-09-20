"""Read the generated Locations v2 selector index.

The selector index is presentation/search data only. Canonical Jobs matching and
storage continue to use the full Locations v2 catalog.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from functools import lru_cache
from pathlib import Path

from helpers.locations_v2 import SUPPORTED_KINDS


DEFAULT_INDEX_PATH = (
    Path(__file__).resolve().parents[1] / "reference" / "locations-v2.search.sqlite3"
)
DEFAULT_MANIFEST_PATH = (
    Path(__file__).resolve().parents[1] / "reference" / "locations-v2.catalog.manifest.json"
)


def _clean(value) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _search_key(value) -> str:
    return re.sub(r"[^\w]+", " ", _clean(value).casefold(), flags=re.UNICODE).strip()


def _prefix_high(value: str) -> str:
    return f"{value}\U0010ffff"


def index_path() -> Path:
    configured = _clean(os.getenv("LOCATIONS_V2_SEARCH_INDEX_PATH"))
    return Path(configured) if configured else DEFAULT_INDEX_PATH


def manifest_path() -> Path:
    configured = _clean(os.getenv("LOCATIONS_V2_CATALOG_MANIFEST_PATH"))
    return Path(configured) if configured else DEFAULT_MANIFEST_PATH


def _expected_catalog_version() -> str:
    path = manifest_path()
    if not path.is_file():
        raise FileNotFoundError(f"Locations v2 manifest not found at {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    version = _clean(payload.get("catalogVersion"))
    if not version:
        raise ValueError("Locations v2 manifest has no catalogVersion")
    return version


def _presentation(row: sqlite3.Row, catalog_version: str) -> dict:
    return {
        "kind": row["kind"],
        "locationId": row["location_id"],
        "displayName": row["display_name"],
        "adminRegionName": row["admin_region_name"],
        "countryCode": row["country_code"],
        "countryName": row["country_name"],
        "contextLabel": row["context_label"],
        "label": row["label"],
        "catalogVersion": catalog_version,
    }


class LocationsSearchIndex:
    """Open the packaged SQLite selector index in immutable read-only mode."""

    def __init__(self, path: Path, expected_catalog_version: str | None = None):
        self.path = Path(path)
        if not self.path.is_file():
            raise FileNotFoundError(
                f"Locations v2 search index not found at {self.path}. "
                "Build tools/build_locations_v2_catalog.py first."
            )
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM metadata WHERE key = 'catalogVersion'"
            ).fetchone()
        if row is None or not _clean(row[0]):
            raise ValueError("Locations v2 search index has no catalogVersion")
        self.catalog_version = _clean(row[0])
        if (
            expected_catalog_version
            and self.catalog_version != expected_catalog_version
        ):
            raise ValueError(
                "Locations v2 search index catalogVersion does not match the catalog manifest"
            )

    def _connect(self) -> sqlite3.Connection:
        uri = f"{self.path.resolve().as_uri()}?mode=ro&immutable=1"
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _candidate_query(term_count: int, exact_name: bool = False) -> str:
        search_predicate = "n.search_name = ?" if exact_name else (
            "n.search_name >= ? AND n.search_name < ?"
        )
        term_predicates = "".join(
            " AND instr(l.search_blob, ?) > 0" for _ in range(term_count)
        )
        return f"""
            SELECT l.*
            FROM names AS n
            INNER JOIN locations AS l
                ON l.location_id = n.location_id
            WHERE {search_predicate}
              {term_predicates}
            GROUP BY l.location_id
            ORDER BY l.population DESC, l.label, l.location_id
            LIMIT ?
        """

    def _search_prefix(
        self,
        conn: sqlite3.Connection,
        prefix: str,
        terms: list[str],
        limit: int,
    ) -> list[sqlite3.Row]:
        return list(
            conn.execute(
                self._candidate_query(len(terms)),
                [prefix, _prefix_high(prefix), *terms, limit],
            )
        )

    def search(self, query: str, limit: int = 8) -> list[dict]:
        query_key = _search_key(query)
        if not query_key:
            return []

        with self._connect() as conn:
            if len(query_key) == 2 and query_key.isalpha():
                row = conn.execute(
                    """
                    SELECT * FROM locations
                    WHERE kind = 'country' AND country_code = ?
                    LIMIT 1
                    """,
                    (query_key.upper(),),
                ).fetchone()
                return [_presentation(row, self.catalog_version)] if row else []

            if len(query_key) < 3:
                return []

            terms = query_key.split()
            candidate_limit = max(limit * 20, 80)
            ranked: dict[str, tuple[int, int, str, str, sqlite3.Row]] = {}

            exact_rows = conn.execute(
                self._candidate_query(len(terms), exact_name=True),
                [query_key, *terms, candidate_limit],
            )
            for row in exact_rows:
                ranked[row["location_id"]] = (
                    0,
                    -int(row["population"] or 0),
                    row["label"].casefold(),
                    row["location_id"],
                    row,
                )

            for row in self._search_prefix(conn, query_key, terms, candidate_limit):
                ranked.setdefault(
                    row["location_id"],
                    (
                        1,
                        -int(row["population"] or 0),
                        row["label"].casefold(),
                        row["location_id"],
                        row,
                    ),
                )

            # A hierarchy term can come before the place name (for example,
            # "Ontario London"). Anchor on every query term, then require all
            # terms in the prepared search text.
            for term in terms:
                if len(term) < 3:
                    continue
                for row in self._search_prefix(conn, term, terms, candidate_limit):
                    ranked.setdefault(
                        row["location_id"],
                        (
                            2,
                            -int(row["population"] or 0),
                            row["label"].casefold(),
                            row["location_id"],
                            row,
                        ),
                    )

        ordered = sorted(ranked.values(), key=lambda value: value[:4])[:limit]
        return [_presentation(value[4], self.catalog_version) for value in ordered]

    def lookup(self, selectors: list[tuple[str, str]]) -> tuple[list[dict], list[dict]]:
        items = []
        missing = []
        seen = set()
        with self._connect() as conn:
            for kind, location_id in selectors:
                key = (kind, location_id)
                if key in seen:
                    continue
                seen.add(key)
                if kind not in SUPPORTED_KINDS:
                    missing.append({"kind": kind, "locationId": location_id})
                    continue
                row = conn.execute(
                    "SELECT * FROM locations WHERE location_id = ? AND kind = ?",
                    (location_id, kind),
                ).fetchone()
                if row is None:
                    missing.append({"kind": kind, "locationId": location_id})
                    continue
                items.append(_presentation(row, self.catalog_version))
        return items, missing

    def coverage_preview(
        self,
        include_selectors: list[tuple[str, str]],
        exclude_selectors: list[tuple[str, str]],
        allow_unknown_location: bool,
    ) -> dict:
        """Return a country-level explanation of selector semantics."""
        include_keys = list(dict.fromkeys(include_selectors))
        exclude_keys = list(dict.fromkeys(exclude_selectors))
        contradiction = sorted(set(include_keys) & set(exclude_keys))
        if contradiction:
            raise ValueError(
                "The same location cannot be included and excluded: "
                f"{contradiction[0][1]}"
            )

        selected_keys = list(dict.fromkeys([*include_keys, *exclude_keys]))
        with self._connect() as conn:
            selected_rows: dict[tuple[str, str], sqlite3.Row] = {}
            for kind, location_id in selected_keys:
                if kind not in SUPPORTED_KINDS:
                    raise ValueError(f"Unsupported location kind: {kind}")
                row = conn.execute(
                    "SELECT * FROM locations WHERE location_id = ? AND kind = ?",
                    (location_id, kind),
                ).fetchone()
                if row is None:
                    raise ValueError(
                        f"Location is not in the current catalog: {kind}/{location_id}"
                    )
                selected_rows[(kind, location_id)] = row

            countries = list(
                conn.execute(
                    """
                    SELECT * FROM locations
                    WHERE kind = 'country'
                    ORDER BY display_name COLLATE NOCASE, location_id
                    """
                )
            )
            region_membership: dict[str, set[str]] = {}
            top_region_by_country: dict[str, str] = {}
            for relation in conn.execute(
                "SELECT country_id, region_id, is_top FROM country_regions"
            ):
                region_membership.setdefault(relation["country_id"], set()).add(
                    relation["region_id"]
                )
                if relation["is_top"]:
                    top_region_by_country[relation["country_id"]] = relation["region_id"]

            top_region_ids = sorted(set(top_region_by_country.values()))
            region_rows = {}
            for region_id in top_region_ids:
                row = conn.execute(
                    "SELECT * FROM locations WHERE location_id = ? AND kind = 'globalRegion'",
                    (region_id,),
                ).fetchone()
                if row is not None:
                    region_rows[region_id] = row

        include_rows = [selected_rows[key] for key in include_keys]
        exclude_rows = [selected_rows[key] for key in exclude_keys]
        include_is_open = not include_rows

        def applies_broadly(selector: sqlite3.Row, country: sqlite3.Row) -> bool:
            if selector["kind"] == "country":
                return selector["location_id"] == country["location_id"]
            if selector["kind"] == "globalRegion":
                return selector["location_id"] in region_membership.get(
                    country["location_id"], set()
                )
            return False

        def is_narrow_in_country(
            selector: sqlite3.Row, country: sqlite3.Row
        ) -> bool:
            return (
                selector["kind"] in {"adminRegion", "city"}
                and selector["country_code"] == country["country_code"]
            )

        grouped_regions: dict[str, dict] = {}
        counts = {"included": 0, "partial": 0, "excluded": 0}

        for country in countries:
            broad_include = include_is_open or any(
                applies_broadly(selector, country) for selector in include_rows
            )
            narrow_includes = [
                selector
                for selector in include_rows
                if is_narrow_in_country(selector, country)
            ]
            if not broad_include and not narrow_includes:
                continue

            broad_exclude = any(
                applies_broadly(selector, country) for selector in exclude_rows
            )
            narrow_excludes = [
                selector
                for selector in exclude_rows
                if is_narrow_in_country(selector, country)
            ]

            if broad_exclude:
                state = "excluded"
            elif broad_include and narrow_excludes:
                state = "partial"
            elif broad_include:
                state = "included"
            else:
                state = "partial"

            counts[state] += 1
            country_row = {
                "kind": "country",
                "locationId": country["location_id"],
                "displayName": country["display_name"],
                "countryCode": country["country_code"],
                "state": state,
                "includedPlaces": [
                    _presentation(selector, self.catalog_version)
                    for selector in narrow_includes
                ],
                "excludedPlaces": [
                    _presentation(selector, self.catalog_version)
                    for selector in narrow_excludes
                ],
            }

            region_id = top_region_by_country.get(country["location_id"], "other")
            if region_id not in grouped_regions:
                region = region_rows.get(region_id)
                grouped_regions[region_id] = {
                    "kind": "globalRegion" if region is not None else "other",
                    "locationId": region_id if region is not None else None,
                    "displayName": (
                        region["display_name"] if region is not None else "Other"
                    ),
                    "countries": [],
                }
            grouped_regions[region_id]["countries"].append(country_row)

        regions = list(grouped_regions.values())
        for region in regions:
            region["countries"].sort(
                key=lambda item: (item["displayName"].casefold(), item["locationId"])
            )
            region["counts"] = {
                state: sum(
                    1 for item in region["countries"] if item["state"] == state
                )
                for state in ("included", "partial", "excluded")
            }
        regions.sort(key=lambda item: item["displayName"].casefold())

        return {
            "catalogVersion": self.catalog_version,
            "includeMode": (
                "allKnownLocations" if include_is_open else "selectedLocations"
            ),
            "includeRules": [
                _presentation(row, self.catalog_version) for row in include_rows
            ],
            "excludeRules": [
                _presentation(row, self.catalog_version) for row in exclude_rows
            ],
            "allowUnknownLocation": bool(allow_unknown_location),
            "counts": {
                **counts,
                "considered": counts["included"] + counts["partial"],
            },
            "regions": regions,
        }


@lru_cache(maxsize=1)
def load_locations_search_index() -> LocationsSearchIndex:
    return LocationsSearchIndex(index_path(), _expected_catalog_version())
