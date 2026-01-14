# helpers/quill_to_text.py
import re
import json
from typing import Any, Dict

def canonical_json(obj: Any) -> str:
    """
    Stable JSON representation for hashing:
    - sorted keys
    - no whitespace
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def quill_delta_to_text(delta: Dict[str, Any]) -> str:
    ops = delta.get("ops", [])
    parts = []
    for op in ops:
        ins = op.get("insert")
        if isinstance(ins, str):
            parts.append(ins)
        elif isinstance(ins, dict):
            # embed (image, etc.) - choose a conservative placeholder
            parts.append("\n")
    return "".join(parts)

def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # trim trailing whitespace per line
    text = "\n".join([line.rstrip() for line in text.split("\n")])
    # collapse excessive blank lines (3+ -> 2)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # collapse repeated spaces/tabs inside lines
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = text.strip() + "\n"
    return text
