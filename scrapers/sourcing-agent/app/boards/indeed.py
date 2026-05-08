from .common import BoardProcedure

PROCEDURE = BoardProcedure(
    name="indeed",
    bookmark_name="indeed:search",
    collect_cards_prompt="""
Read only the visible Indeed job result cards in the left/results list.
Ignore login prompts, alerts, profile nudges, subscription prompts, ads, and non-job UI.
Return up to {limit} job cards as JSON:
{{
  "source": "indeed",
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
Open this Indeed job card:

{card_json}

Click the matching visible job card.
Indeed usually opens the detail in a right-side panel. If it opens a page or tab, use that.
Wait until the detail panel/page is visible.
Return JSON: {"ok": true, "warnings": []}
""",
    extract_detail_prompt="""
Extract exactly one job from the currently visible Indeed job detail.

Rules:
- title/company/location_text: exact visible values.
- visible_description: literal plaintext from the job description panel/page.
- Preserve headers, paragraph breaks, and bullet-like lines with newline characters.
- Exclude Indeed chrome, recommendations, ads, report links, login prompts, and unrelated UI.
- For listing_url, look near the apply button for Share / Copy link.
- If a Share or Copy link control is visible, use it or inspect it to obtain the unique Indeed viewjob URL.
- Prefer URLs shaped like https://de.indeed.com/viewjob?jk=...
- Do not use https://de.indeed.com/?r=us as listing_url unless no job-specific URL is available.
- If no unique job URL is available, set listing_url null and add a warning.
- origin_url: employer/career-site URL only if visibly available; otherwise null.

Return only JSON matching RawCapture shape.
""",
)