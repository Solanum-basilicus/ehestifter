# /app/compatibility.py
from typing import Any, Dict, List, Optional
import json

MAX_SUMMARY_LEN = 1800
MAX_RAW_SNIPPET_LEN = 400


CEFR_ORDER = {
    "A1": 1,
    "A2": 2,
    "B1": 3,
    "B2": 4,
    "C1": 5,
    "C2": 6,
}

LANGUAGE_SYNONYMS = {
    "english": "English",
    "german": "German",
    "french": "French",
    "spanish": "Spanish",
    "italian": "Italian",
    "polish": "Polish",
    "dutch": "Dutch",
    "portuguese": "Portuguese",
    "romanian": "Romanian",
    "czech": "Czech",
    "slovak": "Slovak",
    "hungarian": "Hungarian",
    "ukrainian": "Ukrainian",
    "russian": "Russian",
    "turkish": "Turkish",
    "swedish": "Swedish",
    "norwegian": "Norwegian",
    "danish": "Danish",
    "finnish": "Finnish",
    "greek": "Greek",
    "bulgarian": "Bulgarian",
    "croatian": "Croatian",
    "serbian": "Serbian",
    "slovenian": "Slovenian",
    "lithuanian": "Lithuanian",
    "latvian": "Latvian",
    "estonian": "Estonian",
    "arabic": "Arabic",
    "hindi": "Hindi",
    "japanese": "Japanese",
    "korean": "Korean",
    "mandarin": "Mandarin",
    "chinese": "Chinese",
}


def _truncate_with_note(s: str, limit: int) -> str:
    if s is None:
        return ""
    s = str(s)
    if len(s) <= limit:
        return s
    cut = len(s) - limit
    return s[:limit] + f"... {cut} symbols cut"


def _safe_str(v: Any, default: str = "") -> str:
    if v is None:
        return default
    try:
        return str(v).strip()
    except Exception:
        return default


def _coerce_score(v: Any, default: float = 0.0) -> float:
    try:
        f = float(v)
    except Exception:
        return default
    if f < 0.0:
        return 0.0
    if f > 10.0:
        return 10.0
    return round(f, 1)


def _normalize_language_name(v: Any) -> str:
    s = _safe_str(v)
    if not s:
        return ""
    key = s.lower()
    if key in LANGUAGE_SYNONYMS:
        return LANGUAGE_SYNONYMS[key]
    if len(s) <= 2:
        return s.upper()
    return s[:1].upper() + s[1:].lower()


def _normalize_cefr_level(v: Any, default: str = "B1") -> str:
    s = _safe_str(v).upper()

    if s in CEFR_ORDER:
        return s

    if not s:
        return default

    aliases = {
        "NATIVE": "C2",
        "BILINGUAL": "C2",
        "FLUENT": "C1",
        "ADVANCED": "C1",
        "UPPER-INTERMEDIATE": "B2",
        "UPPER INTERMEDIATE": "B2",
        "INTERMEDIATE": "B1",
        "PROFESSIONAL": "B1",
        "PROFESSIONAL WORKING": "B1",
        "WORKING": "B1",
        "CONVERSATIONAL": "B1",
        "BUSINESS": "B2",
        "NEGOTIATION": "C1",
        "NEGOTIATION LEVEL": "C1",
        "GOOD": "B1",
        "BASIC": "A2",
        "ELEMENTARY": "A1",
        "BEGINNER": "A1",
    }

    if s in aliases:
        return aliases[s]

    if "NEGOTIATION" in s:
        return "C1"
    if "BUSINESS" in s:
        return "B2"
    if "PROFESSIONAL" in s:
        return "B1"
    if "FLUENT" in s:
        return "C1"
    if "ADVANCED" in s:
        return "C1"
    if "UPPER" in s and "INTERMEDIATE" in s:
        return "B2"
    if "INTERMEDIATE" in s:
        return "B1"
    if "CONVERSATIONAL" in s:
        return "B1"
    if "BASIC" in s:
        return "A2"
    if "BEGINNER" in s or "ELEMENTARY" in s:
        return "A1"
    if "NATIVE" in s or "BILINGUAL" in s:
        return "C2"

    return default


def _cefr_rank(level: Any) -> int:
    return CEFR_ORDER.get(_normalize_cefr_level(level, default="A1"), 0)


def _normalize_language_list(obj: Any, default_level: str = "B1") -> List[Dict[str, str]]:
    items: List[Dict[str, str]] = []

    if obj is None:
        return items

    if isinstance(obj, dict):
        for k, v in obj.items():
            lang = _normalize_language_name(k)
            if not lang:
                continue
            level = _normalize_cefr_level(v, default=default_level)
            items.append({"Language": lang, "Level": level})
        return items

    if not isinstance(obj, list):
        return items

    for it in obj:
        if isinstance(it, dict):
            lang = (
                it.get("Language")
                or it.get("language")
                or it.get("Name")
                or it.get("name")
            )
            level = (
                it.get("Level")
                or it.get("level")
                or it.get("CEFR")
                or it.get("cefr")
            )
            lang_n = _normalize_language_name(lang)
            if not lang_n:
                continue
            level_n = _normalize_cefr_level(level, default=default_level)
            items.append({"Language": lang_n, "Level": level_n})
        elif isinstance(it, str):
            lang_n = _normalize_language_name(it)
            if lang_n:
                items.append({"Language": lang_n, "Level": _normalize_cefr_level(None, default=default_level)})

    return items


def _extract_subsection(obj: Any, *keys: str) -> Any:
    if not isinstance(obj, dict):
        return None
    lowered = {str(k).lower(): v for k, v in obj.items()}
    for k in keys:
        if k.lower() in lowered:
            return lowered[k.lower()]
    return None


def _normalize_languages(obj: Any) -> Dict[str, Any]:
    out = {
        "Applicant": [],
        "Job": {
            "Mandatory": [],
            "Optional": [],
        },
    }

    if not isinstance(obj, dict):
        return out

    applicant = _extract_subsection(obj, "Applicant")
    job = _extract_subsection(obj, "Job")

    out["Applicant"] = _normalize_language_list(applicant, default_level="B1")

    if isinstance(job, dict):
        mandatory = _extract_subsection(job, "Mandatory")
        optional = _extract_subsection(job, "Optional")
        out["Job"]["Mandatory"] = _normalize_language_list(mandatory, default_level="B1")
        out["Job"]["Optional"] = _normalize_language_list(optional, default_level="B1")

    return out


def _normalize_scored_section(obj: Any, default_description: str = "") -> Dict[str, Any]:
    if not isinstance(obj, dict):
        return {"score": 0.0, "description": default_description}

    score = (
        obj.get("score")
        or obj.get("Score")
        or obj.get("value")
        or obj.get("Value")
        or 0.0
    )
    description = (
        obj.get("description")
        or obj.get("Description")
        or obj.get("summary")
        or obj.get("Summary")
        or default_description
    )

    return {
        "score": _coerce_score(score, default=0.0),
        "description": _truncate_with_note(_safe_str(description), MAX_SUMMARY_LEN),
    }


def build_prompt(*, job: Dict[str, Any], cv_text: str) -> str:
    title = _safe_str(job.get("title") or job.get("jobName") or "")
    desc = _safe_str(job.get("description") or job.get("jobDescription") or "")
    cv_text = _safe_str(cv_text)

    shape = {
        "Description": "string, 1-2 short sentences explaining overall compatibility verdict",
        "Languages": {
            "Applicant": [
                {"Language": "English", "Level": "C1"}
            ],
            "Job": {
                "Mandatory": [
                    {"Language": "English", "Level": "C1"}
                ],
                "Optional": [
                    {"Language": "French", "Level": "B1"}
                ]
            }
        },
        "HardSkills": {
            "score": "number 0.0-10.0",
            "description": "string"
        },
        "Experience": {
            "score": "number 0.0-10.0",
            "description": "string"
        },
        "SoftSkills": {
            "score": "number 0.0-10.0",
            "description": "string"
        }
    }

    return f"""
Please evaluate the candidate CV versus the job.

JOB_TITLE:
{title}

JOB_DESCRIPTION:
{desc}

CANDIDATE_CV_TEXT:
{cv_text}

Return ONLY a single JSON object with exactly this structure:
{json.dumps(shape, ensure_ascii=False)}

Critical interpretation rules:
1. "Description" means OVERALL COMPATIBILITY VERDICT, not candidate profile summary.
2. "Description" must explain why the candidate is a strong / moderate / weak fit for THIS job.
3. "Description" must compare job requirements against evidence from the CV.
4. "Description" must mention the main positive and/or negative drivers of fit.
5. Do NOT paraphrase or restate the candidate's self-description, profile summary, about-me section, or career objective.
6. Do NOT write what the candidate says about themselves unless it directly supports compatibility with the JD.
7. If the fit is weak, say what is missing. If the fit is strong, say what clearly matches.
8. Keep "Description" short: maximum 2 sentences.

Other rules:
9. Do not invent facts absent from CV or JD.
10. Languages.Applicant: list all applicant languages explicitly present in CV.
11. Languages.Job.Mandatory: required languages from JD.
12. Languages.Job.Optional: languages marked as preferred / plus / advantage / nice-to-have.
13. Convert language wording into CEFR using only A1, A2, B1, B2, C1, C2.
14. If a language is named but no level is stated, assume B1.
15. "professional level" => B1, "business level" => B2, "negotiation level" => C1, "fluent" => C1, "native/bilingual" => C2.
16. HardSkills score must cover technical stack, tools, certifications, education, and explicit hard-skill fit.
17. Experience score must cover years, tenure, seniority, role or industry experience.
18. SoftSkills score must cover communication, teamwork, stakeholder fit, and behavioral/culture fit.
19. Keep section descriptions concise and evidence-based.

Good Description examples:
- "Strong overall fit: the CV matches the core Python, Azure, and SQL requirements, but the candidate appears somewhat lighter on explicit stakeholder-facing experience."
- "Moderate fit: the candidate covers much of the technical stack, but the CV does not clearly support the required years of relevant experience."
- "Weak fit: several core hard-skill requirements are missing or only loosely evidenced in the CV."

Bad Description examples:
- "Experienced data professional with strong motivation and diverse background."
- "Results-driven engineer with passion for technology."
- "I am a hardworking person with excellent communication skills."

No markdown. No extra keys. No extra text.
""".strip()


def normalize_result(obj: Dict[str, Any]) -> Dict[str, Any]:
    notes = []

    description = _safe_str(
        obj.get("Description")
        or obj.get("description")
        or obj.get("summary")
        or obj.get("Summary")
        or ""
    )
    if not description:
        description = "Structured compatibility summary could not be reliably extracted."
        notes.append("description was absent")
    description = _truncate_with_note(description, MAX_SUMMARY_LEN)

    languages = _normalize_languages(
        obj.get("Languages")
        or obj.get("languages")
        or {}
    )

    hard_skills = _normalize_scored_section(
        obj.get("HardSkills") or obj.get("hardSkills") or obj.get("hard_skills"),
        default_description="Hard skills match could not be reliably extracted.",
    )
    experience = _normalize_scored_section(
        obj.get("Experience") or obj.get("experience"),
        default_description="Experience match could not be reliably extracted.",
    )
    soft_skills = _normalize_scored_section(
        obj.get("SoftSkills") or obj.get("softSkills") or obj.get("soft_skills"),
        default_description="Soft skills match could not be reliably extracted.",
    )

    parse_err = obj.get("__parse_error")
    raw_txt = obj.get("__raw")
    if parse_err:
        notes.append(f"model output JSON parse failed: {parse_err}")
        if raw_txt:
            snippet = _truncate_with_note(str(raw_txt), MAX_RAW_SNIPPET_LEN)
            notes.append(f"raw model output snippet: {snippet}")

    result = {
        "description": description,
        "languages": languages,
        "hard_skills": hard_skills,
        "experience": experience,
        "soft_skills": soft_skills,
    }

    for k in ("__parse_diag", "__llama_cpp", "__raw", "__parse_error", "__client_debug", "__server_debug"):
        if k in obj:
            result[k] = obj[k]

    if notes:
        result["__normalize_notes"] = notes

    return result


def evaluate_language_disqualification(languages: Dict[str, Any]) -> Dict[str, Any]:
    applicant = _normalize_language_list((languages or {}).get("Applicant"), default_level="B1")
    job = (languages or {}).get("Job") or {}
    mandatory = _normalize_language_list(job.get("Mandatory"), default_level="B1")

    applicant_best: Dict[str, str] = {}
    for it in applicant:
        lang = _normalize_language_name(it.get("Language"))
        lvl = _normalize_cefr_level(it.get("Level"), default="B1")
        prev = applicant_best.get(lang)
        if prev is None or _cefr_rank(lvl) > _cefr_rank(prev):
            applicant_best[lang] = lvl

    missing = []
    matched = []

    for req in mandatory:
        lang = _normalize_language_name(req.get("Language"))
        required = _normalize_cefr_level(req.get("Level"), default="B1")
        actual = applicant_best.get(lang)

        if actual is None or _cefr_rank(actual) < _cefr_rank(required):
            missing.append({
                "Language": lang,
                "Required": required,
                "Applicant": actual,
            })
        else:
            matched.append({
                "Language": lang,
                "Required": required,
                "Applicant": actual,
            })

    return {
        "disqualified": len(missing) > 0,
        "missing": missing,
        "matched": matched,
    }


def calculate_final_score(
    *,
    hard_skills_score: float,
    experience_score: float,
    soft_skills_score: float,
    language_disqualified: bool,
) -> float:
    if language_disqualified:
        return 0.5

    final_score = (
        _coerce_score(hard_skills_score) * 0.60
        + _coerce_score(experience_score) * 0.25
        + _coerce_score(soft_skills_score) * 0.15
    )
    return round(final_score, 1)