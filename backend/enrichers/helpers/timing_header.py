"""Read only numeric and fixed-label Server-Timing fields from Gateway."""

import re

_FIELD = re.compile(r'\s*([a-z0-9_]+);(dur=([0-9]+(?:\.[0-9]+)?)|desc="([a-z0-9_]+)")\s*')


def parse_header(header, numeric_names, label_names):
    numbers, labels = {}, {}
    for part in (header or "")[:4096].split(",")[:40]:
        match = _FIELD.fullmatch(part)
        if not match:
            continue
        name = match.group(1)
        if match.group(3) is not None and name in numeric_names:
            numbers[name] = float(match.group(3))
        elif match.group(4) is not None and name in label_names:
            labels[name] = match.group(4)
    return numbers, labels
