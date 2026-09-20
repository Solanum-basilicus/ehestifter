#!/usr/bin/env python3
"""Build the canonical Locations v2 catalog.

The catalog is reference data. Runtime services must not call GeoNames or UN M49.
This tool can download official source files, or it can read local source files for
repeatable builds and tests.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import re
import sqlite3
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from importlib import metadata
from pathlib import Path
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


SCHEMA_VERSION = 2
BUILD_VERSION = 1
GEONAMES_CITIES500_URL = "https://download.geonames.org/export/dump/cities500.zip"
GEONAMES_ADMIN1_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"
GEONAMES_TIMEZONES_URL = "https://download.geonames.org/export/dump/timeZones.txt"
M49_OVERVIEW_URL = "https://unstats.un.org/unsd/methodology/m49/overview"
LEGACY_GEO_DEFAULT = Path("backend/core/static/data/geo.sample8.json")
CATALOG_DEFAULT = Path("backend/jobs/reference/locations-v2.catalog.json.gz")
MANIFEST_DEFAULT = Path("backend/jobs/reference/locations-v2.catalog.manifest.json")
SEARCH_INDEX_DEFAULT = Path("backend/jobs/reference/locations-v2.search.sqlite3")


class M49TableParser(HTMLParser):
    """Extract HTML table rows without an external HTML dependency."""

    def __init__(self) -> None:
        super().__init__()
        self.tables: list[list[list[str]]] = []
        self._table: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "table":
            self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell = []

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._cell is not None and self._row is not None:
            self._row.append(_clean_text("".join(self._cell)))
            self._cell = None
        elif tag == "tr" and self._row is not None and self._table is not None:
            if any(self._row):
                self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            if self._table:
                self.tables.append(self._table)
            self._table = None


def _clean_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def _lookup_key(value: str | None) -> str:
    return _clean_text(value).casefold()


def _source_bytes(path: str | None, url: str) -> tuple[bytes, str]:
    if path:
        source_path = Path(path)
        return source_path.read_bytes(), str(source_path)

    request = Request(url, headers={"User-Agent": "Ehestifter-LocationsV2/1.0"})
    with urlopen(request, timeout=120) as response:
        return response.read(), url


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _parse_m49(data: bytes) -> tuple[list[dict], dict[str, dict]]:
    text = data.decode("utf-8-sig")
    stripped = text.lstrip()

    if stripped.startswith("Global Code"):
        reader = csv.DictReader(io.StringIO(text), delimiter=";")
        rows = [{key: _clean_text(value) for key, value in row.items()} for row in reader]
    else:
        parser = M49TableParser()
        parser.feed(text)
        selected = None
        for table in parser.tables:
            if not table:
                continue
            header = table[0]
            if "Global Code" in header and "ISO-alpha2 Code" in header:
                selected = table
                break
        if selected is None:
            raise ValueError("Could not find the English UN M49 table")
        header = selected[0]
        rows = []
        for cells in selected[1:]:
            if len(cells) < len(header):
                cells = cells + [""] * (len(header) - len(cells))
            row = dict(zip(header, cells[: len(header)]))
            if row.get("Global Code") == "001" and row.get("M49 Code"):
                rows.append(row)

    regions: dict[str, dict] = {}
    countries: dict[str, dict] = {}

    def add_region(code: str, name: str, parent_id: str | None) -> str | None:
        code = _clean_text(code)
        name = _clean_text(name)
        if not code or not name:
            return None
        location_id = f"m49:{code}"
        existing = regions.get(location_id)
        value = {
            "id": location_id,
            "kind": "globalRegion",
            "name": name,
            "parentId": parent_id,
        }
        if existing is not None and existing != value:
            raise ValueError(f"Conflicting M49 region definition for {location_id}")
        regions[location_id] = value
        return location_id

    for row in rows:
        global_id = add_region(row.get("Global Code", ""), row.get("Global Name", ""), None)
        region_id = add_region(row.get("Region Code", ""), row.get("Region Name", ""), global_id)
        subregion_id = add_region(
            row.get("Sub-region Code", ""), row.get("Sub-region Name", ""), region_id or global_id
        )
        intermediate_id = add_region(
            row.get("Intermediate Region Code", ""),
            row.get("Intermediate Region Name", ""),
            subregion_id or region_id or global_id,
        )

        code = _clean_text(row.get("ISO-alpha2 Code", "")).upper()
        if len(code) != 2:
            continue
        parent_id = intermediate_id or subregion_id or region_id or global_id
        countries[code] = {
            "id": f"iso3166:{code}",
            "kind": "country",
            "name": _clean_text(row.get("Country or Area", "")),
            "countryCode": code,
            "m49Code": _clean_text(row.get("M49 Code", "")),
            "parentId": parent_id,
            "aliases": [],
        }

    if "m49:001" not in regions:
        raise ValueError("UN M49 source does not contain World (001)")

    return sorted(regions.values(), key=lambda item: item["id"]), countries


def _parse_legacy_country_aliases(data: bytes) -> dict[str, list[str]]:
    legacy = json.loads(data.decode("utf-8"))
    aliases: dict[str, list[str]] = defaultdict(list)
    for country in legacy.get("countries", []):
        code = _clean_text(country.get("code")).upper()
        name = _clean_text(country.get("name"))
        if len(code) == 2 and code != "EU" and name:
            aliases[code].append(name)
    return aliases


def _parse_admin1(data: bytes, countries: dict[str, dict]) -> list[dict]:
    output = []
    for raw_line in data.decode("utf-8").splitlines():
        if not raw_line.strip():
            continue
        parts = raw_line.split("\t")
        if len(parts) < 4:
            continue
        compound_code, name, ascii_name, geoname_id = parts[:4]
        if "." not in compound_code:
            continue
        country_code, admin_code = compound_code.split(".", 1)
        country_code = country_code.upper()
        if country_code not in countries or not geoname_id.isdigit():
            continue
        aliases = []
        if _lookup_key(ascii_name) not in {_lookup_key(name), ""}:
            aliases.append(_clean_text(ascii_name))
        if _lookup_key(admin_code) not in {_lookup_key(name), _lookup_key(ascii_name), ""}:
            aliases.append(_clean_text(admin_code))
        output.append(
            {
                "id": f"geonames:{geoname_id}",
                "kind": "adminRegion",
                "name": _clean_text(name),
                "aliases": aliases,
                "countryCode": country_code,
                "admin1Code": admin_code,
                "parentId": f"iso3166:{country_code}",
            }
        )
    return sorted(output, key=lambda item: (item["countryCode"], item["admin1Code"], item["id"]))


def _parse_cities(data: bytes, countries: dict[str, dict], admin1_by_code: dict[str, dict]) -> list[dict]:
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = [name for name in zf.namelist() if name.endswith(".txt")]
    if not names:
        raise ValueError("GeoNames cities archive has no text file")

    output = []
    with zf.open(names[0]) as source:
        reader = csv.reader(io.TextIOWrapper(source, encoding="utf-8"), delimiter="\t")
        for row in reader:
            if len(row) < 19 or row[6] != "P":
                continue
            geoname_id = _clean_text(row[0])
            country_code = _clean_text(row[8]).upper()
            if not geoname_id.isdigit() or country_code not in countries:
                continue
            name = _clean_text(row[1])
            ascii_name = _clean_text(row[2])
            if not name:
                continue
            aliases = []
            if _lookup_key(ascii_name) not in {_lookup_key(name), ""}:
                aliases.append(ascii_name)
            admin_key = f"{country_code}.{_clean_text(row[10])}"
            admin = admin1_by_code.get(admin_key)
            parent_id = admin["id"] if admin else f"iso3166:{country_code}"
            try:
                population = int(row[14] or 0)
            except ValueError:
                population = 0
            output.append(
                {
                    "id": f"geonames:{geoname_id}",
                    "kind": "city",
                    "name": name,
                    "aliases": aliases,
                    "countryCode": country_code,
                    "admin1Id": admin["id"] if admin else None,
                    "population": max(population, 0),
                    "latitude": float(row[4]),
                    "longitude": float(row[5]),
                    "timeZoneId": _clean_text(row[17]) or None,
                    "featureCode": _clean_text(row[7]) or None,
                    "parentId": parent_id,
                }
            )
    return sorted(output, key=lambda item: int(item["id"].split(":", 1)[1]))


def _parse_country_timezones(data: bytes) -> dict[str, set[str]]:
    output: dict[str, set[str]] = defaultdict(set)
    reader = csv.reader(io.StringIO(data.decode("utf-8-sig")), delimiter="\t")
    for row in reader:
        if len(row) < 2:
            continue
        country_code = _clean_text(row[0]).upper()
        zone_id = _clean_text(row[1])
        if len(country_code) == 2 and zone_id and country_code != "COUNTRYCODE":
            output[country_code].add(zone_id)
    return output


def _zone_offsets(zone_id: str, reference_year: int, cache: dict[str, list[int]]) -> list[int]:
    if zone_id in cache:
        return cache[zone_id]
    try:
        zone = ZoneInfo(zone_id)
    except ZoneInfoNotFoundError:
        cache[zone_id] = []
        return []

    offsets = set()
    current = datetime(reference_year, 1, 1, 12, tzinfo=timezone.utc)
    end = datetime(reference_year + 1, 1, 1, 12, tzinfo=timezone.utc)
    while current < end:
        delta = current.astimezone(zone).utcoffset()
        if delta is not None:
            offsets.add(int(delta.total_seconds() // 60))
        current += timedelta(days=1)
    cache[zone_id] = sorted(offsets)
    return cache[zone_id]


def _add_ancestry(items: list[dict], all_by_id: dict[str, dict]) -> None:
    for item in items:
        ancestors = []
        seen = {item["id"]}
        parent_id = item.get("parentId")
        while parent_id:
            if parent_id in seen:
                raise ValueError(f"Location hierarchy cycle at {item['id']}")
            parent = all_by_id.get(parent_id)
            if parent is None:
                raise ValueError(f"Unknown parent {parent_id} for {item['id']}")
            ancestors.append(parent_id)
            seen.add(parent_id)
            parent_id = parent.get("parentId")
        item["ancestors"] = ancestors


def _add_utc_offsets(
    regions: list[dict],
    countries: list[dict],
    admin_regions: list[dict],
    cities: list[dict],
    country_timezones: dict[str, set[str]],
    reference_year: int,
) -> None:
    zone_cache: dict[str, list[int]] = {}
    country_offsets: dict[str, set[int]] = defaultdict(set)
    admin_offsets: dict[str, set[int]] = defaultdict(set)

    for country in countries:
        for zone_id in country_timezones.get(country["countryCode"], set()):
            country_offsets[country["countryCode"]].update(_zone_offsets(zone_id, reference_year, zone_cache))

    for city in cities:
        offsets = _zone_offsets(city.get("timeZoneId") or "", reference_year, zone_cache) if city.get("timeZoneId") else []
        city["utcOffsets"] = offsets
        country_offsets[city["countryCode"]].update(offsets)
        if city.get("admin1Id"):
            admin_offsets[city["admin1Id"]].update(offsets)

    for admin in admin_regions:
        admin["utcOffsets"] = sorted(admin_offsets.get(admin["id"], set()))

    region_offsets: dict[str, set[int]] = defaultdict(set)
    for country in countries:
        offsets = sorted(country_offsets.get(country["countryCode"], set()))
        country["utcOffsets"] = offsets
        for ancestor_id in country.get("ancestors", []):
            if ancestor_id.startswith("m49:"):
                region_offsets[ancestor_id].update(offsets)

    for region in regions:
        region["utcOffsets"] = sorted(region_offsets.get(region["id"], set()))


def _tzdata_version() -> str:
    try:
        return metadata.version("tzdata")
    except metadata.PackageNotFoundError:
        tzdata_zi = Path("/usr/share/zoneinfo/tzdata.zi")
        if tzdata_zi.is_file():
            first_line = tzdata_zi.read_text(encoding="utf-8", errors="replace").splitlines()[0]
            match = re.search(r"version\s+([^\s]+)", first_line)
            if match:
                return f"system-{match.group(1)}"
        return "system-zoneinfo-unknown"


def build_catalog(
    cities_data: bytes,
    admin1_data: bytes,
    timezone_data: bytes,
    m49_data: bytes,
    legacy_geo_data: bytes,
    reference_year: int,
) -> dict:
    regions, countries_by_code = _parse_m49(m49_data)
    legacy_aliases = _parse_legacy_country_aliases(legacy_geo_data)
    for code, aliases in legacy_aliases.items():
        country = countries_by_code.get(code)
        if not country:
            continue
        seen = {_lookup_key(country["name"])}
        for alias in aliases:
            key = _lookup_key(alias)
            if key and key not in seen:
                country["aliases"].append(alias)
                seen.add(key)

    admin_regions = _parse_admin1(admin1_data, countries_by_code)
    admin1_by_code = {
        f"{item['countryCode']}.{item['admin1Code']}": item for item in admin_regions
    }
    cities = _parse_cities(cities_data, countries_by_code, admin1_by_code)
    countries = sorted(countries_by_code.values(), key=lambda item: item["countryCode"])

    all_by_id = {
        item["id"]: item
        for collection in (regions, countries, admin_regions, cities)
        for item in collection
    }
    for collection in (regions, countries, admin_regions, cities):
        _add_ancestry(collection, all_by_id)

    country_timezones = _parse_country_timezones(timezone_data)
    _add_utc_offsets(
        regions,
        countries,
        admin_regions,
        cities,
        country_timezones,
        reference_year,
    )

    return {
        "schemaVersion": SCHEMA_VERSION,
        "referenceYear": reference_year,
        "regions": regions,
        "countries": countries,
        "adminRegions": admin_regions,
        "cities": cities,
    }


def _catalog_version(
    source_hashes: dict[str, str],
    reference_year: int,
    tzdata_version: str,
) -> str:
    payload = json.dumps(
        {
            "schemaVersion": SCHEMA_VERSION,
            "buildVersion": BUILD_VERSION,
            "referenceYear": reference_year,
            "tzdata": tzdata_version,
            "sources": source_hashes,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:20]


def _write_gzip_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            compressed.write(payload)


def _search_key(value: str | None) -> str:
    return re.sub(r"[^\w]+", " ", _clean_text(value).casefold(), flags=re.UNICODE).strip()


def _search_index_country_display_name(country: dict) -> str:
    aliases = [_clean_text(value) for value in country.get("aliases", []) if _clean_text(value)]
    if aliases:
        return min(aliases, key=lambda value: (len(value), value.casefold()))
    return _clean_text(country.get("name"))


def _write_search_index(path: Path, catalog: dict) -> None:
    """Build the read-only selector index from the canonical catalog."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()

    collections = ("regions", "countries", "adminRegions", "cities")
    by_id = {
        item["id"]: item
        for collection in collections
        for item in catalog.get(collection, [])
    }
    countries_by_code = {
        item.get("countryCode"): item
        for item in catalog.get("countries", [])
        if item.get("countryCode")
    }

    def presentation(item: dict) -> tuple[str, str | None, str | None, str | None, str, str]:
        kind = item["kind"]
        display_name = _clean_text(item.get("name"))
        country_code = _clean_text(item.get("countryCode")).upper() or None
        country = countries_by_code.get(country_code)
        country_name = _search_index_country_display_name(country) if country else None
        admin_region_name = None
        if kind == "city":
            admin = by_id.get(item.get("admin1Id") or item.get("parentId"))
            if admin and admin.get("kind") == "adminRegion":
                admin_region_name = _clean_text(admin.get("name")) or None
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
            parent = by_id.get(item.get("parentId"))
            if parent and parent.get("id") != "m49:001":
                context_parts.append(_clean_text(parent.get("name")))

        label_parts = [display_name]
        label_parts.extend(
            value for value in context_parts if value and value != display_name
        )
        return (
            display_name,
            admin_region_name,
            country_code,
            country_name,
            " · ".join(context_parts),
            ", ".join(value for value in label_parts if value),
        )

    conn = sqlite3.connect(path)
    try:
        cursor = conn.cursor()
        cursor.executescript(
            """
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            PRAGMA temp_store=MEMORY;
            CREATE TABLE metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) WITHOUT ROWID;
            CREATE TABLE locations (
                location_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                display_name TEXT NOT NULL,
                admin_region_name TEXT,
                country_code TEXT,
                country_name TEXT,
                context_label TEXT NOT NULL,
                label TEXT NOT NULL,
                population INTEGER NOT NULL,
                search_blob TEXT NOT NULL
            ) WITHOUT ROWID;
            CREATE TABLE names (
                search_name TEXT NOT NULL,
                location_id TEXT NOT NULL,
                PRIMARY KEY (search_name, location_id)
            ) WITHOUT ROWID;
            CREATE TABLE country_regions (
                country_id TEXT NOT NULL,
                region_id TEXT NOT NULL,
                is_top INTEGER NOT NULL,
                PRIMARY KEY (country_id, region_id)
            ) WITHOUT ROWID;
            """
        )
        cursor.execute(
            "INSERT INTO metadata (key, value) VALUES ('catalogVersion', ?)",
            (catalog["catalogVersion"],),
        )

        location_rows = []
        name_rows = []
        country_region_rows = []
        for item in by_id.values():
            (
                display_name,
                admin_region_name,
                country_code,
                country_name,
                context_label,
                label,
            ) = presentation(item)
            search_names = []
            for raw_name in [item.get("name"), *item.get("aliases", [])]:
                normalized = _search_key(raw_name)
                if normalized and normalized not in search_names:
                    search_names.append(normalized)
            search_blob = " ".join(
                dict.fromkeys(
                    [
                        *search_names,
                        _search_key(admin_region_name),
                        _search_key(country_name),
                        _search_key(country_code),
                    ]
                )
            ).strip()
            location_rows.append(
                (
                    item["id"],
                    item["kind"],
                    display_name,
                    admin_region_name,
                    country_code,
                    country_name,
                    context_label,
                    label,
                    int(item.get("population") or 0),
                    search_blob,
                )
            )
            name_rows.extend((name, item["id"]) for name in search_names)
            if item["kind"] == "country":
                for ancestor_id in item.get("ancestors", []):
                    ancestor = by_id.get(ancestor_id)
                    if not ancestor or ancestor.get("kind") != "globalRegion":
                        continue
                    country_region_rows.append(
                        (
                            item["id"],
                            ancestor_id,
                            1 if ancestor.get("parentId") == "m49:001" else 0,
                        )
                    )

        cursor.executemany(
            "INSERT INTO locations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            location_rows,
        )
        cursor.executemany(
            "INSERT INTO names VALUES (?, ?)",
            name_rows,
        )
        cursor.executemany(
            "INSERT INTO country_regions VALUES (?, ?, ?)",
            country_region_rows,
        )
        conn.commit()
        cursor.execute("ANALYZE")
        conn.commit()
        cursor.execute("VACUUM")
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the Ehestifter Locations v2 catalog")
    parser.add_argument("--cities500", help="Local GeoNames cities500.zip. Download when omitted.")
    parser.add_argument("--admin1", help="Local GeoNames admin1CodesASCII.txt. Download when omitted.")
    parser.add_argument("--time-zones", help="Local GeoNames timeZones.txt. Download when omitted.")
    parser.add_argument("--m49", help="Local UN M49 HTML or semicolon CSV. Download when omitted.")
    parser.add_argument("--legacy-geo", default=str(LEGACY_GEO_DEFAULT), help="Current Web geography JSON")
    parser.add_argument("--reference-year", type=int, default=datetime.now(timezone.utc).year)
    parser.add_argument("--out", default=str(CATALOG_DEFAULT))
    parser.add_argument("--manifest-out", default=str(MANIFEST_DEFAULT))
    parser.add_argument("--search-index-out", default=str(SEARCH_INDEX_DEFAULT))
    args = parser.parse_args()

    if args.reference_year < 2000 or args.reference_year > 2200:
        parser.error("--reference-year must be between 2000 and 2200")

    sources = {}
    source_meta = {}
    for key, path, url in (
        ("geonamesCities500", args.cities500, GEONAMES_CITIES500_URL),
        ("geonamesAdmin1", args.admin1, GEONAMES_ADMIN1_URL),
        ("geonamesTimeZones", args.time_zones, GEONAMES_TIMEZONES_URL),
        ("unM49", args.m49, M49_OVERVIEW_URL),
        ("legacyGeo", args.legacy_geo, str(LEGACY_GEO_DEFAULT)),
    ):
        data, source = _source_bytes(path, url)
        sources[key] = data
        source_meta[key] = {"source": source, "sha256": _sha256(data)}

    source_hashes = {key: value["sha256"] for key, value in source_meta.items()}
    tzdata_version = _tzdata_version()
    version = _catalog_version(source_hashes, args.reference_year, tzdata_version)
    catalog = build_catalog(
        sources["geonamesCities500"],
        sources["geonamesAdmin1"],
        sources["geonamesTimeZones"],
        sources["unM49"],
        sources["legacyGeo"],
        args.reference_year,
    )
    catalog["catalogVersion"] = version

    out_path = Path(args.out)
    _write_gzip_json(out_path, catalog)
    search_index_path = Path(args.search_index_out)
    _write_search_index(search_index_path, catalog)

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "buildVersion": BUILD_VERSION,
        "catalogVersion": version,
        "referenceYear": args.reference_year,
        "tzdata": tzdata_version,
        "counts": {
            "regions": len(catalog["regions"]),
            "countries": len(catalog["countries"]),
            "adminRegions": len(catalog["adminRegions"]),
            "cities": len(catalog["cities"]),
        },
        "sources": source_meta,
    }
    manifest_path = Path(args.manifest_out)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Wrote {out_path}")
    print(f"Wrote {search_index_path}")
    print(f"Wrote {manifest_path}")
    print(json.dumps(manifest["counts"], sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
