from pathlib import Path
from runpy import run_path


JOBS_ROOT = Path(__file__).resolve().parents[1]


def _load_module_globals(relative_path: str) -> dict:
    return run_path(str(JOBS_ROOT / relative_path))


def test_ignored_status_taxonomy_is_consistent():
    domain_constants = _load_module_globals("helpers/domain_constants.py")
    status_normalize = _load_module_globals("helpers/status_normalize.py")

    final_statuses = domain_constants["FINAL_STATUSES"]
    status_options = status_normalize["STATUS_OPTIONS"]
    status_key = status_normalize["status_key"]

    assert "Ignored" in status_options
    assert "Ignored" in final_statuses
    assert status_key("Ignored") == "finished"
    assert status_key("  ignored  ") == "finished"
