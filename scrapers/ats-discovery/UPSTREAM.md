# Career-Ops upstream reference

- Repository: https://github.com/santifer/career-ops
- Tag: career-ops-v1.20.0
- Commit: 493487462608c0cced82c1440e7ba8be6c01f306
- Imported files:
  - providers/_http.mjs
  - providers/_registry.mjs
  - providers/_types.js
  - providers/greenhouse.mjs
  - providers/lever.mjs
  - providers/ashby.mjs
  - providers/workday.mjs

Ehestifter removes Career-Ops tracker, application, CV-generation, pipeline,
scan-history, plugin, and browser-verification integrations. The retained
provider layer is used only for public job discovery.

# Catalog upstream references

## job-board-aggregator

- Repository: https://github.com/Feashliaa/job-board-aggregator
- Ref used by unattended catalog sync: `main`
- License recorded in catalog provenance: CC BY-NC 4.0
- Catalogs: Ashby, Greenhouse, Lever, Workday

## ats-scrapers

- Repository: https://github.com/kalil0321/ats-scrapers
- Ref used by unattended catalog sync: `main`
- License: MIT
- Catalog files:
  - `ats-companies/personio.csv`
  - `ats-companies/smartrecruiters.csv`
  - `ats-companies/softgarden.csv`
  - `ats-companies/successfactors.csv`

Ehestifter downloads these inventories only during the separate catalog-sync
operation, validates them into the common schemaVersion 2 catalog envelope, and
keeps the previous valid local snapshot on fetch, parse, normalization, quality,
or write failure. The source `main` ref is recorded honestly rather than claimed
to be a pinned revision; the downloaded artifact SHA-256 is the exact snapshot
evidence.

SuccessFactors rows that depend on query parameters for company identity are not
currently importable because the provider canonicalizer strips query parameters.
Those rows are rejected during catalog normalization instead of being merged.

# Additional provider snapshots

## Career-Ops BambooHR and iCIMS

- Repository: https://github.com/santifer/career-ops
- Commit: b9cd65e8ddba9448c9590c25f45288cf61c1c1c7
- License: MIT
- Adapted files:
  - providers/bamboohr.mjs
  - providers/icims.mjs

Ehestifter adapts the public listing logic to its provider contract, bounded
execution, shared detail stage, and Jobs-owned canonical identity. The code is
not copied as an unattended upstream update.

## ats-scrapers Paylocity

- Repository: https://github.com/kalil0321/ats-scrapers
- Commit: 83a694a80679d49376b76e31fccd5676cddf9cd1
- License: MIT
- Adapted file: `src/ats_scrapers/scrapers/paylocity.py`
- License copy: `licenses/ats-scrapers-MIT.txt`

Ehestifter adapts the public Paylocity board-page protocol and keeps the board
UUID as the provider tenant. The public detail URL does not contain that UUID,
so ATS Discovery uses Jobs explicit identity lookup for Paylocity.
