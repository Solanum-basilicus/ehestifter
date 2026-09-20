# Jobs reference data

`locations-v2.catalog.json.gz` is generated reference data for Locations v2.
`locations-v2.search.sqlite3` is the generated read-only selector index for
location autocomplete, canonical lookup, and country-level coverage explanation.
The index contains presentation/search data and generated country-to-region
relationships only; it is not an independent geography source.

Build both files with `tools/build_locations_v2_catalog.py` before you deploy
Locations v2 support. The generated manifest records source hashes, the catalog
version, and the UTC reference year. Runtime Jobs code checks that the selector
index catalog version matches the manifest.

Do not edit generated reference files by hand.
