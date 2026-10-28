"""Read only numeric and fixed-label Server-Timing fields from Gateway."""

import re
from math import isfinite

_FIELD = re.compile(r'\s*([a-z0-9_]+);(dur=([0-9]+(?:\.[0-9]+)?)|desc="([a-z0-9_]+)")\s*')


def parse_header(header, numeric_names, label_names):
    numbers, labels = {}, {}
    for part in (header or "")[:4096].split(",")[:40]:
        match = _FIELD.fullmatch(part)
        if not match:
            continue
        name = match.group(1)
        if match.group(3) is not None and name in numeric_names:
            value = float(match.group(3))
            if isfinite(value):
                numbers[name] = value
        elif match.group(4) is not None and name in label_names:
            value = match.group(4)
            if name.endswith("process_first") and value not in ("0", "1"):
                continue
            if name.endswith("sql_count") and (not value.isdigit() or len(value) > 7):
                continue
            labels[name] = value
    return numbers, labels
