from .common import BoardProcedure

PROCEDURE = BoardProcedure(
    name="stepstone",
    bookmark_name="stepstone:s",
    collect_cards_prompt="""
You are already on a loaded StepStone search results page.

Goal:
Find the first real visible job result card and return it as one JobCard.

Success looks like:
- exactly one card in "cards"
- title is a real visible job title
- company is the visible company name
- location_text is the visible location/work mode text if available
- open_instruction tells how to click this same visible result

Rules:
- Do not navigate away.
- Do not open a job detail.
- Do not scroll unless no job card is visible.
- Do not inspect more than the currently visible result list.
- Ignore filters, headers, ads, subscription prompts, recommendations, login/profile prompts, and non-job UI.
- If no real job card is visible after one page snapshot, return an empty cards array with a warning.
- Return only JSON. No commentary.

For the selected card, inspect the link under the job title if available.
Set detail_url to the href of that title/job-card link.
Prefer StepStone URLs containing "/stellenangebote--".
Do not click the link in this step.
If href is unavailable, set detail_url null and provide open_instruction.

Return JSON exactly like:
{{
  "source": "stepstone",
  "cards": [
    {{
      "ordinal": 1,
      "title": "exact visible title",
      "company": "exact visible company",
      "detail_url": "see instructions above",
      "location_text": "exact visible location text or null",
      "evidence": "short exact visible text copied from the card",
      "open_instruction": "click the visible StepStone result card titled 'exact title'"
    }}
  ],
  "warnings": []
}}
""",
    open_detail_prompt="""
Open this StepStone job card:

{card_json}

Click the matching visible job card.
StepStone may open the detail page in a new tab. If so, switch to that new tab.
Wait until the job detail page is visible.
Return JSON: {"ok": true, "warnings": []}
""",
    extract_detail_prompt="""
Extract exactly one job from the currently open StepStone job detail page.

Rules:
- listing_url: exact current browser URL.
- origin_url: same as listing_url unless a separate employer/career-site apply URL is visibly available.
- title/company/location_text: exact visible values.
- visible_description: literal plaintext from the main job description area.
- Preserve headers, paragraph breaks, and bullet-like lines with newline characters.
- Exclude StepStone widgets, recommendations, cookie banners, and “Passt dieser Job zu mir?” blocks.
- Prefer text between the top and bottom application buttons when identifiable.

Return only JSON matching RawCapture shape.
""",
)