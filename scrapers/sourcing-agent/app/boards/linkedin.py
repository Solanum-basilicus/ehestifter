from .common import BoardProcedure

PROCEDURE = BoardProcedure(
    name="linkedin",
    bookmark_name="linkedin:search",
    collect_cards_prompt="""
Read only the visible LinkedIn job result cards in the jobs list.
Ignore profile nudges, premium prompts, alerts, recommendations, and non-job UI.
Return up to {limit} job cards as JSON:
{{
  "source": "linkedin",
  "cards": [
    {{
      "ordinal": 1,
      "title": "...",
      "company": "...",
      "location_text": "...",
      "evidence": "exact visible text proving this card exists",
      "open_instruction": "click the job card titled ..."
    }}
  ],
  "warnings": []
}}
Do not invent cards.
""",
    open_detail_prompt="""
Open this LinkedIn job card:

{card_json}

Click the matching visible job card.
LinkedIn usually opens details in the right-side panel.
If “Show more” is visible in the description, click it.
Wait until the job detail is visible.
Return JSON: {"ok": true, "warnings": []}
""",
    extract_detail_prompt="""
Extract exactly one job from the currently visible LinkedIn job detail.

Rules:
- listing_url: exact current job URL if visible or available from the browser URL.
- title/company/location_text: exact visible values.
- visible_description: literal plaintext from the job description section.
- Preserve headers, paragraph breaks, and bullet-like lines with newline characters.
- Exclude LinkedIn chrome, applicant count, recommendations, promoted labels, and unrelated profile widgets.
- origin_url: external apply/company URL only if visibly available; otherwise null.

Return only JSON matching RawCapture shape.
""",
)