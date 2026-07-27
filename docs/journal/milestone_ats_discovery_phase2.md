### Phase 2 — Ashby catalog and target planner completed

- Test suite: 97 passed, 0 failed.
- Ashby catalog synchronized on 2026-07-20.
- Source items: 3,161.
- Accepted tenants: 3,161.
- Rejected tenants: 0.
- Duplicate tenants: 0.
- Catalog SHA-256:
  `ab69fdbe0a8cb52253272f96f462024ba26506757663b20b4d277cfd31e3e395`

Bounded offline experiments:

| Normal targets | Total targets | Successes | Errors | Rate limited | Duration |
|---:|---:|---:|---:|---:|---:|
| 10 | 13 | 11 | 2 | 0 | 4.1 s |
| 25 | 28 | 23 | 5 | 0 | 9.0 s |
| 100 | 103 | 83 | 20 | 0 | 29.9 s |

The 100-target run returned 1,649 raw jobs and retained 7
candidates after cheap filters.

Observed failures were tenant-level HTTP 404 responses rather than
provider rate limiting. This evidence will feed Phase 3 tenant runtime
health, dead-tenant handling, and rotating-shard design.

Catalog normal targets remained offline-only. Jobs preflight, detail
fetching, location normalization, and import were not executed for the
catalog shard.
