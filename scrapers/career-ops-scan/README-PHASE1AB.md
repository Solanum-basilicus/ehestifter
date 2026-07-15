# Phase 1A/B scaffold

This scaffold adds only:

- tracked-company scans through the extracted Career-Ops provider layer;
- title, location, age, salary, and content filters;
- immutable local run artifacts;
- Ehestifter `GET /jobs/exists?url=...` preflight;
- no `POST /jobs` path.

Copy these files into `scrapers/career-ops-scan`, then run:

```bash
./scripts/copy-upstream-providers.sh /tmp/career-ops-upstream src/providers
npm test
```

Add `careerOps.upstreamRef` to `config/scanner.local.json` using:

```bash
git -C /tmp/career-ops-upstream rev-parse HEAD
```

Example:

```json
{
  "careerOps": {
    "upstreamRef": "<exact commit SHA>"
  }
}
```

The first run should be offline. Inspect `data/runs/<runId>` before using
preflight against the deployed Jobs API.
