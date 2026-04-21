# Adzuna PoC

Phase 1 PoC for the Adzuna-backed import milestone.

This package intentionally stays local-only and read-only:
- fetch recent Adzuna jobs,
- apply milestone filters,
- normalize records,
- attempt origin-link-based canonical identity extraction,
- print formatted JSON for manual inspection.

It does **not** create Jobs-domain records and does **not** book enrichments.

## Python / venv

The host has multiple Python versions installed, so use an explicit Python 3.11 virtual environment.

```bash
cd ./scrappers/adzuna-poc
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -e .
```

For tests:

```bash
pip install -e .[dev]
pytest
```

## Required environment variables

```bash
export ADZUNA_APP_ID="your_app_id"
export ADZUNA_APP_KEY="your_app_key"
```

Optional:

```bash
export ADZUNA_BASE_URL="https://api.adzuna.com/v1/api"
export ADZUNA_TIMEOUT_SECONDS="30"
```

## Example run

```bash
adzuna-poc \
  --country de \
  --query "project manager" \
  --hours 24 \
  --max-pages 3 \
  --results-per-page 50 \
  --output json
```

Equivalent module invocation:

```bash
python -m adzuna_poc \
  --country de \
  --query "project manager" \
  --hours 24 \
  --max-pages 3
```

## Output

The tool prints a single JSON document with:
- fetch metadata,
- counters for each filter stage,
- normalized included jobs,
- per-job diagnostics and raw breadcrumbs that help assess origin-link quality.

## Notes

- Canonical identity extraction is a **best-effort temporary implementation**. In the main system, this should be replaced with the shared Jobs helper or a narrow internal Jobs endpoint.
- `redirect_url` is preserved for diagnostics; the PoC tries to recover an origin URL from Adzuna redirect parameters when possible.
- Remote/Germany relevance is heuristic and isolated in provider-specific normalization code.
