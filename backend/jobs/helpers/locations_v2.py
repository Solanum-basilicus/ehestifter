"""Load and query the canonical Locations v2 catalog.

The module supports legacy projection, Jobs validation, presentation, and the
manual canonical-location selector.
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
LEGACY_COUNTRY_NAME_TO_CODE = {
    "usa": "US",
    "deutschland": "DE",
}
LEGACY_WORLD_NAMES = {"global", "world", "worldwide", "remote - global"}


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
        name = _clean(country_name)
        name_key = _key(name)

        if code == "EU" or name_key in {"eu", "european union"}:
            return self.by_id.get("m49:150")
        if name_key in LEGACY_WORLD_NAMES:
            return self.by_id.get("m49:001")
        if len(code) == 2 and code in self.countries_by_code:
            return self.countries_by_code[code]

        # Legacy rows sometimes store the country code in CountryName.
        name_as_code = name.upper()
        if len(name_as_code) == 2 and name_as_code in self.countries_by_code:
            return self.countries_by_code[name_as_code]

        # Accept punctuation around legacy code-like names such as U.S.A.
        compact_name = re.sub(r"[^A-Z]", "", name.upper())
        mapped_code = LEGACY_COUNTRY_NAME_TO_CODE.get(compact_name.casefold())
        if mapped_code is None:
            mapped_code = LEGACY_COUNTRY_NAME_TO_CODE.get(name_key)
        if mapped_code and mapped_code in self.countries_by_code:
            return self.countries_by_code[mapped_code]

        candidates = self.country_aliases.get(name_key, set())
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

    def get_location(self, kind: str, location_id: str) -> dict | None:
        item = self.by_id.get(_clean(location_id))
        if item is None or item.get("kind") != kind:
            return None
        return item

    def country_display_name(self, country_code: str | None) -> str | None:
        country = self.countries_by_code.get(_clean(country_code).upper())
        if country is None:
            return None
        aliases = [_clean(value) for value in country.get("aliases", []) if _clean(value)]
        if aliases:
            return min(aliases, key=lambda value: (len(value), value.casefold()))
        return _clean(country.get("name")) or None

    def location_presentation(self, item: dict) -> dict:
        """Return human-readable catalog data for one canonical location."""
        kind = item["kind"]
        display_name = _clean(item.get("name"))
        country_code = _clean(item.get("countryCode")).upper() or None
        country_name = self.country_display_name(country_code)
        admin_region_name = None

        if kind == "city":
            admin = self.by_id.get(item.get("admin1Id") or item.get("parentId"))
            if admin and admin.get("kind") == "adminRegion":
                admin_region_name = _clean(admin.get("name")) or None
        elif kind == "adminRegion":
            admin_region_name = display_name or None

        if kind == "country" and country_name:
            display_name = country_name

        context_parts = []
        if kind == "city" and admin_region_name:
            context_parts.append(admin_region_name)
        if kind in {"city", "adminRegion"} and country_name:
            context_parts.append(country_name)
        if kind == "globalRegion":
            parent = self.by_id.get(item.get("parentId"))
            if parent and parent.get("id") != "m49:001":
                context_parts.append(_clean(parent.get("name")))

        label_parts = [display_name]
        label_parts.extend(part for part in context_parts if part and part != display_name)
        return {
            "kind": kind,
            "locationId": item["id"],
            "displayName": display_name,
            "adminRegionName": admin_region_name,
            "countryCode": country_code,
            "countryName": country_name,
            "contextLabel": " · ".join(context_parts),
            "label": ", ".join(part for part in label_parts if part),
            "catalogVersion": self.catalog_version,
        }

    def facts_for_location(self, location: dict) -> list[tuple[str, str]]:
        facts = {(location["kind"], location["id"])}
        for ancestor_id in location.get("ancestors", []):
            ancestor = self.by_id.get(ancestor_id)
            if ancestor:
                facts.add((ancestor["kind"], ancestor["id"]))
        return sorted(facts)

    def facts_for(self, direct_locations: Iterable[dict]) -> list[tuple[str, str]]:
        facts: set[tuple[str, str]] = set()
        for location in direct_locations:
            facts.update(self.facts_for_location(location))
        return sorted(facts)

    def utc_offsets_for_location(self, location: dict) -> list[int]:
        return sorted({int(offset) for offset in location.get("utcOffsets", [])})

    def utc_offsets_for(self, direct_locations: Iterable[dict]) -> list[int]:
        offsets = {
            offset
            for location in direct_locations
            for offset in self.utc_offsets_for_location(location)
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

    sorted_direct = sorted(
        direct_by_key.values(),
        key=lambda value: (value[0]["kind"], value[0]["id"]),
    )
    direct = [value[0] for value in sorted_direct]
    direct_rows = []
    branches = []
    for item, source_id in sorted_direct:
        direct_row = {
            "kind": item["kind"],
            "locationId": item["id"],
            "displayName": item["name"],
            "countryCode": item.get("countryCode"),
            "sourceLocationV1Id": source_id,
        }
        direct_rows.append(direct_row)
        branches.append({
            "direct": direct_row,
            "facts": catalog.facts_for_location(item),
            "utcOffsets": catalog.utc_offsets_for_location(item),
        })

    return {
        "direct": direct_rows,
        "branches": branches,
        # Keep aggregate values for diagnostics and compatibility with issue #20 tests.
        "facts": catalog.facts_for(direct),
        "utcOffsets": catalog.utc_offsets_for(direct),
        "branchFactCount": sum(len(branch["facts"]) for branch in branches),
        "branchUtcOffsetCount": sum(len(branch["utcOffsets"]) for branch in branches),
        "sourceCount": len(rows),
        "unresolvedCount": sum(1 for item in projections if item.direct_location is None),
        "fallbackCount": sum(1 for item in projections if item.is_fallback),
    }
