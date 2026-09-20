import io
import sqlite3
import zipfile

from tools.build_locations_v2_catalog import _write_search_index, build_catalog


M49 = """Global Code;Global Name;Region Code;Region Name;Sub-region Code;Sub-region Name;Intermediate Region Code;Intermediate Region Name;Country or Area;M49 Code;ISO-alpha2 Code;ISO-alpha3 Code;Least Developed Countries (LDC);Land Locked Developing Countries (LLDC);Small Island Developing States (SIDS)\n001;World;150;Europe;155;Western Europe;;;Germany;276;DE;DEU;;;\n001;World;150;Europe;039;Southern Europe;;;Spain;724;ES;ESP;;;\n001;World;019;Americas;021;Northern America;;;United States of America;840;US;USA;;;\n""".encode()

ADMIN1 = """DE.02\tBavaria\tBavaria\t2951839\nES.29\tMadrid\tMadrid\t3117732\nUS.OR\tOregon\tOregon\t5744337\nUS.IL\tIllinois\tIllinois\t4896861\n""".encode()

TIMEZONES = """CountryCode\tTimeZoneId\tGMT offset 1. Jan 2026\tDST offset 1. Jul 2026\tRawOffset\nDE\tEurope/Berlin\t1\t2\t1\nES\tEurope/Madrid\t1\t2\t1\nUS\tAmerica/Los_Angeles\t-8\t-7\t-8\nUS\tAmerica/Chicago\t-6\t-5\t-6\n""".encode()

LEGACY = b'{"countries":[{"name":"Germany","code":"DE"},{"name":"Spain","code":"ES"},{"name":"United States","code":"US"},{"name":"European Union","code":"EU"}],"cities":{}}'


def _city_row(geoname_id, name, ascii_name, lat, lon, cc, admin1, population, timezone_id):
    row = [""] * 19
    row[0] = str(geoname_id)
    row[1] = name
    row[2] = ascii_name
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
        _city_row(2, "Madrid", "Madrid", 40.4, -3.7, "ES", "29", 3200000, "Europe/Madrid"),
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
