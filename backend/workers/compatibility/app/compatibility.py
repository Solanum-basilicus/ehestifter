from typing import Any, Dict

def build_prompt(*, job: Dict[str, Any], cv_text: str, rubric: str) -> str:
    title = (job.get("title") or "").strip()
    desc = (job.get("description") or "").strip()

    return f"""
You will evaluate the candidate CV versus the job.

RUBRIC:
{rubric}

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

def normalize_result(obj: Dict[str, Any]) -> Dict[str, Any]:
    score = obj.get("score")
    summary = obj.get("summary")
    # harden
    try:
        score_f = float(score)
    except Exception:
        score_f = 0.0
    if score_f < 0: score_f = 0.0
    if score_f > 100: score_f = 100.0
    summary_s = str(summary or "")[:2000]
    return {"score": score_f, "summary": summary_s}