# Jobs reference data

`locations-v2.catalog.json.gz` is the committed canonical Locations v2 catalog.
`locations-v2.catalog.manifest.json` records its version, source hashes, and
reference year. Keep both files in Git as one release.

`locations-v2.search.sqlite3` is a generated, read-only selector index. It is not
tracked by Git. It contains search and presentation data, country-to-region relationships, and exact country aliases for the list filter. It is not an independent geography source.

From the repository root, build the index before local Jobs tests or a manual
deployment:

```sh
python tools/build_locations_v2_catalog.py --index-only
```

This command uses only the committed catalog and manifest. It needs no network
access or extra Python packages. It checks the catalog version, item counts, and
SQLite integrity. It replaces the index only after the checks succeed.

The Jobs GitHub Actions workflow runs this command before it deploys the Jobs
package. Each deployed Function instance reads the packaged index. No index
build or external download is needed at startup.

To refresh the canonical catalog from upstream sources, run the builder without
`--index-only`. That is a separate, explicit data-update operation. It can
update the catalog, manifest, and index. Keep ATS Discovery's generated catalog
snapshot in sync when you update the canonical catalog.

Do not edit generated reference files by hand.
