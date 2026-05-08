from dataclasses import dataclass


@dataclass(frozen=True)
class BoardProcedure:
    name: str
    bookmark_name: str
    collect_cards_prompt: str
    open_detail_prompt: str
    extract_detail_prompt: str