import io
import sqlite3
import zipfile

from tools.build_locations_v2_catalog import _write_search_index, build_catalog


M49 = """Global Code;Global Name;Region Code;Region Name;Sub-region Code;Sub-region Name;Intermediate Region Code;Intermediate Region Name;Country or Area;M49 Code;ISO-alpha2 Code;ISO-alpha3 Code;Least Developed Countries (LDC);Land Locked Developing Countries (LLDC);Small Island Developing States (SIDS)\n001;World;150;Europe;155;Western Europe;;;Germany;276;DE;DEU;;;\n001;World;150;Europe;039;Southern Europe;;;Spain;724;ES;ESP;;;\n001;World;019;Americas;021;Northern America;;;United States of America;840;US;USA;;;\n""".encode()

ADMIN1 = """DE.02\tBavaria\tBavaria\t2951839\nES.29\tMadrid\tMadrid\t3117732\nUS.OR\tOregon\tOregon\t5744337\nUS.IL\tIllinois\tIllinois\t4896861\n""".encode()

TIMEZONES = """CountryCode\tTimeZoneId\tGMT offset 1. Jan 2026\tDST offset 1. Jul 2026\tRawOffset\nDE\tEurope/Berlin\t1\t2\t1\nES\tEurope/Madrid\t1\t2\t1\nUS\tAmerica/Los_Angeles\t-8\t-7\t-8\nUS\tAmerica/Chicago\t-6\t-5\t-6\n""".encode()

LEGACY = b'{"countries":[{"name":"Germany","code":"DE"},{"name":"Spain","code":"ES"},{"name":"United States","code":"US"},{"name":"European Union","code":"EU"}],"cities":{}}'


def _city_row(geoname_id, name, ascii_name, lat, lon, cc, admin1, population, timezone_id, alternate_names=""):
    row = [""] * 19
    row[0] = str(geoname_id)
    row[1] = name
    row[2] = ascii_name
    row[3] = alternate_names
    row[4] = str(lat)
    row[5] = str(lon)
    row[6] = "P"
    row[7] = "PPL"
    row[8] = cc
    row[10] = admin1
    row[14] = str(population)
    row[17] = timezone_id
    row[18] = "2026-01-01"
    return "\t".join(row)


def _cities_zip():
    lines = [
        _city_row(1, "Hallbergmoos", "Hallbergmoos", 48.3, 11.7, "DE", "02", 11000, "Europe/Berlin"),
        _city_row(2, "Madrid", "Madrid", 40.4, -3.7, "ES", "29", 3200000, "Europe/Madrid", "Madryt,Madrid"),
        _city_row(3, "Madras", "Madras", 44.6, -121.1, "US", "OR", 7000, "America/Los_Angeles"),
        _city_row(4, "Springfield", "Springfield", 44.0, -123.0, "US", "OR", 62000, "America/Los_Angeles"),
        _city_row(5, "Springfield", "Springfield", 39.8, -89.6, "US", "IL", 114000, "America/Chicago"),
    ]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("cities500.txt", "\n".join(lines) + "\n")
    return buffer.getvalue()


def test_catalog_keeps_small_places_population_and_duplicate_names():
    catalog = build_catalog(
        _cities_zip(),
        ADMIN1,
        TIMEZONES,
        M49,
        LEGACY,
        2026,
    )

    cities = {item["id"]: item for item in catalog["cities"]}
    admins = {item["id"]: item for item in catalog["adminRegions"]}
    assert cities["geonames:1"]["name"] == "Hallbergmoos"
    assert "OR" in admins["geonames:5744337"]["aliases"]
    assert cities["geonames:2"]["population"] == 3200000
    assert cities["geonames:2"]["aliases"] == ["Madryt"]
    assert cities["geonames:3"]["population"] == 7000
    assert [item["name"] for item in catalog["cities"]].count("Springfield") == 2


def test_catalog_adds_hierarchy_and_year_offsets():
    catalog = build_catalog(
        _cities_zip(),
        ADMIN1,
        TIMEZONES,
        M49,
        LEGACY,
        2026,
    )

    countries = {item["countryCode"]: item for item in catalog["countries"]}
    hallbergmoos = next(item for item in catalog["cities"] if item["name"] == "Hallbergmoos")

    assert countries["DE"]["ancestors"] == ["m49:155", "m49:150", "m49:001"]
    assert countries["DE"]["alpha3Code"] == "DEU"
    assert hallbergmoos["ancestors"] == [
        "geonames:2951839",
        "iso3166:DE",
        "m49:155",
        "m49:150",
        "m49:001",
    ]
    assert hallbergmoos["utcOffsets"] == [60, 120]
    assert countries["DE"]["utcOffsets"] == [60, 120]


def test_m49_html_table_is_supported():
    html = b"""<html><body><table><tr><th>Global Code</th><th>Global Name</th><th>Region Code</th><th>Region Name</th><th>Sub-region Code</th><th>Sub-region Name</th><th>Intermediate Region Code</th><th>Intermediate Region Name</th><th>Country or Area</th><th>M49 Code</th><th>ISO-alpha2 Code</th><th>ISO-alpha3 Code</th></tr><tr><td>001</td><td>World</td><td>150</td><td>Europe</td><td>155</td><td>Western Europe</td><td></td><td></td><td>Germany</td><td>276</td><td>DE</td><td>DEU</td></tr></table></body></html>"""
    catalog = build_catalog(
        _cities_zip(),
        ADMIN1,
        TIMEZONES,
        html,
        LEGACY,
        2026,
    )

    countries = {item["countryCode"]: item for item in catalog["countries"]}
    assert countries["DE"]["ancestors"] == ["m49:155", "m49:150", "m49:001"]


def test_search_index_contains_country_region_relationships(tmp_path):
    catalog = build_catalog(
        _cities_zip(),
        ADMIN1,
        TIMEZONES,
        M49,
        LEGACY,
        2026,
    )
    catalog["catalogVersion"] = "test-version"
    path = tmp_path / "locations.sqlite3"

    _write_search_index(path, catalog)

    conn = sqlite3.connect(path)
    try:
        rows = conn.execute(
            """
            SELECT region_id, is_top
            FROM country_regions
            WHERE country_id = 'iso3166:DE'
            ORDER BY region_id
            """
        ).fetchall()
    finally:
        conn.close()

    assert rows == [("m49:001", 0), ("m49:150", 1), ("m49:155", 0)]


def _write_index_only_fixture(tmp_path):
    import json

    from tools.build_locations_v2_catalog import _write_gzip_json

    catalog = build_catalog(_cities_zip(), ADMIN1, TIMEZONES, M49, LEGACY, 2026)
    catalog["catalogVersion"] = "test-version"
    manifest = {
        "schemaVersion": 2,
        "buildVersion": 2,
        "catalogVersion": "test-version",
        "referenceYear": 2026,
        "counts": {
            key: len(catalog[key])
            for key in ("regions", "countries", "adminRegions", "cities")
        },
    }
    catalog_path = tmp_path / "catalog.json.gz"
    manifest_path = tmp_path / "catalog.manifest.json"
    index_path = tmp_path / "index.sqlite3"
    _write_gzip_json(catalog_path, catalog)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return catalog_path, manifest_path, index_path, manifest


def test_index_only_build_uses_existing_catalog_without_source_downloads(tmp_path, monkeypatch):
    import sys

    from tools import build_locations_v2_catalog as builder

    catalog_path, manifest_path, index_path, manifest = _write_index_only_fixture(tmp_path)

    def fail_source_download(*_args):
        raise AssertionError("Index-only build must not read upstream sources")

    monkeypatch.setattr(builder, "_source_bytes", fail_source_download)
    monkeypatch.setattr(sys, "argv", [
        "build_locations_v2_catalog.py", "--index-only",
        "--out", str(catalog_path),
        "--manifest-out", str(manifest_path),
        "--search-index-out", str(index_path),
    ])

    assert builder.main() == 0
    with sqlite3.connect(index_path) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert conn.execute(
            "SELECT value FROM metadata WHERE key = 'catalogVersion'"
        ).fetchone() == ("test-version",)
        assert conn.execute("SELECT COUNT(*) FROM locations").fetchone()[0] == sum(manifest["counts"].values())


def test_index_only_rejects_manifest_version_and_count_mismatches(tmp_path):
    import json

    import pytest

    from tools.build_locations_v2_catalog import _build_index_from_catalog

    catalog_path, manifest_path, index_path, manifest = _write_index_only_fixture(tmp_path)
    manifest["catalogVersion"] = "wrong-version"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="catalogVersion"):
        _build_index_from_catalog(catalog_path, manifest_path, index_path)
    assert not index_path.exists()

    manifest["catalogVersion"] = "test-version"
    manifest["counts"]["cities"] += 1
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="cities count"):
        _build_index_from_catalog(catalog_path, manifest_path, index_path)
    assert not index_path.exists()


def test_index_only_preserves_previous_index_when_build_fails(tmp_path, monkeypatch):
    import pytest

    from tools import build_locations_v2_catalog as builder

    catalog_path, manifest_path, index_path, _ = _write_index_only_fixture(tmp_path)
    index_path.write_bytes(b"previous-valid-index")

    def fail_index_write(path, catalog):
        path.write_bytes(b"incomplete-index")
        raise RuntimeError("test interrupted build")

    monkeypatch.setattr(builder, "_write_search_index", fail_index_write)
    with pytest.raises(RuntimeError, match="interrupted build"):
        builder._build_index_from_catalog(catalog_path, manifest_path, index_path)
    assert index_path.read_bytes() == b"previous-valid-index"
    assert sorted(tmp_path.glob(".index.sqlite3.*.tmp")) == []


def test_geonames_country_and_alternate_names_are_data_driven():
    country_info = (
        "TR\tTUR\t792\tTU\tTurkey\tAnkara\t780580\t85000000\tAS\t.tr\tTRY\tLira\t90\t#####\tpost\ttr-TR\t298795\t\n"
        "TW\tTWN\t158\tTW\tTaiwan\tTaipei\t35980\t23000000\tAS\t.tw\tTWD\tDollar\t886\t#####\tpost\tzh-TW\t1668284\t\n"
        "AT\tAUT\t040\tAU\tAustria\tVienna\t83879\t9000000\tEU\t.at\tEUR\tEuro\t43\t#####\tpost\tde-AT\t2782113\t\n"
        "IT\tITA\t380\tIT\tItaly\tRome\t301340\t59000000\tEU\t.it\tEUR\tEuro\t39\t#####\tpost\tit-IT\t3175395\t\n"
    ).encode()
    city_data = io.BytesIO()
    with zipfile.ZipFile(city_data, "w") as zf:
        zf.writestr("cities500.txt", "\n".join([
            _city_row(100, "Vienna", "Vienna", 48.2, 16.4, "AT", "", 2000000, "Europe/Vienna"),
            _city_row(101, "Taipei", "Taipei", 25.0, 121.5, "TW", "", 2300000, "Asia/Taipei"),
            _city_row(102, "Milan", "Milan", 45.46, 9.19, "IT", "", 1300000, "Europe/Rome"),
        ]))
    alternates = io.BytesIO()
    with zipfile.ZipFile(alternates, "w") as zf:
        zf.writestr("iso-languagecodes.txt", "iso3\tiso2\tiso1\tname\n")
        zf.writestr("notes.txt", "Additional text does not contain alternate names")
        zf.writestr("alternateNamesV2.txt", "\n".join([
            "1\t100\tde\tWien\t1\t0\t0\t0\t\t",
            "2\t298795\ten\tTurkey\t1\t0\t0\t0\t\t",
            "3\t100\tde\tAlt-Wien\t0\t0\t0\t1\t\t",
            "4\t100\tfr\tVienne\t0\t0\t0\t0\t\t",
            "5\t102\tde\tMailand\t0\t0\t0\t0\t\t",
            "6\t102\tit\tMilano\t0\t0\t0\t0\t\t",
            "7\t102\tfr\tMilan-fr-test\t0\t0\t0\t0\t\t",
        ]))
    catalog = build_catalog(
        city_data.getvalue(), b"", TIMEZONES, M49, LEGACY, 2026,
        country_info_data=country_info,
        alternate_names_data=alternates.getvalue(),
    )
    countries = {item["countryCode"]: item for item in catalog["countries"]}
    cities = {item["name"]: item for item in catalog["cities"]}
    assert countries["TW"]["alpha3Code"] == "TWN"
    from tools.build_locations_v2_catalog import _parse_country_info
    assert "zh" in _parse_country_info(country_info)["TW"]["languages"]
    assert countries["TW"]["parentId"] == "m49:001"
    assert "Turkey" in countries["TR"]["aliases"] or countries["TR"]["name"] == "Turkey"
    assert cities["Taipei"]["countryCode"] == "TW"
    assert "Wien" in cities["Vienna"]["aliases"]
    assert "Alt-Wien" not in cities["Vienna"]["aliases"]
    assert "Vienne" not in cities["Vienna"]["aliases"]
    assert "Mailand" in cities["Milan"]["aliases"]
    assert "Milano" in cities["Milan"]["aliases"]
    assert "Milan-fr-test" not in cities["Milan"]["aliases"]


def test_alternate_names_archive_requires_named_member():
    import pytest

    from tools.build_locations_v2_catalog import _parse_preferred_alternate_names

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("iso-languagecodes.txt", "en\tEnglish\n")
        zf.writestr("other.txt", "1\t100\tde\tWien\t1\t0\t0\t0\t\t\n")
    with pytest.raises(ValueError, match="alternateNamesV2.txt"):
        _parse_preferred_alternate_names(archive.getvalue(), {"100": {"de"}})


def test_alternate_names_archive_rejects_duplicate_named_members():
    import pytest

    from tools.build_locations_v2_catalog import _parse_preferred_alternate_names

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("alternateNamesV2.txt", "1\t100\tde\tWien\t1\t0\t0\t0\t\t\n")
        zf.writestr("nested/alternateNamesV2.txt", "2\t100\tde\tAlt-Wien\t1\t0\t0\t0\t\t\n")
    with pytest.raises(ValueError, match="exactly one alternateNamesV2.txt"):
        _parse_preferred_alternate_names(archive.getvalue(), {"100": {"de"}})


def test_country_display_name_rejects_unrelated_short_aliases():
    from tools.build_locations_v2_catalog import _search_index_country_display_name

    cases = [
        ({"name": "Canada", "aliases": ["ካናዳ", "CA", "Canada"]}, "Canada"),
        (
            {"name": "United Kingdom of Great Britain and Northern Ireland",
             "aliases": ["U.K", "GB", "United Kingdom", "Britain"]},
            "United Kingdom",
        ),
        ({"name": "United States of America", "aliases": ["US", "United States"]},
         "United States"),
        ({"name": "Türkiye", "aliases": ["TR", "Turkey"]}, "Türkiye"),
    ]
    for country, expected in cases:
        assert _search_index_country_display_name(country) == expected


def test_search_index_keeps_aliases_searchable_without_using_them_as_labels(tmp_path):
    catalog = {
        "catalogVersion": "test-version",
        "regions": [],
        "countries": [
            {"id": "iso3166:CA", "kind": "country", "name": "Canada",
             "countryCode": "CA", "aliases": ["ካናዳ", "CA"], "ancestors": []},
            {"id": "iso3166:GB", "kind": "country",
             "name": "United Kingdom of Great Britain and Northern Ireland",
             "countryCode": "GB", "aliases": ["U.K", "United Kingdom"],
             "ancestors": []},
        ],
        "adminRegions": [
            {"id": "geonames:6093943", "kind": "adminRegion", "name": "Ontario",
             "countryCode": "CA", "parentId": "iso3166:CA", "aliases": []},
        ],
        "cities": [
            {"id": "geonames:6058560", "kind": "city", "name": "London",
             "countryCode": "CA", "parentId": "geonames:6093943",
             "admin1Id": "geonames:6093943", "aliases": [], "population": 400000},
        ],
    }
    index_path = tmp_path / "locations.sqlite3"
    _write_search_index(index_path, catalog)
    with sqlite3.connect(index_path) as conn:
        assert conn.execute(
            "SELECT label FROM locations WHERE location_id = 'geonames:6058560'"
        ).fetchone()[0] == "London, Ontario, Canada"
        assert conn.execute(
            "SELECT display_name FROM locations WHERE location_id = 'iso3166:GB'"
        ).fetchone()[0] == "United Kingdom"
        assert conn.execute(
            "SELECT location_id FROM names WHERE search_name = ?", ("ካናዳ",)
        ).fetchone()[0] == "iso3166:CA"
        assert conn.execute(
            "SELECT location_id FROM names WHERE search_name = ?", ("u k",)
        ).fetchone()[0] == "iso3166:GB"
