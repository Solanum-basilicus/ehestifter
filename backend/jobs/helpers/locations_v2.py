"""Locations v2 catalog loading and legacy location projection.

Locations v1 stays authoritative until issue #21. This module is used only by
the additive backfill endpoint in issue #20.
"""

from __future__ import annotations

import gzip
import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable


DEFAULT_CATALOG_PATH = Path(__file__).resolve().parents[1] / "reference" / "locations-v2.catalog.json.gz"
SUPPORTED_KINDS = {"city", "adminRegion", "country", "globalRegion"}


def _clean(value) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _key(value) -> str:
    return _clean(value).casefold()


@dataclass(frozen=True)
class LegacyProjection:
    source_location_id: int | None
    requested_level: str
    resolved_level: str | None
    direct_location: dict | None

    @property
    def is_fallback(self) -> bool:
        return self.direct_location is not None and self.requested_level != self.resolved_level


class LocationsV2Catalog:
    def __init__(self, payload: dict):
        if payload.get("schemaVersion") != 2:
            raise ValueError("Locations v2 catalog has an unsupported schema version")
        version = _clean(payload.get("catalogVersion"))
        if not version:
            raise ValueError("Locations v2 catalog has no catalogVersion")

        self.catalog_version = version
        self.reference_year = payload.get("referenceYear")
        self.by_id: dict[str, dict] = {}
        self.countries_by_code: dict[str, dict] = {}
        self.country_aliases: dict[str, set[str]] = {}
        self.admin_by_country_name: dict[tuple[str, str], list[dict]] = {}
        self.city_by_country_name: dict[tuple[str, str], list[dict]] = {}

        for collection_name in ("regions", "countries", "adminRegions", "cities"):
            for item in payload.get(collection_name, []):
                location_id = _clean(item.get("id"))
                kind = item.get("kind")
                if not location_id or kind not in SUPPORTED_KINDS:
                    raise ValueError(f"Invalid Locations v2 catalog item in {collection_name}")
                if location_id in self.by_id:
                    raise ValueError(f"Duplicate Locations v2 id: {location_id}")
                self.by_id[location_id] = item

        for country in payload.get("countries", []):
            code = _clean(country.get("countryCode")).upper()
            if len(code) != 2:
                continue
            self.countries_by_code[code] = country
            names = {_key(country.get("name"))}
            names.update(_key(alias) for alias in country.get("aliases", []))
            for name in names:
                if name:
                    self.country_aliases.setdefault(name, set()).add(code)

        for admin in payload.get("adminRegions", []):
            code = _clean(admin.get("countryCode")).upper()
            for name in _names(admin):
                self.admin_by_country_name.setdefault((code, name), []).append(admin)

        for city in payload.get("cities", []):
            code = _clean(city.get("countryCode")).upper()
            for name in _names(city):
                self.city_by_country_name.setdefault((code, name), []).append(city)

    def resolve_country(self, country_code: str | None, country_name: str | None) -> dict | None:
        code = _clean(country_code).upper()
        if code == "EU" or _key(country_name) == "european union":
            return self.by_id.get("m49:150")
        if len(code) == 2 and code in self.countries_by_code:
            return self.countries_by_code[code]

        candidates = self.country_aliases.get(_key(country_name), set())
        if len(candidates) == 1:
            return self.countries_by_code[next(iter(candidates))]
        return None

    def resolve_admin(self, country_code: str, region_name: str | None) -> dict | None:
        candidates = self.admin_by_country_name.get((country_code, _key(region_name)), [])
        return candidates[0] if len(candidates) == 1 else None

    def resolve_city(
        self,
        country_code: str,
        city_name: str | None,
        admin_id: str | None = None,
    ) -> dict | None:
        candidates = self.city_by_country_name.get((country_code, _key(city_name)), [])
        if admin_id:
            candidates = [item for item in candidates if item.get("admin1Id") == admin_id]
        return candidates[0] if len(candidates) == 1 else None

    def project_legacy_location(self, location: dict) -> LegacyProjection:
        source_id = location.get("id")
        city_name = _clean(location.get("cityName"))
        region_name = _clean(location.get("region"))
        requested_level = "city" if city_name else "adminRegion" if region_name else "country"

        country = self.resolve_country(location.get("countryCode"), location.get("countryName"))
        if country is None:
            return LegacyProjection(source_id, requested_level, None, None)

        if country.get("kind") == "globalRegion":
            return LegacyProjection(source_id, requested_level, "globalRegion", country)

        country_code = country["countryCode"]
        admin = self.resolve_admin(country_code, region_name) if region_name else None
        city = self.resolve_city(country_code, city_name, admin.get("id") if admin else None) if city_name else None

        if city is not None:
            return LegacyProjection(source_id, requested_level, "city", city)
        if admin is not None:
            return LegacyProjection(source_id, requested_level, "adminRegion", admin)
        return LegacyProjection(source_id, requested_level, "country", country)

    def facts_for(self, direct_locations: Iterable[dict]) -> list[tuple[str, str]]:
        facts: set[tuple[str, str]] = set()
        for location in direct_locations:
            facts.add((location["kind"], location["id"]))
            for ancestor_id in location.get("ancestors", []):
                ancestor = self.by_id.get(ancestor_id)
                if ancestor:
                    facts.add((ancestor["kind"], ancestor["id"]))
        return sorted(facts)

    def utc_offsets_for(self, direct_locations: Iterable[dict]) -> list[int]:
        offsets = {
            int(offset)
            for location in direct_locations
            for offset in location.get("utcOffsets", [])
        }
        return sorted(offsets)


def _names(item: dict) -> set[str]:
    names = {_key(item.get("name"))}
    names.update(_key(alias) for alias in item.get("aliases", []))
    return {name for name in names if name}


def catalog_path() -> Path:
    configured = _clean(os.getenv("LOCATIONS_V2_CATALOG_PATH"))
    return Path(configured) if configured else DEFAULT_CATALOG_PATH


@lru_cache(maxsize=1)
def load_locations_v2_catalog() -> LocationsV2Catalog:
    path = catalog_path()
    if not path.is_file():
        raise FileNotFoundError(
            f"Locations v2 catalog not found at {path}. Build tools/build_locations_v2_catalog.py first."
        )
    with gzip.open(path, "rt", encoding="utf-8") as source:
        payload = json.load(source)
    return LocationsV2Catalog(payload)


def project_legacy_locations(catalog: LocationsV2Catalog, rows: list[dict]) -> dict:
    projections = [catalog.project_legacy_location(row) for row in rows]

    # One job can have duplicate v1 rows that collapse to the same canonical place.
    # Keep the lowest source id only as migration provenance.
    direct_by_key: dict[tuple[str, str], tuple[dict, int | None]] = {}
    for projection in projections:
        direct = projection.direct_location
        if direct is None:
            continue
        key = (direct["kind"], direct["id"])
        source_id = projection.source_location_id
        existing = direct_by_key.get(key)
        if existing is None:
            direct_by_key[key] = (direct, source_id)
        elif source_id is not None and (existing[1] is None or source_id < existing[1]):
            direct_by_key[key] = (direct, source_id)

    direct = [value[0] for value in direct_by_key.values()]
    direct_rows = [
        {
            "kind": item["kind"],
            "locationId": item["id"],
            "displayName": item["name"],
            "countryCode": item.get("countryCode"),
            "sourceLocationV1Id": source_id,
        }
        for item, source_id in sorted(
            direct_by_key.values(),
            key=lambda value: (value[0]["kind"], value[0]["id"]),
        )
    ]

    return {
        "direct": direct_rows,
        "facts": catalog.facts_for(direct),
        "utcOffsets": catalog.utc_offsets_for(direct),
        "sourceCount": len(rows),
        "unresolvedCount": sum(1 for item in projections if item.direct_location is None),
        "fallbackCount": sum(1 for item in projections if item.is_fallback),
    }
