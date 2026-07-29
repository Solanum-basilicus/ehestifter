from helpers.domain_constants import FINAL_STATUSES
from helpers.status_normalize import STATUS_OPTIONS, status_key


def test_ignored_status_taxonomy_is_consistent():
    assert "Ignored" in STATUS_OPTIONS
    assert "Ignored" in FINAL_STATUSES
    assert status_key("Ignored") == "finished"
    assert status_key("  ignored  ") == "finished"
