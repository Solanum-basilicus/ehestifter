import argparse
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import os
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerStdio
from pydantic_ai.usage import UsageLimits

from boards import BOARDS
from models import JobCardList, RawCapture

from chrome_control import find_bookmark_url, open_new_tab, wait_for_target_loaded, cdp_evaluate

from boards.stepstone_extract import STEPSTONE_VISIBLE_CARDS_JS

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--board", choices=sorted(BOARDS.keys()), required=True)
    parser.add_argument("--limit", type=int, default=1)
    return parser.parse_args()


def extract_json_object(text: str) -> str:
    marker = "```json"
    if marker in text:
        after_marker = text.rsplit(marker, 1)[1]
        if "```" in after_marker:
            return after_marker.split("```", 1)[0].strip()

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("Model did not include a JSON object.")
    return text[start : end + 1].strip()


def load_json_from_model_output(raw_text: str) -> dict:
    print("\n--- MODEL OUTPUT START ---")
    print(raw_text)
    print("--- MODEL OUTPUT END ---\n")

    json_text = extract_json_object(raw_text)
    return json.loads(json_text)


async def run_json_step(
    agent: Agent,
    prompt: str,
    label: str,
    request_limit: int = 40,
) -> dict:
    print(f"\n[{datetime.now(timezone.utc).isoformat()}] {label}")
    result = await agent.run(
        prompt,
        usage_limits=UsageLimits(request_limit=request_limit),
    )
    return load_json_from_model_output(str(result.output))


async def main() -> None:
    args = parse_args()
    board = BOARDS[args.board]

    chrome_debug_url = os.environ["CHROME_DEBUG_URL"]
    model_name = os.environ["MODEL_NAME"]
    raw_output_dir = Path(os.environ.get("RAW_OUTPUT_DIR", "/out/raw"))
    raw_output_dir.mkdir(parents=True, exist_ok=True)

    chrome_mcp = MCPServerStdio(
        command="npx",
        args=[
            "-y",
            "chrome-devtools-mcp@latest",
            f"--browser-url={chrome_debug_url}",
            "--no-usage-statistics",
            "--no-performance-crux",
        ],
    )

    system_prompt = (
        "You are a cautious local sourcing assistant for a PoC. "
        "Use the already-open Chrome session through browser tools. "
        "Do not log in, bypass access controls, solve captchas, change account settings, or accept paid actions. "
        "Only use visible page content. Never invent jobs, companies, URLs, timestamps, descriptions, or evidence. "
        "If the browser or page is not usable, return an empty result with warnings. "
        "Return ONLY one JSON object. No markdown. No explanation before or after. "
        "Descriptions must be as literal as possible. Preserve paragraph breaks, section headers, and bullet-like lines using newline characters. "
        "Do not summarize descriptions unless the page content is too large; if shortened, add a warning."
    )

    agent = Agent(
        model_name,
        mcp_servers=[chrome_mcp],
        model_settings={
            "temperature": 0.1,
            "max_tokens": 8192,
        },
        system_prompt=system_prompt,
    )

    print(f"Running board={board.name}, limit={args.limit}")
    print(f"Bookmark: {board.bookmark_name}")

    now_utc = datetime.now(timezone.utc).isoformat()

    async with chrome_mcp:
        print(f"\n[{datetime.now(timezone.utc).isoformat()}] [1/4] Opening board search")

        bookmark_url = find_bookmark_url(board.bookmark_name)
        print(f"Resolved bookmark {board.bookmark_name}: {bookmark_url}")

        target = open_new_tab(bookmark_url, chrome_debug_url)
        print(f"Opened Chrome target: {target.get('url')}")

        loaded_target = wait_for_target_loaded(
            target_id=target["id"],
            chrome_debug_url=chrome_debug_url,
            timeout_seconds=45,
        )
        print(f"Loaded Chrome target: {loaded_target.get('title')} | {loaded_target.get('url')}")

        search_target = loaded_target

        if board.name == "stepstone":
            print(f"\n[{datetime.now(timezone.utc).isoformat()}] [2/4] Reading visible job cards deterministically")

            cards_data = cdp_evaluate(
                websocket_url=search_target["webSocketDebuggerUrl"],
                expression=STEPSTONE_VISIBLE_CARDS_JS,
                timeout_seconds=15,
            )

            print(json.dumps(cards_data, ensure_ascii=False, indent=2))
        else:
            collect_prompt = board.collect_cards_prompt.replace("{limit}", str(args.limit))
            cards_data = await run_json_step(
                agent,
                collect_prompt,
                "[2/4] Reading visible job cards",
                request_limit=25,
            )

        cards = JobCardList.model_validate(cards_data)

        if not cards.cards:
            capture = RawCapture(
                source=board.name,
                captured_at_utc=datetime.now(timezone.utc).isoformat(),
                query="No usable job cards found",
                candidates=[],
                warnings=cards.warnings or ["No usable job cards found."],
            )
        else:
            selected_card = cards.cards[0]
            print(f"Selected card: {selected_card.title} / {selected_card.company}")

            if selected_card.detail_url:
                print(f"\n[{datetime.now(timezone.utc).isoformat()}] [3/4] Opening selected job detail")
                print(f"Opening detail URL: {selected_card.detail_url}")

                detail_target = open_new_tab(selected_card.detail_url, chrome_debug_url)
                print(f"Opened Chrome target: {detail_target.get('url')}")

                loaded_detail_target = wait_for_target_loaded(
                    target_id=detail_target["id"],
                    chrome_debug_url=chrome_debug_url,
                    timeout_seconds=45,
                )
                print(
                    f"Loaded Chrome target: "
                    f"{loaded_detail_target.get('title')} | {loaded_detail_target.get('url')}"
                )
            else:
                open_detail_prompt = board.open_detail_prompt.format(
                    bookmark_name=board.bookmark_name,
                    limit=args.limit,
                    now_utc=now_utc,
                    card_json=selected_card.model_dump_json(indent=2),
                )
                await run_json_step(agent, open_detail_prompt, "[3/4] Opening selected job detail")

            extract_prompt = f"""
Current UTC time: {datetime.now(timezone.utc).isoformat()}
Board: {board.name}

Return JSON exactly shaped as:
{{
  "source": "{board.name}",
  "captured_at_utc": "current UTC time from this prompt",
  "query": "short description of the search page/query actually used",
  "candidates": [
    {{
      "title": "string or null",
      "company": "string or null",
      "location_text": "string or null",
      "listing_url": "string or null",
      "origin_url": "string or null",
      "visible_description": "literal plaintext with preserved line breaks, or null",
      "evidence": "exact opened URL and/or exact page title"
    }}
  ],
  "warnings": []
}}

{board.extract_detail_prompt}
""".strip()

            capture_data = await run_json_step(
                agent,
                extract_prompt,
                "[4/4] Extracting selected job detail",
                request_limit=60,
            )
            capture = RawCapture.model_validate(capture_data)

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_path = raw_output_dir / f"{board.name}-raw-capture-{run_id}.json"

    output_path.write_text(
        json.dumps(capture.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"\nWrote {output_path}")
    print(json.dumps(capture.model_dump(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
