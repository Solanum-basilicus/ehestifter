"""Validate the minimum compatibility score for Open Opportunities."""

from decimal import Decimal, InvalidOperation


DEFAULT_MIN_COMPATIBILITY_SCORE = 5.0
MAX_MIN_COMPATIBILITY_SCORE = 9.5
SCORE_STEP = Decimal("0.5")


def parse_min_compatibility_score(raw=None) -> float:
    """Use the default when absent. Accept only half-point steps from 0 to 9.5."""
    if raw is None:
        return DEFAULT_MIN_COMPATIBILITY_SCORE
    if isinstance(raw, bool) or not isinstance(raw, (str, int, float, Decimal)):
        raise ValueError("minCompatibilityScore must be between 0 and 9.5 in steps of 0.5")
    try:
        value = Decimal(str(raw))
    except InvalidOperation as exc:
        raise ValueError("minCompatibilityScore must be between 0 and 9.5 in steps of 0.5") from exc
    if not value.is_finite() or value < 0 or value > Decimal("9.5") or value % SCORE_STEP != 0:
        raise ValueError("minCompatibilityScore must be between 0 and 9.5 in steps of 0.5")
    return float(value)
