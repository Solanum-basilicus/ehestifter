"""Unit tests for Open Opportunities compatibility thresholds."""

import sys
from pathlib import Path

import pytest

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from helpers.compatibility_threshold import parse_min_compatibility_score


def test_missing_score_uses_default():
    assert parse_min_compatibility_score() == 5.0


@pytest.mark.parametrize("raw, expected", [(0, 0.0), ("0.5", 0.5), (5, 5.0), ("9.5", 9.5)])
def test_score_accepts_half_steps(raw, expected):
    assert parse_min_compatibility_score(raw) == expected


@pytest.mark.parametrize("raw", [-0.5, 10, "5.1", "", "nan", "inf", True, [], {}])
def test_score_rejects_invalid_values(raw):
    with pytest.raises(ValueError, match="minCompatibilityScore"):
        parse_min_compatibility_score(raw)
