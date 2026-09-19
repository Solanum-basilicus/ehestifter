# Jobs reference data

`locations-v2.catalog.json.gz` is generated reference data for Locations v2.
Build it with `tools/build_locations_v2_catalog.py` before you deploy migration/backfill support.
The generated manifest records source hashes, the catalog version, and the UTC reference year.

Do not edit the generated catalog by hand.
