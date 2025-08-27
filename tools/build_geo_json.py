#!/usr/bin/env python3
"""
Builds geo.sample.json compatible with your UI:

{
  "countries": [ { "name": "Germany", "code": "DE", "priority": true }, ...,
                 { "name": "European Union", "code": "EU", "priority": true } ],
  "cities":    { "DE": ["Berlin", "Munich", ...], "CH": ["Bottighofen", ...], "EU": ["Brussels","Luxembourg","Strasbourg"] }
}

Sources:
- Countries: mledoze/countries (ODbL-1.0)  -> cca2 + name.common.  :contentReference[oaicite:2]{index=2}
- Cities: GeoNames (CC BY 4.0) -> feature class 'P' from cities500.zip or allCountries.zip.  :contentReference[oaicite:3]{index=3}

run as:
python tools/build_geo_json.py \
  --min-pop 500 \
  --top-per-country 0 \
  --out static/data/geo.sample.json

--min-pop 500 uses cities500—captures small towns like Bottighofen (CH).

--top-per-country 0 means “no limit” (can be ~180k city names, ~6–10 MB JSON uncompressed). 
    If that’s too big for the browser, set --top-per-country 300 for the UI 
    and keep the full set server-side.
"""

import argparse, io, json, zipfile, sys, csv, re, tempfile, os
from pathlib import Path
from urllib.request import urlopen

ML_COUNTRIES_URL = "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"  # :contentReference[oaicite:4]{index=4}
GEONAMES_CITIES500_URL = "https://download.geonames.org/export/dump/cities500.zip"             # :contentReference[oaicite:5]{index=5}
GEONAMES_ALLCOUNTRIES_URL = "https://download.geonames.org/export/dump/allCountries.zip"       # :contentReference[oaicite:6]{index=6}

EU_MEMBER_CCA2 = {
    # keep this explicit for stability
    "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE",
    "IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"
}
PRIORITY_EXTRA = {"GB","CH","NO","IS","US","CA"}  # opinionated: helpful defaults for your UX

EU_PSEUDO = {"name": "European Union", "code": "EU", "priority": True}
EU_PSEUDO_CITIES = ["Brussels", "Luxembourg", "Strasbourg"]  # EU institutions hubs

def fetch(url: str) -> bytes:
    with urlopen(url) as r:
        return r.read()

def load_countries():
    data = json.loads(fetch(ML_COUNTRIES_URL).decode("utf-8"))
    out = []
    for row in data:
        name = row.get("name", {}).get("common") or row.get("name", {}).get("official")
        code = row.get("cca2")
        if not name or not code:  # skip malformed
            continue
        code = code.upper()
        priority = code in EU_MEMBER_CCA2 or code in PRIORITY_EXTRA
        out.append({"name": name, "code": code, "priority": bool(priority)})
    # add EU pseudo at the end of priority block
    out.append(EU_PSEUDO.copy())
    # sort: priority first (stable), then by name
    out.sort(key=lambda x: (not x["priority"], x["name"]))
    return out

def norm_key(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip()).casefold()

def load_cities(min_pop: int, use_all: bool, top_per_country: int):
    # Choose GeoNames file
    url = GEONAMES_ALLCOUNTRIES_URL if use_all else GEONAMES_CITIES500_URL
    raw = fetch(url)
    zf = zipfile.ZipFile(io.BytesIO(raw))
    # Find the internal .txt; for cities500 it's "cities500.txt", for allCountries it's "allCountries.txt"
    inner = [n for n in zf.namelist() if n.endswith(".txt")][0]
    fh = io.TextIOWrapper(zf.open(inner), encoding="utf-8")
    reader = csv.reader(fh, delimiter="\t")
    # GeoNames columns: 0:id,1:name,2:asciiname,3:alternatenames,4:lat,5:lon,6:feature_class,7:feature_code,8:cc,14:population
    by_cc = {}
    for row in reader:
        if len(row) < 19:
            continue
        fclass = row[6]
        if fclass != "P":  # populated places only
            continue
        try:
            pop = int(row[14] or 0)
        except:
            pop = 0
        if pop < min_pop:
            continue
        cc = (row[8] or "").upper()
        name = row[1].strip()
        if not cc or not name:
            continue
        # initialize bucket
        b = by_cc.setdefault(cc, {})
        # keep the most populous per normalized name key
        k = norm_key(name)
        prev = b.get(k)
        if (not prev) or (pop > prev[1]):
            b[k] = (name, pop)
    # convert dicts to sorted lists by population desc, then alpha
    out = {}
    for cc, d in by_cc.items():
        items = sorted(d.values(), key=lambda t: (-t[1], t[0]))
        if top_per_country and top_per_country > 0:
            items = items[:top_per_country]
        out[cc] = [name for (name, _pop) in items]
    # add EU pseudo cities
    out["EU"] = EU_PSEUDO_CITIES[:]
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-pop", type=int, default=500, help="Min population for cities (use 0 with --use-all to keep everything)")
    ap.add_argument("--use-all", action="store_true", help="Use GeoNames allCountries.zip instead of cities500.zip")
    ap.add_argument("--top-per-country", type=int, default=0, help="0 = no limit, otherwise keep only top N cities per country")
    ap.add_argument("--out", required=True, help="Output path: static/data/geo.sample.json")
    args = ap.parse_args()

    countries = load_countries()
    cities = load_cities(args.min_pop, args.use_all, args.top_per_country)

    geo = {"countries": countries, "cities": cities}

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(geo, f, ensure_ascii=False, separators=(",", ":"))
    # Also write a tiny ATTRIBUTION alongside (GeoNames CC BY requirement)
    attr = out_path.with_suffix(".ATTRIBUTION.txt")
    with open(attr, "w", encoding="utf-8") as f:
        f.write("Countries: mledoze/countries (ODbL-1.0)\n")
        f.write("Cities: GeoNames (CC BY 4.0) — https://www.geonames.org/\n")
    print(f"Wrote {out_path} and {attr}")

if __name__ == "__main__":
    sys.exit(main())
