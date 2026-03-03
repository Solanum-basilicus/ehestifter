from typing import Any, Dict, Optional

MAX_SUMMARY_LEN = 1800          # "cut a bit more" than before
MAX_RAW_SNIPPET_LEN = 400       # avoid spamming logs / DB

def build_prompt(*, job: Dict[str, Any], cv_text: str) -> str:
    title = (job.get("title") or "").strip()
    desc = (job.get("description") or "").strip()

    return f"""
Please evaluate the candidate CV versus the job.

JOB_TITLE:
{title}

JOB_DESCRIPTION:
{desc}

CANDIDATE_CV_TEXT:
{cv_text}

Return JSON with exactly:
{{
  "score": number,
  "summary": string
}}
""".strip()

def _truncate_with_note(s: str, limit: int) -> str:
    if s is None:
        return ""
    s = str(s)
    if len(s) <= limit:
        return s
    cut = len(s) - limit
    return s[:limit] + f"... {cut} symbols cut"


def normalize_result(obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalizes the model output, and appends diagnostic notes into `summary`
    for malformed/missing fields and score clamping.
    Supports extra keys injected by OllamaClient on parse errors:
      - __parse_error: str
      - __raw: str
    """
    notes = []

    # --- summary ---
    summary_present = "summary" in obj
    summary_val = obj.get("summary")
    if not summary_present or summary_val is None or str(summary_val).strip() == "":
        summary_s = "summary was absent"
        notes.append("summary was absent")
    else:
        summary_s = str(summary_val)

    # --- score ---
    score_present = "score" in obj
    score_raw: Optional[Any] = obj.get("score")

    if not score_present:
        notes.append("score absent, set to default 0")
        score_f = 0.0
        score_raw_repr = None
    else:
        score_raw_repr = score_raw
        try:
            score_f = float(score_raw)
        except Exception:
            notes.append("score malformed, set to default 0")
            score_f = 0.0

    # clamp + note adjustments
    original = score_f
    if score_f < 0.0:
        score_f = 0.0
    if score_f > 10.0:
        score_f = 10.0
    if score_f != original:
        notes.append(f"score adjusted from {original} to {score_f}")
    # if score key existed but was weird (e.g. string), this helps
    if score_present and score_raw_repr is not None and str(score_raw_repr) != str(score_f):
        # don’t overdo it—just keep it useful
        pass

    # --- parse error injected by client ---
    parse_err = obj.get("__parse_error")
    raw_txt = obj.get("__raw")
    if parse_err:
        notes.append(f"model output JSON parse failed: {parse_err}")
        if raw_txt:
            snippet = _truncate_with_note(str(raw_txt), MAX_RAW_SNIPPET_LEN)
            notes.append(f"raw model output snippet: {snippet}")

    # apply truncation to main summary (after we’ve built it)
    summary_s = _truncate_with_note(summary_s, MAX_SUMMARY_LEN)

    # append notes at the end (but keep overall capped-ish)
    if notes:
        summary_s = (summary_s + "\n\n[diagnostics] " + " | ".join(notes)).strip()
        # final safety cap (don’t let diagnostics blow it up)
        summary_s = _truncate_with_note(summary_s, 2000)

    return {"score": score_f, "summary": summary_s}